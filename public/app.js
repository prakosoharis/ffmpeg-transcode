const form = document.querySelector('#transcodeForm');
const attachForm = document.querySelector('#attachForm');
const fileInput = document.querySelector('#videoInput');
const subtitleInput = document.querySelector('#subtitleInput');
const attachSubtitleInput = document.querySelector('#attachSubtitleInput');
const dropZone = document.querySelector('#dropZone');
const fileName = document.querySelector('#fileName');
const subtitleName = document.querySelector('#subtitleName');
const subtitleTracks = document.querySelector('#subtitleTracks');
const attachSubtitleName = document.querySelector('#attachSubtitleName');
const attachSubtitleTracks = document.querySelector('#attachSubtitleTracks');
const ladderList = document.querySelector('#ladderList');
const executeBtn = document.querySelector('#executeBtn');
const progressState = document.querySelector('#progressState');
const progressPercent = document.querySelector('#progressPercent');
const progressBar = document.querySelector('#progressBar');
const frameMetric = document.querySelector('#frameMetric');
const fpsMetric = document.querySelector('#fpsMetric');
const speedMetric = document.querySelector('#speedMetric');
const logOutput = document.querySelector('#logOutput');
const successDialog = document.querySelector('#successDialog');
const successText = document.querySelector('#successText');
const closeDialog = document.querySelector('#closeDialog');
const deviceLabel = document.querySelector('#deviceLabel');
const hostPathInput = document.querySelector('#hostPath');
const packagePathInput = document.querySelector('#packagePath');
const browsePath = document.querySelector('#browsePath');
const browsePackagePath = document.querySelector('#browsePackagePath');
const directoryDialog = document.querySelector('#directoryDialog');
const currentDirectory = document.querySelector('#currentDirectory');
const directoryList = document.querySelector('#directoryList');
const closeDirectory = document.querySelector('#closeDirectory');
const upDirectory = document.querySelector('#upDirectory');
const selectDirectory = document.querySelector('#selectDirectory');
const attachBtn = document.querySelector('#attachBtn');

let variants = [];
let backend = 'cpu';
let events = null;
let browsingPath = '/';
let browsingParent = null;
let activePathInput = null;

loadLadder();

fileInput.addEventListener('change', () => {
  updateFileLabel(fileInput.files[0]);
});

subtitleInput.addEventListener('change', () => {
  renderSubtitleSelection(subtitleInput, subtitleName, subtitleTracks, 'subtitleLanguage', 'subtitleName');
});

attachSubtitleInput.addEventListener('change', () => {
  renderSubtitleSelection(
    attachSubtitleInput,
    attachSubtitleName,
    attachSubtitleTracks,
    'attachSubtitleLanguage',
    'attachSubtitleName'
  );
});

['dragenter', 'dragover'].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add('is-dragging');
  });
});

['dragleave', 'drop'].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove('is-dragging');
  });
});

dropZone.addEventListener('drop', (event) => {
  const file = event.dataTransfer.files[0];
  if (!file) return;
  fileInput.files = event.dataTransfer.files;
  updateFileLabel(file);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const selected = [...document.querySelectorAll('input[name="variant"]:checked')].map((input) => input.value);
  const variantSettings = Object.fromEntries(
    selected.map((id) => [
      id,
      {
        target: document.querySelector(`[name="target-${id}"]`).value,
        maxrate: document.querySelector(`[name="maxrate-${id}"]`).value,
        bufsize: document.querySelector(`[name="bufsize-${id}"]`).value,
        codec: document.querySelector(`[name="codec-${id}"]`).value
      }
    ])
  );

  if (!fileInput.files[0]) {
    setError('Choose a source video first.');
    return;
  }
  if (!selected.length) {
    setError('Select at least one ladder rendition.');
    return;
  }
  const invalidSubtitle = [...subtitleInput.files].find((file) => !file.name.toLowerCase().endsWith('.vtt'));
  if (invalidSubtitle) {
    setError('All subtitles must use .vtt format.');
    return;
  }

  const body = new FormData(form);
  body.set('variants', JSON.stringify(selected));
  body.set('variantSettings', JSON.stringify(variantSettings));

  executeBtn.disabled = true;
  executeBtn.textContent = 'Starting...';
  setProgress({ status: 'uploading', progress: 0, log: [] });

  try {
    const response = await fetch('/api/transcode', { method: 'POST', body });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Unable to start transcoding.');
    subscribe(payload.jobId);
  } catch (error) {
    setError(error.message);
    executeBtn.disabled = false;
    executeBtn.textContent = 'Execute Transcoding';
  }
});

