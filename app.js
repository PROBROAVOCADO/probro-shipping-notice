/* 波波酪梨 · 出貨通知系統  app.js  v1.1.0 */
'use strict';

const VERSION = 'v1.4.1';
const JSZIP_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
const FONT_RATIO = 0.042;   // 疊字字級 ÷ 圖寬
const MAX_EDGE   = 2200;    // 長邊上限，避免原生相機的 12MP 原圖塞爆 IndexedDB
const OV_MIN = 0.022, OV_MAX = 0.085;   // 字級比例上下限

/* 疊字位置／字級：拖曳調整後記住，成為後續照片的預設 */
const ov = {
  get cx()  { return parseFloat(localStorage.getItem('ovCX')) || 0.5; },
  get y()   { const v = parseFloat(localStorage.getItem('ovY')); return isNaN(v) ? 0.035 : v; },
  get r()   { return parseFloat(localStorage.getItem('ovR')) || FONT_RATIO; },
  save(cx, y, r) {
    localStorage.setItem('ovCX', cx); localStorage.setItem('ovY', y); localStorage.setItem('ovR', r);
  },
  reset() { ['ovCX', 'ovY', 'ovR'].forEach(k => localStorage.removeItem(k)); }
};

/* ── 設定 ──────────────────────────────────────────────── */
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
    // v1.3.1 起資料庫更名為 probro-ship。舊的 bobo-ship 不會被讀取，
    // 升級前請先把 App 內的照片存到相簿。
    const r = indexedDB.open('probro-ship', 1);
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
  orders: [], fetchedAt: null, photos: [],
  sent: {}, extra: {}, batch: {}, showPending: false, q: '', cam: null
};

/* ── 小工具 ────────────────────────────────────────────── */
const $  = s => document.querySelector(s);
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const CIRCLE = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫';

let toastTimer;
function toast(msg, ms = 1900) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('on', !!msg);
  if (!msg) return;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso), p = n => ('0' + n).slice(-2);
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const safeName = s => String(s || '').replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 20) || '無名';
const boxLabel = b => `${CIRCLE[b.idx - 1] || b.idx} ${b.weight ? b.weight + '斤｜' : ''}${b.items}`;

/* ── 導覽 ──────────────────────────────────────────────── */
document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));
function go(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('hide', s.id !== id));
  document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-current', b.dataset.go === id ? 'true' : 'false'));
  if (id === 's-notify') renderNotify();
  if (id === 's-setup') renderSetup();
}

/* ── 啟動 ──────────────────────────────────────────────── */
(async function boot() {
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch (e) { /* 略 */ }
  }
  S.photos = await dbAllPhotos();
  S.sent   = (await kvGet('sent'))  || {};
  S.extra  = (await kvGet('extra')) || {};
  S.batch  = (await kvGet('batch')) || {};
  const cache = await kvGet('orders');
  if (cache) { S.orders = cache.orders; S.fetchedAt = cache.fetchedAt; }

  renderShoot(); renderSetup(); updateBadge();

  if (!cfg.ok) { go('s-setup'); toast('請先填入連線設定'); return; }
  if (navigator.onLine) fetchOrders(true);
})();

