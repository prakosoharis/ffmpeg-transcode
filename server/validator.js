const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

async function validateHlsPackage(rootDir, options = {}) {
  const ffprobePath = options.ffprobePath || process.env.FFPROBE_PATH || 'ffprobe';
  const errors = [];
  const masterPath = path.join(rootDir, 'master.m3u8');

  if (!fs.existsSync(masterPath)) {
    throw new Error(`Missing master playlist: ${masterPath}`);
  }

  const master = readPlaylist(masterPath);
  if (!master.lines.includes('#EXTM3U')) errors.push('master.m3u8 is missing #EXTM3U.');

  const streamEntries = parseMasterStreams(master.lines);
  const mediaEntries = parseMediaEntries(master.lines);

  if (!streamEntries.length) errors.push('master.m3u8 has no EXT-X-STREAM-INF entries.');

  for (const media of mediaEntries) {
    if (media.type === 'SUBTITLES' && /\.vtt($|\?)/i.test(media.uri || '')) {
      errors.push(`Subtitle media entry points directly to .vtt instead of playlist: ${media.uri}`);
    }
    if (media.uri) assertReferencedFile(rootDir, media.uri, errors);
  }

  const durations = [];
  const expectedById = new Map((options.expectedVariants || []).map((variant) => [variant.id, variant]));

  for (const entry of streamEntries) {
    const playlistPath = path.join(rootDir, entry.uri);
    assertReferencedFile(rootDir, entry.uri, errors);
    if (!fs.existsSync(playlistPath)) continue;

    const child = readPlaylist(playlistPath);
    const duration = validateMediaPlaylist({
      rootDir: path.dirname(playlistPath),
      playlist: child,
      playlistLabel: entry.uri,
      errors
    });
    durations.push({ uri: entry.uri, duration });

    const variantId = entry.uri.split('/')[0];
    const expected = expectedById.get(variantId);
    validateMasterAttributes({ entry, expected, expectedAudio: options.expectedAudio, errors });
    validateSampleSegments({
      ffprobePath,
      playlistDir: path.dirname(playlistPath),
      playlist: child,
      expectedAudio: options.expectedAudio,
      expected,
      errors,
      label: entry.uri
    });
  }

  for (const media of mediaEntries.filter((entry) => entry.type === 'SUBTITLES')) {
    const playlistPath = path.join(rootDir, media.uri);
    if (!fs.existsSync(playlistPath)) continue;
    const subtitlePlaylist = readPlaylist(playlistPath);
    validateSubtitlePlaylist({
      playlistDir: path.dirname(playlistPath),
      playlist: subtitlePlaylist,
      label: media.uri,
      errors
    });
  }

  if (durations.length > 1) {
    const values = durations.map((item) => item.duration).filter((value) => Number.isFinite(value));
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (values.length && max - min > Math.max(2, max * 0.02)) {
      errors.push(`Rendition durations are inconsistent: min=${min.toFixed(3)} max=${max.toFixed(3)}.`);
    }
  }

  if (errors.length) {
    throw new Error(`HLS validation failed:\n- ${errors.join('\n- ')}`);
  }

  return { ok: true, streams: streamEntries.length, subtitles: mediaEntries.length };
}

function readPlaylist(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return {
    filePath,
    content,
    lines: content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  };
}

function parseMasterStreams(lines) {
  const streams = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = parseAttrs(line.slice('#EXT-X-STREAM-INF:'.length));
    const uri = lines[index + 1];
    if (uri && !uri.startsWith('#')) streams.push({ attrs, uri });
  }
  return streams;
}

function parseMediaEntries(lines) {
  return lines
    .filter((line) => line.startsWith('#EXT-X-MEDIA:'))
    .map((line) => {
      const attrs = parseAttrs(line.slice('#EXT-X-MEDIA:'.length));
      return {
        attrs,
        type: attrs.TYPE,
        uri: attrs.URI
      };
    });
}

