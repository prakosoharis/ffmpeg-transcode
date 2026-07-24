const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const cors = require('cors');
const express = require('express');
const multer = require('multer');
const sanitize = require('sanitize-filename');

const PORT = Number(process.env.PORT || 7000);
const HOST_ROOT = process.env.HOST_ROOT || (process.platform === 'darwin' ? '/' : '/host');
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/tmp/transcoder-uploads';
const FFMPEG_BIN = resolveBinary('ffmpeg', process.env.FFMPEG_PATH);
const FFPROBE_BIN = resolveBinary('ffprobe', process.env.FFPROBE_PATH);
const REQUESTED_ENCODING_BACKEND = process.env.ENCODING_BACKEND || 'auto';
const ENCODING_BACKEND = resolveEncodingBackend(REQUESTED_ENCODING_BACKEND);
const ENCODING_BACKEND_DETAILS = describeEncodingBackend();
const MAX_UPLOAD_BYTES = parseBytes(process.env.MAX_UPLOAD_SIZE || process.env.MAX_UPLOAD_BYTES || '100GB');

const LADDER = {
  '4k': {
    id: '4k',
    label: '4K',
    width: 3840,
    height: 2160,
    target: '16M',
    maxrate: '24M',
    bufsize: '32M',
    codec: 'hevc',
    codecLabel: 'HEVC',
    bandwidth: 16000000
  },
  '2k': {
    id: '2k',
    label: '2K',
    width: 2560,
    height: 1440,
    target: '10M',
    maxrate: '15M',
    bufsize: '20M',
    codec: 'hevc',
    codecLabel: 'HEVC',
    bandwidth: 10000000
  },
  '1080p': {
    id: '1080p',
    label: '1080p',
    width: 1920,
    height: 1080,
    target: '5M',
    maxrate: '7.5M',
    bufsize: '10M',
    codec: 'h264',
    codecLabel: 'H.264',
    bandwidth: 5000000
  },
  '720p': {
    id: '720p',
    label: '720p',
    width: 1280,
    height: 720,
    target: '2.5M',
    maxrate: '3.75M',
    bufsize: '5M',
    codec: 'h264',
    codecLabel: 'H.264',
    bandwidth: 2500000
  },
  '360p': {
    id: '360p',
    label: '360p',
    width: 640,
    height: 360,
    target: '800k',
    maxrate: '1.2M',
    bufsize: '1.6M',
    codec: 'h264',
    codecLabel: 'H.264',
    bandwidth: 800000
  }
};

function resolveEncodingBackend(requested) {
  const normalized = String(requested || 'auto').toLowerCase();
  if (normalized === 'cpu') return 'cpu';
  if (normalized === 'videotoolbox') return hasVideoToolboxEncoders() ? 'videotoolbox' : 'cpu';
  if (process.platform === 'darwin' && hasRadeonDisplay() && hasVideoToolboxEncoders()) {
    return 'videotoolbox';
  }
  return 'cpu';
}

function describeEncodingBackend() {
  if (ENCODING_BACKEND === 'videotoolbox') {
    return {
      label: 'VideoToolbox',
      note: 'macOS hardware encoder selected'
    };
  }
  return {
    label: 'CPU FFmpeg',
    note: REQUESTED_ENCODING_BACKEND === 'auto' ? 'hardware encoder not detected' : 'CPU encoder selected'
  };
}

function hasVideoToolboxEncoders() {
  const encoders = listFfmpegEncoders();
  return encoders.includes('h264_videotoolbox') && encoders.includes('hevc_videotoolbox');
}