/* ── 取得訂單 ──────────────────────────────────────────── */
async function fetchOrders(silent) {
  if (!cfg.ok) { toast('尚未設定連線'); go('s-setup'); return false; }
  if (!silent) toast('讀取中…', 8000);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 45000);   // GAS 冷啟動可能很慢
  try {
    const u = `${cfg.url}?action=list&token=${encodeURIComponent(cfg.token)}&t=${Date.now()}`;
    const r = await fetch(u, { signal: ctl.signal, redirect: 'follow' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '後端回報失敗');

    S.orders = j.orders; S.fetchedAt = j.fetchedAt;
    await kvSet('orders', { orders: j.orders, fetchedAt: j.fetchedAt });
    renderShoot(); renderNotify(); updateBadge();
    toast(`已更新 ${j.orders.length} 筆`);
    return true;
  } catch (e) {
    const msg = e.name === 'AbortError' ? '連線逾時（GAS 可能在冷啟動，再按一次通常就好）' : (e.message || '連線失敗');
    toast(S.orders.length ? `${msg}，沿用 ${fmtTime(S.fetchedAt)} 的資料` : `${msg}，且本機沒有可用資料`, 3400);
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
const photosOf  = key => S.photos.filter(p => p.orderKey === key).sort((a, b) => a.boxIdx - b.boxIdx);
const shotBoxes = key => new Set(photosOf(key).map(p => p.boxIdx));
const unsaved   = () => S.photos.filter(p => !p.saved);
const activeOrders = () => S.orders.filter(o => o.status === '出貨準備' || S.extra[o.key]);

/* ── 出貨畫面 ──────────────────────────────────────────── */
function renderShoot() {
  renderStamp();
  const body = $('#shootBody');
  body.innerHTML = '';

  const bar = el('div', 'bar');
  const search = el('input', 'field');
  search.placeholder = '搜尋姓名'; search.value = S.q; search.style.margin = '0';
  search.oninput = e => { S.q = e.target.value.trim(); renderList(); };
  const btnFetch = el('button', 'btn sm ghost', '重新抓取');
  btnFetch.onclick = () => fetchOrders(false);
  bar.append(search, btnFetch);
  body.append(bar);

  const us = unsaved().length;
  if (us) {
    const n = el('div', 'notice', `有 ${us} 張照片還沒存到相簿。照片只在 App 裡，iOS 可能會清掉。`);
    const b = el('button', 'btn sm wide', '存到相簿');
    b.style.marginTop = '10px';
    b.onclick = () => saveToPhotos();
    n.append(b);
    body.append(n);
  }

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

  if (act.length) {
    const miss = act.filter(o => shotBoxes(o.key).size < o.boxCount);
    const wrap = el('div'); wrap.style.marginTop = '16px';
    wrap.append(miss.length
      ? el('div', 'notice', `還有 ${miss.length} 筆沒拍完：` +
          miss.map(o => `${o.name}（${shotBoxes(o.key).size}/${o.boxCount}）`).join('、'))
      : el('div', 'notice calm', '這批都拍完了。記得回試算表把 R 欄改成「已出貨」。'));
    holder.append(wrap);
  }

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
  for (let i = 1; i <= o.boxCount; i++) dots.append(el('span', 'dot' + (shot.has(i) ? ' on' : '')));
  dots.append(el('span', 'num', `${shot.size}/${o.boxCount} 箱`));
  b.append(dots);

  if (o.hasBoxDetail === false) {
    b.append(el('div', 'items warn', '⚠️ 這筆沒有裝箱明細，箱數與斤數是推估的，請先補 Q 欄'));
  }
  b.append(el('div', 'items', o.boxes.map(boxLabel).join('\n')));

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

/* ── 相機：改用 iOS 原生相機介面 ──────────────────────────
 * getUserMedia 在 iOS Safari 上沒有點擊對焦與曝光控制的 API，
 * 拍出來的模糊照片會讓舉證失效。改走 <input capture>，
 * 代價是每張多一次「使用照片」確認，換回對焦／亮度／完整解析度。
 */
let fileInput = null;

function ensureInput() {
  if (fileInput) return fileInput;
  fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.setAttribute('capture', 'environment');
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', onPicked);
  document.body.append(fileInput);
  return fileInput;
}

function startCamera(order, boxIdx) {
  S.cam = { order, boxIdx };
  const i = ensureInput();
  i.value = '';          // 允許連續拍同一箱（重拍）
  i.click();
}

async function onPicked(e) {
  const file = e.target.files && e.target.files[0];
  if (!file || !S.cam) return;
  const { order, boxIdx } = S.cam;
  const info = `${file.type || '未知格式'} ${(file.size / 1048576).toFixed(1)}MB`;
  toast('處理中…', 30000);

  try {
    const src = await withTimeout(decodeImage(file), 25000, '解碼');
    const sw = src.width || src.naturalWidth;
    const sh = src.height || src.naturalHeight;
    if (!sw || !sh) throw new Error('尺寸為 0');

    const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
    const w = Math.round(sw * scale), h = Math.round(sh * scale);

    // 底圖（無疊字）留在記憶體，供這次預覽拖曳時重繪用，不寫進資料庫
    const base = document.createElement('canvas');
    base.width = w; base.height = h;
    base.getContext('2d').drawImage(src, 0, 0, w, h);
    if (src.close) src.close();          // 釋放 ImageBitmap 記憶體

    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.drawImage(base, 0, 0);
    drawOverlay(ctx, w, h, overlayLines(order, boxIdx));
    const stamped = await withTimeout(encodeJpeg(cv, 0.92), 25000, '編碼');

    const old = S.photos.filter(p => p.orderKey === order.key && p.boxIdx === boxIdx);
    for (const p of old) await dbDelPhoto(p.id);
    S.photos = S.photos.filter(p => !(p.orderKey === order.key && p.boxIdx === boxIdx));

    const fname = safeName(order.name) + '_' + order.phone3 + '_' + order.orderDate + '_' + order.key4
               + (order.boxCount > 1 ? `_${boxIdx}of${order.boxCount}` : '');
    const rec = {
      orderKey: order.key, boxIdx, boxCount: order.boxCount, name: order.name,
      ts: new Date().toISOString(), filename: fname + '.jpg', stamped, saved: 0
    };
    rec.id = await dbPutPhoto(rec);
    S.photos.push(rec);

    // 記進本批名單：拍到就是出了，之後刪照片也不影響回寫
    if (!S.batch[order.key]) { S.batch[order.key] = new Date().toISOString(); await kvSet('batch', S.batch); }

    toast('');
    showReview(order, boxIdx, rec, base);

  } catch (err) {
    // 失敗必須可見：講出卡在哪一步、檔案是什麼
    toast(`照片處理失敗（${err.message}）\n${info}\n可到 設定→相機→格式 改成「相容性最佳」`, 7000);
    renderShoot();
  }
}

/** 逾時保護：解碼失敗時 Image 的 onload/onerror 都可能不觸發，會永遠卡住 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label + '逾時')), ms))
  ]);
}

/** 先用 createImageBitmap（省記憶體、可處理 HEIC），失敗再退回 Image */
async function decodeImage(file) {
  if (window.createImageBitmap) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (e1) {
      try { return await createImageBitmap(file); } catch (e2) { /* 落到下面 */ }
    }
  }
  return await new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload  = () => { URL.revokeObjectURL(url); res(im); };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('無法解碼')); };
    im.src = url;
  });
}

