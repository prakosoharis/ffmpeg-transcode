# HLS Transcoder

A Dockerized web app for uploading `.mov`, `.mpeg`, or `.mp4` videos and transcoding them into multi-rendition VOD HLS packages with FFmpeg, 4 second TS segments, and a generated `master.m3u8`.

If the source video has audio, the app packages it as an AAC HLS audio track and links it from `master.m3u8`.

Optional `.vtt` subtitle files can be uploaded with the source video. The app copies each subtitle into the output package and adds them as WebVTT subtitle tracks in `master.m3u8`, so languages such as Indonesian and English can be offered together.

Existing HLS packages can also receive subtitles without transcoding again. Use the "Attach Subtitles to Existing HLS" form, point it at the folder that already contains `master.m3u8`, then upload one or more `.vtt` files.

For very large source videos, use the "Source Video Path" field instead of uploading the file through the browser. This lets FFmpeg read the file directly from disk and avoids browser upload failures for files such as 120GB masters.

The current generator uses H.264 for every rendition, including 2K and 4K, to keep the output broadly compatible with HLS.js, Chrome, Safari, Android, and modern browsers. Source audio is transcoded to AAC-LC, 48 kHz, stereo, 192 kbps, and muxed into every MPEG-TS rendition.

## Run on macOS or Docker Desktop

```bash
docker compose up --build
```

Open `http://localhost:7000`.

The default compose file uses the CPU FFmpeg encoder `libx264`.

## Setup VideoToolbox on macOS/Hackintosh

VideoToolbox is the macOS hardware encoding path used here for H.264. It does not run inside Docker Desktop containers, so use this mode by running the app natively on macOS/Hackintosh.

1. Install Homebrew if it is not installed:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

2. Install Node.js and FFmpeg:

```bash
brew install node ffmpeg
```

3. Confirm FFmpeg includes the H.264 VideoToolbox encoder:

```bash
ffmpeg -encoders | grep videotoolbox
```

Expected encoder:

```text
h264_videotoolbox
```

4. Confirm macOS sees the display GPU:

```bash
system_profiler SPDisplaysDataType
```

On a Hackintosh with Radeon graphics, this should list the Radeon GPU under display hardware.

5. Install app dependencies:

```bash
npm install
```

6. Run with automatic backend detection:

```bash
npm start
```

With the default `ENCODING_BACKEND=auto`, the backend selects VideoToolbox when macOS reports a Radeon display and FFmpeg exposes the VideoToolbox encoders.

7. If you want to force VideoToolbox:

```bash
ENCODING_BACKEND=videotoolbox npm start
```

For Hackintosh or Intel/Homebrew installs, use explicit FFmpeg paths:

```bash
FFMPEG_PATH=/usr/local/bin/ffmpeg FFPROBE_PATH=/usr/local/bin/ffprobe ENCODING_BACKEND=videotoolbox npm start
```

For large source videos, raise the upload limit as needed:

```bash
MAX_UPLOAD_SIZE=200GB FFMPEG_PATH=/usr/local/bin/ffmpeg FFPROBE_PATH=/usr/local/bin/ffprobe ENCODING_BACKEND=videotoolbox npm start
```

Open `http://localhost:7000`. In native macOS mode, host output paths are used directly, such as `/Users/alex/Videos/exports`.

If the UI badge shows `CPU FFmpeg` instead of `VideoToolbox`, check that `ffmpeg -encoders | grep h264_videotoolbox` returns an encoder and that `system_profiler SPDisplaysDataType` lists the Radeon display GPU.

If transcoding fails with `spawn ffprobe ENOENT`, FFmpeg is not visible to the Node process. Install it with Homebrew or start the app with explicit paths:

```bash
FFMPEG_PATH=/opt/homebrew/bin/ffmpeg FFPROBE_PATH=/opt/homebrew/bin/ffprobe ENCODING_BACKEND=videotoolbox npm start
```

For Apple Silicon/Homebrew installs, the paths may be:

```bash
FFMPEG_PATH=/opt/homebrew/bin/ffmpeg FFPROBE_PATH=/opt/homebrew/bin/ffprobe ENCODING_BACKEND=videotoolbox npm start
```

