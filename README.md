# Plex Part Merger

A small desktop app for merging split Plex episode files, such as `Episode - Part 1.mkv` and `Episode - Part 2.mkv`, into one video.

## Requirements

- Node.js 18 or newer
- Bundled ffmpeg for packaged desktop builds

The desktop app uses native ffmpeg locally, which is much faster than browser-only merging for large TV seasons.

## Merge Modes

- `Fast Merge` keeps the original video/audio streams and is best when every part comes from the same source with matching settings.
- `Compatibility Merge` converts each file to a normalized H.264/AAC segment before merging. Use this for mixed MKV/MP4 files or files that fail Fast Merge. It is slower and keeps the first video/audio track.

## Run

Desktop app during development:

```powershell
npm run desktop
```

Local browser prototype:

```powershell
npm start
```

Then open:

```text
http://localhost:4127
```

## How To Use

1. Drag video parts into the drop zone, or click it to choose files.
2. Drag the order cells to reorder the files.
3. Confirm or edit the output name.
4. Choose `Fast Merge` for matching files, or `Compatibility Merge` for mixed/weird files.
5. Click `Merge and Save`.
6. Pick where to save the merged file.

## Build

Create an unpacked Windows app folder:

```powershell
npm run pack
```

Create a Windows installer:

```powershell
npm run dist
```

The installer is written to `dist/Plex Part Merger Setup 1.1.1.exe`.