/** toBlob 在部分 iOS 版本上不觸發回呼，退回 toDataURL */
function encodeJpeg(canvas, q) {
  return new Promise((res, rej) => {
    let settled = false;
    try {
      canvas.toBlob(b => {
        if (settled) return;
        settled = true;
        b ? res(b) : rej(new Error('編碼結果為空'));
      }, 'image/jpeg', q);
    } catch (e) { /* 落到下面 */ }

    setTimeout(async () => {
      if (settled) return;
      settled = true;
      try {
        const url = canvas.toDataURL('image/jpeg', q);
        res(await (await fetch(url)).blob());
      } catch (e) { rej(new Error('編碼失敗')); }
    }, 4000);
  });
}

/* 拍完即看：確認對焦與疊字。疊字可拖曳移動、雙指縮放，位置會被記住 */
async function showReview(order, boxIdx, rec, base) {
  document.querySelectorAll('.sheet').forEach(n => n.remove());

  const lines = overlayLines(order, boxIdx);
  const pos = { cx: ov.cx, y: ov.y, r: ov.r };

  const wrap = el('div', 'sheet');
  const body = el('div', 'sheetBody');

  const head = el('div', 'reviewHead');
  head.append(el('span', 'nm', order.name));
  const shot = shotBoxes(order.key);
  head.append(el('span', 'meta', order.boxCount > 1
    ? `第 ${boxIdx} 箱／共 ${order.boxCount} 箱　已拍 ${shot.size}/${order.boxCount}`
    : '共 1 箱'));
  body.append(head);

  const stage = el('div', 'stage');
  const img = el('img', 'reviewImg');
  img.alt = '';
  const ovBox = el('div', 'ovBox');
  stage.append(img, ovBox);
  body.append(stage);

  body.append(el('p', 'hintLine', '拖曳疊字可移動，雙指縮放可改大小（電腦上用滑鼠拖曳、滾輪縮放）。調整後會記住，套用到後面的照片。'));

  const tools = el('div', 'bar');
  const reset = el('button', 'btn xs ghost', '回到預設位置');
  reset.onclick = () => { ov.reset(); pos.cx = ov.cx; pos.y = ov.y; pos.r = ov.r; paint(); rerender(); };
  tools.append(reset);
  body.append(tools);

  const again = el('button', 'btn ghost wide', '重拍這箱');
  again.style.marginBottom = '9px';
  again.onclick = () => { wrap.remove(); startCamera(order, boxIdx); };
  body.append(again);

  const next = order.boxes.find(b => !shot.has(b.idx));
  if (next) {
    const go = el('button', 'btn wide', `拍第 ${next.idx} 箱`);
    go.style.marginBottom = '9px';
    go.onclick = () => { wrap.remove(); renderShoot(); startCamera(order, next.idx); };
    body.append(go);
  }

  const done = el('button', next ? 'btn ghost wide' : 'btn wide', next ? '先回清單' : '完成');
  done.onclick = () => { wrap.remove(); renderShoot(); updateBadge(); };
  body.append(done);

  wrap.append(body);
  document.body.append(wrap);          // ← 先進畫面，之後量到的寬度才不是 0

  // 預覽底圖（無疊字）。用 blob URL 而非 dataURL，省記憶體也快得多。
  try {
    const previewBlob = await encodeJpeg(base, 0.7);
    img.src = URL.createObjectURL(previewBlob);
  } catch (e) { img.src = base.toDataURL('image/jpeg', 0.7); }

  /* 量得到寬度才畫，量不到就下一影格再試，最多兩秒 */
  let tries = 0;
  function paint() {
    const iw = img.clientWidth, ih = img.clientHeight;
    if (!iw || !ih) {
      if (tries++ < 120) requestAnimationFrame(paint);
      else toast('預覽載入異常，照片已存檔，可先繼續', 3000);
      return;
    }
    const probe = document.createElement('canvas').getContext('2d');
    const m = overlayMetrics(probe, iw, lines, pos.r);
    ovBox.innerHTML = '';
    ovBox.style.font = ovFace(m.font);
    ovBox.style.lineHeight = m.lh + 'px';
    ovBox.style.padding = `${m.pad * 0.55}px ${m.pad}px`;
    ovBox.style.borderRadius = m.r + 'px';
    m.out.forEach(t => ovBox.append(el('div', 'ovLine', t)));
    ovBox.style.left = Math.max(0, Math.min(iw - m.bw, pos.cx * iw - m.bw / 2)) + 'px';
    ovBox.style.top  = Math.max(0, Math.min(ih - m.bh, pos.y * ih)) + 'px';
  }
  img.addEventListener('load', () => { tries = 0; paint(); });
  paint();

  /* 手勢：用 Pointer Events，滑鼠與觸控同一套 */
  const pts = new Map();
  let startCX = 0, startY0 = 0, startR = 0, startDist = 0, startX = 0, startY = 0;
  const gap = () => {
    const a = [...pts.values()];
    return Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
  };

  stage.addEventListener('pointerdown', e => {
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      startX = e.clientX; startY = e.clientY; startCX = pos.cx; startY0 = pos.y;
    } else if (pts.size === 2) {
      startDist = gap(); startR = pos.r;
    }
    e.preventDefault();
  });

  stage.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const iw = img.clientWidth, ih = img.clientHeight;
    if (pts.size === 1) {
      pos.cx = Math.max(0, Math.min(1, startCX + (e.clientX - startX) / iw));
      pos.y  = Math.max(0, Math.min(1, startY0 + (e.clientY - startY) / ih));
    } else if (pts.size === 2 && startDist) {
      pos.r = Math.max(OV_MIN, Math.min(OV_MAX, startR * (gap() / startDist)));
    }
    paint();
    e.preventDefault();
  });

  function endPointer(e) {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size === 0) { ov.save(pos.cx, pos.y, pos.r); rerender(); }
  }
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  // 電腦測試用：滾輪縮放
  stage.addEventListener('wheel', e => {
    pos.r = Math.max(OV_MIN, Math.min(OV_MAX, pos.r * (e.deltaY > 0 ? 0.94 : 1.06)));
    paint();
    clearTimeout(stage._wt);
    stage._wt = setTimeout(() => { ov.save(pos.cx, pos.y, pos.r); rerender(); }, 400);
    e.preventDefault();
  }, { passive: false });

  /* 手勢結束後才重繪高解析度版本並覆蓋資料庫 */
  let busy = false, again2 = false;
  async function rerender() {
    if (busy) { again2 = true; return; }
    busy = true;
    try {
      const cv = document.createElement('canvas');
      cv.width = base.width; cv.height = base.height;
      const ctx = cv.getContext('2d');
      ctx.drawImage(base, 0, 0);
      drawOverlay(ctx, cv.width, cv.height, lines, pos);
      rec.stamped = await withTimeout(encodeJpeg(cv, 0.92), 25000, '編碼');
      rec.saved = 0;                    // 內容變了，要重新存相簿
      await dbPutPhoto(rec);
      const i = S.photos.findIndex(p => p.id === rec.id);
      if (i >= 0) S.photos[i] = rec;
    } catch (e) {
      toast('重繪失敗：' + e.message, 3000);
    } finally {
      busy = false;
      if (again2) { again2 = false; rerender(); }
    }
  }
}

