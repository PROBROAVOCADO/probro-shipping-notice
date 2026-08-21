/* 波波酪梨 · 出貨通知系統  app.js  v1.1.0 */
'use strict';

const VERSION = 'v1.10.1';
const JSZIP_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
const FONT_RATIO = 0.042;   // 疊字字級 ÷ 圖寬
const MAX_EDGE   = 2200;
const CLIP_EDGE  = 1800;    // 複製到剪貼簿時的長邊上限（PNG 無壓縮，原尺寸太肥）    // 長邊上限，避免原生相機的 12MP 原圖塞爆 IndexedDB
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
  // 訂單系統（code.gs）的網址。只有工人模式切換會用到，沒填就隱藏該功能。
  get codeUrl() { return localStorage.getItem('codeUrl') || ''; },
  set codeUrl(v) { localStorage.setItem('codeUrl', v.trim()); },
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
  sent: {}, extra: {}, batch: {}, made: {}, worker: null,
  showPending: false, q: '', ship: '', cam: null
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

/**
 * 把一箱的品項換算成檔名用的斤兩縮寫。
 * 規則：只看等級不看品種，同級的斤數相加。A＝優級、B＝次級。
 *   當季【優】3斤×1、當季【次】5斤×1、平克【次】2斤×1 → A3B7
 */
function 規格縮寫_(items) {
  let A = 0, B = 0;
  const re = /【\s*(優|次)\s*】[^【]*?([\d.]+)\s*斤(?:\s*[×xX*]\s*(\d+))?/g;
  let m;
  while ((m = re.exec(String(items || '')))) {
    const 斤 = parseFloat(m[2]) || 0;
    const 件 = m[3] ? parseInt(m[3], 10) : 1;
    if (m[1] === '優') A += 斤 * 件; else B += 斤 * 件;
  }
  const 數 = n => String(Math.round(n * 10) / 10).replace(/\.0$/, '');
  return (A > 0 ? 'A' + 數(A) : '') + (B > 0 ? 'B' + 數(B) : '');
}

/** 出貨日期（拍照當天），檔名用 */
function 出貨日_(ts) {
  const d = ts ? new Date(ts) : new Date();
  const p = n => ('0' + n).slice(-2);
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/**
 * 匯出／分享前確保檔名不重複。
 * 新檔名規則不含識別碼，同一人同一天同規格是有可能撞名的
 * （例如同一位客人下了兩筆一模一樣的訂單）。撞到就加序號，
 * 不要讓其中一張在 ZIP 裡被靜默覆蓋掉。
 */
function 唯一檔名_(用過, name) {
  if (!用過[name]) { 用過[name] = 1; return name; }
  const i = name.lastIndexOf('.');
  const 主 = i > 0 ? name.slice(0, i) : name;
  const 副 = i > 0 ? name.slice(i) : '';
  let n = 2;
  while (用過[主 + '-' + n + 副]) n++;
  const 新 = 主 + '-' + n + 副;
  用過[新] = 1;
  return 新;
}
const boxLabel = b => `${CIRCLE[b.idx - 1] || b.idx} ${b.weight ? b.weight + '斤｜' : ''}${b.items}`;

/* ── 導覽 ──────────────────────────────────────────────── */
document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));
function go(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('hide', s.id !== id));
  document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-current', b.dataset.go === id ? 'true' : 'false'));
  if (id === 's-notify') renderNotify();
  if (id === 's-cvs') renderCvs();
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
  S.made   = (await kvGet('made'))  || {};
  const cache = await kvGet('orders');
  if (cache) { S.orders = cache.orders; S.fetchedAt = cache.fetchedAt; S.worker = cache.worker || null; }

  renderShoot(); renderSetup(); updateBadge(); updateCvsBadge();

  if (!cfg.ok) { go('s-setup'); toast('請先填入連線設定'); return; }
  if (navigator.onLine) fetchOrders(true);
})();