closeDialog.addEventListener('click', () => successDialog.close());
browsePath.addEventListener('click', () => {
  activePathInput = hostPathInput;
  const startPath = hostPathInput.value.trim() || '/';
  openDirectoryBrowser(startPath);
});
browsePackagePath.addEventListener('click', () => {
  activePathInput = packagePathInput;
  const startPath = packagePathInput.value.trim() || hostPathInput.value.trim() || '/';
  openDirectoryBrowser(startPath);
});
closeDirectory.addEventListener('click', () => directoryDialog.close());
upDirectory.addEventListener('click', () => {
  if (browsingParent) loadDirectory(browsingParent);
});
selectDirectory.addEventListener('click', () => {
  (activePathInput || hostPathInput).value = browsingPath;
  directoryDialog.close();
});

attachForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!packagePathInput.value.trim()) {
    setError('Choose an existing HLS package folder.');
    return;
  }
  if (!attachSubtitleInput.files.length) {
    setError('Choose at least one .vtt subtitle to attach.');
    return;
  }
  const invalidSubtitle = [...attachSubtitleInput.files].find((file) => !file.name.toLowerCase().endsWith('.vtt'));
  if (invalidSubtitle) {
    setError('All subtitles must use .vtt format.');
    return;
  }

  attachBtn.disabled = true;
  attachBtn.textContent = 'Attaching...';

  try {
    const body = new FormData(attachForm);
    const response = await fetch('/api/attach-subtitles', { method: 'POST', body });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Unable to attach subtitles.');
    setProgress({ status: 'complete', progress: 100, message: payload.message, log: [payload.message] });
  } catch (error) {
    setError(error.message);
  } finally {
    attachBtn.disabled = false;
    attachBtn.textContent = 'Attach Subtitles';
  }
});

async function loadLadder() {
  const response = await fetch('/api/ladder');
  const payload = await response.json();
  variants = payload.variants;
  backend = payload.backend || 'cpu';
  deviceLabel.textContent = payload.backendDetails?.label || 'CPU FFmpeg';
  ladderList.innerHTML = variants.map(renderVariant).join('');
}

function renderVariant(variant) {
  return `
    <article class="variant">
      <label class="check">
        <input type="checkbox" name="variant" value="${variant.id}" checked />
        <span></span>
      </label>
      <div class="variant-main">
        <strong>${variant.label} (${variant.width}x${variant.height})</strong>
        <div class="rate-grid">
          <label><span>Target</span><input name="target-${variant.id}" value="${variant.target}" /></label>
          <label><span>Maxrate</span><input name="maxrate-${variant.id}" value="${variant.maxrate}" /></label>
          <label><span>Bufsize</span><input name="bufsize-${variant.id}" value="${variant.bufsize}" /></label>
        </div>
      </div>
      <label class="codec">
        <span>Codec</span>
        <select name="codec-${variant.id}">
          <option value="h264" ${variant.codec === 'h264' ? 'selected' : ''}>H.264 (${backendLabel()})</option>
          <option value="hevc" ${variant.codec === 'hevc' ? 'selected' : ''}>HEVC (${backendLabel()})</option>
        </select>
      </label>
    </article>
  `;
}

function backendLabel() {
  if (backend === 'videotoolbox') return 'via VideoToolbox';
  return 'CPU';
}

function renderSubtitleSelection(input, label, container, languageName, trackName) {
  const files = [...input.files];
  label.textContent = files.length
    ? `${files.length} subtitle${files.length === 1 ? '' : 's'} selected`
    : 'No subtitles selected';
  container.innerHTML = files.map((file, index) => renderSubtitleTrack(file, index, languageName, trackName)).join('');
}

