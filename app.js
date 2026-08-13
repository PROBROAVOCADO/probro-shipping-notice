/* 波波酪梨 · 出貨通知系統  app.js  v1.0.0 */
'use strict';

const VERSION = 'v1.0.0';
const JSZIP_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';

/* ── 設定（存 localStorage，不進 GitHub）───────────────── */
const cfg = {
  get url() { return localStorage.getItem('gasUrl') || ''; },
  set url(v) { localStorage.setItem('gasUrl', v.trim()); },
  get token() { return localStorage.getItem('gasToken') || ''; },
  set token(v) { localStorage.setItem('gasToken', v.trim()); },
  get ok() { return !!(this.url && this.token); }
};

/* ── IndexedDB ─────────────────────────────────────────── */
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('bobo-ship', 1);
    r.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('photos')) {
        const s = d.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
        s.createIndex('orderKey', 'orderKey');
      }
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(store, mode, fn) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
  });
}
const dbAllPhotos = () => tx('photos', 'readonly', s => s.getAll());
const dbPutPhoto  = p => tx('photos', 'readwrite', s => s.put(p));
const dbDelPhoto  = id => tx('photos', 'readwrite', s => s.delete(id));
const kvGet = k => tx('kv', 'readonly', s => s.get(k));
const kvSet = (k, v) => tx('kv', 'readwrite', s => s.put(v, k));

/* ── 狀態 ──────────────────────────────────────────────── */
const S = {
  orders: [],       // 來自 GAS
  fetchedAt: null,  // ISO 字串
  photos: [],       // 全部照片紀錄
  sent: {},         // orderKey -> 傳送時間
  extra: {},        // orderKey -> true（現場臨時加入）
  showPending: false,
  q: '',
  cam: null         // { order, boxIdx, stream }
};

/* ── 小工具 ────────────────────────────────────────────── */
const $  = s => document.querySelector(s);
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

let toastTimer;
function toast(msg, ms = 1900) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = n => ('0' + n).slice(-2);
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 20) || '無名';
}

/* ── 啟動 ──────────────────────────────────────────────── */
document.querySelectorAll('#tabs button').forEach(b => {
  b.addEventListener('click', () => go(b.dataset.go));
});
function go(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('hide', s.id !== id));
  document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-current', b.dataset.go === id ? 'true' : 'false'));
  if (id === 's-notify') renderNotify();
  if (id === 's-setup') renderSetup();
  window.scrollTo(0, 0);
}

(async function boot() {
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch (e) { /* 離線或不支援 */ }
  }
  S.photos = await dbAllPhotos();
  S.sent   = (await kvGet('sent'))  || {};
  S.extra  = (await kvGet('extra')) || {};
  const cache = await kvGet('orders');
  if (cache) { S.orders = cache.orders; S.fetchedAt = cache.fetchedAt; }

  renderShoot();
  renderSetup();
  updateBadge();

  if (!cfg.ok) { go('s-setup'); toast('請先填入連線設定'); return; }
  if (navigator.onLine) fetchOrders(true);
})();

/* ── 取得訂單 ──────────────────────────────────────────── */
async function fetchOrders(silent) {
  if (!cfg.ok) { toast('尚未設定連線'); go('s-setup'); return false; }
  if (!silent) toast('讀取中…', 8000);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const u = `${cfg.url}?action=list&token=${encodeURIComponent(cfg.token)}&t=${Date.now()}`;
    const r = await fetch(u, { signal: ctl.abort ? ctl.signal : undefined, redirect: 'follow' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '後端回報失敗');

    S.orders = j.orders;
    S.fetchedAt = j.fetchedAt;
    await kvSet('orders', { orders: j.orders, fetchedAt: j.fetchedAt });
    renderShoot(); renderNotify(); updateBadge();
    toast(`已更新 ${j.orders.length} 筆`);
    return true;
  } catch (e) {
    const msg = e.name === 'AbortError' ? '連線逾時' : (e.message || '連線失敗');
    if (S.orders.length) toast(`${msg}，沿用 ${fmtTime(S.fetchedAt)} 的資料`, 3200);
    else toast(`${msg}，且本機沒有可用資料`, 3600);
    return false;
  } finally {
    clearTimeout(timer);
    renderStamp();
  }
}

