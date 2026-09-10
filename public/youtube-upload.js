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
