# Image Slideshow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user pick any number of images on a new page and generate one crossfade+Ken-Burns "slideshow" video from them, compressed the same way the existing merge pipeline compresses (H.265/CRF, visually unchanged, much smaller file).

**Architecture:** A new standalone page (`images.html`/`images.js`) reuses the merge page's UI patterns (clip-card style rows, progress polling, destination-folder browse) and a newly-extracted shared YouTube-upload widget. The server gets three new endpoints (`/api/browse-images`, `/api/upload-images-from-path`, `/api/generate-images`) plus a new `runImagePipeline` that mirrors the existing `runPipeline`'s three-pass structure: per-image Ken-Burns segment → xfade crossfade chain → H.265 compress.

**Tech Stack:** Node/Express, multer (unused by the new endpoints — they copy from disk paths, not browser uploads), ffmpeg/ffprobe (spawned via `child_process`), vanilla JS + Bootstrap 5 on the frontend, PowerShell (`System.Windows.Forms.OpenFileDialog`) for native file dialogs.

**Spec:** `docs/superpowers/specs/2026-09-10-image-slideshow-design.md`

## Global Constraints

- Fixed 3 seconds per image (`IMAGE_DURATION`), not user-configurable in this version.
- Crossfade duration 0.8s (`CROSSFADE_DURATION`), must stay `<` `IMAGE_DURATION`.
- No audio track in the generated slideshow (`-an` throughout the pipeline).
- No new npm dependencies — no drag-and-drop library, no test framework (this repo has none; verification below is manual/curl/`node --check`, matching the existing project's approach).
- Images page reuses the merge page's visual language (Bootstrap classes, `.clip-card`/`.app-header` styles) via a shared `public/styles.css` rather than duplicating `<style>` blocks.
- `express.static` now also serves `uploads/` (read-only, for thumbnail `<img>` tags) — this app is localhost-only with no auth already, so this doesn't change its threat model.

---

## Task 1: Extract shared CSS into `public/styles.css`

Pure refactor (no behavior change) that both `index.html` and the new `images.html` will link, instead of duplicating a `<style>` block.

**Files:**
- Create: `public/styles.css`
- Modify: `public/index.html:8-95` (remove the inline `<style>...</style>` block, add a `<link>`)

**Interfaces:**
- Produces: `public/styles.css`, containing every rule currently inside `index.html`'s `<style>` block, verbatim.

- [ ] **Step 1: Create `public/styles.css` with the current inline styles**

Copy the full contents currently between `<style>` and `</style>` in `public/index.html` (lines 8–95) into a new file, unchanged:

```css
body { background: #f4f6f9; }

.app-header {
  position: relative;
  overflow: hidden;
  background: linear-gradient(135deg,#2b3a67,#1f2937);
  background-size: 200% 200%;
  animation: gradientShift 8s ease infinite;
  color:#fff;
  padding:2rem 0;
  margin-bottom:2rem;
}
@keyframes gradientShift {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}
.app-header h1 {
  animation: headerPop .6s cubic-bezier(.34,1.56,.64,1);
}
@keyframes headerPop {
  0% { opacity: 0; transform: translateY(-10px) scale(.95); }
  100% { opacity: 1; transform: translateY(0) scale(1); }
}

.clip-card {
  border-left: 4px solid #2b3a67;
  animation: slideInFade .35s ease-out;
  transition: box-shadow .2s ease, transform .2s ease;
}
.clip-card:hover {
  box-shadow: 0 .5rem 1rem rgba(43,58,103,.15) !important;
  transform: translateY(-2px);
}
@keyframes slideInFade {
  0% { opacity: 0; transform: translateX(-16px); }
  100% { opacity: 1; transform: translateX(0); }
}
.clip-card.removing {
  animation: slideOutFade .25s ease-in forwards;
}
@keyframes slideOutFade {
  0% { opacity: 1; transform: scale(1); max-height: 300px; }
  100% { opacity: 0; transform: scale(.96); max-height: 0; margin: 0; padding: 0; overflow: hidden; }
}

.clip-thumb { width:64px; height:64px; object-fit:cover; border-radius:6px; background:#000; }
.clip-thumb.uploaded { animation: thumbPulse .5s ease; }
@keyframes thumbPulse {
  0% { box-shadow: 0 0 0 0 rgba(43,58,103,.5); }
  100% { box-shadow: 0 0 0 10px rgba(43,58,103,0); }
}

#addClipBtn { transition: transform .15s ease, box-shadow .15s ease; }
#addClipBtn:hover { transform: translateY(-1px); box-shadow: 0 .25rem .5rem rgba(43,58,103,.2); }
#addClipBtn:active { transform: translateY(0) scale(.97); }
#addClipBtn .fs-5 { display:inline-block; transition: transform .2s ease; }
#addClipBtn:hover .fs-5 { transform: rotate(90deg); }

#generateBtn {
  transition: transform .15s ease, box-shadow .2s ease, filter .2s ease;
}
#generateBtn:not(:disabled):hover {
  transform: translateY(-1px);
  box-shadow: 0 .5rem 1rem rgba(43,58,103,.25);
  filter: brightness(1.05);
}
#generateBtn:not(:disabled):active { transform: translateY(0) scale(.98); }

#progressWrap { display:none; animation: slideInFade .3s ease-out; }
.progress { height: 1rem; overflow: hidden; }
.progress-bar {
  background: linear-gradient(90deg,#2b3a67,#4a63a8,#2b3a67);
  background-size: 200% 100%;
  animation: barShimmer 1.6s linear infinite;
  transition: width .4s ease;
}
@keyframes barShimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

#alertArea .alert { animation: slideInFade .3s ease-out; }

.drop-hint { font-size:.85rem; color:#6c757d; }
footer { color:#8891a0; font-size:.8rem; margin: 2rem 0; text-align:center; }
```

- [ ] **Step 2: Replace the inline `<style>` block in `index.html` with a `<link>`**

In `public/index.html`, replace:

```html
<link href="vendor/bootstrap/css/bootstrap.min.css" rel="stylesheet">
<style>
  body { background: #f4f6f9; }
  ...
  footer { color:#8891a0; font-size:.8rem; margin: 2rem 0; text-align:center; }
</style>
</head>
```

with:

```html
<link href="vendor/bootstrap/css/bootstrap.min.css" rel="stylesheet">
<link href="styles.css" rel="stylesheet">
</head>
```

- [ ] **Step 3: Verify no behavior change**

Run:
```bash
node -e "require('http').get('http://localhost:1010/styles.css', r => { console.log(r.statusCode); process.exit(0); })" 2>&1 || echo "server not running, start it first: npm start"
```
Start the server (`npm start` in the project root, or your usual dev command) if it isn't already running, then open `http://localhost:1010/` in a browser and confirm the page looks pixel-identical to before (gradient header, card styling, button hover animation on "+ Add Video"). Stop the server after checking.

- [ ] **Step 4: Commit**

```bash
git add public/styles.css public/index.html
git commit -m "refactor: extract shared CSS into styles.css"
```

---

## Task 2: Extract YouTube upload widget into `public/youtube-upload.js`

Pure refactor (no behavior change) so the new images page can reuse the exact same widget instead of duplicating ~140 lines of connect/upload/progress logic.

**Files:**
- Create: `public/youtube-upload.js`
- Modify: `public/app.js:15-29` (remove inline `yt*` element lookups), `public/app.js:36-169` (remove inline widget functions/listeners), `public/app.js:435-436` (call the new module's `setVideoPath` instead of touching `ytVideoPath`/`ytAlertArea` directly)
- Modify: `public/index.html:203-204` (add `<script src="youtube-upload.js">` before `app.js`)

**Interfaces:**
- Produces: `initYoutubeUpload(container)` — global function (plain script, not a module, matching this project's existing `app.js` style). `container` is the DOM element wrapping the widget's markup (the `#youtubeCard` div). Returns `{ setVideoPath(path) }`.
- Consumes (from `index.html`'s existing markup, unchanged): `#ytVideoPath`, `#ytBrowseBtn`, `#ytConnectWrap`, `#ytConnectBtn`, `#ytFormWrap`, `#ytTitle`, `#ytDescription`, `#ytTags`, `#ytPrivacy`, `#ytUploadBtn`, `#ytProgressWrap`, `#ytProgressBar`, `#ytProgressPercent`, `#ytProgressStatus`, `#ytAlertArea`.

- [ ] **Step 1: Create `public/youtube-upload.js`**

```js
// Shared YouTube-upload widget, used by both the merge page (app.js) and
// the image-slideshow page (images.js). Scoped to whatever `container`
// element wraps the #yt* markup (the #youtubeCard div on each page) so
// both pages can include the same widget markup and wire it up the same
// way.
function initYoutubeUpload(container) {
  const ytVideoPath = container.querySelector('#ytVideoPath');
  const ytBrowseBtn = container.querySelector('#ytBrowseBtn');
  const ytConnectWrap = container.querySelector('#ytConnectWrap');
  const ytConnectBtn = container.querySelector('#ytConnectBtn');
  const ytFormWrap = container.querySelector('#ytFormWrap');
  const ytTitle = container.querySelector('#ytTitle');
  const ytDescription = container.querySelector('#ytDescription');
  const ytTags = container.querySelector('#ytTags');
  const ytPrivacy = container.querySelector('#ytPrivacy');
  const ytUploadBtn = container.querySelector('#ytUploadBtn');
  const ytProgressWrap = container.querySelector('#ytProgressWrap');
  const ytProgressBar = container.querySelector('#ytProgressBar');
  const ytProgressPercent = container.querySelector('#ytProgressPercent');
  const ytProgressStatus = container.querySelector('#ytProgressStatus');
  const ytAlertArea = container.querySelector('#ytAlertArea');

  function showYtAlert(message, type = 'danger') {
    ytAlertArea.innerHTML = `
      <div class="alert alert-${type} alert-dismissible fade show" role="alert">
        ${message}
        <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
      </div>`;
  }

  async function refreshYtConnectState() {
    try {
      const res = await fetch('/api/youtube/auth-status');
      const data = await res.json();
      if (data.connected) {
        ytConnectWrap.style.display = 'none';
        ytFormWrap.style.display = 'block';
      } else {
        ytConnectWrap.style.display = 'block';
        ytFormWrap.style.display = 'none';
      }
    } catch {
      // leave whatever state was showing; user can retry via the button
    }
  }

  ytBrowseBtn.addEventListener('click', async () => {
    ytAlertArea.innerHTML = '';
    ytBrowseBtn.disabled = true;
    ytBrowseBtn.textContent = 'Waiting for dialog...';
    try {
      const res = await fetch('/api/browse-file');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not open file browser');
      if (data.path) {
        ytVideoPath.value = data.path;
      }
    } catch (err) {
      showYtAlert('File browse failed: ' + err.message);
    } finally {
      ytBrowseBtn.disabled = false;
      ytBrowseBtn.textContent = 'Browse...';
    }
  });

  ytConnectBtn.addEventListener('click', async () => {
    ytAlertArea.innerHTML = '';
    ytConnectBtn.disabled = true;
    ytConnectBtn.textContent = 'Waiting for browser consent...';
    try {
      const res = await fetch('/api/youtube/authorize');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not connect YouTube account');
      await refreshYtConnectState();
    } catch (err) {
      showYtAlert('Connect failed: ' + err.message);
    } finally {
      ytConnectBtn.disabled = false;
      ytConnectBtn.textContent = 'Connect YouTube Account';
    }
  });

  function pollYtProgress(uploadId) {
    const timer = setInterval(async () => {
      try {
        const res = await fetch('/api/youtube/upload-progress/' + uploadId);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload progress check failed');

        ytProgressBar.style.width = data.percent + '%';
        ytProgressPercent.textContent = data.percent + '%';
        ytProgressStatus.textContent = data.message || data.status;

        if (data.status === 'done') {
          clearInterval(timer);
          showYtAlert(
            '✅ Uploaded: <a href="' + data.videoUrl + '" target="_blank" rel="noopener">' + data.videoUrl + '</a>',
            'success'
          );
          ytUploadBtn.disabled = false;
          ytUploadBtn.textContent = 'Upload to YouTube';
        } else if (data.status === 'error') {
          clearInterval(timer);
          showYtAlert('Upload failed: ' + data.message);
          ytUploadBtn.disabled = false;
          ytUploadBtn.textContent = 'Upload to YouTube';
        }
      } catch (err) {
        clearInterval(timer);
        showYtAlert('Lost connection to upload progress: ' + err.message);
        ytUploadBtn.disabled = false;
        ytUploadBtn.textContent = 'Upload to YouTube';
      }
    }, 1000);
  }

  ytUploadBtn.addEventListener('click', async () => {
    ytAlertArea.innerHTML = '';
    if (!ytVideoPath.value.trim()) {
      showYtAlert('Choose a video file first.');
      return;
    }
    if (!ytTitle.value.trim()) {
      showYtAlert('Title is required.');
      return;
    }

    ytUploadBtn.disabled = true;
    ytUploadBtn.textContent = 'Starting upload...';
    ytProgressWrap.style.display = 'block';
    ytProgressBar.style.width = '0%';
    ytProgressPercent.textContent = '0%';
    ytProgressStatus.textContent = 'Starting...';

    try {
      const res = await fetch('/api/youtube/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outputPath: ytVideoPath.value.trim(),
          title: ytTitle.value.trim(),
          description: ytDescription.value.trim(),
          tags: ytTags.value.trim(),
          privacyStatus: ytPrivacy.value
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start upload');
      ytUploadBtn.textContent = 'Uploading...';
      pollYtProgress(data.uploadId);
    } catch (err) {
      showYtAlert('Failed to start upload: ' + err.message);
      ytUploadBtn.disabled = false;
      ytUploadBtn.textContent = 'Upload to YouTube';
    }
  });

  refreshYtConnectState();

  return {
    setVideoPath(path) {
      ytVideoPath.value = path;
      ytAlertArea.innerHTML = '';
    }
  };
}
```

- [ ] **Step 2: Remove the inline `yt*` element lookups from `app.js`**

In `public/app.js`, delete lines 15–29 (the block of `const yt... = document.getElementById(...)` declarations):

```js
  const ytVideoPath = document.getElementById('ytVideoPath');
  const ytBrowseBtn = document.getElementById('ytBrowseBtn');
  const ytConnectWrap = document.getElementById('ytConnectWrap');
  const ytConnectBtn = document.getElementById('ytConnectBtn');
  const ytFormWrap = document.getElementById('ytFormWrap');
  const ytTitle = document.getElementById('ytTitle');
  const ytDescription = document.getElementById('ytDescription');
  const ytTags = document.getElementById('ytTags');
  const ytPrivacy = document.getElementById('ytPrivacy');
  const ytUploadBtn = document.getElementById('ytUploadBtn');
  const ytProgressWrap = document.getElementById('ytProgressWrap');
  const ytProgressBar = document.getElementById('ytProgressBar');
  const ytProgressPercent = document.getElementById('ytProgressPercent');
  const ytProgressStatus = document.getElementById('ytProgressStatus');
  const ytAlertArea = document.getElementById('ytAlertArea');
```

Replace with a single line that initializes the shared widget:

```js
  const youtubeUpload = initYoutubeUpload(document.getElementById('youtubeCard'));
```

- [ ] **Step 3: Remove the inline widget functions from `app.js`**

Delete everything from `function showYtAlert(message, type = 'danger') {` through the closing of the `ytUploadBtn.addEventListener('click', ...)` block (originally lines 36–169) — i.e. `showYtAlert`, `refreshYtConnectState`, the `ytBrowseBtn`/`ytConnectBtn`/`ytUploadBtn` listeners, and `pollYtProgress`. All of that logic now lives in `youtube-upload.js`.

- [ ] **Step 4: Update the two remaining references to the removed elements**

In `app.js`, find (originally lines 435–436):

```js
          ytVideoPath.value = data.youtubeSafePath || data.outputPath;
          ytAlertArea.innerHTML = '';
```

Replace with:

```js
          youtubeUpload.setVideoPath(data.youtubeSafePath || data.outputPath);
```

- [ ] **Step 5: Remove the now-redundant call at the bottom of `app.js`**

At the bottom of `app.js`, find:

```js
  // start with one clip row
  addClipRow(null);
  refreshYtConnectState();
})();
```

Replace with:

```js
  // start with one clip row
  addClipRow(null);
})();
```

(`refreshYtConnectState()` now runs automatically inside `initYoutubeUpload`, called in Step 1 above.)

- [ ] **Step 6: Add the new script tag to `index.html`**

In `public/index.html`, find:

```html
<script src="vendor/bootstrap/js/bootstrap.bundle.min.js"></script>
<script src="app.js"></script>
```

Replace with:

```html
<script src="vendor/bootstrap/js/bootstrap.bundle.min.js"></script>
<script src="youtube-upload.js"></script>
<script src="app.js"></script>
```

- [ ] **Step 7: Verify syntax and behavior**

```bash
node --check public/youtube-upload.js
node --check public/app.js
```
Both must print nothing (success). Then start the server, open `http://localhost:1010/`, and confirm the YouTube card still shows "Connect YouTube Account" (or the upload form, if already connected) exactly as before, and that running a merge still populates the video path field on completion.

- [ ] **Step 8: Commit**

```bash
git add public/youtube-upload.js public/app.js public/index.html
git commit -m "refactor: extract YouTube upload widget into shared module"
```

---

## Task 3: Server — image constants, static uploads serving, `/api/browse-images`

**Files:**
- Modify: `server.js:53-56` (add `ALLOWED_IMAGE_EXT` alongside `ALLOWED_VIDEO_EXT`)
- Modify: `server.js:19-21` (add `express.static` for `uploads/`)
- Modify: `server.js` (add `GET /api/browse-images` after the existing `GET /api/browse-file`, i.e. after line 270)

**Interfaces:**
- Produces: `ALLOWED_IMAGE_EXT` (Set<string>, module scope), `GET /api/browse-images` → `{ paths: string[] }`.

- [ ] **Step 1: Add `ALLOWED_IMAGE_EXT`**

In `server.js`, find:

```js
const ALLOWED_VIDEO_EXT = new Set([
  '.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm',
  '.wmv', '.flv', '.mpg', '.mpeg', '.3gp', '.ts', '.m2ts'
]);
```

Add immediately after it:

```js

const ALLOWED_IMAGE_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.bmp', '.gif', '.tiff', '.webp'
]);
```

- [ ] **Step 2: Serve `uploads/` statically (for thumbnail previews)**

In `server.js`, find:

```js
const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));
```

Replace with:

```js
const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));
// Read-only static serving so <img> thumbnails on the image-slideshow page
// can load copied-in images by URL. This app is already localhost-only
// with no auth, so this doesn't change its threat model.
app.use('/uploads', express.static(UPLOAD_DIR));
```

- [ ] **Step 3: Add `GET /api/browse-images`**

In `server.js`, find the end of the existing `/api/browse-file` handler:

```js
  execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', psScript], { timeout: 120000 }, (err, stdout) => {
    if (err) {
      return res.status(500).json({ error: 'Could not open file dialog: ' + err.message });
    }
    const selected = stdout.trim();
    res.json({ path: selected || null });
  });
});
```

(this is the closing of `/api/browse-file`). Add immediately after it:

```js

// ---------------------------------------------------------------------
// Native Windows file browse dialog (multi-select images, for the
// image-slideshow page)
// ---------------------------------------------------------------------
app.get('/api/browse-images', (req, res) => {
  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.StartPosition = 'CenterScreen'
$owner.WindowState = 'Minimized'
$owner.ShowInTaskbar = $false
$owner.Show()
$owner.Activate()
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Select images for the slideshow'
$dialog.Filter = 'Image files|*.jpg;*.jpeg;*.png;*.bmp;*.gif;*.tiff;*.webp|All files|*.*'
$dialog.Multiselect = $true
$result = $dialog.ShowDialog($owner)
$owner.Close()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  $dialog.FileNames | ForEach-Object { Write-Output $_ }
}
`.trim();

  execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', psScript], { timeout: 120000 }, (err, stdout) => {
    if (err) {
      return res.status(500).json({ error: 'Could not open file dialog: ' + err.message });
    }
    const paths = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    res.json({ paths });
  });
});
```

- [ ] **Step 4: Verify syntax and smoke-test**

```bash
node --check server.js
```
Must print nothing. Then start the server (`npm start`) and, in another terminal:

```bash
curl -s http://localhost:1010/api/browse-images
```
A Windows file-picker dialog should appear (this opens an actual OS dialog — select 1-2 test images or press Cancel). After it closes, curl should print `{"paths":[...]}` (or `{"paths":[]}` if cancelled) with no error. Stop the server after checking.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: add image constants, static uploads serving, browse-images endpoint"
```