function renderStamp() {
  const stale = S.fetchedAt && (Date.now() - new Date(S.fetchedAt).getTime() > 3 * 3600 * 1000);
  const txt = S.fetchedAt ? `資料時間 ${fmtTime(S.fetchedAt)}` : '尚未取得資料';
  ['#stamp', '#stamp2'].forEach(sel => {
    const n = $(sel); if (!n) return;
    n.textContent = txt;
    n.classList.toggle('stale', !!stale || !S.fetchedAt);
  });
}

/* ── 照片查詢 ──────────────────────────────────────────── */
const photosOf = key => S.photos.filter(p => p.orderKey === key).sort((a, b) => a.boxIdx - b.boxIdx);
const shotBoxes = key => new Set(photosOf(key).map(p => p.boxIdx));
const unexported = () => S.photos.filter(p => !p.exported);

/* 今天要處理的清單：狀態為出貨準備，或現場臨時加入的 */
function activeOrders() {
  return S.orders.filter(o => o.status === '出貨準備' || S.extra[o.key]);
}

/* ── 出貨畫面 ──────────────────────────────────────────── */
function renderShoot() {
  renderStamp();
  const body = $('#shootBody');
  body.innerHTML = '';

  // 頂部操作
  const bar = el('div', 'bar');
  const btnFetch = el('button', 'btn sm ghost', '重新抓取');
  btnFetch.onclick = () => fetchOrders(false);
  const search = el('input', 'field');
  search.placeholder = '搜尋姓名';
  search.value = S.q;
  search.style.margin = '0';
  search.oninput = e => { S.q = e.target.value.trim(); renderList(); };
  bar.append(search, btnFetch);
  body.append(bar);

  // 未匯出提醒
  const ux = unexported().length;
  if (ux) {
    const n = el('div', 'notice', `有 ${ux} 張照片還沒匯出存證版。存證版只在這支手機上，請當天匯出。`);
    const b = el('button', 'btn sm wide', '前往匯出');
    b.style.marginTop = '10px';
    b.onclick = () => go('s-setup');
    n.append(b);
    body.append(n);
  }

  body.append(el('div', '', ''));
  const holder = el('div'); holder.id = 'listHolder';
  body.append(holder);
  renderList();
}

function renderList() {
  const holder = $('#listHolder');
  if (!holder) return;
  holder.innerHTML = '';

  const q = S.q;
  const match = o => !q || o.name.includes(q) || o.phone3.includes(q);
  const act = activeOrders().filter(match);

  // 統計
  const totalBox = act.reduce((s, o) => s + o.boxCount, 0);
  const shotBox  = act.reduce((s, o) => s + shotBoxes(o.key).size, 0);
  const tally = el('div', 'tally');
  tally.innerHTML = `<span>訂單 <b class="num">${act.length}</b></span>
    <span>箱數 <b class="num">${shotBox}/${totalBox}</b></span>`;
  holder.append(tally);

  if (!act.length) {
    holder.append(el('div', 'empty',
      S.orders.length ? '今天沒有標記「出貨準備」的訂單。到試算表 R 欄標記，或用下方按鈕臨時加入。'
                      : '還沒有資料。按「重新抓取」載入訂單。'));
  }

  act.forEach(o => holder.append(orderCard(o)));

  // 收工檢查
  if (act.length) {
    const miss = act.filter(o => shotBoxes(o.key).size < o.boxCount);
    const box = el('div');
    box.style.marginTop = '18px';
    if (miss.length) {
      const n = el('div', 'notice',
        `還有 ${miss.length} 筆沒拍完：` + miss.map(o => `${o.name}（${shotBoxes(o.key).size}/${o.boxCount}）`).join('、'));
      box.append(n);
    } else {
      box.append(el('div', 'notice calm', '這批都拍完了。記得回試算表把 R 欄改成「已出貨」。'));
    }
    holder.append(box);
  }

  // 臨時加入
  holder.append(el('div', 'secTitle', '不在清單上？'));
  const add = el('button', 'btn ghost wide', S.showPending ? '收合未出貨訂單' : '＋ 從尚未出貨中加入');
  add.onclick = () => { S.showPending = !S.showPending; renderList(); };
  holder.append(add);

  if (S.showPending) {
    const pend = S.orders.filter(o => o.status !== '出貨準備' && !S.extra[o.key] && match(o)).slice(0, 40);
    if (!pend.length) holder.append(el('div', 'empty', '沒有符合的未出貨訂單。試著在上面搜尋姓名。'));
    pend.forEach(o => {
      const b = el('button', 'card');
      b.innerHTML = `<div class="cardHead"><span class="nm">${esc(o.name)}</span>
        <span class="meta">${esc(o.shipShort)} · ${o.jin}斤 · ${o.boxCount}箱</span></div>`;
      b.onclick = async () => {
        S.extra[o.key] = true; await kvSet('extra', S.extra);
        S.showPending = false; S.q = '';
        renderShoot();
        toast(`已加入 ${o.name}，記得回試算表補標記`);
      };
      holder.append(b);
    });
  }
}

