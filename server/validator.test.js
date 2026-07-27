const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { validateHlsPackage } = require('./validator');

test('rejects subtitle media entries that point directly to vtt files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-validator-'));
  fs.mkdirSync(path.join(root, 'subtitles'), { recursive: true });
  fs.writeFileSync(path.join(root, 'subtitles', 'subtitle-en.vtt'), 'WEBVTT\n\n', 'utf8');
  fs.writeFileSync(
    path.join(root, 'master.m3u8'),
    [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,LANGUAGE="en",URI="subtitles/subtitle-en.vtt"',
      ''
    ].join('\n'),
    'utf8'
  );

  await assert.rejects(
    () => validateHlsPackage(root, { expectedAudio: false }),
    /points directly to \.vtt/
  );
});