/* ── 取得訂單 ──────────────────────────────────────────── */
async function fetchOrders(silent) {
  if (!cfg.ok) { toast('尚未設定連線'); go('s-setup'); return false; }
  if (!silent) toast('讀取中…', 8000);

  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 45000);   // GAS 冷啟動可能很慢
  try {
    const u = `${cfg.url}?action=list&token=${encodeURIComponent(cfg.token)}&t=${Date.now()}`;
    const r = await fetch(u, { signal: ctl.signal, redirect: 'follow' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '後端回報失敗');

    S.orders = j.orders; S.fetchedAt = j.fetchedAt; S.worker = j.worker || null;
    await kvSet('orders', { orders: j.orders, fetchedAt: j.fetchedAt, worker: j.worker || null });
    renderShoot(); renderNotify(); renderCvs(); updateBadge(); updateCvsBadge();
    // 顯示往返總耗時與後端耗時，兩者差距就是 Google 那段的固定成本
    const 往返 = Date.now() - t0;
    // 講「出貨準備」幾筆才有意義；orders.length 含尚未出貨的，容易誤讀
    const 準備 = (j.counts && j.counts.ready !== undefined)
      ? j.counts.ready
      : j.orders.filter(o => o.status === '出貨準備').length;
    toast(`出貨準備 ${準備} 筆（讀取 ${j.orders.length} 筆／${(往返 / 1000).toFixed(1)} 秒）`);
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
  ['#stamp', '#stamp2', '#stamp3'].forEach(sel => {
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
  search.setAttribute('enterkeyhint', 'done');
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

  // 配送方式篩選器。只列出這批實際有的方式，沒有的不佔位。
  const 全部 = activeOrders().filter(match);
  const 分類 = [];
  全部.forEach(o => {
    const k = o.shipShort || '其他';
    const hit = 分類.find(x => x.key === k);
    if (hit) hit.n++; else 分類.push({ key: k, n: 1 });
  });
  if (S.ship && !分類.some(x => x.key === S.ship)) S.ship = '';   // 篩選對象消失就自動回全部

  if (分類.length > 1) {
    const chips = el('div', 'chips');
    const mk = (label, key, n) => {
      const b = el('button', 'chip' + (S.ship === key ? ' on' : ''));
      b.innerHTML = `${esc(label)}<span class="num">${n}</span>`;
      b.onclick = () => { S.ship = key; renderList(); };
      return b;
    };
    chips.append(mk('全部', '', 全部.length));
    分類.forEach(c => chips.append(mk(c.key, c.key, c.n)));
    holder.append(chips);
  }

  const act = S.ship ? 全部.filter(o => (o.shipShort || '其他') === S.ship) : 全部;

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

  if (全部.length) {
    const miss = 全部.filter(o => shotBoxes(o.key).size < o.boxCount);
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
        <span class="meta">${esc(o.shipShort)} · ${o.jin}斤 · ${o.boxCount}箱</span></div>` +
        (o.store ? `<div class="store">🏪 ${esc(o.store)}</div>` : '');
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

  if (o.store) b.append(el('div', 'store', '🏪 ' + o.store));

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

    // 檔名：出貨日期-姓名-斤兩縮寫[-第幾箱]
    const box0 = order.boxes.find(b => b.idx === boxIdx) || order.boxes[0];
    const 規格 = 規格縮寫_(box0 && box0.items) || (box0 && box0.weight ? box0.weight + '斤' : '');
    const fname = [出貨日_(), safeName(order.name), 規格].filter(Boolean).join('-')
               + (order.boxCount > 1 ? `-${boxIdx}of${order.boxCount}` : '');
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
  // 第一行帶配送方式：封箱後要分堆時，一眼就知道這箱走哪一家
  const lines = [o.shipShort ? `${o.name} · ${o.shipShort}` : o.name];
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

  const 用過 = {};
  const files = list.map(p => new File([p.stamped], 唯一檔名_(用過, p.filename), { type: 'image/jpeg' }));
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
    '流程：按「存相簿」→ 儲存影像 → 到 LINE 官方帳號用相簿鍵挑最新那幾張 → 回來按「複製文案」→ 長按輸入框貼上。\n「複製照片」把圖放進剪貼簿，但官方帳號的輸入框不接受貼上圖片，只有個人 LINE 用得到。'));

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

  // 訂單已被標成已出貨、或已從清單移除 → GAS 不再回傳它。
  // 這種孤兒照片沒有文案可用，只能存相簿或刪掉，否則會永遠卡在這裡。
  const 孤兒 = !o;
  if (孤兒) main.append(el('div', 'rowMeta warn', '訂單已完成或不在清單中'));
  else if (o.messageMissing) main.append(el('div', 'rowMeta warn', '⚠️ 試算表沒有文案，請檢查「出貨通知」分頁'));
  else {
    main.append(el('div', 'rowMeta', `${ps.length} 張 · ${o.boxCount} 箱`));
    if (/需人工發放/.test(o.message)) main.append(el('div', 'rowMeta warn', '⚠️ 集點需人工發放'));
  }
  row.append(main);

  const acts = el('div', 'rowActs');

  if (孤兒) {
    const pic = el('button', 'btn xs', ps.every(p => p.saved) ? '相簿 ✓' : '存相簿');
    pic.onclick = () => saveToPhotos(key);
    acts.append(pic);

    const cp = el('button', 'btn xs ghost', '複製照片');
    cp.onclick = () => copyPhoto(key, cp);
    acts.append(cp);

    const del = el('button', 'btn xs ghost', '刪除');
    del.style.color = 'var(--alert)';
    del.style.borderColor = '#EDCFC9';
    del.onclick = () => 刪除本筆照片(key, ps);
    acts.append(del);

    row.append(acts);
    return row;
  }

  // 上排＝實際會用到的兩條路，綠色主要按鈕
  const copy = el('button', 'btn xs', '複製文案');
  copy.onclick = () => copyMessage(key);
  acts.append(copy);

  const pic = el('button', 'btn xs', ps.every(p => p.saved) ? '相簿 ✓' : '存相簿');
  pic.onclick = () => saveToPhotos(key);
  acts.append(pic);

  // 下排＝次要。複製照片只有個人 LINE 吃得下，官方帳號的輸入框不接受貼上圖片
  const cpImg = el('button', 'btn xs ghost', '複製照片');
  cpImg.onclick = () => copyPhoto(key, cpImg);
  acts.append(cpImg);

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

/**
 * 複製照片到剪貼簿，貼進 LINE 輸入框用。
 *
 * 兩個平台限制：
 *   1. Safari 的剪貼簿只接受 image/png，所以要在複製當下把 JPEG 轉成 PNG
 *   2. 剪貼簿一次只裝得下一張 → 多箱訂單先讓使用者挑
 *
 * ⚠️ ClipboardItem 必須「同步建立」並傳入 Promise，不能先 await 再 write ——
 *    await 之後就脫離使用者手勢，Safari 會直接拒絕。
 */
async function copyPhoto(key, btn) {
  const ps = photosOf(key);
  if (!ps.length) { toast('這筆沒有照片'); return; }
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard || !navigator.clipboard.write) {
    toast('這台裝置不支援複製圖片，請改用「存相簿」', 3400);
    return;
  }
  if (ps.length === 1) return 寫入剪貼簿_(ps[0], btn);

  // 多箱 → 挑一張
  const wrap = el('div', 'sheet');
  const body = el('div', 'sheetBody');
  body.append(el('h2', '', '複製哪一箱的照片？'));
  body.append(el('p', '', '剪貼簿一次只能放一張，傳完再回來複製下一箱。'));
  ps.forEach(p => {
    const b = el('button', 'boxBtn');
    b.innerHTML = `<b>第 ${p.boxIdx} 箱／共 ${p.boxCount} 箱</b><span>${esc(p.filename)}</span>`;
    b.onclick = () => { wrap.remove(); 寫入剪貼簿_(p, btn); };
    body.append(b);
  });
  const c = el('button', 'btn ghost wide', '取消');
  c.onclick = () => wrap.remove();
  body.append(c);
  wrap.append(body);
  wrap.onclick = e => { if (e.target === wrap) wrap.remove(); };
  document.body.append(wrap);
}

function 寫入剪貼簿_(photo, btn) {
  const 原文 = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '轉檔中…'; }

  // 注意：這裡不能 await，要把 Promise 直接交給 ClipboardItem
  const png = 轉PNG_(photo.stamped);

  return navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    .then(() => toast('照片已複製，到 LINE 長按輸入框貼上', 2800))
    .catch(err => toast('複製圖片失敗：' + (err.message || '未知錯誤') + '\n可改用「存相簿」', 4000))
    .then(() => { if (btn) { btn.disabled = false; btn.textContent = 原文; } });
}

async function 轉PNG_(blob) {
  const src = await decodeImage(blob);
  const sw = src.width || src.naturalWidth, sh = src.height || src.naturalHeight;
  const scale = Math.min(1, CLIP_EDGE / Math.max(sw, sh));
  const cv = document.createElement('canvas');
  cv.width = Math.round(sw * scale);
  cv.height = Math.round(sh * scale);
  cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
  if (src.close) src.close();
  return new Promise((res, rej) => {
    cv.toBlob(b => b ? res(b) : rej(new Error('轉檔失敗')), 'image/png');
  });
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

/** 刪除某一筆的所有照片，連同標記一起清乾淨 */
async function 刪除本筆照片(key, ps) {
  const 未存 = ps.filter(p => !p.saved).length;
  const 警語 = 未存 ? `\n\n⚠️ 其中 ${未存} 張還沒存到相簿，刪掉就沒了。` : '';
  if (!confirm(`要刪除這筆的 ${ps.length} 張照片嗎？${警語}`)) return;

  for (const p of ps) await dbDelPhoto(p.id);
  S.photos = S.photos.filter(p => p.orderKey !== key);
  delete S.sent[key]; delete S.batch[key];
  await kvSet('sent', S.sent);
  await kvSet('batch', S.batch);

  renderNotify(); renderShoot(); renderSetup(); updateBadge();
  toast('已刪除');
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

/* ── 超取建單 ──────────────────────────────────────────
 * 跟拍照是完全不同的作業：坐著、在兩個 App 之間切換、
 * 一個客人要複製三次。所以獨立一頁，不塞進出貨清單。
 */
const cvsOrders = () => activeOrders().filter(o => o.shipShort === '7-11');

function updateCvsBadge() {
  const n = cvsOrders().filter(o => !S.made[o.key]).length;
  const b = $('#badgeCvs');
  if (!b) return;
  b.textContent = n; b.classList.toggle('hide', !n);
}

function renderCvs() {
  const body = $('#cvsBody');
  if (!body) return;
  renderStamp();
  body.innerHTML = '';

  const bar = el('div', 'bar');
  const f = el('button', 'btn sm ghost', '重新抓取');
  f.onclick = () => fetchOrders(false);
  bar.append(f);
  body.append(bar);

  const list = cvsOrders();
  if (!list.length) {
    body.append(el('div', 'empty', '這批沒有標記「出貨準備」的 7-11 訂單。'));
    return;
  }

  const 待辦 = list.filter(o => !S.made[o.key]);
  const 完成 = list.filter(o => S.made[o.key]);

  const tally = el('div', 'tally');
  tally.innerHTML = `<span>7-11 <b class="num">${list.length}</b> 筆</span>
    <span>已建單 <b class="num">${完成.length}/${list.length}</b></span>`;
  body.append(tally);

  body.append(el('div', 'notice calm',
    '點欄位右邊的「複製」把內容放進剪貼簿，切到 7-11 系統貼上。建完按「已建單」讓它下沉，清單會越來越短。'));

  待辦.forEach(o => body.append(cvsCard(o)));
  if (完成.length) {
    body.append(el('div', 'secTitle', `已建單 ${完成.length}`));
    完成.forEach(o => body.append(cvsCard(o)));
  }
}

function cvsCard(o) {
  const done = !!S.made[o.key];
  const card = el('div', 'cvsCard' + (done ? ' done' : ''));

  const head = el('div', 'cardHead');
  head.innerHTML = `<span class="nm">${esc(o.name)}</span>`;
  head.append(el('span', 'meta', `${o.jin}斤 · ${o.boxCount}箱`));
  card.append(head);

  const 欄位 = (標籤, 值) => {
    if (!值) return;
    const r = el('div', 'cvsRow');
    r.innerHTML = `<span class="cvsLabel">${esc(標籤)}</span><span class="cvsVal">${esc(值)}</span>`;
    const b = el('button', 'btn xs ghost', '複製');
    b.onclick = () => copyText(值, `已複製${標籤}`);
    r.append(b);
    card.append(r);
  };

  欄位('姓名', o.name);
  欄位('手機', o.phone);
  if (o.storeCode) {
    欄位('店號', o.storeCode);
    欄位('店名', o.storeName);
  } else {
    欄位('門市', o.store);
  }

  const mark = el('button', 'btn sm' + (done ? ' ghost' : '') + ' wide', done ? '取消建單標記' : '已建單');
  mark.style.marginTop = '10px';
  mark.onclick = async () => {
    if (S.made[o.key]) delete S.made[o.key];
    else S.made[o.key] = new Date().toISOString();
    await kvSet('made', S.made);
    renderCvs(); updateCvsBadge();
  };
  card.append(mark);
  return card;
}

/** 複製純文字，失敗時退回可手動選取的方式 */
async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg || '已複製');
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:45%;left:5%;width:90%;font-size:17px;z-index:99';
    document.body.append(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) {}
    setTimeout(() => ta.remove(), 60);
    toast(ok ? (okMsg || '已複製') : '無法自動複製，請長按選取', 3000);
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

  body.append(el('div', 'secTitle', '訂單系統（選填）'));
  const cu = el('input', 'field');
  cu.placeholder = 'code.gs 網頁應用程式網址';
  cu.value = cfg.codeUrl;
  cu.onchange = () => { cfg.codeUrl = cu.value; renderSetup(); };
  body.append(cu);
  body.append(el('div', 'notice calm',
    '填了才會出現下方的「開賣控制」。這是訂購網站那支 GAS 的網址，跟上面那支不同。\n憑證只存在這支手機，不會進入 GitHub。'));

  renderWorker(body);

  body.append(el('div', 'secTitle', '照片'));
  const stat = el('div', 'tally');
  stat.innerHTML = `<span>總計 <b class="num">${S.photos.length}</b> 張</span>
    <span>未存相簿 <b class="num">${unsaved().length}</b> 張</span>`;
  body.append(stat);

  const ICON_相簿 = '<svg viewBox="0 0 24 24"><rect x="3" y="3.5" width="18" height="12.5" rx="3"/>' +
    '<path d="M3.4 13.2 7 9.8a2 2 0 0 1 2.7 0l3 2.8"/>' +
    '<path d="M14 12.2l1.4-1.3a2 2 0 0 1 2.7 0l2.5 2.3"/>' +
    '<circle cx="15.7" cy="7.6" r="1.3"/>' +
    '<path d="M12 17.5v4.2M9.4 19.4 12 22l2.6-2.6"/></svg>';

  const ICON_匯出 = '<svg viewBox="0 0 24 24"><path d="M3 6.5h18v3.2H3z"/>' +
    '<path d="M4.6 9.7v9.8a1 1 0 0 0 1 1h12.8a1 1 0 0 0 1-1V9.7"/>' +
    '<path d="M12 18.4v-5.6M9.4 14.9 12 12.3l2.6 2.6"/></svg>';

  const iconBtn = (icon, label, primary, badge, fn) => {
    const wrap = el('button', 'iconBtn');
    const c = el('span', 'iconCircle' + (primary ? '' : ' alt'));
    c.innerHTML = icon;
    if (badge) c.append(el('span', 'iconBadge', String(badge)));
    wrap.append(c, el('span', 'iconLabel', label));
    wrap.onclick = fn;
    return wrap;
  };

  const row = el('div', 'iconRow');
  row.append(
    iconBtn(ICON_相簿, '把未存的照片存到相簿', true, unsaved().length, () => saveToPhotos()),
    iconBtn(ICON_匯出, '匯出全部照片', false, 0, () => exportZip())
  );
  body.append(row);

  body.append(el('div', 'notice',
    'iOS 在儲存空間吃緊時會清掉網站資料。當天存到相簿，不要累積一整季在 App 裡。\n存過相簿的副本會在收工時自動清掉，不需要手動處理。'));

  body.append(el('div', 'secTitle', '收工'));

  body.append(el('div', 'notice calm',
    '這一批都寄出、通知也發完之後按下面這顆。它會依序做三件事：\n' +
    '① 把本批拍過照的訂單，在試算表 R 欄寫成「已出貨」\n' +
    '② 清空「臨時加入」與「已傳送」標記\n' +
    '③ 刪掉 App 內已存過相簿的照片副本，釋放空間\n\n' +
    '相簿裡的照片不受影響。沒存過相簿的照片會被保留，不會刪。\n' +
    '寫入失敗時什麼都不會動，可以直接再按一次。'));

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

/* ── 開賣控制：待機／備戰 ─────────────────────────────── */
function renderWorker(body) {
  if (!cfg.codeUrl) return;

  body.append(el('div', 'secTitle', '開賣控制'));

  const w = S.worker;
  if (!w) {
    body.append(el('div', 'notice calm', '尚未取得工人模式狀態，請先到出貨頁按「重新抓取」。'));
    return;
  }

  const stat = el('div', 'tally');
  stat.innerHTML = `<span>目前 <b>${esc(w.mode)}</b></span>
    <span>庫存合計 <b class="num">${w.stock}</b> 份</span>`;
  body.append(stat);

  if (w.warn) {
    body.append(el('div', 'notice',
      '⚠️ 有庫存卻在待機模式。背景工人每 10 分鐘才跑一次，推播失敗的訂單收據會晚很久才補上，客人查不到自己的訂單。開賣前請切成備戰。'));
  }

  const row = el('div', 'bar');
  const 備戰 = el('button', 'btn sm' + (w.mode === '備戰' ? '' : ' ghost'), '切成備戰');
  備戰.style.flex = '1';
  備戰.onclick = () => setWorkerMode('備戰', false, 備戰);
  const 待機 = el('button', 'btn sm' + (w.mode === '待機' ? '' : ' ghost'), '切成待機');
  待機.style.flex = '1';
  待機.onclick = () => setWorkerMode('待機', false, 待機);
  row.append(備戰, 待機);
  body.append(row);

  body.append(el('div', 'notice calm',
    '備戰：背景工人每 1 分鐘跑一次，開賣前後用。\n待機：每 10 分鐘，沒在賣的日子用，省下配額與執行紀錄。'));
}

async function setWorkerMode(mode, force, btn) {
  if (!cfg.codeUrl) { toast('尚未填入訂單系統網址'); return; }
  if (S.worker && S.worker.mode === mode && !force) { toast('目前已經是' + mode); return; }

  btn.disabled = true;
  const 原文 = btn.textContent;
  btn.textContent = '切換中…';

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 45000);
  try {
    const r = await fetch(cfg.codeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'setWorkerMode', token: cfg.token, mode, force: !!force }),
      signal: ctl.signal,
      redirect: 'follow'
    });
    const j = await r.json();

    if (!j.success) {
      // 搶購中切待機 → 後端要求二次確認
      if (j.needForce) {
        if (confirm(j.error + '\n\n仍要切成待機嗎？')) {
          clearTimeout(timer);
          btn.disabled = false; btn.textContent = 原文;
          return setWorkerMode(mode, true, btn);
        }
        toast('已取消');
        return;
      }
      throw new Error(j.error || '切換失敗');
    }

    S.worker = { mode: j.mode, stock: j.stock, warn: (j.mode === '待機' && j.stock > 0) };
    renderSetup();
    toast(`已切為 ${j.mode}（背景工人每 ${j.intervalMin} 分鐘）`, 2600);

  } catch (e) {
    const m = e.name === 'AbortError' ? '連線逾時' : (e.message || '連線失敗');
    toast('切換失敗：' + m, 4000);
  } finally {
    clearTimeout(timer);
    btn.disabled = false;
    btn.textContent = 原文;
  }
}

/* ── 結束這批：回寫試算表 → 成功才清標記 ───────────────── */
async function finishBatch(btn) {
  const keys = Object.keys(S.batch);
  if (!keys.length) { toast('本批沒有拍過任何訂單'); return; }
  if (!cfg.ok) { toast('尚未設定連線'); return; }

  const 未傳 = keys.filter(k => !S.sent[k]).length;
  const 可刪 = S.photos.filter(p => p.saved).length;
  const 保留 = S.photos.filter(p => !p.saved).length;

  let 訊息 = `要完成這批的出貨作業嗎？\n\n`
    + `· 試算表寫入「已出貨」：${keys.length} 筆\n`
    + `· 刪除 App 內照片副本：${可刪} 張（相簿不受影響）`;
  if (保留) 訊息 += `\n· 保留未存相簿的照片：${保留} 張`;
  if (未傳) 訊息 += `\n\n⚠️ 還有 ${未傳} 筆沒標記為已傳送，清掉後會失去發送進度。`;
  if (!confirm(訊息)) return;

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
    S.extra = {}; S.sent = {}; S.batch = {}; S.made = {};
    await kvSet('extra', S.extra);
    await kvSet('sent', S.sent);
    await kvSet('batch', S.batch);
    await kvSet('made', S.made);

    // 只刪已存過相簿的副本；沒存過的一律保留
    const 待刪 = S.photos.filter(p => p.saved);
    for (const p of 待刪) await dbDelPhoto(p.id);
    S.photos = S.photos.filter(p => !p.saved);

    await fetchOrders(true);
    renderShoot(); renderNotify(); renderSetup(); updateBadge();

    let msg = `已寫入 ${j.updated} 筆，清掉 ${待刪.length} 張照片副本`;
    if (j.already) msg += `\n${j.already} 筆本來就是已出貨`;
    if (S.photos.length) msg += `\n保留 ${S.photos.length} 張未存相簿的照片`;
    if (j.notFound) msg += `\n⚠️ 有 ${j.notFound} 筆在試算表找不到，請人工確認`;
    toast(msg, (j.notFound || S.photos.length) ? 6000 : 2800);

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
  const 用過 = {};
  for (const p of S.photos) zip.file(唯一檔名_(用過, p.filename), p.stamped);
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
