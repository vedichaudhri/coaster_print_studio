/* Coaster Print Studio
 *
 * Resolution rule: the crop UI stores only numbers - a square {sx, sy, size}
 * in SOURCE pixels. Nothing on screen ever feeds an export. At export time we
 * re-read the original blob and crop+resample in one native call, so the
 * 5804x8066 Manet never needs a canvas its own size (which would blow past
 * Safari's canvas area limit).
 */

const PROXY_MAX = 1600;   // preview bitmap cap - big enough to frame against
const THUMB_MAX = 220;
const GUTTER_IN = 0.2;    // space between squares on the print sheet
const PRINTABLE_W = 8.0;  // Letter minus a typical laser printer's dead margin
const PRINTABLE_H = 10.5;

const DEFAULT_BRIGHT = 12; // percent lift - toner prints darker than the screen

const $ = (s) => document.querySelector(s);

// Canvas filter is the fast path; older engines get a pixel loop so an export
// never silently comes out unadjusted.
const FILTER_OK = (() => {
  const c = document.createElement('canvas').getContext('2d');
  c.filter = 'brightness(1.5)';
  return c.filter === 'brightness(1.5)';
})();

const brightFilter = (pct) => (pct ? `brightness(${(100 + pct) / 100})` : 'none');

// Fallback: same non-linear sRGB multiply the CSS filter does.
function applyBrightness(ctx, w, h, pct) {
  if (!pct) return;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const f = (100 + pct) / 100;
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.round(i * f);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[d[i]];
    d[i + 1] = lut[d[i + 1]];
    d[i + 2] = lut[d[i + 2]];
  }
  ctx.putImageData(img, 0, 0);
}

const state = {
  items: [],
  active: -1,
  sizeIn: 3.8,
  dpi: 300,
  fmt: 'png',
  sheetFmt: 'pdf',
  static: false,
  mirror: false,
  busy: false,
};

// --------------------------------------------------------------- rotation

// Source point -> display point, for rotation in {0, 90, 180, 270}.
function rotPoint(x, y, r, w, h) {
  if (r === 90) return [h - y, x];
  if (r === 180) return [w - x, h - y];
  if (r === 270) return [y, w - x];
  return [x, y];
}

// Screen delta -> source delta (inverse of the above, translation-free).
function unrotDelta(dx, dy, r) {
  if (r === 90) return [dy, -dx];
  if (r === 180) return [-dx, -dy];
  if (r === 270) return [-dy, dx];
  return [dx, dy];
}

// --------------------------------------------------------------- crop state

function defaultCrop(w, h) {
  const size = Math.min(w, h);
  return {
    sx: Math.round((w - size) / 2),
    sy: Math.round((h - size) / 2),
    size,
    rotation: 0,
    brightness: DEFAULT_BRIGHT,
  };
}

function clampCrop(c, w, h) {
  c.size = Math.max(64, Math.min(c.size, Math.min(w, h)));
  c.sx = Math.max(0, Math.min(Math.round(c.sx), w - c.size));
  c.sy = Math.max(0, Math.min(Math.round(c.sy), h - c.size));
  return c;
}

const storeKey = (name) => `coaster:crop:${name}`;

function saveCrop(item) {
  try { localStorage.setItem(storeKey(item.name), JSON.stringify(item.crop)); } catch {}
}

function loadCrop(name, w, h) {
  try {
    const raw = localStorage.getItem(storeKey(name));
    if (!raw) return defaultCrop(w, h);
    const c = JSON.parse(raw);
    if (![0, 90, 180, 270].includes(c.rotation)) c.rotation = 0;
    const b = Number.isFinite(+c.brightness) ? +c.brightness : DEFAULT_BRIGHT;
    return clampCrop(
      {
        sx: +c.sx || 0,
        sy: +c.sy || 0,
        size: +c.size || Math.min(w, h),
        rotation: c.rotation,
        brightness: Math.max(-10, Math.min(30, b)),
      },
      w, h,
    );
  } catch {
    return defaultCrop(w, h);
  }
}

// ------------------------------------------------------------------ loading

async function boot() {
  // With the Node server, /api/images lists images/ live. On a static host
  // (GitHub Pages) there is no API, so fall back to a committed manifest and
  // switch exports over to browser downloads.
  let list = null;
  try {
    const res = await fetch('api/images');
    if (res.ok) list = await res.json();
  } catch { /* no server - fall through */ }

  if (!list) {
    state.static = true;
    document.body.classList.add('is-static');
    try {
      const res = await fetch('images/index.json');
      if (res.ok) list = await res.json();
    } catch { /* no manifest either */ }
  }

  if (!list || !list.length) {
    $('#loadstatus').textContent = state.static
      ? 'No bundled images. Use "Open images…" to load your own.'
      : 'No images found in images/';
    return;
  }

  state.items = list.map((f) => ({ ...f, ready: false }));
  renderThumbs();

  // Sequential: each image is decoded at full size exactly once to measure it
  // and derive the proxy, then released. Four at once would peak near 250 MB.
  for (let i = 0; i < state.items.length; i++) {
    const item = state.items[i];
    $('#loadstatus').textContent = `Reading ${i + 1} of ${state.items.length}…`;
    try {
      await prepare(item);
      if (state.active === -1) selectItem(i);
    } catch (err) {
      item.error = String(err.message || err);
      console.error(item.name, err);
    }
    renderThumbs();
  }

  $('#loadstatus').textContent = `${state.items.filter((i) => i.ready).length} images ready`;
}