function orderCard(o) {
  const shot = shotBoxes(o.key);
  const cls = shot.size === 0 ? '' : (shot.size >= o.boxCount ? 'full' : 'part');
  const b = el('button', `card ${cls} ${S.extra[o.key] ? 'extra' : ''}`);

  const head = el('div', 'cardHead');
  head.innerHTML = `<span class="nm">${esc(o.name)}</span>`;
  if (S.extra[o.key]) head.append(el('span', 'tagExtra', '臨時'));
  head.append(el('span', 'meta', `${o.shipShort} · ${o.jin}斤`));
  b.append(head);

  const dots = el('div', 'dots');
  for (let i = 1; i <= o.boxCount; i++) {
    dots.append(el('span', 'dot' + (shot.has(i) ? ' on' : '')));
  }
  dots.append(el('span', 'num', `${shot.size}/${o.boxCount} 箱`));
  b.append(dots);

  if (o.hasBoxDetail === false) {
    const w = el('div', 'items', '⚠️ 這筆沒有裝箱明細，箱數與斤數是推估的，請先補 Q 欄');
    w.style.color = 'var(--alert)';
    w.style.fontWeight = '600';
    b.append(w);
  }
  b.append(el('div', 'items', o.boxes.map(x =>
    `${'①②③④⑤⑥⑦⑧⑨⑩'[x.idx - 1] || x.idx} ${x.weight ? x.weight + '斤｜' : ''}${x.items}`).join('\n')));

  b.onclick = () => o.boxCount > 1 ? pickBox(o) : startCamera(o, 1);
  return b;
}

/* ── 選箱 ──────────────────────────────────────────────── */
function pickBox(o) {
  const shot = shotBoxes(o.key);
  const wrap = el('div', 'sheet');
  const body = el('div', 'sheetBody');
  body.append(el('h2', '', o.name));
  body.append(el('p', '', `共 ${o.boxCount} 箱，選擇現在要拍的這一箱`));

  o.boxes.forEach(x => {
    const done = shot.has(x.idx);
    const b = el('button', 'boxBtn' + (done ? ' shot' : ''));
    b.innerHTML = `<b>第 ${x.idx} 箱${x.weight ? ' · ' + x.weight + '斤' : ''}</b>
      <span>${esc(x.items)}${done ? ' ✓ 已拍，再拍會取代' : ''}</span>`;
    b.onclick = () => { wrap.remove(); startCamera(o, x.idx); };
    body.append(b);
  });

  const c = el('button', 'btn ghost wide', '取消');
  c.onclick = () => wrap.remove();
  body.append(c);
  wrap.append(body);
  wrap.onclick = e => { if (e.target === wrap) wrap.remove(); };
  document.body.append(wrap);
}

/* ── 相機 ──────────────────────────────────────────────── */
async function startCamera(order, boxIdx) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 2560 } },
      audio: false
    });
  } catch (e) {
    toast('無法開啟相機。請在 Safari 允許相機權限。', 3600);
    return;
  }

  const cam = el('div'); cam.id = 'cam';
  cam.innerHTML = `
    <video playsinline autoplay muted></video>
    <div id="flash"></div>
    <div class="camTop">
      <div class="nm" id="camName"></div>
      <div class="sub" id="camSub"></div>
      <div class="it" id="camItems"></div>
    </div>
    <div class="camBot">
      <button class="camBtn" id="camClose">關閉</button>
      <button class="shutter" id="camShot" aria-label="拍照"></button>
      <img id="camThumb" alt="">
    </div>`;
  document.body.append(cam);

  const video = cam.querySelector('video');
  video.srcObject = stream;
  S.cam = { order, boxIdx, stream, cam, video };
  paintCamTarget();

  cam.querySelector('#camClose').onclick = closeCamera;
  cam.querySelector('#camShot').onclick = capture;
}