function listFfmpegEncoders() {
  const result = spawnSync(FFMPEG_BIN, ['-hide_banner', '-encoders'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 4
  });
  if (result.error || result.status !== 0) return '';
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function hasRadeonDisplay() {
  if (process.platform !== 'darwin') return false;
  const result = spawnSync('system_profiler', ['SPDisplaysDataType'], {
    encoding: 'utf8',
    timeout: 8000,
    maxBuffer: 1024 * 1024
  });
  if (result.error || result.status !== 0) return false;
  return /radeon|rx\s*\d+|vega|navi/i.test(result.stdout || '');
}

const app = express();
const jobs = new Map();

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${crypto.randomUUID()}${ext}`);
    }
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.fieldname === 'video' && !['.mov', '.mpeg', '.mp4'].includes(ext)) {
      cb(new Error('Only .mov, .mpeg, and .mp4 uploads are supported.'));
      return;
    }
    if (file.fieldname === 'subtitle' && ext !== '.vtt') {
      cb(new Error('Only .vtt subtitle uploads are supported.'));
      return;
    }
    if (!['video', 'subtitle'].includes(file.fieldname)) {
      cb(new Error('Unexpected upload field.'));
      return;
    }
    cb(null, true);
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/ladder', (_req, res) => {
  res.json({
    variants: Object.values(LADDER).map(formatVariantForBackend),
    backend: ENCODING_BACKEND,
    backendDetails: ENCODING_BACKEND_DETAILS
  });
});

app.get('/api/directories', async (req, res) => {
  try {
    const requested = String(req.query.path || '/');
    const hostPath = normalizeHostBrowsePath(requested);
    const containerPath = hostPathToContainer(hostPath);
    const resolvedRoot = path.resolve(HOST_ROOT);
    const resolvedPath = path.resolve(containerPath);

    if (!isPathInsideRoot(resolvedPath, resolvedRoot)) {
      return res.status(400).json({ error: 'Invalid directory path.' });
    }

    const entries = await fs.promises.readdir(resolvedPath, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => ({
        name: entry.name,
        path: path.posix.join(hostPath, entry.name)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      path: hostPath,
      parent: hostPath === '/' ? null : path.posix.dirname(hostPath),
      directories
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({
        error: 'Directory is not available inside Docker. Make sure this host folder is mounted and allowed in Docker Desktop file sharing.'
      });
    }
    res.status(400).json({ error: error.message || 'Unable to read directory.' });
  }
});

app.post(
  '/api/transcode',
  upload.fields([
    { name: 'video', maxCount: 1 },
    { name: 'subtitle', maxCount: 10 }
  ]),
  async (req, res) => {
  try {
    const videoFile = req.files?.video?.[0];
    const subtitleFiles = req.files?.subtitle || [];

    if (!videoFile) {
      cleanupUploads(...subtitleFiles);
      return res.status(400).json({ error: 'A video file is required.' });
    }

    const outputFolder = sanitize(String(req.body.outputFolder || '').trim());
    const hostPath = String(req.body.hostPath || '').trim();
    const selectedIds = parseJsonArray(req.body.variants);
    const variantSettings = parseObject(req.body.variantSettings);
    const subtitleLanguages = asArray(req.body.subtitleLanguage);
    const subtitleNames = asArray(req.body.subtitleName);

    if (!outputFolder) {
      cleanupUploads(videoFile, ...subtitleFiles);
      return res.status(400).json({ error: 'Output Folder Name is required.' });
    }

    if (!path.isAbsolute(hostPath)) {
      cleanupUploads(videoFile, ...subtitleFiles);
      return res.status(400).json({ error: 'Absolute Host Storage Path must be an absolute path.' });
    }

    const variants = selectedIds.map((id) => buildVariantConfig(id, variantSettings[id])).filter(Boolean);
    if (!variants.length) {
      cleanupUploads(videoFile, ...subtitleFiles);
      return res.status(400).json({ error: 'Select at least one bitrate ladder variant.' });
    }

    const job = createJob({
      source: videoFile.path,
      originalName: videoFile.originalname,
      hostPath,
      outputFolder,
      variants,
      subtitles: subtitleFiles.map((file, index) => ({
        source: file.path,
        originalName: file.originalname,
        language: normalizeLanguage(subtitleLanguages[index] || guessLanguageFromName(file.originalname, index)),
        name: sanitizeText(subtitleNames[index] || guessSubtitleName(file.originalname, index), 'Subtitle')
      }))
    });

    jobs.set(job.id, job);
    res.status(202).json({ jobId: job.id });
    runJob(job).catch((error) => failJob(job, error));
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to start transcoding.' });
  }
});

app.post(
  '/api/attach-subtitles',
  upload.fields([{ name: 'subtitle', maxCount: 10 }]),
  async (req, res) => {
    const subtitleFiles = req.files?.subtitle || [];

    try {
      const hostPath = String(req.body.packagePath || '').trim();
      const subtitleLanguages = asArray(req.body.attachSubtitleLanguage);
      const subtitleNames = asArray(req.body.attachSubtitleName);

      if (!path.isAbsolute(hostPath)) {
        cleanupUploads(...subtitleFiles);
        return res.status(400).json({ error: 'HLS package path must be an absolute path.' });
      }

      if (!subtitleFiles.length) {
        return res.status(400).json({ error: 'At least one .vtt subtitle is required.' });
      }

      const outputDir = hostPathToContainer(hostPath);
      const masterPath = path.join(outputDir, 'master.m3u8');
      await fs.promises.access(masterPath, fs.constants.R_OK | fs.constants.W_OK);

      const job = {
        outputDir,
        subtitles: subtitleFiles.map((file, index) => ({
          source: file.path,
          originalName: file.originalname,
          language: normalizeLanguage(subtitleLanguages[index] || guessLanguageFromName(file.originalname, index)),
          name: sanitizeText(subtitleNames[index] || guessSubtitleName(file.originalname, index), 'Subtitle')
        }))
      };

      await finalizeJob(job);
      cleanupJobFiles(job);
      res.json({
        message: `Subtitles have been attached to ${hostPath}/master.m3u8.`,
        outputPath: hostPath
      });
    } catch (error) {
      cleanupUploads(...subtitleFiles);
      res.status(400).json({ error: error.message || 'Unable to attach subtitles.' });
    }
  }
);

app.get('/api/jobs/:id/events', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.writeHead(404, { 'Content-Type': 'text/event-stream' });
    res.write(`event: error\ndata: ${JSON.stringify({ error: 'Job not found.' })}\n\n`);
    res.end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  sendSse(res, 'snapshot', serializeJob(job));
  job.clients.add(res);

  req.on('close', () => {
    job.clients.delete(res);
  });
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: `Upload file is too large. Maximum allowed size is ${formatBytes(MAX_UPLOAD_BYTES)}.`
    });
  }
  res.status(400).json({ error: error.message || 'Request failed.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`HLS transcoder listening on http://0.0.0.0:${PORT} using ${ENCODING_BACKEND_DETAILS.label}`);
});

