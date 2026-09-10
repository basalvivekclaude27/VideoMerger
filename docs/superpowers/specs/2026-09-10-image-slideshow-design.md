# Image Slideshow — Design

## Purpose

Let the user pick any number of images and generate a single
"beautiful" (crossfade + slow zoom/pan) video from them, compressed
for minimum file size without visibly changing quality — same goal as
the existing video-merge pipeline, applied to a stack of still images
instead of video clips.

## Non-goals

- Background music / audio track (images have no inherent audio;
  can be added later if requested).
- Per-image duration control — fixed 3s per image for this version.
- Editing images (crop/filter/etc.) before use.
- Mixing images and video clips in one timeline — this is a separate,
  images-only flow from the existing merge page.

## Entry point

`Add Images` button (already added to the merge page) navigates to a
new standalone page: `window.location = 'images.html'`.

## Architecture

```
Browser (public/images.html, public/images.js)
   │  Browse Images... (multi-select) → thumbnail list (reorder/remove)
   │  Browse... destination folder
   │  Generate Video → poll progress → result
   │  Upload to YouTube (shared widget, also used by merge page)
   ▼
server.js
   │  /api/browse-images, /api/upload-images-from-path,
   │  /api/generate-images, /api/progress/:jobId (reused),
   │  /api/youtube/* (reused, unchanged)
   ▼
ffmpeg (per-image Ken Burns segment → xfade crossfade chain → H.265 compress)
```

## Frontend

### `public/images.html`

Same visual language as `index.html` (Bootstrap, `.app-header`,
`.clip-card`, `#progressWrap`, `#alertArea` patterns reused as-is).

- `Browse Images...` button → calls `/api/browse-images`, gets back a
  list of full paths, uploads them via `/api/upload-images-from-path`,
  renders one card per image: thumbnail (`<img src="/uploads/<jobId>/<filename>">`),
  filename, ↑/↓ reorder buttons, × remove button. No drag-and-drop
  library — arrow buttons keep this dependency-free.
- Destination Folder card — identical markup/behavior to the merge
  page's, calling the existing `/api/browse-folder?purpose=destination`.
- `Generate Video` button (disabled until ≥1 image + dest folder set)
  → `POST /api/generate-images`, then polls
  `/api/progress/:jobId` exactly like the merge page's generate flow.
