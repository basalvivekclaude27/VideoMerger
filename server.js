const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const youtubeAuth = require('./youtube-auth');

const PORT = 1010;
const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const TMP_DIR = path.join(ROOT, 'tmp');
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2GB per file

for (const dir of [UPLOAD_DIR, TMP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

// ---- in-memory job tracking ----
// jobs: jobId -> { percent, status: 'queued'|'processing'|'done'|'error', message, outputPath }
const jobs = new Map();

// uploadId -> { percent, status: 'queued'|'processing'|'done'|'error', message, videoId, videoUrl }
const uploads = new Map();

// ---------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const jobId = req.body.jobId || req.query.jobId;
    if (!jobId || !/^[a-zA-Z0-9_-]+$/.test(jobId)) {
      return cb(new Error('Invalid jobId'));
    }
    const dir = path.join(UPLOAD_DIR, jobId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = crypto.randomBytes(6).toString('hex') + path.extname(file.originalname);
    cb(null, safe);
  }
});

// Some browsers/OSes report a generic mimetype (application/octet-stream) for
// less common containers like .mov/.mkv, so fall back to an extension
// whitelist rather than trusting mimetype alone. ffmpeg itself decodes all of
// these fine (and many more) once the file is on disk.
const ALLOWED_VIDEO_EXT = new Set([
  '.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm',
  '.wmv', '.flv', '.mpg', '.mpeg', '.3gp', '.ts', '.m2ts'
]);

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  const looksLikeVideo = file.mimetype.startsWith('video/') || ALLOWED_VIDEO_EXT.has(ext);
  if (!looksLikeVideo) {
    return cb(new Error(`Unsupported file type: ${file.originalname}`));
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE }
});

// ---------------------------------------------------------------------
// Natural sort: splits into numeric/non-numeric chunks so "00_", "01_",
// ..., "09_", "10_" sort in numeric order rather than lexicographic
// ("10_" before "2_"). Files without a leading number sort after ones
// that have one, then alphabetically among themselves.
// ---------------------------------------------------------------------
function naturalSortKey(name) {
  return name.match(/\d+|\D+/g) || [];
}

function naturalCompare(a, b) {
  const ak = naturalSortKey(a);
  const bk = naturalSortKey(b);
  const len = Math.max(ak.length, bk.length);
  for (let i = 0; i < len; i++) {
    const av = ak[i];
    const bv = bk[i];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    const an = /^\d+$/.test(av);
    const bn = /^\d+$/.test(bv);
    if (an && bn) {
      const diff = Number(av) - Number(bv);
      if (diff !== 0) return diff;
    } else {
      const diff = av.localeCompare(bv);
      if (diff !== 0) return diff;
    }
  }
  return 0;
}

// Strips a leading numeric prefix like "00_" / "01-" / "02." and the file
// extension, then turns remaining underscores/hyphens into spaces, to make
// a readable default label out of a filename such as "00_Intro.mp4".
function labelFromFilename(filename) {
  const noExt = filename.replace(/\.[^.]+$/, '');
  const noPrefix = noExt.replace(/^\d+[_\-. ]+/, '');
  return noPrefix.replace(/[_\-]+/g, ' ').trim() || noExt;
}

app.post('/api/new-job', (req, res) => {
  const jobId = crypto.randomBytes(8).toString('hex');
  fs.mkdirSync(path.join(UPLOAD_DIR, jobId), { recursive: true });
  res.json({ jobId });
});

app.post('/api/upload', (req, res) => {
  upload.single('video')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    res.json({ filename: req.file.filename });
  });
});

// ---------------------------------------------------------------------
// List video files in a folder, sorted in sequence order (00_, 01_, ...)
// ---------------------------------------------------------------------
app.get('/api/list-folder', (req, res) => {
  const dir = req.query.path;
  if (!dir || typeof dir !== 'string') {
    return res.status(400).json({ error: 'path is required' });
  }
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return res.status(400).json({ error: 'Could not read folder: ' + err.message });
  }

  const files = entries
    .filter((e) => e.isFile() && ALLOWED_VIDEO_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort(naturalCompare);

  res.json({
    files: files.map((name) => ({
      fullPath: path.join(dir, name),
      originalName: name,
      label: labelFromFilename(name)
    }))
  });
});