---

## Task 4: Server — bulk `/api/upload-images-from-path`

**Files:**
- Modify: `server.js` (add new endpoint after the existing `POST /api/upload-from-path`)

**Interfaces:**
- Consumes: `ALLOWED_IMAGE_EXT` (from Task 3), `UPLOAD_DIR`, `MAX_FILE_SIZE` (existing module-scope constants).
- Produces: `POST /api/upload-images-from-path` → `{ files: [{filename, originalName}], errors: [{path, error}] }`.

- [ ] **Step 1: Add the endpoint**

In `server.js`, find the end of the existing `/api/upload-from-path` handler:

```js
  const dir = path.join(UPLOAD_DIR, jobId);
  fs.mkdirSync(dir, { recursive: true });
  const safe = crypto.randomBytes(6).toString('hex') + ext;
  const dest = path.join(dir, safe);
  try {
    fs.copyFileSync(fullPath, dest);
  } catch (err) {
    return res.status(500).json({ error: 'Could not copy file: ' + err.message });
  }
  res.json({ filename: safe });
});
```

(this is the closing of `/api/upload-from-path`). Add immediately after it:

```js

// ---------------------------------------------------------------------
// Bulk version of /api/upload-from-path for the image-slideshow page:
// copies multiple already-on-disk images (from /api/browse-images) into
// the job's upload dir in one request. Per-file failures are reported in
// `errors` rather than failing the whole batch, so one bad path (deleted
// mid-flight, unsupported extension, etc.) doesn't block the rest.
// ---------------------------------------------------------------------
app.post('/api/upload-images-from-path', (req, res) => {
  const { jobId, fullPaths } = req.body;
  if (!jobId || !/^[a-zA-Z0-9_-]+$/.test(jobId)) {
    return res.status(400).json({ error: 'Invalid jobId' });
  }
  if (!Array.isArray(fullPaths) || fullPaths.length === 0) {
    return res.status(400).json({ error: 'fullPaths is required' });
  }

  const dir = path.join(UPLOAD_DIR, jobId);
  fs.mkdirSync(dir, { recursive: true });

  const files = [];
  const errors = [];

  for (const fullPath of fullPaths) {
    if (typeof fullPath !== 'string' || !fullPath) {
      errors.push({ path: String(fullPath), error: 'Invalid path' });
      continue;
    }
    const ext = path.extname(fullPath).toLowerCase();
    if (!ALLOWED_IMAGE_EXT.has(ext)) {
      errors.push({ path: fullPath, error: `Unsupported file type: ${fullPath}` });
      continue;
    }
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      errors.push({ path: fullPath, error: 'File not found: ' + fullPath });
      continue;
    }
    if (!stat.isFile()) {
      errors.push({ path: fullPath, error: 'Not a file: ' + fullPath });
      continue;
    }
    if (stat.size > MAX_FILE_SIZE) {
      errors.push({ path: fullPath, error: 'File too large: ' + fullPath });
      continue;
    }
    const safe = crypto.randomBytes(6).toString('hex') + ext;
    const dest = path.join(dir, safe);
    try {
      fs.copyFileSync(fullPath, dest);
    } catch (err) {
      errors.push({ path: fullPath, error: 'Could not copy file: ' + err.message });
      continue;
    }
    files.push({ filename: safe, originalName: path.basename(fullPath) });
  }

  res.json({ files, errors });
});
```