const toBlob = (canvas, q) => new Promise(res => canvas.toBlob(res, 'image/jpeg', q));

/* ── 疊字 ──────────────────────────────────────────────── */
function overlayLines(o, boxIdx) {
  const box = o.boxes.find(b => b.idx === boxIdx) || o.boxes[0];
  const lines = [o.name];
  if (box) lines.push(`${box.weight ? box.weight + '斤｜' : ''}${box.items}`);
  if (o.boxCount > 1) lines.push(`第${boxIdx}箱／共${o.boxCount}箱`);
  return lines;
}

/** 依字寬把過長的行以「、」為界拆開，Canvas 與預覽共用同一份結果 */
function wrapLines(ctx, lines, maxW) {
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
  return out;
}

const ovFace = px => `700 ${px}px "Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif`;

/** 回傳疊字方塊的實際尺寸與換行結果（預覽與繪製共用） */
function overlayMetrics(ctx, w, lines, ratio) {
  const font = Math.max(10, Math.round(w * ratio));
  const pad = font * 0.62, lh = font * 1.34, r = font * 0.28;
  ctx.font = ovFace(font);
  const out = wrapLines(ctx, lines, w * 0.9 - pad * 2);
  const bw = Math.min(w * 0.94, Math.max(...out.map(t => ctx.measureText(t).width)) + pad * 2);
  const bh = lh * out.length + pad * 1.1;
  return { font, pad, lh, r, out, bw, bh };
}

