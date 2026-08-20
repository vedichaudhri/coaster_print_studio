# Coaster Print Studio

Crops the images in `images/` to square at full resolution and lays them out for printing
4×4″ ceramic tile coasters.

Crop images to square at full resolution, check they still have the pixels to print sharply at
4 inches, and lay them out on a Letter sheet at exact size with cut marks — then decoupage them
onto ceramic tiles.

Two Manet paintings ship as examples. Drop your own files into `images/` — `.webp`, `.png`,
`.jpg` all work — and they'll appear in the app. `images/` is gitignored apart from the two
examples, so nothing you add gets published by accident.

## Run it

```bash
node server.js
```

Then open <http://127.0.0.1:4400>. No `npm install` — it uses Node builtins only.

## Using it

| Control | What it does |
|---|---|
| Drag on the image | Move the crop square |
| Drag a corner grip | Resize the square (stays square) |
| Scroll | Resize about the centre |
| Arrow keys | Nudge 1 source pixel (⇧ = 10) |
| Fill / Rotate 90° / Reset | Largest square, quarter turn, start over |
| Brightness slider | Lifts the image, saved per image (default +12%) |

Crop positions are saved per image, so a reload picks up where you left off.

**Print quality** shows the real number that matters: how many source pixels are inside your
square versus how many the print needs. Green means you're downsampling from the original —
full quality. Red means you've zoomed in past what the file can support; zoom back out.

**Export** writes into `exports/` with the true DPI written into the file metadata, so the
image measures its stated physical size when opened or printed.

**Build print sheet** is the one you want: all four squares on a Letter page at exact size with
cut marks, plus a printed reminder not to scale it.

Pick the sheet format to match how you're ordering:

- **PDF** for uploading to a print shop's website. A PDF's page size is stated in the file
  itself, so nothing downstream has to interpret a DPI tag to get the size right. This is what
  FedEx Office recommends, and it's the safer choice whenever you can't see the print dialog.
  When the layout needs more than one page you get **one multi-page PDF**, not several files.
- **PNG** for walking up to an in-store self-service copier, which takes images directly.
  Multi-page layouts produce one PNG per page, since an image can't hold pages.

### Brightness test sheet

**Build brightness test sheet** prints every image twice — at **+15%** and **+25%** — as one
PDF, with each image's two variants placed adjacent so you can judge them against each other
rather than from memory. The level and filename are labelled in the gutter, which is waste:
the label is cut away when you trim the square, so it never reaches the tile.

At 3.8″ the variants land side by side in a row (2 images per page, 2 pages). At 4.1″ they
stack vertically (1 image per page, 4 pages). The side-by-side version is easier to judge.

Print it, glue a couple onto spare tiles, seal them, and see which survives the Mod Podge and
the toner shift. Then set that value on the brightness slider and build the real sheet.

To compare different levels, edit `COMPARE_BRIGHTS` at the top of the print-sheet section in
`public/app.js` — it takes any number of values, not just two.

### Do not merge or re-save the PDF in Preview

Upload the file exactly as the app writes it.

Combining PDFs in macOS Preview — dragging page thumbnails together — does not rewrite the
file. It appends a **second revision** on top of the first, leaving two stacked documents in
one file that disagree about how many pages exist. Strict readers follow the last revision,
but some print portals composite both and render overlapping, doubled, misaligned garbage.
That failure looks like a problem with your artwork; it isn't.

This is why the app emits every page in a single PDF: so there is never a reason to merge by
hand. If you ever need to check a file, open a **copy**, and don't save it.

### Brightness

Defaults to **+12%**. Toner lays down darker and slightly flatter than the screen, so a
10–15% lift is the usual pre-compensation — and the Manets are dark paintings to begin with.
It's stored per image, so you can push the Balcony harder than the Matisse.

The adjustment is applied on export, not just in the preview, and the amount is recorded in
the filename (`_b12`) so test prints stay traceable. Highlights clip at pure white, so very
large lifts will flatten the brightest areas — worth watching the white dresses in the Balcony.

If you print a test sheet and it still comes out dark, raise this rather than fiddling with
the printer driver: you'll get a predictable file you can reprint anywhere.

### Size on tile

- **3.8″ (border)** — leaves a 0.1″ white border on a 4″ tile. Most forgiving: a slightly
  crooked cut doesn't show.