- [ ] **Step 2: Verify syntax and smoke-test**

```bash
node --check server.js
```
Must print nothing. Start the server, create a job, and upload a real local image plus one bad path in the same batch to confirm partial success:

```bash
JOB=$(curl -s -X POST http://localhost:1010/api/new-job | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).jobId))")
echo "jobId: $JOB"
# Replace with a real image path that exists on this machine:
curl -s -X POST http://localhost:1010/api/upload-images-from-path \
  -H "Content-Type: application/json" \
  -d "{\"jobId\":\"$JOB\",\"fullPaths\":[\"C:\\\\Windows\\\\Web\\\\Wallpaper\\\\Theme1\\\\img1.jpg\",\"C:\\\\does\\\\not\\\\exist.jpg\"]}"
```
Expected: JSON with one entry in `files` (the real image, now copied into `uploads/<jobId>/`) and one entry in `errors` (the bad path, "File not found"). Stop the server after checking.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add bulk upload-images-from-path endpoint"
```

---

## Task 5: Server — `runImagePipeline` + `/api/generate-images`

The core ffmpeg work: per-image Ken-Burns segment → xfade crossfade chain → H.265 compress, mirroring `runPipeline`'s structure and progress-weighting approach.

**Files:**
- Modify: `server.js:541` (hoist the `roundUpEven` helper out of `runPipeline` so both pipelines can use it)
- Modify: `server.js` (add `runImagePipeline` and `buildXfadeFilterComplex` near `runPipeline`, add `/api/generate-images` near `/api/generate`)

**Interfaces:**
- Consumes: `ffprobe(filePath)` → `{width, height, fps}`, `runFfmpeg(args, onProgress)` → `Promise<void>` (both existing, unchanged), `jobs` Map (existing), `ALLOWED_IMAGE_EXT` (Task 3).
- Produces: `roundUpEven(n)` (module scope), `buildXfadeFilterComplex(n)` → filter_complex string, `runImagePipeline(jobId, images, destFolder)` → `Promise<void>`, `POST /api/generate-images` → `{jobId}`.

- [ ] **Step 1: Hoist `roundUpEven` to module scope**

In `server.js`, inside `runPipeline`, find:

```js
  const probes = [];
  for (const p of inputPaths) probes.push(await ffprobe(p));
  const roundUpEven = (n) => Math.ceil(n / 2) * 2;
  const target = {
```

Replace with:

```js
  const probes = [];
  for (const p of inputPaths) probes.push(await ffprobe(p));
  const target = {
```

Then, just above the `function runFfmpeg(args, onProgress) {` definition, add the hoisted helper so it's available to both pipelines:

```js
// Rounds up to the nearest even number — video codecs require even
// width/height, so any canvas size derived from source dimensions must
// be rounded this way before use as an encode target.
function roundUpEven(n) {
  return Math.ceil(n / 2) * 2;
}

function runFfmpeg(args, onProgress) {
```

- [ ] **Step 2: Add the image-pipeline constants and `buildXfadeFilterComplex`**

In `server.js`, immediately after the `ALLOWED_IMAGE_EXT` constant added in Task 3, add:

```js

const IMAGE_DURATION = 3; // seconds per image, fixed (see spec)
const CROSSFADE_DURATION = 0.8; // seconds, must be < IMAGE_DURATION
const IMAGE_FPS = 30;

// Builds an ffmpeg filter_complex chaining `xfade` across n pre-built,
// equal-duration (IMAGE_DURATION) segment inputs [0:v]..[n-1:v] into a
// single [vout] crossfaded stream. Every segment has the same fixed
// duration, so each transition's offset is simply a multiple of
// (IMAGE_DURATION - CROSSFADE_DURATION) — the point at which the next
// segment starts overlapping the one before it. Only called for n > 1;
// n === 1 has nothing to crossfade.
function buildXfadeFilterComplex(n) {
  const parts = [];
  let prevLabel = '0:v';
  for (let i = 1; i < n; i++) {
    const outLabel = i === n - 1 ? 'vout' : `v${i}`;
    const offset = i * (IMAGE_DURATION - CROSSFADE_DURATION);
    parts.push(`[${prevLabel}][${i}:v]xfade=transition=fade:duration=${CROSSFADE_DURATION}:offset=${offset}[${outLabel}]`);
    prevLabel = outLabel;
  }
  return parts.join(';');
}
```

- [ ] **Step 3: Add `runImagePipeline`**

In `server.js`, immediately after the closing `}` of `runPipeline` (the function added in the original merge feature, ending just before the `// ---------------------------------------------------------------------\napp.listen(PORT, ...)` block), add:

```js

async function runImagePipeline(jobId, images, destFolder) {
  const jobUploadDir = path.join(UPLOAD_DIR, jobId);
  const jobTmpDir = path.join(TMP_DIR, jobId);
  fs.mkdirSync(jobTmpDir, { recursive: true });

  const setJob = (patch) => jobs.set(jobId, { ...jobs.get(jobId), ...patch });

  setJob({ status: 'processing', message: 'Analyzing images...', percent: 1 });

  const inputPaths = images.map((img) => path.join(jobUploadDir, img.filename));

  // Target canvas = the largest width/height across all images, same
  // reasoning as the video-merge pipeline: whichever image happens to be
  // smallest shouldn't force every other image to be downscaled.
  const probes = [];
  for (const p of inputPaths) probes.push(await ffprobe(p));
  const target = {
    width: roundUpEven(Math.max(...probes.map((p) => p.width))),
    height: roundUpEven(Math.max(...probes.map((p) => p.height)))
  };

  const n = inputPaths.length;
  // Weighted progress across up to 3 passes: per-image segment encode,
  // crossfade chain (skipped for a single image), final compress.
  const normalizeWeight = n > 1 ? 0.45 : 0.55;
  const concatWeight = n > 1 ? 0.1 : 0;
  const compressWeight = 0.45;

  const totalSegSeconds = n * IMAGE_DURATION;
  let doneSeconds = 0;

  const segmentPaths = [];
  for (let i = 0; i < n; i++) {
    const inPath = inputPaths[i];
    const outPath = path.join(jobTmpDir, `seg_${i}.mp4`);
    segmentPaths.push(outPath);

    setJob({ message: `Processing image ${i + 1} of ${n}...` });

    // scale+crop fills the whole target canvas with no letterboxing (a
    // still image, unlike mismatched video clips, has no reason to show
    // black bars), then zoompan drives a slow Ken Burns zoom-in across
    // the image's full on-screen duration (d = IMAGE_DURATION * IMAGE_FPS
    // frames). -an: images carry no audio.
    const vf = [
      `scale=${target.width}:${target.height}:force_original_aspect_ratio=increase`,
      `crop=${target.width}:${target.height}`,
      `zoompan=z='min(zoom+0.0015,1.12)':d=${IMAGE_DURATION * IMAGE_FPS}:s=${target.width}x${target.height}:fps=${IMAGE_FPS}`,
      'format=yuv420p'
    ].join(',');

    const args = [
      '-loop', '1',
      '-t', String(IMAGE_DURATION),
      '-i', inPath,
      '-vf', vf,
      '-r', String(IMAGE_FPS),
      '-an',
      '-c:v', 'libx264',
      '-preset', 'slow',
      '-crf', '20',
      '-movflags', '+faststart',
      outPath
    ];

    const segStartSeconds = doneSeconds;
    await runFfmpeg(args, (seconds) => {
      const segProgress = Math.min(seconds, IMAGE_DURATION);
      const overall = ((segStartSeconds + segProgress) / totalSegSeconds) * normalizeWeight;
      setJob({ percent: Math.round(overall * 100) });
    });
    doneSeconds += IMAGE_DURATION;
  }

  const concatOutputPath = path.join(jobTmpDir, 'concat_output.mp4');
  // Every crossfade overlaps the next segment by CROSSFADE_DURATION, so
  // the final duration is less than the sum of segment durations.
  const finalSegDuration = n * IMAGE_DURATION - Math.max(0, n - 1) * CROSSFADE_DURATION;

  if (n === 1) {
    // Nothing to crossfade with a single image.
    fs.copyFileSync(segmentPaths[0], concatOutputPath);
    setJob({ percent: Math.round((normalizeWeight + concatWeight) * 100) });
  } else {
    setJob({ message: 'Blending crossfades...', percent: Math.round(normalizeWeight * 100) });

    const inputArgs = segmentPaths.flatMap((p) => ['-i', p]);
    const filterComplex = buildXfadeFilterComplex(n);

    // xfade is a real filter, not a concat-demuxer stream copy, so this
    // pass re-encodes once (unlike the video-merge pipeline's -c copy
    // concat, which can skip re-encoding because every segment there is
    // already byte-identical in format).
    await runFfmpeg([
      ...inputArgs,
      '-filter_complex', filterComplex,
      '-map', '[vout]',
      '-c:v', 'libx264',
      '-preset', 'slow',
      '-crf', '20',
      '-movflags', '+faststart',
      concatOutputPath
    ], (seconds) => {
      const overall = normalizeWeight + Math.min(seconds / finalSegDuration, 1) * concatWeight;
      setJob({ percent: Math.round(overall * 100) });
    });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputFilename = `slideshow_output_${timestamp}.mp4`;
  const finalOutputPath = path.join(destFolder, outputFilename);
  const originalSizeBytes = fs.statSync(concatOutputPath).size;

  setJob({ message: 'Compressing final video...', percent: Math.round((normalizeWeight + concatWeight) * 100) });

  // Same compression approach as the video-merge pipeline: H.265/CRF 23
  // for roughly half the bitrate at visually-unchanged quality, falling
  // back to a plain copy if this ffmpeg build has no libx265.
  let compressed = false;
  try {
    await runFfmpeg([
      '-i', concatOutputPath,
      '-map', '0:v:0',
      '-c:v', 'libx265',
      '-preset', 'medium',
      '-crf', '23',
      '-tag:v', 'hvc1',
      '-movflags', '+faststart',
      finalOutputPath
    ], (seconds) => {
      const overall = normalizeWeight + concatWeight + Math.min(seconds / finalSegDuration, 1) * compressWeight;
      setJob({ percent: Math.round(overall * 100) });
    });
    compressed = true;
  } catch (err) {
    fs.copyFileSync(concatOutputPath, finalOutputPath);
  }

  const compressedSizeBytes = fs.statSync(finalOutputPath).size;
  const savedBytes = Math.max(0, originalSizeBytes - compressedSizeBytes);
  const savedPercent = originalSizeBytes > 0 ? Math.round((savedBytes / originalSizeBytes) * 1000) / 10 : 0;

  // Same H.264 "youtube-safe" copy as the video-merge pipeline, and for
  // the same reason: YouTube's ingest pipeline is unreliable with HEVC.
  let youtubeSafePath = finalOutputPath;
  if (compressed) {
    youtubeSafePath = path.join(destFolder, `slideshow_output_${timestamp}_youtube-safe.mp4`);
    fs.copyFileSync(concatOutputPath, youtubeSafePath);
  }

  try {
    fs.rmSync(jobTmpDir, { recursive: true, force: true });
    fs.rmSync(jobUploadDir, { recursive: true, force: true });
  } catch { /* non-fatal */ }

  setJob({
    status: 'done',
    percent: 100,
    message: compressed ? 'Done' : 'Done (compression unavailable, saved uncompressed slideshow)',
    outputPath: finalOutputPath,
    youtubeSafePath,
    originalSizeBytes,
    compressedSizeBytes,
    savedBytes,
    savedPercent,
    compressed
  });
}
```

- [ ] **Step 4: Add `POST /api/generate-images`**

In `server.js`, immediately after the closing `});` of the existing `GET /api/progress/:jobId` handler, add:

```js

// ---------------------------------------------------------------------
// Generate (image slideshow: Ken Burns + crossfade + compress)
// ---------------------------------------------------------------------
app.post('/api/generate-images', (req, res) => {
  const { jobId, images, destFolder } = req.body;

  if (!jobId || !Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: 'jobId and at least one image are required' });
  }
  if (!destFolder || typeof destFolder !== 'string') {
    return res.status(400).json({ error: 'destFolder is required' });
  }
  try {
    fs.accessSync(destFolder, fs.constants.W_OK);
  } catch {
    return res.status(400).json({ error: 'Destination folder does not exist or is not writable: ' + destFolder });
  }

  const jobUploadDir = path.join(UPLOAD_DIR, jobId);
  for (const img of images) {
    if (!img.filename || !/^[a-f0-9]+(\.[a-zA-Z0-9]+)?$/.test(img.filename)) {
      return res.status(400).json({ error: 'Invalid image filename' });
    }
    const full = path.join(jobUploadDir, img.filename);
    if (!fs.existsSync(full)) {
      return res.status(400).json({ error: 'Uploaded file missing: ' + img.filename });
    }
  }

  jobs.set(jobId, { percent: 0, status: 'queued', message: 'Queued', outputPath: null });
  res.json({ jobId });

  runImagePipeline(jobId, images, destFolder).catch((err) => {
    jobs.set(jobId, { percent: 0, status: 'error', message: err.message, outputPath: null });
    try {
      fs.rmSync(path.join(TMP_DIR, jobId), { recursive: true, force: true });
      fs.rmSync(jobUploadDir, { recursive: true, force: true });
    } catch { /* non-fatal */ }
  });
});
```

- [ ] **Step 5: Verify syntax**

```bash
node --check server.js
```
Must print nothing.

- [ ] **Step 6: End-to-end pipeline test**

Start the server, then run (adjust the image paths to real files on this machine — any 2+ images of different resolutions is the most useful test):

```bash
mkdir -p /tmp/slideshow-test-out 2>/dev/null || true
JOB=$(curl -s -X POST http://localhost:1010/api/new-job | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).jobId))")
UP=$(curl -s -X POST http://localhost:1010/api/upload-images-from-path -H "Content-Type: application/json" -d "{\"jobId\":\"$JOB\",\"fullPaths\":[\"C:\\\\Windows\\\\Web\\\\Wallpaper\\\\Theme1\\\\img1.jpg\",\"C:\\\\Windows\\\\Web\\\\Wallpaper\\\\Theme1\\\\img2.jpg\"]}")
echo "$UP"
FILENAMES=$(node -e "const d=$UP; console.log(JSON.stringify(d.files.map(f=>({filename:f.filename}))))")
curl -s -X POST http://localhost:1010/api/generate-images -H "Content-Type: application/json" -d "{\"jobId\":\"$JOB\",\"images\":$FILENAMES,\"destFolder\":\"C:\\\\Users\\\\VB\\\\Downloads\\\\00_AI_Projects\\\\Claude\\\\MergeVideos\\\\output\"}"
# Poll until status is done or error:
for i in $(seq 1 60); do
  sleep 2
  STATUS=$(curl -s http://localhost:1010/api/progress/$JOB)
  echo "$STATUS"
  echo "$STATUS" | grep -q '"status":"done"' && break
  echo "$STATUS" | grep -q '"status":"error"' && break
done
```
Expected: final `status` is `"done"`, with an `outputPath` pointing at a real file. Confirm it:

```bash
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1 "<outputPath from above>"
```
For 2 images at `IMAGE_DURATION=3`/`CROSSFADE_DURATION=0.8`, expect a duration near `5.2` seconds (`2*3 - 0.8`). Play the file (or open it in the project's `output/` folder) and visually confirm: a slow zoom on each image, a smooth crossfade between them, no audio, no letterboxing. Then test the `n === 1` path the same way with a single image and confirm it still produces a valid ~3s video (no crossfade needed). Stop the server after checking.

- [ ] **Step 7: Commit**

```bash
git add server.js
git commit -m "feat: add image slideshow ffmpeg pipeline and generate-images endpoint"
```

---

## Task 6: Frontend — `public/images.html`

**Files:**
- Create: `public/images.html`

**Interfaces:**
- Consumes: `public/styles.css` (Task 1), `public/youtube-upload.js` (Task 2, providing global `initYoutubeUpload`), `public/images.js` (Task 7).
- Produces: element ids `imagesContainer`, `browseImagesBtn`, `destFolder`, `browseBtn`, `generateBtn`, `progressWrap`/`progressBar`/`progressPercent`/`progressStatus`, `alertArea`, `youtubeCard` (and its inner `yt*` ids, identical markup to `index.html`'s).

- [ ] **Step 1: Create the page**

```html
<!doctype html>
<html lang="en" data-bs-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MergeVideos — Image Slideshow</title>
<link href="vendor/bootstrap/css/bootstrap.min.css" rel="stylesheet">
<link href="styles.css" rel="stylesheet">
</head>
<body>

<div class="app-header text-center">
  <h1 class="h3 mb-1">🖼️ Image Slideshow</h1>
  <p class="mb-0 opacity-75">Turn a stack of images into one compressed video</p>
</div>

<div class="container" style="max-width: 860px;">

  <a href="index.html" class="d-inline-block mb-3">&larr; Back to merge videos</a>

  <div id="imagesContainer"></div>

  <div class="d-flex gap-2 mb-4">
    <button id="browseImagesBtn" type="button" class="btn btn-outline-primary">
      🖼️ Browse Images...
    </button>
  </div>

  <div class="card shadow-sm mb-4">
    <div class="card-body">
      <label class="form-label fw-semibold">Destination Folder</label>
      <div class="input-group">
        <input type="text" id="destFolder" class="form-control" placeholder="Choose where to save the slideshow video..." readonly>
        <button id="browseBtn" class="btn btn-outline-secondary" type="button">Browse...</button>
      </div>
    </div>
  </div>

  <div class="d-grid mb-4">
    <button id="generateBtn" class="btn btn-primary btn-lg" type="button" disabled>Generate Video</button>
  </div>

  <div id="progressWrap" class="card shadow-sm mb-4">
    <div class="card-body">
      <div class="d-flex justify-content-between mb-1">
        <span id="progressStatus" class="fw-semibold">Processing...</span>
        <span id="progressPercent">0%</span>
      </div>
      <div class="progress" role="progressbar">
        <div id="progressBar" class="progress-bar progress-bar-striped progress-bar-animated" style="width:0%"></div>
      </div>
    </div>
  </div>

  <div id="alertArea"></div>

  <div id="youtubeCard" class="card shadow-sm mb-4">
    <div class="card-body">
      <h5 class="card-title">📺 Upload to YouTube</h5>

      <div class="mb-2">
        <label class="form-label small mb-1">Video file</label>
        <div class="input-group">
          <input type="text" id="ytVideoPath" class="form-control" placeholder="Choose a video file to upload..." readonly>
          <button id="ytBrowseBtn" class="btn btn-outline-secondary" type="button">Browse...</button>
        </div>
      </div>

      <div id="ytConnectWrap">
        <button id="ytConnectBtn" type="button" class="btn btn-outline-danger">Connect YouTube Account</button>
      </div>

      <div id="ytFormWrap" style="display:none">
        <div class="mb-2">
          <label class="form-label small mb-1">Title</label>
          <input type="text" id="ytTitle" class="form-control" placeholder="Video title">
        </div>
        <div class="mb-2">
          <label class="form-label small mb-1">Description</label>
          <textarea id="ytDescription" class="form-control" rows="2" placeholder="(optional)"></textarea>
        </div>
        <div class="mb-2">
          <label class="form-label small mb-1">Tags (comma-separated)</label>
          <input type="text" id="ytTags" class="form-control" placeholder="(optional)">
        </div>
        <div class="mb-3">
          <label class="form-label small mb-1">Privacy</label>
          <select id="ytPrivacy" class="form-select">
            <option value="public" selected>Public</option>
            <option value="unlisted">Unlisted</option>
            <option value="private">Private</option>
          </select>
        </div>
        <button id="ytUploadBtn" type="button" class="btn btn-danger">Upload to YouTube</button>

        <div id="ytProgressWrap" class="mt-3" style="display:none">
          <div class="d-flex justify-content-between mb-1">
            <span id="ytProgressStatus" class="fw-semibold">Uploading...</span>
            <span id="ytProgressPercent">0%</span>
          </div>
          <div class="progress" role="progressbar">
            <div id="ytProgressBar" class="progress-bar progress-bar-striped progress-bar-animated" style="width:0%"></div>
          </div>
        </div>
      </div>

      <div id="ytAlertArea" class="mt-3"></div>
    </div>
  </div>

</div>

<footer>Runs locally on your machine · port 1010</footer>

<script src="vendor/bootstrap/js/bootstrap.bundle.min.js"></script>
<script src="youtube-upload.js"></script>
<script src="images.js"></script>
</body>
</html>
```

- [ ] **Step 2: Verify it loads**

Start the server, open `http://localhost:1010/images.html`. The page should render with the same visual style as the merge page (gradient header, cards) even though `images.js` doesn't exist yet (expect a 404 in the browser console for it — that's fixed in Task 7). Confirm "← Back to merge videos" navigates to `index.html`.

- [ ] **Step 3: Commit**

```bash
git add public/images.html
git commit -m "feat: add image-slideshow page skeleton"
```

---

## Task 7: Frontend — `public/images.js` + wire up "Add Images" navigation

**Files:**
- Create: `public/images.js`
- Modify: `public/app.js` (replace the no-op `addImagesBtn` handler with navigation)

**Interfaces:**
- Consumes: `initYoutubeUpload(container)` (Task 2), `/api/browse-images`, `/api/upload-images-from-path`, `/api/generate-images`, `/api/progress/:jobId`, `/api/browse-folder`, `/api/new-job` (all existing or added in prior tasks).

- [ ] **Step 1: Wire "Add Images" to navigate to the new page**

In `public/app.js`, find:

```js
  // TODO: image support not implemented yet.
  addImagesBtn.addEventListener('click', () => {});
```

Replace with:

```js
  addImagesBtn.addEventListener('click', () => {
    window.location.href = 'images.html';
  });
```

- [ ] **Step 2: Create `public/images.js`**

```js
(() => {
  const imagesContainer = document.getElementById('imagesContainer');
  const browseImagesBtn = document.getElementById('browseImagesBtn');
  const browseBtn = document.getElementById('browseBtn');
  const destFolderInput = document.getElementById('destFolder');
  const generateBtn = document.getElementById('generateBtn');
  const alertArea = document.getElementById('alertArea');
  const progressWrap = document.getElementById('progressWrap');
  const progressBar = document.getElementById('progressBar');
  const progressPercent = document.getElementById('progressPercent');
  const progressStatus = document.getElementById('progressStatus');

  const youtubeUpload = initYoutubeUpload(document.getElementById('youtubeCard'));

  let jobId = null;
  let jobPromise = null;
  let imgCounter = 0;
  const images = []; // ordered array of { uid, filename, originalName, cardEl }

  function showAlert(message, type = 'danger') {
    alertArea.innerHTML = `
      <div class="alert alert-${type} alert-dismissible fade show" role="alert">
        ${message}
        <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
      </div>`;
  }

  function clearAlert() {
    alertArea.innerHTML = '';
  }

  async function ensureJob() {
    if (jobId) return jobId;
    if (!jobPromise) {
      jobPromise = fetch('/api/new-job', { method: 'POST' })
        .then((res) => {
          if (!res.ok) throw new Error('Could not start a new job');
          return res.json();
        })
        .then((data) => {
          jobId = data.jobId;
          return jobId;
        })
        .catch((err) => {
          jobPromise = null; // allow retry on failure
          throw err;
        });
    }
    return jobPromise;
  }

  function updateGenerateState() {
    generateBtn.disabled = !(images.length > 0 && destFolderInput.value.trim().length > 0);
  }

  function renumberRows() {
    images.forEach((entry, i) => {
      entry.upBtn.disabled = i === 0;
      entry.downBtn.disabled = i === images.length - 1;
    });
  }

  function addImageRow(filename, originalName) {
    const uid = 'img_' + (++imgCounter);
    const card = document.createElement('div');
    card.className = 'card clip-card shadow-sm mb-3';
    card.innerHTML = `
      <div class="card-body">
        <div class="row g-3 align-items-center">
          <div class="col-auto">
            <img class="clip-thumb" src="/uploads/${encodeURIComponent(jobId)}/${encodeURIComponent(filename)}" alt="thumb">
          </div>
          <div class="col">
            <div class="fw-semibold">${originalName}</div>
          </div>
          <div class="col-auto d-flex flex-column gap-1">
            <button type="button" class="btn btn-sm btn-outline-secondary move-up-btn">↑</button>
            <button type="button" class="btn btn-sm btn-outline-secondary move-down-btn">↓</button>
          </div>
          <div class="col-auto">
            <button type="button" class="btn btn-sm btn-outline-danger remove-img-btn">✕</button>
          </div>
        </div>
      </div>`;
    imagesContainer.appendChild(card);

    const entry = {
      uid,
      filename,
      originalName,
      cardEl: card,
      upBtn: card.querySelector('.move-up-btn'),
      downBtn: card.querySelector('.move-down-btn')
    };
    images.push(entry);

    entry.upBtn.addEventListener('click', () => {
      const i = images.indexOf(entry);
      if (i <= 0) return;
      const prev = images[i - 1];
      images[i - 1] = entry;
      images[i] = prev;
      imagesContainer.insertBefore(entry.cardEl, prev.cardEl);
      renumberRows();
    });

    entry.downBtn.addEventListener('click', () => {
      const i = images.indexOf(entry);
      if (i === -1 || i >= images.length - 1) return;
      const next = images[i + 1];
      images[i + 1] = entry;
      images[i] = next;
      imagesContainer.insertBefore(next.cardEl, entry.cardEl);
      renumberRows();
    });

    card.querySelector('.remove-img-btn').addEventListener('click', () => {
      const i = images.indexOf(entry);
      if (i !== -1) images.splice(i, 1);
      card.classList.add('removing');
      card.addEventListener('animationend', () => card.remove(), { once: true });
      renumberRows();
      updateGenerateState();
    });

    renumberRows();
    updateGenerateState();
  }

  browseImagesBtn.addEventListener('click', async () => {
    clearAlert();
    browseImagesBtn.disabled = true;
    browseImagesBtn.textContent = 'Waiting for dialog...';
    try {
      const browseRes = await fetch('/api/browse-images');
      const browseData = await browseRes.json();
      if (!browseRes.ok) throw new Error(browseData.error || 'Could not open file browser');
      if (!browseData.paths || browseData.paths.length === 0) return; // user cancelled

      browseImagesBtn.textContent = 'Uploading...';
      await ensureJob();
      const upRes = await fetch('/api/upload-images-from-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, fullPaths: browseData.paths })
      });
      const upData = await upRes.json();
      if (!upRes.ok) throw new Error(upData.error || 'Upload failed');

      for (const file of upData.files) {
        addImageRow(file.filename, file.originalName);
      }
      if (upData.errors && upData.errors.length > 0) {
        const list = upData.errors.map((e) => `${e.path}: ${e.error}`).join('<br>');
        showAlert(`${upData.errors.length} file(s) skipped:<br>${list}`, 'warning');
      }
    } catch (err) {
      showAlert('Image browse/upload failed: ' + err.message);
    } finally {
      browseImagesBtn.disabled = false;
      browseImagesBtn.textContent = '🖼️ Browse Images...';
      updateGenerateState();
    }
  });

  browseBtn.addEventListener('click', async () => {
    clearAlert();
    browseBtn.disabled = true;
    browseBtn.textContent = 'Waiting for dialog...';
    try {
      const res = await fetch('/api/browse-folder');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not open folder browser');
      if (data.path) {
        destFolderInput.value = data.path;
      }
    } catch (err) {
      showAlert('Folder browse failed: ' + err.message);
    } finally {
      browseBtn.disabled = false;
      browseBtn.textContent = 'Browse...';
      updateGenerateState();
    }
  });

  function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let val = bytes;
    let i = 0;
    while (val >= 1024 && i < units.length - 1) {
      val /= 1024;
      i++;
    }
    return `${val.toFixed(val >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function pollProgress() {
    const timer = setInterval(async () => {
      try {
        const res = await fetch('/api/progress/' + jobId);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Progress check failed');

        progressBar.style.width = data.percent + '%';
        progressPercent.textContent = data.percent + '%';
        progressStatus.textContent = data.message || data.status;

        if (data.status === 'done') {
          clearInterval(timer);
          progressStatus.textContent = 'Done';
          let sizeLine = '';
          if (typeof data.savedBytes === 'number' && data.compressed) {
            sizeLine = `<br>📦 Compressed ${formatBytes(data.originalSizeBytes)} → ${formatBytes(data.compressedSizeBytes)}` +
              ` — saved ${formatBytes(data.savedBytes)} (${data.savedPercent}%)` +
              `<br>📤 YouTube-safe H.264 copy saved to: <strong>${data.youtubeSafePath}</strong> (used for upload — YouTube's ingest pipeline is unreliable with HEVC)`;
          } else if (data.compressed === false) {
            sizeLine = '<br><span class="text-muted">Compression unavailable on this machine — saved uncompressed slideshow.</span>';
          }
          showAlert('✅ Slideshow video saved to: <strong>' + data.outputPath + '</strong>' + sizeLine, 'success');
          generateBtn.disabled = false;
          generateBtn.textContent = 'Generate Video';

          youtubeUpload.setVideoPath(data.youtubeSafePath || data.outputPath);
        } else if (data.status === 'error') {
          clearInterval(timer);
          showAlert('Processing failed: ' + data.message);
          generateBtn.disabled = false;
          generateBtn.textContent = 'Generate Video';
        }
      } catch (err) {
        clearInterval(timer);
        showAlert('Lost connection to progress updates: ' + err.message);
        generateBtn.disabled = false;
        generateBtn.textContent = 'Generate Video';
      }
    }, 1000);
  }

  generateBtn.addEventListener('click', async () => {
    clearAlert();
    if (images.length === 0) {
      showAlert('Add at least one image first.');
      return;
    }
    if (!destFolderInput.value.trim()) {
      showAlert('Choose a destination folder first.');
      return;
    }

    const imagesPayload = images.map((entry) => ({ filename: entry.filename }));

    generateBtn.disabled = true;
    generateBtn.textContent = 'Processing...';
    progressWrap.style.display = 'block';
    progressBar.style.width = '0%';
    progressPercent.textContent = '0%';
    progressStatus.textContent = 'Starting...';

    try {
      const res = await fetch('/api/generate-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId,
          images: imagesPayload,
          destFolder: destFolderInput.value.trim()
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start generation');
      pollProgress();
    } catch (err) {
      showAlert('Failed to start generation: ' + err.message);
      generateBtn.disabled = false;
      generateBtn.textContent = 'Generate Video';
    }
  });
})();
```

- [ ] **Step 3: Verify syntax**

```bash
node --check public/app.js
node --check public/images.js
```
Both must print nothing.

- [ ] **Step 4: End-to-end UI test**

Start the server, open `http://localhost:1010/`, click "🖼️ Add Images" — confirm it navigates to `images.html`. On that page:
1. Click "🖼️ Browse Images...", select 3+ images in the OS dialog (mix resolutions if possible). Confirm thumbnail rows appear with filenames.
2. Use ↑/↓ to reorder a row, confirm the row visually moves and the topmost row's ↑ button and bottommost row's ↓ button are disabled.
3. Remove one image with ✕, confirm it animates out and the remaining rows' arrow-button disabled states update correctly.
4. Click "Browse..." next to Destination Folder, pick a folder. Confirm "Generate Video" becomes enabled only once both images and a folder are set.
5. Click "Generate Video", watch the progress bar move through "Processing image N of M...", "Blending crossfades...", "Compressing final video...", to "Done". Confirm the success alert shows the output path and compression stats.
6. Confirm the YouTube upload card at the bottom is pre-filled with the generated video's path and behaves the same as on the merge page.

- [ ] **Step 5: Commit**

```bash
git add public/app.js public/images.js
git commit -m "feat: wire up image-slideshow page UI and Add Images navigation"
```

---

## Self-Review Notes

- **Spec coverage:** Entry point (Task 7 Step 1), browse/upload/reorder/remove UI (Task 6 + 7), destination folder + generate + progress (Task 6 + 7), ffmpeg 3-pass pipeline incl. N=1 edge case (Task 5), YouTube upload reuse (Task 2 + 6 + 7), static image serving (Task 3), shared CSS (Task 1) — all covered.
- **Placeholder scan:** No TBD/TODO left in any task; every step has literal code.
- **Type/name consistency:** `initYoutubeUpload(container)` returns `{setVideoPath(path)}` in Task 2, and both `app.js` (Task 2 Step 4) and `images.js` (Task 7 Step 2) call `youtubeUpload.setVideoPath(...)` with that exact name. `ALLOWED_IMAGE_EXT` defined in Task 3, consumed in Task 4 and implicitly relied on by Task 5's endpoint validation (filename regex, not extension, since by generate time files are already validated/copied). `roundUpEven` defined once (Task 5 Step 1, hoisted) and used by both `runPipeline` (existing) and `runImagePipeline` (Task 5 Step 3). Job result shape (`outputPath`, `youtubeSafePath`, `originalSizeBytes`, `compressedSizeBytes`, `savedBytes`, `savedPercent`, `compressed`) matches between `runPipeline` and `runImagePipeline`, and `images.js`'s `pollProgress` reads the same fields `app.js`'s does.