function drawOverlay(ctx, w, h, lines, pos) {
  const p = pos || { cx: ov.cx, y: ov.y, r: ov.r };
  const m = overlayMetrics(ctx, w, lines, p.r);

  const x = Math.max(0, Math.min(w - m.bw, p.cx * w - m.bw / 2));
  const y = Math.max(0, Math.min(h - m.bh, p.y * h));

  ctx.fillStyle = '#FFFFFF';
  roundRect(ctx, x, y, m.bw, m.bh, m.r);
  ctx.fill();

  ctx.fillStyle = '#1A1A1A';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = ovFace(m.font);
  m.out.forEach((t, i) => ctx.fillText(t, x + m.bw / 2, y + m.pad * 0.55 + m.lh * (i + 0.5)));
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

/* ── 存到相簿 ──────────────────────────────────────────── */
async function saveToPhotos(keyOrNull) {
  const list = keyOrNull ? photosOf(keyOrNull) : unsaved();
  if (!list.length) { toast('沒有待存的照片'); return; }

  const files = list.map(p => new File([p.stamped], p.filename, { type: 'image/jpeg' }));
  if (!(navigator.canShare && navigator.canShare({ files }))) {
    toast('這台裝置不支援存到相簿，請改用匯出 ZIP', 3400); return;
  }
  try {
    await navigator.share({ files });
  } catch (e) {
    return;   // 使用者取消
  }
  for (const p of list) { if (!p.saved) { p.saved = 1; await dbPutPhoto(p); } }
  renderShoot(); renderSetup();
  toast(`${list.length} 張已送出，記得選「儲存影像」`, 2600);
}

/* ── 通知畫面 ──────────────────────────────────────────── */
function updateBadge() {
  const n = pendingNotify().length;
  const b = $('#badgeNotify');
  b.textContent = n; b.classList.toggle('hide', !n);
}
const pendingNotify = () => [...new Set(S.photos.map(p => p.orderKey))].filter(k => !S.sent[k]);

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
    '「複製文案」把這筆文案放進剪貼簿，到 LINE 官方帳號長按輸入框貼上。「存相簿」把這筆照片送進相簿，再從聊天室的相簿鍵挑最新那幾張。'));

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
  img.src = URL.createObjectURL(ps[0].stamped); img.alt = '';
  img.onclick = () => saveToPhotos(key);
  row.append(img);

  const main = el('div', 'rowMain');
  main.append(el('div', 'nm', o ? o.name : ps[0].name));
  if (!o) main.append(el('div', 'rowMeta warn', '這筆訂單已不在清單中，請重新抓取'));
  else if (o.messageMissing) main.append(el('div', 'rowMeta warn', '⚠️ 試算表沒有文案，請檢查「出貨通知」分頁'));
  else {
    main.append(el('div', 'rowMeta', `${ps.length} 張 · ${o.boxCount} 箱 · ${o.points} 點`));
    if (/需人工發放/.test(o.message)) main.append(el('div', 'rowMeta warn', '⚠️ 集點需人工發放'));
  }
  row.append(main);

  const acts = el('div', 'rowActs');

  const copy = el('button', 'btn xs', '複製文案');
  copy.onclick = () => copyMessage(key);
  acts.append(copy);

  const pic = el('button', 'btn xs ghost', ps.every(p => p.saved) ? '照片 ✓' : '存相簿');
  pic.onclick = () => saveToPhotos(key);
  acts.append(pic);

  const mark = el('button', 'btn xs ghost', sent ? '取消標記' : '已傳送');
  mark.onclick = async () => {
    if (S.sent[key]) delete S.sent[key]; else S.sent[key] = new Date().toISOString();
    await kvSet('sent', S.sent);
    renderNotify(); updateBadge();
  };
  acts.append(mark);

  row.append(acts);
  return row;
}