async function prepare(item) {
  if (!item.blob) {
    const res = await fetch(`images/${encodeURIComponent(item.name)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    item.blob = await res.blob();
  }

  const full = await createImageBitmap(item.blob);
  item.w = full.width;
  item.h = full.height;

  const pScale = Math.min(1, PROXY_MAX / Math.max(full.width, full.height));
  item.proxy = await createImageBitmap(full, {
    resizeWidth: Math.max(1, Math.round(full.width * pScale)),
    resizeHeight: Math.max(1, Math.round(full.height * pScale)),
    resizeQuality: 'high',
  });

  const tScale = Math.min(1, THUMB_MAX / Math.max(full.width, full.height));
  item.thumb = await createImageBitmap(full, {
    resizeWidth: Math.max(1, Math.round(full.width * tScale)),
    resizeHeight: Math.max(1, Math.round(full.height * tScale)),
    resizeQuality: 'high',
  });

  full.close();
  item.crop = loadCrop(item.name, item.w, item.h);
  item.ready = true;
}

// --------------------------------------------------------------- filmstrip

function renderThumbs() {
  const host = $('#thumbs');
  host.innerHTML = '';

  state.items.forEach((item, i) => {
    const el = document.createElement('button');
    el.className = 'thumb' + (i === state.active ? ' is-on' : '');
    el.title = item.name;

    if (item.thumb) {
      const c = document.createElement('canvas');
      const side = Math.min(item.thumb.width, item.thumb.height);
      c.width = c.height = side;
      const ctx = c.getContext('2d');
      ctx.drawImage(
        item.thumb,
        (item.thumb.width - side) / 2, (item.thumb.height - side) / 2, side, side,
        0, 0, side, side,
      );
      el.appendChild(c);
    } else {
      const ph = document.createElement('div');
      ph.className = 'ph';
      ph.textContent = item.error ? 'failed' : '…';
      el.appendChild(ph);
    }

    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.textContent = item.name;
    el.appendChild(cap);

    if (item.ready) el.onclick = () => selectItem(i);
    host.appendChild(el);
  });
}

function selectItem(i) {
  state.active = i;
  renderThumbs();
  const item = state.items[i];
  $('#stageTitle').textContent = item.name;
  $('#stageDims').textContent = `${item.w.toLocaleString()} × ${item.h.toLocaleString()} px`;
  layout();
  draw();
  updateReadouts();
}

const current = () => (state.active >= 0 ? state.items[state.active] : null);

// Load images the user picks or drops. Works with or without the server -
// the file is already in memory, so nothing needs fetching.
async function addFiles(files) {
  const picked = [...files].filter((f) => /^image\//.test(f.type));
  if (!picked.length) return;

  for (const file of picked) {
    const item = { name: file.name, size: file.size, type: file.type, blob: file, ready: false };
    state.items.push(item);
    renderThumbs();
    try {
      await prepare(item);
    } catch (err) {
      item.error = String(err.message || err);
      console.error(file.name, err);
    }
    renderThumbs();
  }

  $('#loadstatus').textContent = `${state.items.filter((i) => i.ready).length} images ready`;
  const first = state.items.findIndex((i) => i.ready);
  if (state.active === -1 && first >= 0) selectItem(first);
}

$('#btnOpen').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };

// `stage` proper is declared further down; grab the element directly so this
// does not depend on declaration order.
const dropZone = $('#stage');
for (const evt of ['dragenter', 'dragover']) {
  dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add('is-drop'); });
}
for (const evt of ['dragleave', 'drop']) {
  dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.remove('is-drop'); });
}
dropZone.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files) addFiles(e.dataTransfer.files);
});

// ----------------------------------------------------------------- viewport

const stage = $('#stage');
const canvas = $('#stageCanvas');
const ctx = canvas.getContext('2d');
const view = { scale: 1, ox: 0, oy: 0, w: 0, h: 0 };

function layout() {
  const rect = stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  view.w = rect.width;
  view.h = rect.height;

  const item = current();
  if (!item) return;

  const r = item.crop.rotation;
  const dw = r % 180 ? item.h : item.w;
  const dh = r % 180 ? item.w : item.h;
  view.scale = Math.min(view.w / dw, view.h / dh) * 0.9;
  view.ox = (view.w - dw * view.scale) / 2;
  view.oy = (view.h - dh * view.scale) / 2;
}

function srcToScreen(x, y, item) {
  const [dx, dy] = rotPoint(x, y, item.crop.rotation, item.w, item.h);
  return [view.ox + dx * view.scale, view.oy + dy * view.scale];
}

// Screen-space bounding box of the crop square (axis-aligned: rotation is 90-ish).
function cropScreenRect(item) {
  const { sx, sy, size } = item.crop;
  const a = srcToScreen(sx, sy, item);
  const b = srcToScreen(sx + size, sy + size, item);
  return {
    x: Math.min(a[0], b[0]),
    y: Math.min(a[1], b[1]),
    s: Math.abs(b[0] - a[0]),
  };
}

// Put the canvas into source-pixel space, rotation included.
function applySrcTransform(c, item) {
  const r = item.crop.rotation;
  c.translate(view.ox, view.oy);
  c.scale(view.scale, view.scale);
  if (r === 90) { c.translate(item.h, 0); c.rotate(Math.PI / 2); }
  else if (r === 180) { c.translate(item.w, item.h); c.rotate(Math.PI); }
  else if (r === 270) { c.translate(0, item.w); c.rotate(-Math.PI / 2); }
}

function draw() {
  ctx.clearRect(0, 0, view.w, view.h);
  const item = current();
  if (!item || !item.proxy) return;

  const filter = brightFilter(item.crop.brightness);

  // Whole image, dimmed.
  ctx.save();
  applySrcTransform(ctx, item);
  ctx.filter = filter;
  ctx.drawImage(item.proxy, 0, 0, item.w, item.h);
  ctx.restore();

  ctx.fillStyle = 'rgba(12,13,17,.66)';
  ctx.fillRect(0, 0, view.w, view.h);

  // Crop region, undimmed - this is what the export will look like.
  ctx.save();
  applySrcTransform(ctx, item);
  ctx.beginPath();
  ctx.rect(item.crop.sx, item.crop.sy, item.crop.size, item.crop.size);
  ctx.clip();
  ctx.filter = filter;
  ctx.drawImage(item.proxy, 0, 0, item.w, item.h);
  ctx.restore();

  const { x, y, s } = cropScreenRect(item);

  // Thirds guides.
  ctx.strokeStyle = 'rgba(255,255,255,.16)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < 3; i++) {
    ctx.moveTo(x + (s * i) / 3, y);
    ctx.lineTo(x + (s * i) / 3, y + s);
    ctx.moveTo(x, y + (s * i) / 3);
    ctx.lineTo(x + s, y + (s * i) / 3);
  }
  ctx.stroke();

  ctx.strokeStyle = '#d98f4a';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x + .75, y + .75, s - 1.5, s - 1.5);

  // Corner grips.
  ctx.fillStyle = '#d98f4a';
  const g = 9;
  for (const [cx, cy] of [[x, y], [x + s, y], [x, y + s], [x + s, y + s]]) {
    ctx.fillRect(cx - g / 2, cy - g / 2, g, g);
  }
}

// ------------------------------------------------------------ interactions

let drag = null;

canvas.addEventListener('pointerdown', (e) => {
  const item = current();
  if (!item) return;
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const cr = cropScreenRect(item);

  // Grab a corner to resize, anywhere else to pan.
  let corner = null;
  const corners = [
    ['tl', cr.x, cr.y], ['tr', cr.x + cr.s, cr.y],
    ['bl', cr.x, cr.y + cr.s], ['br', cr.x + cr.s, cr.y + cr.s],
  ];
  for (const [id, cx, cy] of corners) {
    if (Math.hypot(px - cx, py - cy) < 14) { corner = id; break; }
  }

  drag = { px, py, corner, start: { ...item.crop } };
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('is-drag');
});

canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const item = current();
  const rect = canvas.getBoundingClientRect();
  const dxs = e.clientX - rect.left - drag.px;
  const dys = e.clientY - rect.top - drag.py;
  const [dx, dy] = unrotDelta(dxs / view.scale, dys / view.scale, drag.start.rotation);

  if (drag.corner) {
    // Corner drag: project onto the square's diagonal so it stays square.
    const signX = drag.corner.includes('l') ? -1 : 1;
    const signY = drag.corner.includes('t') ? -1 : 1;
    const delta = (dx * signX + dy * signY) / 2;

    let size = Math.round(drag.start.size + delta * 2);
    size = Math.max(64, Math.min(size, Math.min(item.w, item.h)));

    const cx = drag.start.sx + drag.start.size / 2;
    const cy = drag.start.sy + drag.start.size / 2;
    item.crop.size = size;
    item.crop.sx = Math.round(cx - size / 2);
    item.crop.sy = Math.round(cy - size / 2);
  } else {
    item.crop.sx = Math.round(drag.start.sx - dx);
    item.crop.sy = Math.round(drag.start.sy - dy);
  }

  clampCrop(item.crop, item.w, item.h);
  draw();
  updateReadouts();
});

function endDrag() {
  if (!drag) return;
  drag = null;
  canvas.classList.remove('is-drag');
  const item = current();
  if (item) saveCrop(item);
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

canvas.addEventListener('wheel', (e) => {
  const item = current();
  if (!item) return;
  e.preventDefault();

  const c = item.crop;
  const cx = c.sx + c.size / 2;
  const cy = c.sy + c.size / 2;
  const factor = Math.exp(e.deltaY * 0.0016);
  const size = Math.max(64, Math.min(Math.round(c.size * factor), Math.min(item.w, item.h)));

  c.size = size;
  c.sx = Math.round(cx - size / 2);
  c.sy = Math.round(cy - size / 2);
  clampCrop(c, item.w, item.h);
  draw();
  updateReadouts();
  saveCrop(item);
}, { passive: false });

window.addEventListener('keydown', (e) => {
  const item = current();
  if (!item || !$('#view-shops').classList.contains('is-hidden')) return;
  const step = e.shiftKey ? 10 : 1;
  const map = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  const mv = map[e.key];
  if (!mv) return;
  e.preventDefault();
  const [dx, dy] = unrotDelta(mv[0], mv[1], item.crop.rotation);
  item.crop.sx += dx;
  item.crop.sy += dy;
  clampCrop(item.crop, item.w, item.h);
  draw();
  updateReadouts();
  saveCrop(item);
});

window.addEventListener('resize', () => { layout(); draw(); });

$('#btnFill').onclick = () => {
  const item = current();
  if (!item) return;
  item.crop = {
    ...defaultCrop(item.w, item.h),
    rotation: item.crop.rotation,
    brightness: item.crop.brightness,
  };
  draw();
  updateReadouts();
  saveCrop(item);
};

$('#btnReset').onclick = () => {
  const item = current();
  if (!item) return;
  item.crop = defaultCrop(item.w, item.h);
  layout();
  draw();
  updateReadouts();
  saveCrop(item);
};

$('#btnRotate').onclick = () => {
  const item = current();
  if (!item) return;
  item.crop.rotation = (item.crop.rotation + 90) % 360;
  layout();
  draw();
  updateReadouts();
  saveCrop(item);
};

// ------------------------------------------------------------------ segments

function wireSeg(sel, attr, onPick) {
  const host = $(sel);
  host.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    [...host.querySelectorAll('.seg-btn')].forEach((b) => b.classList.toggle('is-on', b === btn));
    onPick(btn.dataset[attr]);
  });
}

wireSeg('#segSize', 'size', (v) => { state.sizeIn = parseFloat(v); updateReadouts(); });
wireSeg('#segDpi', 'dpi', (v) => { state.dpi = parseInt(v, 10); updateReadouts(); });
wireSeg('#segFmt', 'fmt', (v) => { state.fmt = v; });
wireSeg('#segSheetFmt', 'sheetfmt', (v) => { state.sheetFmt = v; });

$('#chkMirror').onchange = (e) => { state.mirror = e.target.checked; updateReadouts(); };

function setBrightness(pct, commit) {
  const item = current();
  if (!item) return;
  item.crop.brightness = pct;
  $('#rngBright').value = String(pct);
  $('#brightVal').textContent = `${pct > 0 ? '+' : ''}${pct}%`;
  draw();
  drawTile();
  if (commit) saveCrop(item);
}

$('#rngBright').oninput = (e) => setBrightness(parseInt(e.target.value, 10), false);
$('#rngBright').onchange = (e) => setBrightness(parseInt(e.target.value, 10), true);
$('#btnBrightReset').onclick = () => setBrightness(DEFAULT_BRIGHT, true);

// ----------------------------------------------------------------- readouts

const targetPx = () => Math.round(state.sizeIn * state.dpi);

function updateReadouts() {
  const item = current();
  if (!item) return;

  // Brightness lives per image, so the slider follows the selection.
  const b = item.crop.brightness;
  $('#rngBright').value = String(b);
  $('#brightVal').textContent = `${b > 0 ? '+' : ''}${b}%`;

  const src = item.crop.size;
  const tgt = targetPx();
  const effDpi = Math.round(src / state.sizeIn);
  const ok = src >= tgt;

  const q = $('#quality');
  q.className = 'quality ' + (ok ? 'ok' : 'bad');
  q.innerHTML = ok
    ? `${src.toLocaleString()}&nbsp;px → ${tgt.toLocaleString()}&nbsp;px<br>` +
      `<b>${effDpi} DPI</b> at ${state.sizeIn}&Prime;` +
      `<span class="note">Downsampling from the original — full quality.</span>`
    : `${src.toLocaleString()}&nbsp;px → ${tgt.toLocaleString()}&nbsp;px<br>` +
      `<b>${effDpi} DPI</b> at ${state.sizeIn}&Prime; — upscaling` +
      `<span class="note">Zoom out until this clears ${tgt.toLocaleString()} px, or drop to 300 DPI.</span>`;

  const bar = $('#qualityBar');
  bar.classList.toggle('bad', !ok);
  bar.querySelector('i').style.width = Math.min(100, (src / tgt) * 100) + '%';

  drawTile();
}

// Finished-coaster mock: 4in white tile with the crop centred on it.
function drawTile() {
  const item = current();
  const c = $('#tileCanvas');
  const tctx = c.getContext('2d');
  const S = c.width;

  tctx.clearRect(0, 0, S, S);
  tctx.fillStyle = '#f4f2ee';
  tctx.beginPath();
  tctx.roundRect(0, 0, S, S, 10);
  tctx.fill();

  if (!item || !item.proxy) return;

  // The canvas holds whichever is larger: the tile or an overhanging print.
  const perIn = S / Math.max(4.0, state.sizeIn);
  const tile = 4.0 * perIn;
  const tileOff = (S - tile) / 2;
  const print = state.sizeIn * perIn;
  const printOff = (S - print) / 2;

  tctx.fillStyle = '#f4f2ee';
  tctx.beginPath();
  tctx.roundRect(tileOff, tileOff, tile, tile, 10);
  tctx.fill();

  const ps = item.proxy.width / item.w;
  const { sx, sy, size } = item.crop;

  tctx.save();
  tctx.beginPath();
  tctx.rect(printOff, printOff, print, print);
  tctx.clip();
  tctx.translate(printOff + print / 2, printOff + print / 2);
  tctx.rotate((item.crop.rotation * Math.PI) / 180);
  if (state.mirror) tctx.scale(-1, 1);
  tctx.imageSmoothingQuality = 'high';
  tctx.filter = brightFilter(item.crop.brightness);
  tctx.drawImage(
    item.proxy,
    sx * ps, sy * ps, size * ps, size * ps,
    -print / 2, -print / 2, print, print,
  );
  tctx.restore();

  if (!FILTER_OK) applyBrightness(tctx, S, S, item.crop.brightness);

  const over = state.sizeIn - 4.0;

  if (over > 0) {
    // Grey back the part that hangs off the tile and dash the tile edge.
    tctx.save();
    tctx.beginPath();
    tctx.rect(0, 0, S, S);
    tctx.roundRect(tileOff, tileOff, tile, tile, 10);
    tctx.fillStyle = 'rgba(12,13,17,.55)';
    tctx.fill('evenodd');
    tctx.restore();

    tctx.setLineDash([7, 5]);
    tctx.strokeStyle = 'rgba(255,255,255,.85)';
    tctx.lineWidth = 2;
    tctx.strokeRect(tileOff, tileOff, tile, tile);
    tctx.setLineDash([]);
  } else if (over < 0) {
    tctx.strokeStyle = 'rgba(0,0,0,.18)';
    tctx.lineWidth = 1;
    tctx.strokeRect(printOff + .5, printOff + .5, print - 1, print - 1);
  }

  $('#tileNote').textContent =
    over > 0
      ? `${state.sizeIn}″ on a 4″ tile — ${(over / 2).toFixed(3).replace(/0+$/, '')}″ hangs over each edge; trim or sand flush once dry.`
      : over < 0
        ? `${state.sizeIn}″ print on a 4″ tile — ${(-over / 2).toFixed(2).replace(/0+$/, '')}″ border all round.`
        : 'Full coverage — trim flush to the tile edge.';
}

// ------------------------------------------------------------------- export

// Crop + resample straight from the original file. One native call, no
// intermediate canvas at source resolution.
async function cropBitmap(item, target) {
  const { sx, sy, size } = item.crop;
  try {
    return await createImageBitmap(item.blob, sx, sy, size, size, {
      resizeWidth: target, resizeHeight: target, resizeQuality: 'high',
    });
  } catch {
    return await cropFallback(item, target);
  }
}

// Older engines ignore crop+resize together. Step down by halves instead -
// a single 5x drawImage downscale aliases badly.
async function cropFallback(item, target) {
  const { sx, sy, size } = item.crop;
  const full = await createImageBitmap(item.blob);

  let cur = Math.min(size, 4096);
  let c = document.createElement('canvas');
  c.width = c.height = cur;
  let cc = c.getContext('2d');
  cc.imageSmoothingEnabled = true;
  cc.imageSmoothingQuality = 'high';
  cc.drawImage(full, sx, sy, size, size, 0, 0, cur, cur);
  full.close();

  while (cur > target * 2) {
    const next = Math.max(target, Math.round(cur / 2));
    const c2 = document.createElement('canvas');
    c2.width = c2.height = next;
    const cc2 = c2.getContext('2d');
    cc2.imageSmoothingQuality = 'high';
    cc2.drawImage(c, 0, 0, cur, cur, 0, 0, next, next);
    c = c2; cc = cc2; cur = next;
  }

  if (cur !== target) {
    const c3 = document.createElement('canvas');
    c3.width = c3.height = target;
    const cc3 = c3.getContext('2d');
    cc3.imageSmoothingQuality = 'high';
    cc3.drawImage(c, 0, 0, cur, cur, 0, 0, target, target);
    c = c3;
  }
  return await createImageBitmap(c);
}

// Full-resolution square, rotation and mirror applied. `brightOverride` lets
// the comparison sheet render the same crop at several brightness levels.
async function renderSquare(item, target, brightOverride) {
  const bright = brightOverride === undefined ? item.crop.brightness : brightOverride;
  const bmp = await cropBitmap(item, target);
  const c = document.createElement('canvas');
  c.width = c.height = target;
  const cc = c.getContext('2d');
  cc.imageSmoothingQuality = 'high';
  cc.save();
  cc.translate(target / 2, target / 2);
  cc.rotate((item.crop.rotation * Math.PI) / 180);
  if (state.mirror) cc.scale(-1, 1);
  cc.filter = brightFilter(bright);
  cc.drawImage(bmp, -target / 2, -target / 2, target, target);
  cc.restore();
  bmp.close?.();

  if (!FILTER_OK) applyBrightness(cc, target, target, bright);
  return c;
}

function toBlob(canvas) {
  const type = state.fmt === 'jpeg' ? 'image/jpeg' : 'image/png';
  return new Promise((res) => canvas.toBlob(res, type, state.fmt === 'jpeg' ? 0.95 : undefined));
}

async function save(blob, name) {
  if (state.static) {
    // No server to write exports/, so hand the file to the browser instead.
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return { name, bytes: blob.size, path: name };
  }

  const res = await fetch(
    `api/export?name=${encodeURIComponent(name)}&dpi=${state.dpi}`,
    { method: 'POST', body: blob, headers: { 'Content-Type': 'application/octet-stream' } },
  );
  if (!res.ok) throw new Error(`save failed (${res.status})`);
  return await res.json();
}

function outName(item, suffix = '') {
  const base = item.name.replace(/\.[^.]+$/, '').replace(/[^\w.\-() ]+/g, '_');
  const ext = state.fmt === 'jpeg' ? 'jpg' : 'png';
  const mir = state.mirror ? '_mirrored' : '';
  const b = item.crop.brightness;
  const bright = b ? `_b${b}` : '';   // '+' would be stripped by the server's sanitiser
  return `${base}_${state.sizeIn}in_${state.dpi}dpi${bright}${mir}${suffix}.${ext}`;
}

async function withBusy(label, fn) {
  if (state.busy) return;
  state.busy = true;
  const btns = [...document.querySelectorAll('.panel .btn')];
  btns.forEach((b) => (b.disabled = true));
  toast(label, 0);
  try {
    await fn();
  } catch (err) {
    console.error(err);
    toast(String(err.message || err), 4000, true);
  } finally {
    state.busy = false;
    btns.forEach((b) => (b.disabled = false));
  }
}

$('#btnExport').onclick = () => withBusy('Exporting…', async () => {
  const item = current();
  if (!item) throw new Error('No image selected');
  const c = await renderSquare(item, targetPx());
  const r = await save(await toBlob(c), outName(item));
  toast(`Saved ${r.name} — ${targetPx()}×${targetPx()} px`);
});

$('#btnExportAll').onclick = () => withBusy('Exporting all…', async () => {
  const ready = state.items.filter((i) => i.ready);
  for (const item of ready) {
    const c = await renderSquare(item, targetPx());
    await save(await toBlob(c), outName(item));
  }
  toast(`Saved ${ready.length} squares to exports/`);
});

// --------------------------------------------------------------- print sheet

function sheetLayout(sizeIn) {
  const cols = 2 * sizeIn + GUTTER_IN <= PRINTABLE_W ? 2 : 1;
  const rows = Math.max(1, Math.min(2, Math.floor((PRINTABLE_H + GUTTER_IN) / (sizeIn + GUTTER_IN))));
  return { cols, rows, perPage: cols * rows };
}

// Positions in INCHES, top-down. Shared by the PNG compositor and the PDF
// writer so the two formats can never drift apart.
function layoutPages(cells, sizeIn) {
  const { cols, rows, perPage } = sheetLayout(sizeIn);
  const gridW = cols * sizeIn + (cols - 1) * GUTTER_IN;
  const gridH = rows * sizeIn + (rows - 1) * GUTTER_IN;
  const left = (8.5 - gridW) / 2;
  const top = (11 - gridH) / 2;

  const pages = [];
  for (let p = 0; p * perPage < cells.length; p++) {
    const slice = cells.slice(p * perPage, (p + 1) * perPage);
    pages.push({
      squares: slice.map((cell, i) => ({
        ...cell,
        xIn: left + (i % cols) * (sizeIn + GUTTER_IN),
        topIn: top + Math.floor(i / cols) * (sizeIn + GUTTER_IN),
        sizeIn,
      })),
    });
  }
  return pages;
}

// Rasterised page, used for the PNG sheet only.
function compositePage(page, dpi) {
  const px = (inches) => Math.round(inches * dpi);
  const c = document.createElement('canvas');
  c.width = px(8.5);
  c.height = px(11);
  const cc = c.getContext('2d');
  cc.fillStyle = '#fff';
  cc.fillRect(0, 0, c.width, c.height);

  const gap = px(0.03);
  const mark = px(0.12);
  cc.lineWidth = Math.max(1, Math.round(dpi / 300));
  cc.strokeStyle = '#000';

  for (const sq of page.squares) {
    const x = px(sq.xIn);
    const y = px(sq.topIn);
    const side = px(sq.sizeIn);
    cc.drawImage(sq.canvas, x, y, side, side);

    cc.beginPath();
    for (const [mx, my, dx, dy] of [
      [x, y, -1, -1], [x + side, y, 1, -1],
      [x, y + side, -1, 1], [x + side, y + side, 1, 1],
    ]) {
      cc.moveTo(mx + dx * gap, my);
      cc.lineTo(mx + dx * (gap + mark), my);
      cc.moveTo(mx, my + dy * gap);
      cc.lineTo(mx, my + dy * (gap + mark));
    }
    cc.stroke();

    if (sq.label) {
      cc.fillStyle = '#666';
      cc.font = `${px(0.083)}px Helvetica, Arial, sans-serif`;
      cc.textAlign = 'center';
      cc.fillText(sq.label, x + side / 2, y + side + px(0.135));
    }
  }

  cc.fillStyle = '#444';
  cc.font = `${px(0.11)}px Helvetica, Arial, sans-serif`;
  cc.textAlign = 'center';
  cc.fillText(page.footer, c.width / 2, c.height - px(0.55));
  return c;
}

$('#btnSheet').onclick = () => withBusy('Building sheet…', async () => {
  const ready = state.items.filter((i) => i.ready);
  if (!ready.length) throw new Error('Nothing to lay out');

  const dpi = state.dpi;
  const sizeIn = state.sizeIn;
  const side = Math.round(sizeIn * dpi);
  const pages = layoutPages(ready.map((item) => ({ item })), sizeIn);

  // Footer is ASCII only - it becomes real PDF text, and the exotic dashes
  // and middots do not survive WinAnsi cleanly.
  pages.forEach((pg, i) => {
    pg.footer =
      `PRINT AT 100% / ACTUAL SIZE - DO NOT SCALE TO FIT   |   ` +
      `${sizeIn}in squares @ ${dpi} DPI   |   page ${i + 1} of ${pages.length}`;
  });

  for (const pg of pages) {
    for (const sq of pg.squares) sq.canvas = await renderSquare(sq.item, side);
  }

  const stem = `print-sheet_${sizeIn}in_${dpi}dpi`;

  if (state.sheetFmt === 'pdf') {
    // Every page in ONE file, so there is never a reason to merge in Preview.
    const blob = await buildSheetPdf(pages, { widthIn: 8.5, heightIn: 11 });
    const r = await save(blob, `${stem}.pdf`);
    toast(
      `${stem}.pdf saved - ${pages.length} page${pages.length > 1 ? 's' : ''}, ` +
      `${(r.bytes / 1e6).toFixed(1)} MB. Upload this file as-is.`,
      6000,
    );
  } else {
    for (let i = 0; i < pages.length; i++) {
      const c = compositePage(pages[i], dpi);
      const name = `${stem}${pages.length > 1 ? `_p${i + 1}` : ''}.png`;
      await save(await new Promise((r) => c.toBlob(r, 'image/png')), name);
    }
    toast(`${pages.length} PNG sheet${pages.length > 1 ? 's' : ''} saved.`, 5000);
  }
});

// Brightness levels compared side by side on the test sheet. Edit to taste.
const COMPARE_BRIGHTS = [15, 25];

$('#btnCompare').onclick = () => withBusy('Building comparison…', async () => {
  const ready = state.items.filter((i) => i.ready);
  if (!ready.length) throw new Error('Nothing to lay out');

  const dpi = state.dpi;
  const sizeIn = state.sizeIn;
  const side = Math.round(sizeIn * dpi);

  // Interleaved so an image's variants always land adjacent - the whole point
  // is judging them against each other, not hunting across pages.
  const cells = [];
  for (const item of ready) {
    for (const b of COMPARE_BRIGHTS) {
      cells.push({ item, bright: b, label: `${b > 0 ? '+' : ''}${b}%  ${item.name}` });
    }
  }

  const pages = layoutPages(cells, sizeIn);
  pages.forEach((pg, i) => {
    pg.footer =
      `PRINT AT 100% / ACTUAL SIZE - DO NOT SCALE TO FIT   |   ` +
      `brightness test, ${COMPARE_BRIGHTS.map((b) => b + '%').join(' vs ')}   |   ` +
      `${sizeIn}in squares @ ${dpi} DPI   |   page ${i + 1} of ${pages.length}`;
  });

  for (const pg of pages) {
    for (const sq of pg.squares) sq.canvas = await renderSquare(sq.item, side, sq.bright);
  }

  const stem = `brightness-test_${COMPARE_BRIGHTS.join('-')}_${sizeIn}in_${dpi}dpi`;

  if (state.sheetFmt === 'pdf') {
    const blob = await buildSheetPdf(pages, { widthIn: 8.5, heightIn: 11 });
    const r = await save(blob, `${stem}.pdf`);
    toast(
      `${stem}.pdf saved - ${cells.length} squares over ${pages.length} pages, ` +
      `${(r.bytes / 1e6).toFixed(1)} MB. Upload as-is.`,
      6000,
    );
  } else {
    for (let i = 0; i < pages.length; i++) {
      const c = compositePage(pages[i], dpi);
      const name = `${stem}${pages.length > 1 ? `_p${i + 1}` : ''}.png`;
      await save(await new Promise((r) => c.toBlob(r, 'image/png')), name);
    }
    toast(`${pages.length} comparison sheet${pages.length > 1 ? 's' : ''} saved.`, 5000);
  }
});

$('#btnReveal').onclick = async () => {
  try { await fetch('api/reveal', { method: 'POST' }); } catch {}
};

// -------------------------------------------------------------------- shops

const SHOPS_KEY = 'coaster:myshops';

function myShops() {
  try { return JSON.parse(localStorage.getItem(SHOPS_KEY)) || []; } catch { return []; }
}

function setMyShops(list) {
  try { localStorage.setItem(SHOPS_KEY, JSON.stringify(list)); } catch {}
}

function shopCard(s, onRemove) {
  const el = document.createElement(onRemove ? 'div' : 'a');
  el.className = 'shop' + (onRemove ? ' mine' : '');
  if (!onRemove) {
    el.href = s.url;
    el.target = '_blank';
    el.rel = 'noopener noreferrer';
  }

  const nm = document.createElement('div');
  nm.className = 'nm';
  if (onRemove) {
    const a = document.createElement('a');
    a.href = s.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = s.name;
    nm.appendChild(a);
  } else {
    nm.textContent = s.name;
  }
  el.appendChild(nm);

  for (const [cls, text] of [['area', s.area], ['note', s.note]]) {
    if (!text) continue;
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    el.appendChild(d);
  }

  const link = document.createElement('div');
  link.className = 'link';
  link.textContent = String(s.url || '').replace(/^https?:\/\//, '').slice(0, 46);
  el.appendChild(link);

  if (onRemove) {
    const btn = document.createElement('button');
    btn.className = 'shop-del';
    btn.type = 'button';
    btn.title = 'Remove';
    btn.textContent = '\u00d7';
    btn.onclick = onRemove;
    el.appendChild(btn);
  }
  return el;
}

function renderGroup(host, title, note, shops, opts = {}) {
  const sec = document.createElement('section');
  sec.className = 'shop-group' + (opts.warn ? ' warn' : '');

  const h = document.createElement('h3');
  h.textContent = title;
  sec.appendChild(h);

  if (note) {
    const p = document.createElement('p');
    p.className = 'gnote';
    p.textContent = note;
    sec.appendChild(p);
  }

  if (!shops.length) {
    if (opts.emptyText) {
      const e = document.createElement('div');
      e.className = 'shop-empty';
      e.textContent = opts.emptyText;
      sec.appendChild(e);
    }
  } else {
    const grid = document.createElement('div');
    grid.className = 'shop-grid';
    shops.forEach((s, i) => grid.appendChild(shopCard(s, opts.removable ? () => {
      const list = myShops();
      list.splice(i, 1);
      setMyShops(list);
      loadShops();
    } : null)));
    sec.appendChild(grid);
  }

  host.appendChild(sec);
}

async function loadShops() {
  // A personal shops.json is gitignored; fall back to the shipped default so a
  // fresh clone still has something useful without carrying anyone's location.
  let groups = [];
  for (const src of ['public/shops.json', 'public/shops.default.json']) {
    try {
      const res = await fetch(src);
      if (!res.ok) continue;
      groups = await res.json();
      break;
    } catch { /* try the next one */ }
  }

  const host = $('#shopGroups');
  host.innerHTML = '';

  const mine = myShops();
  renderGroup(
    host, 'Your shops',
    'Saved in this browser only — never written to the project or committed.',
    mine,
    {
      removable: true,
      emptyText: 'Nothing saved yet. Search above to find shops near you, then add the ones worth keeping.',
    },
  );

  for (const g of groups) {
    renderGroup(host, g.title, g.note, g.shops || [], {
      warn: g.warn,
      emptyText: 'No shops listed here by default — use the search above to find local ones.',
    });
  }
}

function mapSearch(query) {
  const where = $('#nearInput').value.trim();
  const q = where ? `${query} near ${where}` : query;
  window.open(
    `https://www.google.com/maps/search/${encodeURIComponent(q)}`,
    '_blank',
    'noopener',
  );
}

$('#btnFindToner').onclick = () => mapSearch('color laser printing copy shop');
$('#btnFindArt').onclick = () => mapSearch('fine art giclee printing');
$('#nearInput').onkeydown = (e) => { if (e.key === 'Enter') $('#btnFindToner').click(); };

$('#btnAddShop').onclick = () => {
  const name = $('#shopName').value.trim();
  let url = $('#shopUrl').value.trim();
  if (!name) { toast('Give the shop a name first.', 2500, true); return; }
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  if (!url) url = `https://www.google.com/maps/search/${encodeURIComponent(name)}`;

  const list = myShops();
  list.push({
    name,
    area: $('#shopArea').value.trim(),
    note: $('#shopNote').value.trim(),
    url,
  });
  setMyShops(list);

  for (const id of ['#shopName', '#shopArea', '#shopUrl', '#shopNote']) $(id).value = '';
  loadShops();
  toast(`Added ${name}.`);
};

// --------------------------------------------------------------------- tabs

document.querySelector('.tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === btn));
  const wantCrop = btn.dataset.view === 'crop';
  $('#view-crop').classList.toggle('is-hidden', !wantCrop);
  $('#view-shops').classList.toggle('is-hidden', wantCrop);
  if (wantCrop) { layout(); draw(); }
});

// -------------------------------------------------------------------- toast

let toastTimer;
function toast(msg, ms = 2600, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.classList.add('show');
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

boot();
loadShops();