function createJob({ source, originalName, hostPath, outputFolder, variants, subtitles }) {
  const id = crypto.randomUUID();
  const containerHostPath = hostPathToContainer(hostPath);
  const outputDir = path.join(containerHostPath, outputFolder);

  return {
    id,
    source,
    originalName,
    hostPath,
    outputFolder,
    outputDir,
    variants,
    subtitles,
    clients: new Set(),
    status: 'queued',
    progress: 0,
    duration: null,
    fps: null,
    frame: null,
    speed: null,
    log: [],
    createdAt: new Date().toISOString(),
    error: null
  };
}

async function runJob(job) {
  updateJob(job, { status: 'probing', message: 'Reading source duration.' });
  job.duration = await probeDuration(job.source);

  fs.mkdirSync(job.outputDir, { recursive: true });
  for (const variant of job.variants) {
    fs.mkdirSync(path.join(job.outputDir, variant.id), { recursive: true });
  }
  fs.accessSync(job.outputDir, fs.constants.W_OK);

  const args = buildFfmpegArgs(job);
  appendLog(job, `ffmpeg ${args.map(shellQuote).join(' ')}`);
  updateJob(job, { status: 'running', message: `Transcoding with ${ENCODING_BACKEND.toUpperCase()} backend.` });

  await new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      appendLog(job, chunk);
      parseProgress(job, chunk);
    });

    child.on('error', (error) => reject(processSpawnError(error, FFMPEG_BIN)));
    child.on('close', (code) => {
      if (code === 0) {
        finalizeJob(job)
          .then(() => {
            cleanupJobFiles(job);
            updateJob(job, {
              status: 'complete',
              progress: 100,
              message: `Transcoding Successful! HLS Master playlist (master.m3u8) and TS segments have been safely saved to ${job.hostPath}/${job.outputFolder}.`
            });
            resolve();
          })
          .catch(reject);
      } else {
        cleanupJobFiles(job);
        reject(new Error(`FFmpeg exited with code ${code}.`));
      }
    });
  });
}