// ---------------------------------------------------------------------
// Copy a file already on disk (from /api/list-folder) into the job's
// upload dir, same as a browser upload but without re-sending the bytes
// through the client.
// ---------------------------------------------------------------------
app.post('/api/upload-from-path', (req, res) => {
  const { jobId, fullPath } = req.body;
  if (!jobId || !/^[a-zA-Z0-9_-]+$/.test(jobId)) {
    return res.status(400).json({ error: 'Invalid jobId' });
  }
  if (!fullPath || typeof fullPath !== 'string') {
    return res.status(400).json({ error: 'fullPath is required' });
  }
  const ext = path.extname(fullPath).toLowerCase();
  if (!ALLOWED_VIDEO_EXT.has(ext)) {
    return res.status(400).json({ error: `Unsupported file type: ${fullPath}` });
  }
  let stat;
  try {
    stat = fs.statSync(fullPath);
  } catch {
    return res.status(400).json({ error: 'File not found: ' + fullPath });
  }
  if (!stat.isFile()) {
    return res.status(400).json({ error: 'Not a file: ' + fullPath });
  }
  if (stat.size > MAX_FILE_SIZE) {
    return res.status(400).json({ error: 'File too large: ' + fullPath });
  }

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

// ---------------------------------------------------------------------
// Native Windows folder browse dialog
// ---------------------------------------------------------------------
app.get('/api/browse-folder', (req, res) => {
  const description = req.query.purpose === 'input'
    ? 'Select folder containing video clips to merge'
    : 'Select destination folder for merged video';
  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.StartPosition = 'CenterScreen'
$owner.WindowState = 'Minimized'
$owner.ShowInTaskbar = $false
$owner.Show()
$owner.Activate()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "${description}"
$dialog.ShowNewFolderButton = $true
$result = $dialog.ShowDialog($owner)
$owner.Close()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
}
`.trim();

  execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', psScript], { timeout: 120000 }, (err, stdout) => {
    if (err) {
      return res.status(500).json({ error: 'Could not open folder dialog: ' + err.message });
    }
    const selected = stdout.trim();
    res.json({ path: selected || null });
  });
});

// ---------------------------------------------------------------------
// Native Windows file browse dialog (single video file, e.g. for a
// standalone YouTube upload of a file that wasn't just produced here)
// ---------------------------------------------------------------------
app.get('/api/browse-file', (req, res) => {
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
$dialog.Title = 'Select a video file to upload'
$dialog.Filter = 'Video files|*.mp4;*.mov;*.m4v;*.avi;*.mkv;*.webm;*.wmv;*.flv;*.mpg;*.mpeg;*.3gp;*.ts;*.m2ts|All files|*.*'
$dialog.Multiselect = $false
$result = $dialog.ShowDialog($owner)
$owner.Close()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.FileName
}
`.trim();

  execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', psScript], { timeout: 120000 }, (err, stdout) => {
    if (err) {
      return res.status(500).json({ error: 'Could not open file dialog: ' + err.message });
    }
    const selected = stdout.trim();
    res.json({ path: selected || null });
  });
});

// ---------------------------------------------------------------------
// Generate (merge + label + compress)
// ---------------------------------------------------------------------
app.post('/api/generate', (req, res) => {
  const { jobId, clips, destFolder } = req.body;

  if (!jobId || !Array.isArray(clips) || clips.length === 0) {
    return res.status(400).json({ error: 'jobId and at least one clip are required' });
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
  for (const clip of clips) {
    if (!clip.filename || !/^[a-f0-9]+(\.[a-zA-Z0-9]+)?$/.test(clip.filename)) {
      return res.status(400).json({ error: 'Invalid clip filename' });
    }
    const full = path.join(jobUploadDir, clip.filename);
    if (!fs.existsSync(full)) {
      return res.status(400).json({ error: 'Uploaded file missing: ' + clip.filename });
    }
  }

  // Safety net: if every clip's original filename carries a leading numeric
  // prefix (00_, 01_, ...), trust that sequence over whatever order the
  // clips array arrived in, so manually-added-out-of-order clips still
  // merge in filename sequence.
  const allPrefixed = clips.every((c) => c.originalName && /^\d+[_\-. ]/.test(c.originalName));
  if (allPrefixed) {
    clips.sort((a, b) => naturalCompare(a.originalName, b.originalName));
  }

  jobs.set(jobId, { percent: 0, status: 'queued', message: 'Queued', outputPath: null });
  res.json({ jobId });

  runPipeline(jobId, clips, destFolder).catch((err) => {
    jobs.set(jobId, { percent: 0, status: 'error', message: err.message, outputPath: null });
    try {
      fs.rmSync(path.join(TMP_DIR, jobId), { recursive: true, force: true });
      fs.rmSync(jobUploadDir, { recursive: true, force: true });
    } catch { /* non-fatal */ }
  });
});

app.get('/api/progress/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown job' });
  res.json(job);
});