- Result area shows output path + size-saved stats (same shape as
  merge page's result), then shows the YouTube upload widget.

### `public/youtube-upload.js` (new, extracted)

The YouTube upload card (connect button, title/description/tags/privacy
form, upload button, progress bar, result alert) currently lives inline
in `app.js`/`index.html`. Extract it into a small reusable module:

- Exports a function `initYoutubeUpload(container, getOutputPath)` that
  wires up the connect/upload/progress logic against elements scoped
  under `container`, calling `getOutputPath()` when the user clicks
  Upload.
- `index.html` and `images.html` each include the same
  `<div id="youtubeCard">...</div>` markup (or the module renders it
  into an empty container — whichever keeps both pages' markup
  identical) and both call `initYoutubeUpload(...)`.
- `app.js` is updated to call the shared module instead of its inline
  YouTube code; behavior for the merge page is unchanged.

## Backend (`server.js`)

### New constants

```js
const ALLOWED_IMAGE_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.bmp', '.gif', '.tiff', '.webp'
]);
const IMAGE_DURATION = 3; // seconds per image, fixed
const CROSSFADE_DURATION = 0.8; // seconds, must be < IMAGE_DURATION
```

### `GET /api/browse-images`

Same pattern as `/api/browse-file`, but `OpenFileDialog.Multiselect = $true`
and an image filter (`*.jpg;*.jpeg;*.png;*.bmp;*.gif;*.tiff;*.webp`).
Returns `{ paths: string[] }` (empty array if the user cancels).

### `POST /api/upload-images-from-path`

Bulk sibling of the existing `/api/upload-from-path`: body
`{ jobId, fullPaths: string[] }`. For each path: validate extension
against `ALLOWED_IMAGE_EXT`, validate it exists/is a file, copy into
`uploads/<jobId>/` under a random-hex filename (same collision-safe
approach as today). Returns `{ files: [{ filename, originalName }] }`,
skipping (not failing the whole batch on) any individual path that
fails validation, with per-file errors included in the response so the
frontend can report which ones were skipped.

### Static image serving

`app.use('/uploads', express.static(UPLOAD_DIR))` — needed only so
`<img>` thumbnails can load the copied files by URL. This app is
localhost-only (`server.js` already binds to all interfaces on port
1010 with no auth), so this doesn't change the app's threat model.

### `POST /api/generate-images`

Body `{ jobId, images: [{ filename }], destFolder }` (order = display
order). Validates the same way `/api/generate` does (filename regex,
file exists, destFolder writable), then kicks off `runImagePipeline`
and returns `{ jobId }` for progress polling — mirrors `/api/generate`
exactly, reusing the same `jobs` Map (job IDs are random hex either
way, no collision risk between the two pipelines sharing one Map).

## ffmpeg pipeline (`runImagePipeline`)

Three passes, matching the merge pipeline's structure and progress-
weighting approach:

**1. Per-image Ken Burns segment** (weight 0.45, like the merge
pipeline's normalize pass)

For each image, compute the target canvas as the largest
width/height across all selected images (`roundUpEven`, same helper
as today). Then:

```
ffmpeg -y -loop 1 -t 3 -i <img>
  -vf "scale=<W>:<H>:force_original_aspect_ratio=increase,
       crop=<W>:<H>,
       zoompan=z='min(zoom+0.0015,1.12)':d=90:s=<W>x<H>:fps=30,
       format=yuv420p"
  -r 30 -an -c:v libx264 -preset slow -crf 20 -movflags +faststart
  seg_N.mp4
```

(`scale...increase` + `crop` fills the canvas with no letterboxing,
since a still image — unlike mismatched video clips — has no reason to
show black bars; `zoompan` drives the slow zoom-in; `-an` = no audio
track, since images have none.)

**2. Crossfade chain** (weight 0.1)

One `ffmpeg` call with a `filter_complex` chaining `xfade` across all
N segments pairwise (`transition=fade`, `duration=0.8`, offset =
running total of prior segment durations minus accumulated crossfade
overlap), output re-encoded (xfade can't stream-copy) to
`concat_output.mp4`. This is a real filter pass, unlike the
merge pipeline's stream-copy concat, so it's its own weighted stage
rather than folded into step 3.

**3. Compress pass** (weight 0.45) — identical logic to the existing
merge pipeline's compression step: re-encode to H.265/CRF 23
(`-tag:v hvc1`), fallback to a plain copy if libx265 isn't available in
the ffmpeg build. Also writes the `..._youtube-safe.mp4` H.264 copy
alongside, for the same HEVC-upload-desync reason documented in
`runPipeline`.

Output: `slideshow_output_<timestamp>.mp4` (+ `_youtube-safe.mp4`) in
`destFolder`. Job result shape matches `/api/generate`'s
(`outputPath`, `youtubeSafePath`, `originalSizeBytes`,
`compressedSizeBytes`, `savedBytes`, `savedPercent`, `compressed`) so
the frontend's result-rendering and YouTube-upload wiring work
unchanged against either pipeline's output.

## Error handling

- Bad/unreadable image path from `/api/browse-images` selection or
  bulk upload → reported per-file, doesn't abort the whole batch (see
  `/api/upload-images-from-path` above).
- ffmpeg failure at any of the 3 stages → job marked `error` with
  ffmpeg's stderr tail (same as `runPipeline`'s error path), temp/job
  upload dirs cleaned up.
- Fewer than 1 image or missing destFolder → `Generate Video` stays
  disabled client-side; server also 400s on the same conditions
  (defense in depth, matching `/api/generate`).

## Testing

- Manual: run the app, Add Images → select several images of mixed
  aspect ratios → verify canvas sizing (largest wins, no distortion),
  reorder/remove, generate, confirm crossfade+zoom plays smoothly and
  output file size is meaningfully smaller than the naive concat while
  looking visually unchanged.
- Manual: verify YouTube upload works from the new page via the
  shared widget, and that the merge page's YouTube upload still works
  unchanged after the extraction.
- Manual: single image (N=1) edge case — no crossfade chain needed,
  pipeline should skip step 2 and just run the compress pass directly
  on the one Ken Burns segment.