function paintCamTarget() {
  const { order, boxIdx } = S.cam;
  const box = order.boxes.find(b => b.idx === boxIdx) || order.boxes[0];
  $('#camName').textContent = order.name;
  $('#camSub').textContent = order.boxCount > 1
    ? `${order.shipShort} · 第 ${boxIdx} 箱／共 ${order.boxCount} 箱`
    : `${order.shipShort} · 共 1 箱`;
  $('#camItems').textContent = box ? `${box.weight ? box.weight + '斤｜' : ''}${box.items}` : '';
  const last = photosOf(order.key).slice(-1)[0];
  const th = $('#camThumb');
  if (last) { th.src = URL.createObjectURL(last.stamped); th.style.visibility = 'visible'; }
  else th.style.visibility = 'hidden';
}

function closeCamera() {
  if (!S.cam) return;
  S.cam.stream.getTracks().forEach(t => t.stop());
  S.cam.cam.remove();
  S.cam = null;
  renderShoot(); updateBadge();
}

async function capture() {
  if (!S.cam) return;
  const { order, boxIdx, video } = S.cam;
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) { toast('相機還沒準備好'); return; }

  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.drawImage(video, 0, 0, w, h);

  const f = $('#flash');
  f.style.transition = 'none'; f.style.opacity = '.85';
  requestAnimationFrame(() => { f.style.transition = 'opacity .3s'; f.style.opacity = '0'; });

  const raw = await toBlob(cv, 0.95);
  drawOverlay(ctx, w, h, overlayLines(order, boxIdx));
  const stamped = await toBlob(cv, 0.92);

  // 同一箱重拍 → 取代
  const old = S.photos.filter(p => p.orderKey === order.key && p.boxIdx === boxIdx);
  for (const p of old) { await dbDelPhoto(p.id); }
  S.photos = S.photos.filter(p => !(p.orderKey === order.key && p.boxIdx === boxIdx));

  const base = safeName(order.name) + '_' + order.phone3 + '_' + order.orderDate + '_' + order.key4
             + (order.boxCount > 1 ? `_${boxIdx}of${order.boxCount}` : '');
  const rec = {
    orderKey: order.key, boxIdx, boxCount: order.boxCount,
    name: order.name, ts: new Date().toISOString(),
    filename: base + '.jpg', filenameRaw: base + '_RAW.jpg',
    stamped, raw, exported: 0
  };
  const id = await dbPutPhoto(rec);
  rec.id = id; S.photos.push(rec);

  toast(old.length ? `已取代 第${boxIdx}箱` : `已拍 ${order.name} 第${boxIdx}箱`, 1200);

  // 還有沒拍的箱 → 自動前進，維持連拍節奏
  const shot = shotBoxes(order.key);
  const next = order.boxes.find(b => !shot.has(b.idx));
  if (next) { S.cam.boxIdx = next.idx; paintCamTarget(); }
  else closeCamera();
}

function toBlob(canvas, q) {
  return new Promise(res => canvas.toBlob(res, 'image/jpeg', q));
}

/* ── 疊字 ──────────────────────────────────────────────── */
function overlayLines(o, boxIdx) {
  const box = o.boxes.find(b => b.idx === boxIdx) || o.boxes[0];
  const lines = [o.name];
  lines.push(o.boxCount > 1 ? `${o.shipShort} 第${boxIdx}箱/共${o.boxCount}箱` : o.shipShort);
  if (box && box.items) lines.push(box.items);
  return lines;
}