// ---------------------------------------------------------------------
// YouTube upload
// ---------------------------------------------------------------------
app.get('/api/youtube/auth-status', (req, res) => {
  res.json(youtubeAuth.getAuthStatus());
});

app.get('/api/youtube/authorize', async (req, res) => {
  try {
    await youtubeAuth.startAuthFlow();
    res.json({ connected: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const ALLOWED_PRIVACY = new Set(['public', 'unlisted', 'private']);

app.post('/api/youtube/upload', (req, res) => {
  const { outputPath, title, description, tags, privacyStatus } = req.body;

  if (!outputPath || typeof outputPath !== 'string') {
    return res.status(400).json({ error: 'outputPath is required' });
  }
  let stat;
  try {
    stat = fs.statSync(outputPath);
  } catch {
    return res.status(400).json({ error: 'File not found: ' + outputPath });
  }
  if (!stat.isFile()) {
    return res.status(400).json({ error: 'Not a file: ' + outputPath });
  }
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  const privacy = ALLOWED_PRIVACY.has(privacyStatus) ? privacyStatus : 'public';

  const uploadId = crypto.randomBytes(8).toString('hex');
  uploads.set(uploadId, { percent: 0, status: 'queued', message: 'Queued', videoId: null, videoUrl: null });
  res.json({ uploadId });

  runYoutubeUpload(uploadId, {
    outputPath,
    title: title.trim(),
    description: description || '',
    tags: tags || '',
    privacy,
    fileSize: stat.size
  }).catch((err) => {
    uploads.set(uploadId, { percent: 0, status: 'error', message: err.message, videoId: null, videoUrl: null });
  });
});

app.get('/api/youtube/upload-progress/:uploadId', (req, res) => {
  const u = uploads.get(req.params.uploadId);
  if (!u) return res.status(404).json({ error: 'Unknown upload' });
  res.json(u);
});

async function runYoutubeUpload(uploadId, { outputPath, title, description, tags, privacy, fileSize }) {
  const setUpload = (patch) => uploads.set(uploadId, { ...uploads.get(uploadId), ...patch });
  setUpload({ status: 'processing', message: 'Uploading to YouTube...', percent: 1 });

  const auth = await youtubeAuth.getAuthorizedClient();

  const tagList = tags
    ? tags.split(',').map((t) => t.trim()).filter(Boolean)
    : undefined;

  // Resumable, byte-verified upload — see youtube-auth.js for why this
  // replaced a single-shot media upload (that was the source of videos
  // arriving on YouTube with repeated/missing/desynced sections).
  const response = await youtubeAuth.uploadVideoResumable(auth, {
    filePath: outputPath,
    fileSize,
    metadata: {
      snippet: { title, description, tags: tagList },
      status: { privacyStatus: privacy }
    },
    onProgress: (bytesUploaded) => {
      // Cap display at 99% — YouTube still has to finish processing the
      // upload server-side after the last byte is sent, and the response
      // (and our 'done' state) only arrives after that.
      const percent = fileSize ? Math.min(99, Math.round((bytesUploaded / fileSize) * 100)) : 0;
      setUpload({ percent, message: `Uploading... ${percent}%` });
    }
  });

  const videoId = response.id;
  setUpload({
    status: 'done',
    percent: 100,
    message: 'Uploaded',
    videoId,
    videoUrl: `https://youtu.be/${videoId}`
  });
}

// ---------------------------------------------------------------------
// Pipeline helpers
// ---------------------------------------------------------------------
function escapeDrawtext(text) {
  // escape for ffmpeg drawtext filter: backslash, colon, single quote
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "’");
}

// Windows ffmpeg builds have no fontconfig config, so drawtext must be given
// an explicit font file or it crashes (fontconfig "no default config" error).
function findSystemFont() {
  const candidates = [
    'C:/Windows/Fonts/segoeui.ttf',
    'C:/Windows/Fonts/arial.ttf',
    'C:/Windows/Fonts/tahoma.ttf'
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) return f;
  }
  return null;
}
const SYSTEM_FONT = findSystemFont();

function ffprobe(filePath) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate,avg_frame_rate',
      '-of', 'json',
      filePath
    ], (err, stdout) => {
      if (err) return reject(new Error('ffprobe failed: ' + err.message));
      try {
        const data = JSON.parse(stdout);
        const stream = data.streams[0];
        // avg_frame_rate is the true measured rate (frame count / duration);
        // r_frame_rate is just a nominal guess and can be way off for
        // variable-frame-rate sources (common from phones/screen recorders),
        // which is a major cause of audio/video drift once we force CFR.
        const parseRate = (s) => {
          if (!s) return 0;
          const [num, den] = s.split('/').map(Number);
          return den ? num / den : num;
        };
        const fps = parseRate(stream.avg_frame_rate) || parseRate(stream.r_frame_rate);
        resolve({ width: stream.width, height: stream.height, fps: Math.round(fps) || 30 });
      } catch (e) {
        reject(new Error('Could not parse ffprobe output for ' + filePath));
      }
    });
  });
}

