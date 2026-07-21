# HLS Transcoder

A Dockerized web app for uploading `.mov`, `.mpeg`, or `.mp4` videos and transcoding them into multi-rendition VOD HLS packages with FFmpeg, 2 second TS segments, and a generated `master.m3u8`.

Optional `.vtt` subtitle files can be uploaded with the source video. The app copies each subtitle into the output package and adds them as WebVTT subtitle tracks in `master.m3u8`, so languages such as Indonesian and English can be offered together.

Existing HLS packages can also receive subtitles without transcoding again. Use the "Attach Subtitles to Existing HLS" form, point it at the folder that already contains `master.m3u8`, then upload one or more `.vtt` files.

## Run on macOS or Docker Desktop

```bash
docker compose up --build
```

Open `http://localhost:7000`.

The default compose file uses CPU FFmpeg encoders (`libx264` and `libx265`) because Docker Desktop on macOS does not expose Linux render devices such as `/dev/dri/renderD128`.

## Run Native on macOS with VideoToolbox

For Hackintosh/macOS systems, hardware encoding is available through VideoToolbox when FFmpeg includes `h264_videotoolbox` and `hevc_videotoolbox`. Run the app outside Docker:

```bash
npm install
npm start
```

With the default `ENCODING_BACKEND=auto`, the backend selects VideoToolbox when macOS reports a Radeon display and FFmpeg exposes the VideoToolbox encoders. To force it:

```bash
ENCODING_BACKEND=videotoolbox npm start
```

In native macOS mode, host output paths are used directly, such as `/Users/alex/Videos/exports`.

## Run on Linux with VAAPI

Use the VAAPI override file on a Linux host with VAAPI available:

```bash
docker compose -f docker-compose.yml -f docker-compose.vaapi.yml up --build
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

## VAAPI

The VAAPI override passes the host render device into the container:

```yaml
devices:
  - "/dev/dri:/dev/dri"
```

The FFmpeg command initializes VAAPI with:

```bash
-hwaccel vaapi -hwaccel_device /dev/dri/renderD128 -hwaccel_output_format vaapi
```

In VAAPI mode, the default ladder maps 4K and 2K to `hevc_vaapi`, and 1080p, 720p, and 360p to `h264_vaapi`. In CPU mode, the same ladder maps to `libx265` and `libx264`.

## Notes

- VAAPI mode is intended for Linux hosts with render-device support.
- The app streams progress via Server-Sent Events by parsing FFmpeg stderr `time=`, `frame=`, `fps=`, and `speed=` fields.
- The output package contains per-rendition playlists and TS chunks plus `master.m3u8`.