function renderSubtitleTrack(file, index, languageName, trackName) {
  const guessed = guessSubtitleMetadata(file.name, index);
  return `
    <div class="subtitle-track">
      <strong>${escapeHtml(file.name)}</strong>
      <label>
        <span>Language</span>
        <input name="${languageName}" value="${escapeHtml(guessed.language)}" maxlength="12" />
      </label>
      <label>
        <span>Track Name</span>
        <input name="${trackName}" value="${escapeHtml(guessed.name)}" />
      </label>
    </div>
  `;
}

function guessSubtitleMetadata(fileName, index) {
  const normalized = fileName.toLowerCase();
  if (/\b(en|eng|english|inggris)\b/.test(normalized)) {
    return { language: 'en', name: 'English' };
  }
  if (/\b(id|ind|indo|indonesian|indonesia)\b/.test(normalized)) {
    return { language: 'id', name: 'Indonesian' };
  }
  return index === 0
    ? { language: 'id', name: 'Indonesian' }
    : { language: 'en', name: 'English' };
}

async function openDirectoryBrowser(startPath) {
  directoryDialog.showModal();
  await loadDirectory(startPath);
}

async function loadDirectory(path) {
  currentDirectory.textContent = path;
  directoryList.innerHTML = '<div class="directory-empty">Loading...</div>';

  try {
    const response = await fetch(`/api/directories?path=${encodeURIComponent(path)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Unable to read directory.');

    browsingPath = payload.path;
    browsingParent = payload.parent;
    currentDirectory.textContent = payload.path;
    upDirectory.disabled = !payload.parent;
    directoryList.innerHTML = payload.directories.length
      ? payload.directories.map(renderDirectory).join('')
      : '<div class="directory-empty">No folders found.</div>';

    document.querySelectorAll('[data-directory]').forEach((button) => {
      button.addEventListener('click', () => loadDirectory(button.dataset.directory));
    });
  } catch (error) {
    directoryList.innerHTML = `<div class="directory-empty">${escapeHtml(error.message)}</div>`;
  }
}

function renderDirectory(directory) {
  return `
    <button class="directory-row" type="button" data-directory="${escapeHtml(directory.path)}">
      <span class="folder-mark"></span>
      <span>${escapeHtml(directory.name)}</span>
    </button>
  `;
}

function subscribe(jobId) {
  if (events) events.close();
  events = new EventSource(`/api/jobs/${jobId}/events`);
  events.addEventListener('snapshot', (event) => setProgress(JSON.parse(event.data)));
  events.addEventListener('progress', (event) => {
    const job = JSON.parse(event.data);
    setProgress(job);
    if (job.status === 'complete') {
      events.close();
      executeBtn.disabled = false;
      executeBtn.textContent = 'Execute Transcoding';
      successText.textContent = job.message;
      successDialog.showModal();
    }
    if (job.status === 'failed') {
      events.close();
      executeBtn.disabled = false;
      executeBtn.textContent = 'Execute Transcoding';
    }
  });
  events.onerror = () => {
    setError('Progress stream disconnected.');
    executeBtn.disabled = false;
    executeBtn.textContent = 'Execute Transcoding';
  };
}

function setProgress(job) {
  const progress = Number(job.progress || 0);
  progressState.textContent = job.message || titleCase(job.status || 'idle');
  progressPercent.textContent = `${progress.toFixed(1)}%`;
  progressBar.style.width = `${Math.min(100, progress)}%`;
  frameMetric.textContent = `frame ${job.frame || '-'}`;
  fpsMetric.textContent = `fps ${job.fps || '-'}`;
  speedMetric.textContent = `speed ${job.speed || '-'}`;
  logOutput.textContent = (job.log || []).join('\n');

  if (job.status === 'failed') {
    progressState.textContent = job.error || 'Transcoding failed.';
  }
}

function setError(message) {
  setProgress({ status: 'failed', progress: 0, error: message, log: [message] });
}

function updateFileLabel(file) {
  fileName.textContent = file ? file.name : 'Drop a .mov, .mpeg, or .mp4 file here';
}

function titleCase(value) {
  return String(value).replace(/^\w/, (letter) => letter.toUpperCase());
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    }[character];
  });
}