## Host Output Paths

The compose file mounts common macOS host locations under `/host`:

```yaml
volumes:
  - "/Users:/host/Users:rw"
  - "/Volumes:/host/Volumes:rw"
  - "/tmp:/host/tmp:rw"
```

When the UI receives an absolute host path such as `/Users/alex/Videos/exports`, the backend writes to `/host/Users/alex/Videos/exports/<Output Folder Name>` inside the container. This is what lets a user-entered absolute path resolve at runtime without recreating the container.

The path field includes a Browse button that lists host folders through the `/host` mount. On Docker Desktop, make sure the chosen host path is allowed in file sharing settings.

## Notes

- Docker mode uses CPU encoding. Native macOS can use VideoToolbox when available.
- The app streams progress via Server-Sent Events by parsing FFmpeg stderr `time=`, `frame=`, `fps=`, and `speed=` fields.
- The output package contains per-rendition playlists and TS chunks plus `master.m3u8`.
- Transcoding writes to a temporary output folder first. The final folder is published only after validation passes; an existing folder is renamed to `.previous-<timestamp>` rather than deleted.
- Validate an HLS package manually with `npm run validate:hls -- /path/to/hls-package`.
- Object storage uploads should use the MIME map in `server/hlsMimeTypes.json`.

## Output Structure

```text
movie-hls-package/
  master.m3u8
  360p/
    index.m3u8
    segment_00000.ts
  720p/
    index.m3u8
    segment_00000.ts
  1080p/
    index.m3u8
    segment_00000.ts
  2k/
    index.m3u8
    segment_00000.ts
  4k/
    index.m3u8
    segment_00000.ts
  subtitles/
    1-id/
      index.m3u8
      movie-id.vtt
    2-en/
      index.m3u8
      movie-en.vtt
```

## Example Master Playlist

```m3u8
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Indonesian",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,LANGUAGE="id",URI="subtitles/1-id/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=992000,AVERAGE-BANDWIDTH=992000,RESOLUTION=640x360,FRAME-RATE=30.000,CODECS="avc1.42c01e,mp4a.40.2",SUBTITLES="subs"
360p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2692000,AVERAGE-BANDWIDTH=2692000,RESOLUTION=1280x720,FRAME-RATE=30.000,CODECS="avc1.64001f,mp4a.40.2",SUBTITLES="subs"
720p/index.m3u8
```

## Example Media Playlist

```m3u8
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-INDEPENDENT-SEGMENTS
#EXTINF:4.000000,
segment_00000.ts
#EXT-X-ENDLIST
```

## Example Subtitle Playlist

```m3u8
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:7200
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:7200.000,
movie-en.vtt
#EXT-X-ENDLIST
```

## Final FFmpeg Shape

The generated command uses this structure:

```bash
ffmpeg -hide_banner -y -i input.mov \
  -filter_complex "[0:v]split=5[v0in][v1in][v2in][v3in][v4in];[v0in]scale=w=640:h=360:flags=lanczos[v0];..." \
  -map "[v0]" -c:v:0 h264_videotoolbox -b:v:0 800k -maxrate:v:0 1.2M -bufsize:v:0 1.6M -g:v:0 120 -keyint_min:v:0 120 -sc_threshold:v:0 0 \
  -map 0:a:0 -c:a:0 aac -b:a:0 192k -ac:a:0 2 -ar:a:0 48000 \
  -force_key_frames "expr:gte(t,n_forced*4)" \
  -f hls -hls_time 4 -hls_playlist_type vod -hls_flags independent_segments \
  -master_pl_name master.m3u8 \
  -var_stream_map "v:0,a:0,name:360p ..." \
  -hls_segment_filename "output/%v/segment_%05d.ts" "output/%v/index.m3u8"
```

## Migrating Old Outputs

Old outputs that were transcoded without audio need to be retranscoded with the updated generator. Audio cannot be restored by patching playlists if the TS segments do not contain audio streams.

Old outputs that only need subtitles can use the "Attach Subtitles to Existing HLS" form. The app now creates subtitle playlists and points `EXT-X-MEDIA` to `subtitles/<lang>/index.m3u8`, not directly to `.vtt`.