/** 只複製文案，不動照片。複製成功即視為已處理，讓清單自我收斂。 */
async function copyMessage(key) {
  const o = S.orders.find(x => x.key === key);
  if (!o) { toast('找不到訂單資料，請先重新抓取'); return; }
  if (o.messageMissing) { toast('這筆沒有文案，請先修好試算表再重抓', 3000); return; }

  try {
    await navigator.clipboard.writeText(o.message);
  } catch (e) {
    // 少數情況剪貼簿 API 不可用 → 退回可手動選取的方式
    const ta = document.createElement('textarea');
    ta.value = o.message;
    ta.style.cssText = 'position:fixed;top:50%;left:5%;width:90%;height:40%;z-index:99;font-size:15px';
    document.body.append(ta); ta.select();
    try { document.execCommand('copy'); } catch (e2) {}
    setTimeout(() => ta.remove(), 60);
  }
  if (!S.sent[key]) { S.sent[key] = new Date().toISOString(); await kvSet('sent', S.sent); }
  renderNotify(); updateBadge();
  toast(`已複製 ${o.name} 的文案`);
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
    } catch (e) { /* 取消 */ }
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
  body.append(u);

  const tWrap = el('div', 'fieldWrap');
  const t = el('input', 'field'); t.placeholder = 'SHIP_TOKEN'; t.value = cfg.token; t.type = 'password';
  t.autocapitalize = 'off'; t.autocorrect = 'off'; t.spellcheck = false;
  const eye = el('button', 'eye', '顯示');
  eye.onclick = () => {
    const shown = t.type === 'text';
    t.type = shown ? 'password' : 'text';
    eye.textContent = shown ? '顯示' : '隱藏';
  };
  tWrap.append(t, eye);
  body.append(tWrap);

  const hint = el('div', 'tally');
  hint.innerHTML = `<span>目前 token 長度 <b class="num">${cfg.token.length}</b> 字元</span>`;
  body.append(hint);

  const save = el('button', 'btn wide', '儲存並測試連線');
  save.onclick = async () => {
    cfg.url = u.value; cfg.token = t.value;
    if (await fetchOrders(false)) go('s-shoot');
  };
  body.append(save);
  body.append(el('div', 'notice calm', '憑證只存在這支手機，填一次就好，不會進入 GitHub。'));

  body.append(el('div', 'secTitle', '照片'));
  const stat = el('div', 'tally');
  stat.innerHTML = `<span>總計 <b class="num">${S.photos.length}</b> 張</span>
    <span>未存相簿 <b class="num">${unsaved().length}</b> 張</span>`;
  body.append(stat);

  const s1 = el('button', 'btn wide', '把未存的照片存到相簿');
  s1.style.marginBottom = '10px';
  s1.onclick = () => saveToPhotos();
  const s2 = el('button', 'btn ghost wide', '匯出全部照片 ZIP');
  s2.style.marginBottom = '10px';
  s2.onclick = () => exportZip();
  body.append(s1, s2);

  body.append(el('div', 'notice',
    'iOS 在儲存空間吃緊時會清掉網站資料。當天存到相簿，不要累積一整季在 App 裡。'));

  body.append(el('div', 'notice calm',
    '收工順序：① 通知全部發完 → ② 釋放空間 → ③ 結束這批 → ④ 回試算表把 R 欄改「已出貨」。\n下面兩顆都不會刪到 iOS 相簿裡的照片。'));

  const clear = el('button', 'btn ghost wide', '釋放空間（刪除 App 內的照片副本）');
  clear.onclick = async () => {
    const gone = S.photos.filter(p => p.saved);
    if (!gone.length) { toast('沒有已存到相簿的照片'); return; }
    if (!confirm(`要刪除 App 裡的 ${gone.length} 張照片嗎？\n\n相簿裡那份不受影響，這只是清掉 App 內的副本以釋放空間。\n\n請先確認通知都發完了，刪除後這些訂單會從通知頁消失。`)) return;
    for (const p of gone) await dbDelPhoto(p.id);
    S.photos = S.photos.filter(p => !p.saved);
    renderSetup(); renderShoot(); renderNotify(); updateBadge();
    toast('已清除');
  };
  body.append(clear);

  body.append(el('div', 'secTitle', '收工'));

  body.append(el('div', 'notice calm',
    '這一批都寄出、通知也發完之後按下面這顆。它會做兩件事：\n' +
    '① 把本批拍過照的訂單，在試算表 R 欄寫成「已出貨」\n' +
    '② 寫入成功後，清空「臨時加入」與「已傳送」標記，讓下一批從乾淨狀態開始\n\n' +
    '照片與相簿都不受影響。寫入失敗時標記不會被清掉，可以直接再按一次。'));

  const bk = Object.keys(S.batch);
  const bstat = el('div', 'tally');
  bstat.innerHTML = `<span>本批已拍 <b class="num">${bk.length}</b> 筆訂單</span>`;
  body.append(bstat);

  const reset = el('button', 'btn wide', '完成出貨作業');
  reset.onclick = () => finishBatch(reset);
  body.append(reset);

  body.append(el('div', 'secTitle', '版本'));
  body.append(el('div', 'notice calm', `${VERSION}　更新後需完全關閉 App 再開啟才會生效。`));
}