function drawOverlay(ctx, w, h, lines) {
  const font = Math.round(w * 0.055);
  const pad  = font * 0.5;
  const lh   = font * 1.28;
  const r    = font * 0.18;
  const face = `700 ${font}px "Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif`;
  ctx.font = face;

  // 過寬的品項行以「、」為界換行
  const maxW = w * 0.9 - pad * 2;
  const out = [];
  lines.forEach(line => {
    if (ctx.measureText(line).width <= maxW) { out.push(line); return; }
    let cur = '';
    line.split('、').forEach(seg => {
      const t = cur ? cur + '、' + seg : seg;
      if (ctx.measureText(t).width > maxW && cur) { out.push(cur + '、'); cur = seg; }
      else cur = t;
    });
    if (cur) out.push(cur);
  });

  const bw = Math.min(w * 0.94, Math.max(...out.map(t => ctx.measureText(t).width)) + pad * 2);
  const bh = lh * out.length + pad * 1.2;
  const x  = (w - bw) / 2;
  const y  = h * 0.04;

  ctx.fillStyle = '#FFFFFF';
  roundRect(ctx, x, y, bw, bh, r);
  ctx.fill();

  ctx.fillStyle = '#111111';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = face;
  out.forEach((t, i) => ctx.fillText(t, w / 2, y + pad * 0.6 + lh * (i + 0.5)));
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

function roundRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ── 通知畫面 ──────────────────────────────────────────── */
function updateBadge() {
  const n = pendingNotify().length;
  const b = $('#badgeNotify');
  b.textContent = n; b.classList.toggle('hide', !n);
}
function pendingNotify() {
  const keys = [...new Set(S.photos.map(p => p.orderKey))];
  return keys.filter(k => !S.sent[k]);
}

function renderNotify() {
  const body = $('#notifyBody');
  if (!body) return;
  renderStamp();
  body.innerHTML = '';

  const bar = el('div', 'bar');
  const f = el('button', 'btn sm ghost', '重新抓取文案');
  f.onclick = () => fetchOrders(false);
  bar.append(f);
  body.append(bar);

  body.append(el('div', 'notice calm',
    '按「傳送」會把文案複製到剪貼簿，並開啟分享選單帶著照片。到 LINE 選好聊天室送出照片後，長按輸入框貼上文案。'));

  const keys = [...new Set(S.photos.map(p => p.orderKey))];
  if (!keys.length) { body.append(el('div', 'empty', '還沒有拍過的照片。')); return; }

  const waiting = keys.filter(k => !S.sent[k]);
  const done    = keys.filter(k => S.sent[k]);

  if (waiting.length) body.append(el('div', 'secTitle', `待發送 ${waiting.length}`));
  waiting.forEach(k => body.append(notifyRow(k)));
  if (done.length) body.append(el('div', 'secTitle', `已發送 ${done.length}`));
  done.forEach(k => body.append(notifyRow(k)));
}

function notifyRow(key) {
  const ps = photosOf(key);
  const o  = S.orders.find(x => x.key === key);
  const sent = !!S.sent[key];
  const row = el('div', 'row' + (sent ? ' sent' : ''));

  const img = el('img');
  img.src = URL.createObjectURL(ps[0].stamped);
  img.alt = '';
  row.append(img);

  const main = el('div', 'rowMain');
  main.append(el('div', 'nm', o ? o.name : ps[0].name));
  if (!o) {
    main.append(el('div', 'rowMeta warn', '這筆訂單已不在清單中，請重新抓取'));
  } else if (o.messageMissing) {
    main.append(el('div', 'rowMeta warn', '⚠️ 試算表沒有文案，請檢查「出貨通知」分頁'));
  } else {
    main.append(el('div', 'rowMeta', `${ps.length} 張 · ${o.boxCount} 箱 · ${o.points} 點`));
    if (o.points > 0 && /需人工發放/.test(o.message)) {
      main.append(el('div', 'rowMeta warn', '⚠️ 集點需人工發放'));
    }
  }
  row.append(main);

  const acts = el('div', 'rowActs');
  const send = el('button', 'btn sm', sent ? '再傳一次' : '傳送');
  send.onclick = () => shareOrder(key);
  acts.append(send);

  const mark = el('button', 'btn sm ghost', sent ? '取消標記' : '已傳送');
  mark.onclick = async () => {
    if (S.sent[key]) delete S.sent[key]; else S.sent[key] = new Date().toISOString();
    await kvSet('sent', S.sent);
    renderNotify(); updateBadge();
  };
  acts.append(mark);
  row.append(acts);
  return row;
}

async function shareOrder(key) {
  const o = S.orders.find(x => x.key === key);
  const ps = photosOf(key);
  if (!o) { toast('找不到訂單資料，請先重新抓取'); return; }
  if (o.messageMissing) { toast('這筆沒有文案，請先修好試算表再重抓', 3000); return; }

  try { await navigator.clipboard.writeText(o.message); }
  catch (e) { toast('無法自動複製文案，請到試算表複製', 3000); }

  const files = ps.map(p => new File([p.stamped], p.filename, { type: 'image/jpeg' }));
  if (navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files });
      if (!S.sent[key]) { S.sent[key] = new Date().toISOString(); await kvSet('sent', S.sent); }
      renderNotify(); updateBadge();
    } catch (e) { /* 使用者取消 */ }
  } else {
    toast('這台裝置不支援分享照片，請用設定頁匯出 ZIP', 3400);
  }
}