async function finalizeJob(job) {
  if (!job.subtitles?.length) return;

  const subtitleDir = path.join(job.outputDir, 'subtitles');
  await fs.promises.mkdir(subtitleDir, { recursive: true });

  const tracks = [];
  for (const [index, subtitle] of job.subtitles.entries()) {
    const baseName = sanitize(path.basename(subtitle.originalName, path.extname(subtitle.originalName))) || `subtitle-${index + 1}`;
    const subtitleFileName = uniqueSubtitleFileName(baseName, subtitle.language, index);
    const subtitleRelativePath = path.posix.join('subtitles', subtitleFileName);
    const subtitleOutputPath = path.join(subtitleDir, subtitleFileName);

    await fs.promises.copyFile(subtitle.source, subtitleOutputPath);
    tracks.push({
      ...subtitle,
      uri: subtitleRelativePath,
      default: index === 0
    });
  }

  await attachSubtitlesToMasterPlaylist(job, tracks);
}

async function attachSubtitlesToMasterPlaylist(job, tracks) {
  const masterPath = path.join(job.outputDir, 'master.m3u8');
  const playlist = await fs.promises.readFile(masterPath, 'utf8');
  const groupId = 'subs';
  const subtitleLines = tracks.map((track) => {
    const defaultValue = track.default ? 'YES' : 'NO';
    return `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="${groupId}",NAME="${escapePlaylistAttribute(track.name)}",DEFAULT=${defaultValue},AUTOSELECT=YES,LANGUAGE="${escapePlaylistAttribute(track.language)}",URI="${escapePlaylistAttribute(track.uri)}"`;
  });

  const lines = playlist.split(/\r?\n/);
  const output = [];
  let insertedMedia = false;

  for (const line of lines) {
    if (line.startsWith(`#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="${groupId}"`)) {
      continue;
    }
    if (!insertedMedia && line.startsWith('#EXT-X-STREAM-INF')) {
      output.push(...subtitleLines);
      insertedMedia = true;
    }
    if (line.startsWith('#EXT-X-STREAM-INF') && !line.includes('SUBTITLES=')) {
      output.push(`${line},SUBTITLES="${groupId}"`);
    } else {
      output.push(line);
    }
  }

  await fs.promises.writeFile(masterPath, output.join('\n'), 'utf8');
}

function buildFfmpegArgs(job) {
  if (ENCODING_BACKEND === 'videotoolbox') return buildVideoToolboxFfmpegArgs(job);
  return buildCpuFfmpegArgs(job);
}

function buildCpuFfmpegArgs(job) {
  const splitLabels = job.variants.map((_, index) => `[v${index}in]`).join('');
  const filters = [`[0:v]split=${job.variants.length}${splitLabels}`];

  job.variants.forEach((variant, index) => {
    filters.push(
      `[v${index}in]scale=w=${variant.width}:h=${variant.height}:flags=lanczos[v${index}]`
    );
  });

  const args = ['-hide_banner', '-y', '-i', job.source, '-filter_complex', filters.join(';')];

  job.variants.forEach((variant, index) => {
    args.push('-map', `[v${index}]`);
    args.push('-c:v:' + index, codecForBackend(variant.codec));
    args.push('-preset:v:' + index, 'medium');
    args.push('-b:v:' + index, variant.target);
    args.push('-maxrate:v:' + index, variant.maxrate);
    args.push('-bufsize:v:' + index, variant.bufsize);
    args.push('-g:v:' + index, '60');
    args.push('-keyint_min:v:' + index, '60');
    args.push('-sc_threshold:v:' + index, '0');
  });

  args.push(
    '-an',
    '-f',
    'hls',
    '-hls_time',
    '2',
    '-hls_playlist_type',
    'vod',
    '-hls_flags',
    'independent_segments',
    '-master_pl_name',
    'master.m3u8',
    '-var_stream_map',
    job.variants.map((_, index) => `v:${index},name:${job.variants[index].id}`).join(' '),
    '-hls_segment_filename',
    path.join(job.outputDir, '%v', 'segment_%05d.ts'),
    path.join(job.outputDir, '%v', 'index.m3u8')
  );

  return args;
}