/* ── 結束這批：回寫試算表 → 成功才清標記 ───────────────── */
async function finishBatch(btn) {
  const keys = Object.keys(S.batch);
  if (!keys.length) { toast('本批沒有拍過任何訂單'); return; }
  if (!cfg.ok) { toast('尚未設定連線'); return; }

  const 未傳 = keys.filter(k => !S.sent[k]).length;
  const 警語 = 未傳 ? `\n\n注意：還有 ${未傳} 筆沒標記為已傳送，清掉後會失去發送進度。` : '';
  if (!confirm(`要把這 ${keys.length} 筆在試算表寫成「已出貨」，並清空臨時加入與已傳送標記嗎？${警語}`)) return;

  btn.disabled = true;
  const 原文 = btn.textContent;
  btn.textContent = '回寫中…';

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 45000);
  try {
    const r = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // 避開 CORS 預檢
      body: JSON.stringify({ action: 'complete', token: cfg.token, keys }),
      signal: ctl.signal,
      redirect: 'follow'
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '後端回報失敗');

    // 寫入成功才清標記
    S.extra = {}; S.sent = {}; S.batch = {};
    await kvSet('extra', S.extra);
    await kvSet('sent', S.sent);
    await kvSet('batch', S.batch);

    await fetchOrders(true);
    renderShoot(); renderNotify(); renderSetup(); updateBadge();

    let msg = `已寫入 ${j.updated} 筆`;
    if (j.already) msg += `，${j.already} 筆本來就是已出貨`;
    if (j.notFound) msg += `\n⚠️ 有 ${j.notFound} 筆在試算表找不到，請人工確認`;
    toast(msg, j.notFound ? 6000 : 2600);

  } catch (e) {
    const m = e.name === 'AbortError' ? '連線逾時' : (e.message || '連線失敗');
    toast(`回寫失敗（${m}）\n標記沒有被清掉，可以再按一次`, 5000);
  } finally {
    clearTimeout(timer);
    btn.disabled = false;
    btn.textContent = 原文;
  }
}

/* ── 匯出 ZIP（備援，主要靠存到相簿）─────────────────────── */
function loadJSZip() {
  if (window.JSZip) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = JSZIP_URL; s.onload = res; s.onerror = () => rej(new Error('x'));
    document.head.append(s);
  });
}

async function exportZip() {
  if (!S.photos.length) { toast('沒有照片可匯出'); return; }
  toast('打包中…', 20000);
  try { await loadJSZip(); }
  catch (e) { toast('載入壓縮元件失敗，請連上網路後再試', 3400); return; }

  const zip = new JSZip();
  for (const p of S.photos) zip.file(p.filename, p.stamped);
  const blob = await zip.generateAsync({ type: 'blob' });
  const d = new Date(), pz = n => ('0' + n).slice(-2);
  const fname = `波波酪梨_出貨照片_${d.getFullYear()}${pz(d.getMonth() + 1)}${pz(d.getDate())}.zip`;

  const file = new File([blob], fname, { type: 'application/zip' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); toast('已匯出'); return; } catch (e) { /* 取消後改用下載 */ }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = fname;
  document.body.append(a); a.click(); a.remove();
  toast('已匯出');
}