/* ── 設定畫面 ──────────────────────────────────────────── */
function renderSetup() {
  const body = $('#setupBody');
  if (!body) return;
  body.innerHTML = '';

  body.append(el('div', 'secTitle', '連線'));
  const u = el('input', 'field'); u.placeholder = 'GAS 網頁應用程式網址'; u.value = cfg.url;
  const t = el('input', 'field'); t.placeholder = 'SHIP_TOKEN'; t.value = cfg.token; t.type = 'password';
  body.append(u, t);

  const save = el('button', 'btn wide', '儲存並測試連線');
  save.onclick = async () => {
    cfg.url = u.value; cfg.token = t.value;
    const ok = await fetchOrders(false);
    if (ok) go('s-shoot');
  };
  body.append(save);
  body.append(el('div', 'notice calm', '憑證只存在這支手機，不會進入 GitHub。'));

  body.append(el('div', 'secTitle', '照片'));
  const ux = unexported().length;
  const stat = el('div', 'tally');
  stat.innerHTML = `<span>總計 <b class="num">${S.photos.length}</b> 張</span>
    <span>未匯出 <b class="num">${ux}</b> 張</span>`;
  body.append(stat);

  const e1 = el('button', 'btn wide', '匯出存證版 ZIP（原始未疊字）');
  e1.style.marginBottom = '10px';
  e1.onclick = () => exportZip('raw');
  const e2 = el('button', 'btn ghost wide', '匯出疊字版 ZIP');
  e2.style.marginBottom = '10px';
  e2.onclick = () => exportZip('stamped');
  body.append(e1, e2);

  body.append(el('div', 'notice',
    'iOS 在儲存空間吃緊時會清掉網站資料。存證版請當天匯出到「檔案」或雲端，不要累積一整季在 App 裡。'));

  const clear = el('button', 'btn ghost wide', '清除已匯出的照片');
  clear.onclick = async () => {
    const gone = S.photos.filter(p => p.exported);
    if (!gone.length) { toast('沒有已匯出的照片'); return; }
    if (!confirm(`要刪除 ${gone.length} 張已匯出的照片嗎？此動作無法復原。`)) return;
    for (const p of gone) await dbDelPhoto(p.id);
    S.photos = S.photos.filter(p => !p.exported);
    renderSetup(); renderShoot(); renderNotify(); updateBadge();
    toast('已清除');
  };
  body.append(clear);

  body.append(el('div', 'secTitle', '這批'));
  const reset = el('button', 'btn ghost wide', '結束這批（清空臨時加入與發送標記）');
  reset.onclick = async () => {
    if (!confirm('要清空「臨時加入」與「已發送」標記嗎？照片不會被刪除。')) return;
    S.extra = {}; S.sent = {};
    await kvSet('extra', S.extra); await kvSet('sent', S.sent);
    renderShoot(); renderNotify(); updateBadge();
    toast('已重設');
  };
  body.append(reset);

  body.append(el('div', 'secTitle', '版本'));
  body.append(el('div', 'notice calm', `${VERSION}　更新後需完全關閉 App 再開啟才會生效。`));
}

/* ── 匯出 ──────────────────────────────────────────────── */
function loadJSZip() {
  if (window.JSZip) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = JSZIP_URL; s.onload = res; s.onerror = () => rej(new Error('載入壓縮元件失敗'));
    document.head.append(s);
  });
}

async function exportZip(kind) {
  if (!S.photos.length) { toast('沒有照片可匯出'); return; }
  toast('打包中…', 20000);
  try { await loadJSZip(); }
  catch (e) { toast('載入壓縮元件失敗，請連上網路後再試', 3400); return; }

  const zip = new JSZip();
  for (const p of S.photos) {
    zip.file(kind === 'raw' ? p.filenameRaw : p.filename, kind === 'raw' ? p.raw : p.stamped);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  const d = new Date(), pz = n => ('0' + n).slice(-2);
  const fname = `波波酪梨_${kind === 'raw' ? '存證版' : '疊字版'}_${d.getFullYear()}${pz(d.getMonth() + 1)}${pz(d.getDate())}.zip`;

  const file = new File([blob], fname, { type: 'application/zip' });
  let shared = false;
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); shared = true; } catch (e) { /* 取消 */ }
  }
  if (!shared) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = fname;
    document.body.append(a); a.click(); a.remove();
    shared = true;
  }

  if (kind === 'raw' && shared) {
    for (const p of S.photos) {
      if (p.exported) continue;
      p.exported = 1; await dbPutPhoto(p);
    }
    renderSetup(); renderShoot();
  }
  toast('已匯出');
}