function buildVideoToolboxFfmpegArgs(job) {
  const splitLabels = job.variants.map((_, index) => `[v${index}in]`).join('');
  const filters = [`[0:v]split=${job.variants.length}${splitLabels}`];

  job.variants.forEach((variant, index) => {
    filters.push(
      `[v${index}in]scale=w=${variant.width}:h=${variant.height}:flags=lanczos,format=yuv420p[v${index}]`
    );
  });

  const args = ['-hide_banner', '-y', '-i', job.source, '-filter_complex', filters.join(';')];

  job.variants.forEach((variant, index) => {
    args.push('-map', `[v${index}]`);
    args.push('-c:v:' + index, codecForBackend(variant.codec));
    args.push('-b:v:' + index, variant.target);
    args.push('-maxrate:v:' + index, variant.maxrate);
    args.push('-bufsize:v:' + index, variant.bufsize);
    args.push('-g:v:' + index, '60');
    args.push('-keyint_min:v:' + index, '60');
    args.push('-sc_threshold:v:' + index, '0');
  });

  args.push(
    '-an',
    '-f',
    'hls',
    '-hls_time',
    '2',
    '-hls_playlist_type',
    'vod',
    '-hls_flags',
    'independent_segments',
    '-master_pl_name',
    'master.m3u8',
    '-var_stream_map',
    job.variants.map((_, index) => `v:${index},name:${job.variants[index].id}`).join(' '),
    '-hls_segment_filename',
    path.join(job.outputDir, '%v', 'segment_%05d.ts'),
    path.join(job.outputDir, '%v', 'index.m3u8')
  );

  return args;
}

function probeDuration(source) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFPROBE_BIN, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      source
    ]);

    let output = '';
    let errorOutput = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      errorOutput += chunk.toString();
    });
    child.on('error', (error) => reject(processSpawnError(error, FFPROBE_BIN)));
    child.on('close', (code) => {
      const duration = Number.parseFloat(output);
      if (code !== 0 || !Number.isFinite(duration) || duration <= 0) {
        reject(new Error(errorOutput || 'Unable to determine video duration.'));
        return;
      }
      resolve(duration);
    });
  });
}

function parseProgress(job, chunk) {
  const text = String(chunk);
  const timeMatches = [...text.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  const frameMatches = [...text.matchAll(/frame=\s*(\d+)/g)];
  const fpsMatches = [...text.matchAll(/fps=\s*([\d.]+)/g)];
  const speedMatches = [...text.matchAll(/speed=\s*([\d.]+x)/g)];

  if (frameMatches.length) {
    job.frame = Number(frameMatches.at(-1)[1]);
  }
  if (fpsMatches.length) {
    job.fps = fpsMatches.at(-1)[1];
  }
  if (speedMatches.length) {
    job.speed = speedMatches.at(-1)[1];
  }
  if (timeMatches.length && job.duration) {
    const latest = timeMatches.at(-1);
    const seconds = Number(latest[1]) * 3600 + Number(latest[2]) * 60 + Number(latest[3]);
    const progress = Math.max(0, Math.min(99.5, (seconds / job.duration) * 100));
    updateJob(job, { progress });
  } else if (frameMatches.length || fpsMatches.length || speedMatches.length) {
    broadcast(job, 'progress', serializeJob(job));
  }
}

function failJob(job, error) {
  cleanupJobFiles(job);
  updateJob(job, {
    status: 'failed',
    error: error.message || 'Transcoding failed.',
    message: error.message || 'Transcoding failed.'
  });
}

function updateJob(job, patch) {
  Object.assign(job, patch);
  broadcast(job, 'progress', serializeJob(job));
}

function broadcast(job, event, payload) {
  for (const client of job.clients) {
    sendSse(client, event, payload);
  }
}

function sendSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function serializeJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: Number(job.progress.toFixed(1)),
    duration: job.duration,
    frame: job.frame,
    fps: job.fps,
    speed: job.speed,
    outputPath: `${job.hostPath}/${job.outputFolder}`,
    message: job.message || null,
    error: job.error,
    log: job.log.slice(-20)
  };
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function buildVariantConfig(id, overrides = {}) {
  const base = LADDER[id];
  if (!base) return null;
  const codec = ['h264', 'hevc', 'h264_videotoolbox', 'hevc_videotoolbox'].includes(overrides.codec)
    ? normalizeCodec(overrides.codec)
    : base.codec;

  return {
    ...base,
    codec,
    codecLabel: codecLabelForBackend(codec),
    target: normalizeRate(overrides.target, base.target),
    maxrate: normalizeRate(overrides.maxrate, base.maxrate),
    bufsize: normalizeRate(overrides.bufsize, base.bufsize)
  };
}

function formatVariantForBackend(variant) {
  return {
    ...variant,
    codec: normalizeCodec(variant.codec),
    codecLabel: codecLabelForBackend(variant.codec)
  };
}

function normalizeCodec(codec) {
  return String(codec).includes('hevc') ? 'hevc' : 'h264';
}