function getDuration(filePath) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'json',
      filePath
    ], (err, stdout) => {
      if (err) return reject(new Error('ffprobe duration failed: ' + err.message));
      try {
        const data = JSON.parse(stdout);
        resolve(parseFloat(data.format.duration) || 0);
      } catch (e) {
        reject(new Error('Could not parse duration for ' + filePath));
      }
    });
  });
}

function runFfmpeg(args, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', ...args]);
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      const str = chunk.toString();
      stderr += str;
      const match = str.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (match && onProgress) {
        const seconds = (+match[1]) * 3600 + (+match[2]) * 60 + (+match[3]);
        onProgress(seconds);
      }
    });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg exited with code ' + code + ': ' + stderr.slice(-800)));
    });
    proc.on('error', (err) => reject(err));
  });
}

async function runPipeline(jobId, clips, destFolder) {
  const jobUploadDir = path.join(UPLOAD_DIR, jobId);
  const jobTmpDir = path.join(TMP_DIR, jobId);
  fs.mkdirSync(jobTmpDir, { recursive: true });

  const setJob = (patch) => jobs.set(jobId, { ...jobs.get(jobId), ...patch });

  setJob({ status: 'processing', message: 'Analyzing videos...', percent: 1 });

  const inputPaths = clips.map((c) => path.join(jobUploadDir, c.filename));

  // Target canvas = the largest width/height/fps across ALL clips, not just
  // the first one. Clips are sequenced 00_, 01_, ... by filename, which has
  // no relation to quality — a low-res clip placed first must not force
  // every higher-res clip in the merge to be downscaled to match it.
  const probes = [];
  for (const p of inputPaths) probes.push(await ffprobe(p));
  const roundUpEven = (n) => Math.ceil(n / 2) * 2;
  const target = {
    width: roundUpEven(Math.max(...probes.map((p) => p.width))),
    height: roundUpEven(Math.max(...probes.map((p) => p.height))),
    fps: Math.max(...probes.map((p) => p.fps))
  };

  const durations = [];
  for (const p of inputPaths) durations.push(await getDuration(p));
  const totalDuration = durations.reduce((a, b) => a + b, 0) || 1;

  // Weighted progress: normalize pass + concat pass + final compress pass
  let doneSeconds = 0;
  const normalizeWeight = 0.45;
  const concatWeight = 0.1;
  const compressWeight = 0.45;

  const segmentPaths = [];
  for (let i = 0; i < clips.length; i++) {
    const label = (clips[i].label || '').trim();
    const inPath = inputPaths[i];
    const outPath = path.join(jobTmpDir, `seg_${i}.mp4`);
    segmentPaths.push(outPath);

    setJob({ message: `Processing clip ${i + 1} of ${clips.length}: ${label || '(no label)'}` });

    const vf = [
      `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease`,
      `pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      `fps=${target.fps}`,
      // Force standard 8-bit 4:2:0 output. Some sources (HEVC Main10 .MOV,
      // e.g. iPhone recordings) decode as 10-bit (yuv420p10le); left alone,
      // libx264 here happily encodes those as 10-bit H.264 (High10
      // profile) while normal 8-bit sources encode as regular H.264.
      // Mixing bit depths across segments breaks the final -c copy concat
      // and produces a file most players (Windows' built-in Movies & TV
      // included) reject as "unsupported encoding settings". Every segment
      // must share the same 8-bit format.
      'format=yuv420p'
    ];

    if (label) {
      const safeText = escapeDrawtext(label);
      const fontSize = Math.max(18, Math.round(target.height * 0.045));
      const fontOpt = SYSTEM_FONT ? `fontfile='${SYSTEM_FONT.replace(/:/g, '\\:')}':` : '';
      const labelDuration = Math.min(5, durations[i]);
      const fadeDur = Math.min(0.4, labelDuration / 3);
      // Smooth fade in/out instead of a hard cut: alpha ramps 0->1 over fadeDur,
      // holds at 1, then ramps back to 0 over the last fadeDur before hiding.
      const alphaExpr =
        `if(lt(t\\,${fadeDur})\\,t/${fadeDur}\\,` +
        `if(lt(t\\,${labelDuration}-${fadeDur})\\,1\\,` +
        `if(lt(t\\,${labelDuration})\\,(${labelDuration}-t)/${fadeDur}\\,0)))`;
      vf.push(
        `drawtext=${fontOpt}text='${safeText}':fontcolor=white:fontsize=${fontSize}:` +
        `box=1:boxcolor=black@0.55:boxborderw=12:x=(w-text_w)/2:y=h-text_h-${Math.round(target.height * 0.05)}:` +
        `alpha='${alphaExpr}':enable='between(t\\,0\\,${labelDuration})'`
      );
    }

    const clipDuration = durations[i];
    const args = [
      // Regenerate any missing/broken timestamps before decoding — some
      // source files (VFR recordings, certain .mov exports) carry
      // unreliable PTS that would otherwise seed A/V drift downstream.
      '-fflags', '+genpts',
      '-i', inPath,
      // Explicit stream selection: some sources (observed: a .mov with
      // audio as stream 0, video as stream 1) don't put video first, so
      // don't rely on ffmpeg's default "best stream" guess.
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-vf', vf.join(','),
      '-r', String(target.fps),
      // Force true constant frame rate output. Several source clips are
      // variable-frame-rate (their declared r_frame_rate doesn't match
      // their actual average) — without this, frame duplication/drop to
      // hit -r is uneven and the video timeline drifts from audio.
      '-fps_mode', 'cfr',
      '-c:v', 'libx264',
      // 'slow' spends more encode time finding better rate-distortion
      // trade-offs than 'medium' — smaller file at the SAME crf-defined
      // visual quality, not lower quality. CRF (not preset) is what sets
      // the quality ceiling, so this is a free compression win.
      '-preset', 'slow',
      '-crf', '20',
      '-c:a', 'aac',
      '-b:a', '192k',
      // Normalize every clip's audio to one common sample rate/channel
      // layout. Source clips mix 44.1kHz and 48kHz (and one is mono) —
      // concatenating segments with differing audio formats is what was
      // producing the pitch/quality change ("sound got changed").
      '-ar', '48000',
      '-ac', '2',
      // loudnorm: normalize every clip to the same integrated loudness
      // (-16 LUFS, the streaming-platform standard) so quiet clips get
      // boosted and loud clips stay capped — consistent volume across the
      // whole merge instead of some clips sounding much quieter than
      // others. TP=-1.5 caps true peaks so boosted-up clips don't clip.
      // This is a gain/dynamics filter only, not pitch-shifting, so pitch
      // stays natural. aresample=async after it resyncs audio to the
      // video timeline, compensating for any drift already present in the
      // source and for the 0.14s audio/video start offset seen in one of
      // the test clips.
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=async=1:first_pts=0',
      '-avoid_negative_ts', 'make_zero',
      // AAC encodes in fixed 1024-sample frames, so the encoded audio
      // track always overshoots the (frame-accurate CFR) video track by
      // a fraction of a frame — and without -shortest it overshoots by
      // SEVERAL frames' worth of extra tail padding from the loudnorm/
      // aresample buffering. Concat below is a plain stream-copy append
      // with no per-boundary resync, so that per-segment overshoot adds
      // up across every clip — audible drift and, on long merges, video
      // visibly falling behind its audio. -shortest caps audio to the
      // video's length, cutting each segment's overshoot down to the
      // unavoidable <1-frame (~10-20ms) AAC quantization floor.
      '-shortest',
      '-movflags', '+faststart',
      outPath
    ];

    const segStartSeconds = doneSeconds;
    await runFfmpeg(args, (seconds) => {
      const clipProgress = Math.min(seconds, clipDuration);
      const overall = ((segStartSeconds + clipProgress) / totalDuration) * normalizeWeight;
      setJob({ percent: Math.round(overall * 100) });
    });
    doneSeconds += clipDuration;
  }

  setJob({ message: 'Merging clips...', percent: Math.round(normalizeWeight * 100) });

  const listFile = path.join(jobTmpDir, 'concat_list.txt');
  const listContent = segmentPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(listFile, listContent);

  // Concat first into a TMP file, not straight into destFolder — the
  // compression pass below re-encodes this into the real output, so this
  // copy never needs to leave tmp.
  const concatOutputPath = path.join(jobTmpDir, 'concat_output.mp4');

  // Every segment was normalized to identical params above (same fps/
  // resolution/codec, 48kHz stereo audio), so this is the standard
  // supported case for concat-demuxer stream copy: no second re-encode
  // generation, which keeps the sync fix from the normalize pass intact
  // and avoids further quality loss.
  await runFfmpeg([
    '-f', 'concat',
    '-safe', '0',
    '-i', listFile,
    '-c', 'copy',
    '-movflags', '+faststart',
    concatOutputPath
  ], (seconds) => {
    const overall = normalizeWeight + Math.min(seconds / totalDuration, 1) * concatWeight;
    setJob({ percent: Math.round(overall * 100) });
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputFilename = `merged_output_${timestamp}.mp4`;
  const finalOutputPath = path.join(destFolder, outputFilename);
  const originalSizeBytes = fs.statSync(concatOutputPath).size;

  setJob({ message: 'Compressing final video...', percent: Math.round((normalizeWeight + concatWeight) * 100) });

  let compressed = false;
  try {
    // Re-encode H.264 -> H.265/HEVC. HEVC needs roughly half the bitrate of
    // H.264 for the same perceived quality, so this shrinks the file
    // substantially at a CRF chosen to stay visually indistinguishable from
    // the source (not just "smaller"). Audio is stream-copied (already
    // normalized above) so it isn't touched by a second lossy encode.
    await runFfmpeg([
      '-i', concatOutputPath,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-c:v', 'libx265',
      '-preset', 'medium',
      '-crf', '23',
      '-tag:v', 'hvc1', // so Windows/QuickTime/Movies&TV recognize the HEVC file
      '-c:a', 'copy',
      '-movflags', '+faststart',
      finalOutputPath
    ], (seconds) => {
      const overall = normalizeWeight + concatWeight + Math.min(seconds / totalDuration, 1) * compressWeight;
      setJob({ percent: Math.round(overall * 100) });
    });
    compressed = true;
  } catch (err) {
    // No libx265 in this ffmpeg build, or the encode otherwise failed —
    // fall back to the already-merged file rather than losing the job.
    fs.copyFileSync(concatOutputPath, finalOutputPath);
  }

  const compressedSizeBytes = fs.statSync(finalOutputPath).size;
  const savedBytes = Math.max(0, originalSizeBytes - compressedSizeBytes);
  const savedPercent = originalSizeBytes > 0 ? Math.round((savedBytes / originalSizeBytes) * 1000) / 10 : 0;

  // When compression ran, finalOutputPath is H.265/HEVC. That's great for
  // local storage (half the bitrate of H.264 at equal quality) but YouTube's
  // own ingest/transcode pipeline is documented and tested primarily
  // against H.264 — HEVC uploads are known to occasionally come out with
  // repeated/skipped/desynced sections server-side even when the uploaded
  // bytes are verified correct, which plain H.264 does not exhibit. So keep
  // a second copy of the pre-compression H.264 file specifically as the
  // upload-to-YouTube source, alongside the small HEVC file kept for disk.
  let youtubeSafePath = finalOutputPath;
  if (compressed) {
    youtubeSafePath = path.join(destFolder, `merged_output_${timestamp}_youtube-safe.mp4`);
    fs.copyFileSync(concatOutputPath, youtubeSafePath);
  }

  // cleanup temp files
  try {
    fs.rmSync(jobTmpDir, { recursive: true, force: true });
    fs.rmSync(jobUploadDir, { recursive: true, force: true });
  } catch { /* non-fatal */ }

  setJob({
    status: 'done',
    percent: 100,
    message: compressed ? 'Done' : 'Done (compression unavailable, saved uncompressed merge)',
    outputPath: finalOutputPath,
    youtubeSafePath,
    originalSizeBytes,
    compressedSizeBytes,
    savedBytes,
    savedPercent,
    compressed
  });
}

// ---------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`MergeVideos app running at http://localhost:${PORT}`);
});
