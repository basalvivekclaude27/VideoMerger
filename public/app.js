(() => {
  const clipsContainer = document.getElementById('clipsContainer');
  const addClipBtn = document.getElementById('addClipBtn');
  const loadFolderBtn = document.getElementById('loadFolderBtn');
  const addImagesBtn = document.getElementById('addImagesBtn');
  const browseBtn = document.getElementById('browseBtn');
  const destFolderInput = document.getElementById('destFolder');
  const generateBtn = document.getElementById('generateBtn');
  const alertArea = document.getElementById('alertArea');
  const progressWrap = document.getElementById('progressWrap');
  const progressBar = document.getElementById('progressBar');
  const progressPercent = document.getElementById('progressPercent');
  const progressStatus = document.getElementById('progressStatus');

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

  let jobId = null;
  let jobPromise = null;
  let clipCounter = 0;
  const clips = new Map(); // clipUid -> { labelEl, fileEl, filename, thumbEl, cardEl }

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
    // Multiple clip rows can call this concurrently (folder-load fires an
    // upload per file at once) — share one in-flight request so they don't
    // each mint a separate jobId/upload dir.
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
    const rows = Array.from(clips.values());
    const ready = rows.length > 0
      && rows.every((c) => c.filename && c.labelEl.value.trim().length > 0)
      && destFolderInput.value.trim().length > 0;
    generateBtn.disabled = !ready;
  }

  // prefill (optional): { label, originalName, sourcePath } — sourcePath
  // present means "upload this file already on disk server-side" (folder
  // load flow) instead of waiting on a browser file-picker change event.
  function addClipRow(prefill) {
    const uid = 'clip_' + (++clipCounter);
    const card = document.createElement('div');
    card.className = 'card clip-card shadow-sm mb-3';
    card.innerHTML = `
      <div class="card-body">
        <div class="row g-3 align-items-center">
          <div class="col-auto">
            <img class="clip-thumb" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Crect width='64' height='64' fill='%23222'/%3E%3Ctext x='32' y='38' font-size='28' fill='white' text-anchor='middle'%3E%F0%9F%8E%9E%3C/text%3E%3C/svg%3E" alt="thumb">
          </div>
          <div class="col">
            <label class="form-label small mb-1">Label text</label>
            <input type="text" class="form-control label-input" placeholder="e.g. Introduction">
            <label class="form-label small mb-1 mt-2">Video file</label>
            <input type="file" class="form-control video-input" accept="video/*">
            <div class="drop-hint mt-1 file-status">No file chosen</div>
          </div>
          <div class="col-auto">
            <button type="button" class="btn btn-sm btn-outline-danger remove-clip-btn">✕</button>
          </div>
        </div>
      </div>`;
    clipsContainer.appendChild(card);

    const labelEl = card.querySelector('.label-input');
    const fileEl = card.querySelector('.video-input');
    const statusEl = card.querySelector('.file-status');
    const removeBtn = card.querySelector('.remove-clip-btn');
    const thumbEl = card.querySelector('.clip-thumb');

    const entry = { labelEl, fileEl, filename: null, originalName: null, cardEl: card };
    clips.set(uid, entry);

    labelEl.addEventListener('input', () => {
      clearAlert();
      updateGenerateState();
    });

    function markUploaded(filename, originalName, displayName) {
      entry.filename = filename;
      entry.originalName = originalName;
      statusEl.textContent = `✓ ${displayName}`;
      thumbEl.classList.remove('uploaded');
      void thumbEl.offsetWidth; // restart animation
      thumbEl.classList.add('uploaded');
      updateGenerateState();
    }

    fileEl.addEventListener('change', async () => {
      clearAlert();
      const file = fileEl.files[0];
      if (!file) {
        statusEl.textContent = 'No file chosen';
        entry.filename = null;
        entry.originalName = null;
        updateGenerateState();
        return;
      }
      statusEl.textContent = `Uploading ${file.name}...`;
      fileEl.disabled = true;
      try {
        await ensureJob();
        const form = new FormData();
        form.append('jobId', jobId);
        form.append('video', file);
        const res = await fetch('/api/upload?jobId=' + encodeURIComponent(jobId), {
          method: 'POST',
          body: form
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        markUploaded(data.filename, file.name, file.name);
      } catch (err) {
        statusEl.textContent = 'Upload failed';
        showAlert('Upload failed for ' + file.name + ': ' + err.message);
        entry.filename = null;
        entry.originalName = null;
      } finally {
        fileEl.disabled = false;
        updateGenerateState();
      }
    });

    removeBtn.addEventListener('click', () => {
      clips.delete(uid);
      card.classList.add('removing');
      card.addEventListener('animationend', () => card.remove(), { once: true });
      updateGenerateState();
    });

    if (prefill) {
      labelEl.value = prefill.label || '';
      fileEl.style.display = 'none';
      statusEl.textContent = `Uploading ${prefill.originalName}...`;
      (async () => {
        try {
          await ensureJob();
          const res = await fetch('/api/upload-from-path', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId, fullPath: prefill.sourcePath })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Upload failed');
          markUploaded(data.filename, prefill.originalName, prefill.originalName);
        } catch (err) {
          statusEl.textContent = 'Upload failed';
          showAlert('Upload failed for ' + prefill.originalName + ': ' + err.message);
        }
      })();
    }

    updateGenerateState();
    return entry;
  }

  addClipBtn.addEventListener('click', () => addClipRow());

  // TODO: image support not implemented yet.
  addImagesBtn.addEventListener('click', () => {});

  loadFolderBtn.addEventListener('click', async () => {
    clearAlert();
    loadFolderBtn.disabled = true;
    loadFolderBtn.textContent = 'Waiting for dialog...';
    try {
      const browseRes = await fetch('/api/browse-folder?purpose=input');
      const browseData = await browseRes.json();
      if (!browseRes.ok) throw new Error(browseData.error || 'Could not open folder browser');
      if (!browseData.path) return; // user cancelled

      loadFolderBtn.textContent = 'Loading...';
      const listRes = await fetch('/api/list-folder?path=' + encodeURIComponent(browseData.path));
      const listData = await listRes.json();
      if (!listRes.ok) throw new Error(listData.error || 'Could not read folder');
      if (listData.files.length === 0) {
        showAlert('No video files found in that folder.');
        return;
      }

      // Replace any empty starter rows, keep already-filled rows as-is.
      for (const [uid, entry] of Array.from(clips.entries())) {
        if (!entry.filename && !entry.labelEl.value.trim()) {
          clips.delete(uid);
          entry.cardEl.remove();
        }
      }

      for (const file of listData.files) {
        addClipRow({ label: file.label, originalName: file.originalName, sourcePath: file.fullPath });
      }
    } catch (err) {
      showAlert('Folder load failed: ' + err.message);
    } finally {
      loadFolderBtn.disabled = false;
      loadFolderBtn.textContent = '📂 Load Folder...';
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
            sizeLine = '<br><span class="text-muted">Compression unavailable on this machine — saved uncompressed merge.</span>';
          }
          showAlert('✅ Merged video saved to: <strong>' + data.outputPath + '</strong>' + sizeLine, 'success');
          generateBtn.disabled = false;
          generateBtn.textContent = 'Generate';

          ytVideoPath.value = data.youtubeSafePath || data.outputPath;
          ytAlertArea.innerHTML = '';
        } else if (data.status === 'error') {
          clearInterval(timer);
          showAlert('Processing failed: ' + data.message);
          generateBtn.disabled = false;
          generateBtn.textContent = 'Generate';
        }
      } catch (err) {
        clearInterval(timer);
        showAlert('Lost connection to progress updates: ' + err.message);
        generateBtn.disabled = false;
        generateBtn.textContent = 'Generate';
      }
    }, 1000);
  }

  generateBtn.addEventListener('click', async () => {
    clearAlert();
    const rows = Array.from(clips.values());
    if (rows.length === 0) {
      showAlert('Add at least one video first.');
      return;
    }
    const missing = rows.find((c) => !c.filename || !c.labelEl.value.trim());
    if (missing) {
      showAlert('Every clip needs both a label and an uploaded video file.');
      return;
    }
    if (!destFolderInput.value.trim()) {
      showAlert('Choose a destination folder first.');
      return;
    }

    const clipsPayload = rows.map((c) => ({
      filename: c.filename,
      label: c.labelEl.value.trim(),
      originalName: c.originalName
    }));

    generateBtn.disabled = true;
    generateBtn.textContent = 'Processing...';
    progressWrap.style.display = 'block';
    progressBar.style.width = '0%';
    progressPercent.textContent = '0%';
    progressStatus.textContent = 'Starting...';

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId,
          clips: clipsPayload,
          destFolder: destFolderInput.value.trim()
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start generation');
      pollProgress();
    } catch (err) {
      showAlert('Failed to start generation: ' + err.message);
      generateBtn.disabled = false;
      generateBtn.textContent = 'Generate';
    }
  });

  // start with one clip row
  addClipRow(null);
  refreshYtConnectState();
})();