- **4.0″ (flush)** — edge to edge, no margin for cutting error.
- **4.1″ (overhang)** — 0.05″ hangs over each edge. Glue it slightly oversized and trim or
  sand flush once dry, which guarantees no bare tile shows at the edges. The tile preview
  dashes the tile boundary so you can see what gets trimmed.

Two-up on Letter only fits at 3.8″. At 4.0″ and 4.1″ the grid would exceed the printable
width, so the sheet splits across two pages rather than being silently shrunk to fit.

### Mirror

Leave it **off**. It's only for Mod Podge *photo transfer medium*, where the print goes
face-down onto the tile and gets rubbed away. Your method glues face-up, so it prints normally.

## At the print shop

Two things that are easy to lose in translation:

1. **"Print at 100% / Actual Size — not Fit to Page."** Fit-to-page silently shrinks the sheet
   by a few percent and the squares stop matching the tiles. The reminder is printed on the
   sheet itself, so it travels with the file into the PDF.

   Upload the **PDF** rather than the PNG when ordering online. FedEx Office's own guidance
   sizes uploaded *images* from their DPI tag — which our PNGs do carry — but they explicitly
   recommend PDF "to ensure formatting appears correctly," and nothing they publish says
   whether their uploader auto-fits a bare image. The PDF removes the question entirely.
2. **Colour laser, not inkjet.** Toner is fused plastic on the paper surface and won't bleed
   when wet Mod Podge goes over it. Inkjet ink can run.

Plain or lightweight paper beats cardstock — thin paper conforms to the tile and the edges
disappear under the sealer. See the **Print shops** tab to find somewhere near you.

## Making the coasters

**Materials** — 4×4″ unglazed white ceramic tiles, your printed squares, Mod Podge (matte or
satin), clear acrylic spray sealer or water-based polyurethane, self-adhesive cork or felt
backing pads, sponge brush, rubbing alcohol.

1. **Prep.** Wipe each tile with rubbing alcohol to strip dust and oils. Let dry completely.
   Trim the prints on the cut marks.
2. **Glue.** Thin even coat of Mod Podge on the tile face. Place the print, centre it, and
   smooth from the middle outward with a scraper card to push out air bubbles. Work quickly.
   Dry 15–20 min.
3. **Seal.** Thin coat of Mod Podge over the top, working the edges where paper meets tile.
   Dry ~20 min, then a second coat with strokes crosswise to the first. Cure at least 2 hours.
4. **Waterproof.** In a ventilated area, 2–3 light coats of clear acrylic spray over top and
   sides, 15 min between coats. This is what handles condensation from a cold glass — don't
   skip it. Cure overnight.
5. **Back.** Stick on cork or felt pads so the tile doesn't scratch furniture.

If you go the fine-art inkjet route instead of toner, spray one print with clear acrylic
sealer *before* gluing and test it on a spare tile first.

## Print shops

The **Print shops** tab explains what to ask for — toner rather than inkjet, 100% scale, plain
paper — and then helps you find somewhere local: type a city or postcode and it opens a map
search. Shops you want to keep can be saved via *Add a shop of your own*; they live in your
browser's local storage, never in the project.

`public/shops.default.json` ships with mail-order coaster services only, deliberately carrying
no local listings. Create `public/shops.json` in the same shape to keep your own curated list —
it's gitignored, so it stays off GitHub along with wherever you happen to live.

## Licence

MIT, see [LICENSE](LICENSE).

The two example images are photographic reproductions of paintings by Édouard Manet
(1832–1883) and are in the public domain worldwide — *The Balcony* (c. 1868–69) and *The Grand
Canal of Venice* (1875). They aren't covered by the MIT licence and don't need to be.

## Layout

```
images/     source images (read only)
exports/    everything the app writes
public/     front end — shops.json is plain data, edit it freely
server.js   local server: lists images, serves originals, saves exports
```

## How the resolution is preserved

The crop UI only ever stores numbers — a square `{sx, sy, size}` in source pixels. Nothing
drawn on screen feeds an export. On export the original file is re-read and cropped and
resampled in a single `createImageBitmap` call, so the 5804×8066 image never needs a canvas
its own size, and the output is resampled once from full resolution rather than from anything
the screen showed.