function codecForBackend(codec) {
  if (ENCODING_BACKEND === 'videotoolbox') {
    return normalizeCodec(codec) === 'hevc' ? 'hevc_videotoolbox' : 'h264_videotoolbox';
  }
  return normalizeCodec(codec) === 'hevc' ? 'libx265' : 'libx264';
}

function codecLabelForBackend(codec) {
  const family = normalizeCodec(codec) === 'hevc' ? 'HEVC' : 'H.264';
  if (ENCODING_BACKEND === 'videotoolbox') return `${family} (via VideoToolbox)`;
  return `${family} (CPU)`;
}

function normalizeRate(value, fallback) {
  const rate = String(value || '').trim();
  return /^\d+(?:\.\d+)?[kKmM]$/.test(rate) ? rate : fallback;
}

function normalizeLanguage(value) {
  const language = String(value || 'id').trim().toLowerCase();
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(language) ? language : 'id';
}

function guessLanguageFromName(fileName, index) {
  const normalized = String(fileName || '').toLowerCase();
  if (/\b(en|eng|english|inggris)\b/.test(normalized)) return 'en';
  if (/\b(id|ind|indo|indonesian|indonesia)\b/.test(normalized)) return 'id';
  return index === 0 ? 'id' : 'en';
}

function guessSubtitleName(fileName, index) {
  const normalized = String(fileName || '').toLowerCase();
  if (/\b(en|eng|english|inggris)\b/.test(normalized)) return 'English';
  if (/\b(id|ind|indo|indonesian|indonesia)\b/.test(normalized)) return 'Indonesian';
  return `Subtitle ${index + 1}`;
}

function sanitizeText(value, fallback) {
  const text = String(value || '').trim().replace(/[^\w .()-]/g, '');
  return text || fallback;
}

function uniqueSubtitleFileName(baseName, language, index) {
  const cleanBase = sanitize(`${index + 1}-${language}-${baseName}`) || `subtitle-${index + 1}`;
  return `${cleanBase}.vtt`;
}

function escapePlaylistAttribute(value) {
  return String(value).replace(/["\r\n]/g, '');
}

function hostPathToContainer(hostPath) {
  const normalized = path.resolve(hostPath);
  if (path.resolve(HOST_ROOT) === path.sep) return normalized;
  return path.join(HOST_ROOT, normalized.replace(/^\/+/, ''));
}

function normalizeHostBrowsePath(value) {
  const normalized = path.posix.normalize(`/${String(value).replace(/\\/g, '/')}`);
  return normalized === '//' ? '/' : normalized;
}

function isPathInsideRoot(targetPath, rootPath) {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedTarget = path.resolve(targetPath);
  if (resolvedRoot === path.sep) return resolvedTarget.startsWith(path.sep);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function resolveBinary(name, explicitPath) {
  if (explicitPath && fs.existsSync(explicitPath)) return explicitPath;

  const candidates = [
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    `/bin/${name}`,
    name
  ];

  for (const candidate of candidates) {
    if (candidate === name || fs.existsSync(candidate)) return candidate;
  }

  return name;
}

function processSpawnError(error, binary) {
  if (error.code === 'ENOENT') {
    return new Error(`${binary} was not found. Install FFmpeg or set ${path.basename(binary).toUpperCase()}_PATH to the full binary path.`);
  }
  return error;
}

function parseBytes(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i);
  if (!match) return 100 * 1024 * 1024 * 1024;

  const amount = Number(match[1]);
  const unit = (match[2] || 'b').toLowerCase();
  const multipliers = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
    tb: 1024 ** 4
  };
  return Math.floor(amount * multipliers[unit]);
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes);
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${Number(value.toFixed(value >= 10 || unit === 0 ? 0 : 1))}${units[unit]}`;
}

function appendLog(job, chunk) {
  const lines = String(chunk)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  job.log.push(...lines);
  if (job.log.length > 200) {
    job.log.splice(0, job.log.length - 200);
  }
}

function cleanup(filePath) {
  if (!filePath) return;
  fs.rm(filePath, { force: true }, () => {});
}

function cleanupUploads(...files) {
  files.filter(Boolean).forEach((file) => cleanup(file.path));
}

function cleanupJobFiles(job) {
  cleanup(job.source);
  for (const subtitle of job.subtitles || []) {
    cleanup(subtitle.source);
  }
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=,%\-[\]]+$/.test(value)) return value;
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
