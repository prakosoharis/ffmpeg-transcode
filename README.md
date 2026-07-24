# HLS Transcoder

A Dockerized web app for uploading `.mov`, `.mpeg`, or `.mp4` videos and transcoding them into multi-rendition VOD HLS packages with FFmpeg, 2 second TS segments, and a generated `master.m3u8`.

Optional `.vtt` subtitle files can be uploaded with the source video. The app copies each subtitle into the output package and adds them as WebVTT subtitle tracks in `master.m3u8`, so languages such as Indonesian and English can be offered together.

Existing HLS packages can also receive subtitles without transcoding again. Use the "Attach Subtitles to Existing HLS" form, point it at the folder that already contains `master.m3u8`, then upload one or more `.vtt` files.

For very large source videos, use the "Source Video Path" field instead of uploading the file through the browser. This lets FFmpeg read the file directly from disk and avoids browser upload failures for files such as 120GB masters.

## Run on macOS or Docker Desktop

```bash
docker compose up --build
```

Open `http://localhost:7000`.

The default compose file uses CPU FFmpeg encoders (`libx264` and `libx265`).

## Setup VideoToolbox on macOS/Hackintosh

VideoToolbox is the macOS hardware encoding path for H.264 and HEVC. It does not run inside Docker Desktop containers, so use this mode by running the app natively on macOS/Hackintosh.

1. Install Homebrew if it is not installed:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

2. Install Node.js and FFmpeg:

```bash
brew install node ffmpeg
```

3. Confirm FFmpeg includes VideoToolbox encoders:

```bash
ffmpeg -encoders | grep videotoolbox
```

Expected encoders include:

```text
h264_videotoolbox
hevc_videotoolbox
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

If the UI badge shows `CPU FFmpeg` instead of `VideoToolbox`, check that `ffmpeg -encoders | grep videotoolbox` returns both encoders and that `system_profiler SPDisplaysDataType` lists the Radeon display GPU.

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
