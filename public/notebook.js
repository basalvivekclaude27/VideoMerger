(() => {
  const imagesContainer = document.getElementById('imagesContainer');
  const browseImagesBtn = document.getElementById('browseImagesBtn');
  const browseBtn = document.getElementById('browseBtn');
  const destFolderInput = document.getElementById('destFolder');
  const generateBtn = document.getElementById('generateBtn');
  const alertArea = document.getElementById('alertArea');

  let jobId = null;
  let jobPromise = null;
  let imgCounter = 0;
  const images = []; // ordered array of { uid, filename, originalName, cardEl, upBtn, downBtn }

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
    generateBtn.textContent = 'Generating...';

    try {
      const res = await fetch('/api/generate-notebook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId,
          images: imagesPayload,
          destFolder: destFolderInput.value.trim()
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not generate notebook');
      showAlert('✅ Notebook saved to: <strong>' + data.outputPath + '</strong> — open it in any browser.', 'success');
    } catch (err) {
      showAlert('Failed to generate notebook: ' + err.message);
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = 'Generate Notebook';
      updateGenerateState();
    }
  });
})();
