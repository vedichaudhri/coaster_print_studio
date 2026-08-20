#!/usr/bin/env node
// Coaster Print Studio - local server.
// Node builtins only. Lists images/, streams originals, saves exports/.

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = __dirname;
const IMAGES_DIR = path.join(ROOT, 'images');
const EXPORTS_DIR = path.join(ROOT, 'exports');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 4400;

const IMAGE_EXTS = new Set(['.webp', '.png', '.jpg', '.jpeg']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

// ---------------------------------------------------------------- DPI tagging
// Canvas toBlob() writes no physical-size metadata, so a 1140px PNG opens as
// 1140px @ 72dpi and print dialogs size it wrong. We stamp the real DPI in so
// the file measures 3.8" on its own.

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// PNG stores resolution in a pHYs chunk as pixels-per-metre.
function setPngDpi(buf, dpi) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return buf;

  const ppm = Math.round(dpi / 0.0254);
  const data = Buffer.alloc(9);
  data.writeUInt32BE(ppm, 0);
  data.writeUInt32BE(ppm, 4);
  data.writeUInt8(1, 8); // unit: metres

  const chunk = Buffer.alloc(21);
  chunk.writeUInt32BE(9, 0);
  chunk.write('pHYs', 4, 'latin1');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 17)), 17);

  // Walk chunks so we can drop any existing pHYs and insert right after IHDR.
  const parts = [buf.subarray(0, 8)];
  let off = 8;
  let inserted = false;

  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const end = off + 12 + len;
    if (end > buf.length) break;

    if (type !== 'pHYs') parts.push(buf.subarray(off, end));
    if (type === 'IHDR' && !inserted) {
      parts.push(chunk);
      inserted = true;
    }
    off = end;
    if (type === 'IEND') break;
  }

  return inserted ? Buffer.concat(parts) : buf;
}

// JPEG stores resolution in the JFIF APP0 segment.
function setJpegDpi(buf, dpi) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf;

  const d = Math.max(1, Math.min(65535, Math.round(dpi)));

  if (buf[2] === 0xff && buf[3] === 0xe0 && buf.toString('latin1', 6, 11) === 'JFIF\0') {
    const out = Buffer.from(buf);
    out.writeUInt8(1, 13); // density units: dots per inch
    out.writeUInt16BE(d, 14);
    out.writeUInt16BE(d, 16);
    return out;
  }

  // No JFIF header (rare) - splice a minimal one in after SOI.
  const app0 = Buffer.alloc(20);
  app0.writeUInt16BE(0xffe0, 0);
  app0.writeUInt16BE(16, 2);
  app0.write('JFIF\0', 4, 'latin1');
  app0.writeUInt16BE(0x0102, 9);
  app0.writeUInt8(1, 11);
  app0.writeUInt16BE(d, 12);
  app0.writeUInt16BE(d, 14);
  // trailing two bytes stay zero: no embedded thumbnail
  return Buffer.concat([buf.subarray(0, 2), app0.subarray(0, 18), buf.subarray(2)]);
}

function tagDpi(buf, filename, dpi) {
  if (!dpi || !Number.isFinite(dpi)) return buf;
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.png') return setPngDpi(buf, dpi);
  if (ext === '.jpg' || ext === '.jpeg') return setJpegDpi(buf, dpi);
  return buf;
}

// ------------------------------------------------------------------- helpers

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': MIME['.json'] });
}

// Resolve `name` inside `dir` and refuse anything that escapes it.
function safeJoin(dir, name) {
  const full = path.resolve(dir, path.basename(decodeURIComponent(name)));
  return full.startsWith(dir + path.sep) ? full : null;
}

function readBody(req, limitBytes = 256 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limitBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveStatic(res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// -------------------------------------------------------------------- routes

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/api/images') {
      const entries = await fsp.readdir(IMAGES_DIR, { withFileTypes: true });
      const files = [];
      for (const e of entries) {
        if (!e.isFile() || e.name.startsWith('.')) continue;
        const ext = path.extname(e.name).toLowerCase();
        if (!IMAGE_EXTS.has(ext)) continue;
        const stat = await fsp.stat(path.join(IMAGES_DIR, e.name));
        files.push({ name: e.name, size: stat.size, type: MIME[ext] });
      }
      files.sort((a, b) => a.name.localeCompare(b.name));
      return sendJson(res, 200, files);
    }

    if (pathname.startsWith('/exports/')) {
      const full = safeJoin(EXPORTS_DIR, pathname.slice('/exports/'.length));
      if (!full) return send(res, 403, 'Forbidden');
      return serveStatic(res, full);
    }

    if (pathname.startsWith('/images/')) {
      const full = safeJoin(IMAGES_DIR, pathname.slice('/images/'.length));
      if (!full) return send(res, 403, 'Forbidden');
      return serveStatic(res, full);
    }

    if (pathname === '/api/export' && req.method === 'POST') {
      const name = url.searchParams.get('name');
      if (!name) return sendJson(res, 400, { error: 'missing name' });

      const clean = path.basename(name).replace(/[^\w.\-() ]+/g, '_');
      const full = safeJoin(EXPORTS_DIR, clean);
      if (!full) return sendJson(res, 403, { error: 'bad name' });

      const dpi = Number(url.searchParams.get('dpi')) || 0;
      const raw = await readBody(req);
      const tagged = tagDpi(raw, clean, dpi);

      await fsp.mkdir(EXPORTS_DIR, { recursive: true });
      await fsp.writeFile(full, tagged);
      return sendJson(res, 200, { path: full, name: clean, bytes: tagged.length });
    }

    // Convenience for a local-only tool: open exports/ in Finder.
    if (pathname === '/api/reveal' && req.method === 'POST') {
      await fsp.mkdir(EXPORTS_DIR, { recursive: true });
      spawn('open', [EXPORTS_DIR], { detached: true, stdio: 'ignore' }).unref();
      return sendJson(res, 200, { ok: true });
    }

    // Static front end.
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const full = path.resolve(PUBLIC_DIR, rel);
    if (!full.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
    return serveStatic(res, full);
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Coaster Print Studio  →  http://127.0.0.1:${PORT}\n`);
  console.log(`  images:  ${IMAGES_DIR}`);
  console.log(`  exports: ${EXPORTS_DIR}\n`);
});