function parseAttrs(value) {
  const attrs = {};
  const regex = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match;
  while ((match = regex.exec(value))) {
    attrs[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return attrs;
}

function validateMediaPlaylist({ rootDir, playlist, playlistLabel, errors }) {
  if (!playlist.lines.includes('#EXTM3U')) errors.push(`${playlistLabel} is missing #EXTM3U.`);
  if (!playlist.lines.includes('#EXT-X-ENDLIST')) errors.push(`${playlistLabel} is missing #EXT-X-ENDLIST.`);

  const targetLine = playlist.lines.find((line) => line.startsWith('#EXT-X-TARGETDURATION:'));
  const targetDuration = targetLine ? Number(targetLine.split(':')[1]) : NaN;
  if (!Number.isFinite(targetDuration) || targetDuration <= 0) {
    errors.push(`${playlistLabel} has invalid TARGETDURATION.`);
  }

  let total = 0;
  let maxSegment = 0;
  const segmentDurations = [];
  for (let index = 0; index < playlist.lines.length; index += 1) {
    const line = playlist.lines[index];
    if (!line.startsWith('#EXTINF:')) continue;
    const duration = Number(line.slice('#EXTINF:'.length).split(',')[0]);
    const uri = playlist.lines[index + 1];
    total += duration;
    maxSegment = Math.max(maxSegment, duration);
    segmentDurations.push(duration);
    if (!uri || uri.startsWith('#')) errors.push(`${playlistLabel} has EXTINF without segment URI.`);
    else assertReferencedFile(rootDir, uri, errors, playlistLabel);
    if (duration <= 0) errors.push(`${playlistLabel} has non-positive segment duration.`);
  }

  if (Number.isFinite(targetDuration) && Math.ceil(maxSegment) > targetDuration) {
    errors.push(`${playlistLabel} TARGETDURATION ${targetDuration} is lower than max EXTINF ${maxSegment.toFixed(3)}.`);
  }

  segmentDurations.slice(0, -1).forEach((duration, index) => {
    if (Number.isFinite(targetDuration) && duration < Math.max(1, targetDuration * 0.5)) {
      errors.push(`${playlistLabel} segment ${index} is too short (${duration.toFixed(3)}s) for target ${targetDuration}s.`);
    }
  });

  return total;
}

function validateSubtitlePlaylist({ playlistDir, playlist, label, errors }) {
  const total = validateMediaPlaylist({ rootDir: playlistDir, playlist, playlistLabel: label, errors });
  const directSegments = playlist.lines.filter((line) => !line.startsWith('#'));
  for (const segment of directSegments) {
    if (!/\.vtt($|\?)/i.test(segment)) errors.push(`${label} references non-VTT subtitle segment: ${segment}`);
  }
  return total;
}

function validateMasterAttributes({ entry, expected, expectedAudio, errors }) {
  const attrs = entry.attrs;
  for (const required of ['BANDWIDTH', 'AVERAGE-BANDWIDTH', 'RESOLUTION', 'CODECS']) {
    if (!attrs[required]) errors.push(`${entry.uri} master entry is missing ${required}.`);
  }

  if (expected && attrs.RESOLUTION !== `${expected.width}x${expected.height}`) {
    errors.push(`${entry.uri} has RESOLUTION=${attrs.RESOLUTION}, expected ${expected.width}x${expected.height}.`);
  }

  if (expectedAudio && attrs.CODECS && !attrs.CODECS.includes('mp4a.40.2')) {
    errors.push(`${entry.uri} CODECS is missing AAC codec mp4a.40.2.`);
  }
}

function validateSampleSegments({ ffprobePath, playlistDir, playlist, expectedAudio, expected, errors, label }) {
  const segments = playlist.lines.filter((line) => !line.startsWith('#'));
  if (!segments.length) {
    errors.push(`${label} has no media segments.`);
    return;
  }

  const sampleIndexes = [...new Set([0, Math.floor(segments.length / 2), segments.length - 1])];
  for (const index of sampleIndexes) {
    const segmentPath = path.join(playlistDir, segments[index]);
    const result = probeSegment(ffprobePath, segmentPath);
    if (!result.ok) {
      errors.push(`${label} segment probe failed: ${segments[index]} ${result.error}`);
      continue;
    }

    const video = result.streams.find((stream) => stream.codec_type === 'video');
    const audio = result.streams.find((stream) => stream.codec_type === 'audio');
    if (!video) errors.push(`${label} segment has no video stream: ${segments[index]}`);
    if (expectedAudio && !audio) errors.push(`${label} segment has no audio stream: ${segments[index]}`);
    if (audio && audio.codec_name !== 'aac') errors.push(`${label} audio codec is ${audio.codec_name}, expected aac.`);
    if (audio && String(audio.sample_rate) !== '48000') errors.push(`${label} audio sample rate is ${audio.sample_rate}, expected 48000.`);
    if (audio && Number(audio.channels) !== 2) errors.push(`${label} audio channels is ${audio.channels}, expected 2.`);
    if (expected && video && (Number(video.width) !== expected.width || Number(video.height) !== expected.height)) {
      errors.push(`${label} segment resolution is ${video.width}x${video.height}, expected ${expected.width}x${expected.height}.`);
    }
  }
}

function probeSegment(ffprobePath, segmentPath) {
  const result = spawnSync(ffprobePath, [
    '-v',
    'error',
    '-show_streams',
    '-of',
    'json',
    segmentPath
  ], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 4
  });

  if (result.error || result.status !== 0) {
    return { ok: false, error: result.error?.message || result.stderr || `exit ${result.status}` };
  }

  try {
    const parsed = JSON.parse(result.stdout || '{}');
    return { ok: true, streams: parsed.streams || [] };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function assertReferencedFile(rootDir, uri, errors, label = 'playlist') {
  if (/^https?:\/\//i.test(uri)) return;
  const cleanUri = uri.split('?')[0];
  const filePath = path.resolve(rootDir, cleanUri);
  if (!filePath.startsWith(path.resolve(rootDir))) {
    errors.push(`${label} references path outside package: ${uri}`);
    return;
  }
  if (!fs.existsSync(filePath)) errors.push(`${label} references missing file: ${uri}`);
  else if (fs.statSync(filePath).size === 0) errors.push(`${label} references empty file: ${uri}`);
}

module.exports = { validateHlsPackage };

if (require.main === module) {
  const rootDir = process.argv[2];
  if (!rootDir) {
    console.error('Usage: node server/validator.js /path/to/hls-package');
    process.exit(2);
  }

  validateHlsPackage(rootDir, {
    ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
    expectedAudio: process.env.EXPECT_AUDIO !== '0'
  })
    .then(() => {
      console.log(`HLS validation passed: ${rootDir}`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
