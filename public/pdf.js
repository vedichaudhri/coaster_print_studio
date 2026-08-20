/* Minimal multi-page PDF writer - no dependencies.
 *
 * Why this exists: a PNG's physical size is a DPI tag that downstream systems
 * may or may not honour. A PDF's MediaBox is not negotiable - it states the
 * page size outright, so "print at actual size" means the same thing
 * everywhere.
 *
 * Why it emits ALL sheets as one document: merging separate PDFs in macOS
 * Preview writes an *incremental update* - the original file with a second
 * revision appended. Strict readers follow the last xref, but some print
 * portals composite both revisions and render garbage. Producing one clean
 * multi-page file removes any reason to merge by hand.
 *
 * Pages are built as real PDF content - each square is its own image placed by
 * transform, crop marks are vector strokes, the footer is live text. That is
 * both far smaller and far more conventional than rasterising a whole page.
 */

const PT_PER_IN = 72; // fixed by the PDF spec, unrelated to raster DPI

const enc = (s) => new TextEncoder().encode(s);
const num = (n) => (Math.round(n * 1000) / 1000).toString();
const esc = (s) => s.replace(/[\\()]/g, (c) => '\\' + c);

async function jpegBytes(canvas, q = 0.95) {
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', q));
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    w: canvas.width,
    h: canvas.height,
  };
}

// Helvetica widths match closely enough between canvas and PDF to centre text.
function textWidthPt(text, sizePt) {
  const c = document.createElement('canvas').getContext('2d');
  c.font = `${sizePt}px Helvetica, Arial, sans-serif`;
  return c.measureText(text).width;
}

/**
 * @param {Array<{squares: Array<{canvas, xIn, topIn, sizeIn}>, footer?: string}>} pages
 * @param {{widthIn: number, heightIn: number}} opt
 * @returns {Promise<Blob>} one PDF containing every page
 */
async function buildSheetPdf(pages, opt) {
  const wPt = opt.widthIn * PT_PER_IN;
  const hPt = opt.heightIn * PT_PER_IN;

  // One image XObject per square.
  const images = [];
  for (const pg of pages) {
    for (const sq of pg.squares) {
      sq._im = images.length;
      images.push(await jpegBytes(sq.canvas));
    }
  }

  // Object numbering: 1 catalog, 2 pages, 3 font, 4 info, then pages, then images.
  let next = 5;
  const pageIds = pages.map(() => ({ content: next++, page: next++ }));
  const imageIds = images.map(() => next++);
  const total = next - 1;

  const xobjects = imageIds.map((id, i) => `/Im${i} ${id} 0 R`).join(' ');
  const resources = `<< /XObject << ${xobjects} >> /Font << /F1 3 0 R >> >>`;

  const chunks = [];
  let len = 0;
  const push = (u8) => { chunks.push(u8); len += u8.length; };
  const put = (s) => push(enc(s));

  const off = [];
  const obj = (n, body) => { off[n] = len; put(`${n} 0 obj\n${body}\nendobj\n`); };

  put('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // marks the file binary

  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2,
    `<< /Type /Pages /Count ${pages.length} ` +
    `/Kids [${pageIds.map((p) => `${p.page} 0 R`).join(' ')}] >>`);
  obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  obj(4, '<< /Producer (Coaster Print Studio) /Title (Coaster print sheet) >>');

  const gap = 0.03 * PT_PER_IN;
  const tick = 0.12 * PT_PER_IN;

  pages.forEach((pg, i) => {
    let s = '';

    // Images. PDF's origin is bottom-left, so flip the top-down layout.
    for (const sq of pg.squares) {
      const side = sq.sizeIn * PT_PER_IN;
      const x = sq.xIn * PT_PER_IN;
      const y = (opt.heightIn - sq.topIn - sq.sizeIn) * PT_PER_IN;
      s += `q ${num(side)} 0 0 ${num(side)} ${num(x)} ${num(y)} cm /Im${sq._im} Do Q\n`;
    }

    // Crop marks as real strokes, so they stay hairlines at any zoom.
    s += '0 G 0.5 w\n';
    for (const sq of pg.squares) {
      const side = sq.sizeIn * PT_PER_IN;
      const x = sq.xIn * PT_PER_IN;
      const y = (opt.heightIn - sq.topIn - sq.sizeIn) * PT_PER_IN;
      for (const [cx, cy, dx, dy] of [
        [x, y, -1, -1], [x + side, y, 1, -1],
        [x, y + side, -1, 1], [x + side, y + side, 1, 1],
      ]) {
        s += `${num(cx + dx * gap)} ${num(cy)} m ${num(cx + dx * (gap + tick))} ${num(cy)} l\n`;
        s += `${num(cx)} ${num(cy + dy * gap)} m ${num(cx)} ${num(cy + dy * (gap + tick))} l\n`;
      }
    }
    s += 'S\n';

    // Per-square labels sit in the gutter, centred, so they are cut away with
    // the waste and never appear on the finished coaster.
    for (const sq of pg.squares) {
      if (!sq.label) continue;
      const size = 6;
      const cx = (sq.xIn + sq.sizeIn / 2) * PT_PER_IN - textWidthPt(sq.label, size) / 2;
      const by = (opt.heightIn - sq.topIn - sq.sizeIn) * PT_PER_IN - 0.075 * PT_PER_IN;
      s += `BT /F1 ${size} Tf 0.4 0.4 0.4 rg ${num(cx)} ${num(by)} Td ` +
           `(${esc(sq.label)}) Tj ET\n`;
    }

    if (pg.footer) {
      const size = 8;
      const tx = (wPt - textWidthPt(pg.footer, size)) / 2;
      s += `BT /F1 ${size} Tf 0.27 0.27 0.27 rg ${num(tx)} ${num(0.55 * PT_PER_IN)} Td ` +
           `(${esc(pg.footer)}) Tj ET\n`;
    }

    const bytes = enc(s);
    off[pageIds[i].content] = len;
    put(`${pageIds[i].content} 0 obj\n<< /Length ${bytes.length} >>\nstream\n`);
    push(bytes);
    put('endstream\nendobj\n');

    obj(pageIds[i].page,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(wPt)} ${num(hPt)}] ` +
      `/Resources ${resources} /Contents ${pageIds[i].content} 0 R >>`);
  });

  images.forEach((img, i) => {
    off[imageIds[i]] = len;
    put(
      `${imageIds[i]} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${img.w} ` +
      `/Height ${img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
      `/Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n`);
    push(img.bytes);
    put('\nendstream\nendobj\n');
  });

  // xref entries are fixed 20-byte records; the count must match /Size.
  const xref = len;
  let table = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= total; i++) table += `${String(off[i]).padStart(10, '0')} 00000 n \n`;
  put(table);
  put(`trailer\n<< /Size ${total + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  return new Blob(chunks, { type: 'application/pdf' });
}
