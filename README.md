# Plex Part Merger

A small desktop app for merging split Plex episode files, such as `Episode - Part 1.mkv` and `Episode - Part 2.mkv`, into one video.

## Requirements

- Node.js 18 or newer
- Bundled ffmpeg for packaged desktop builds

The desktop app uses native ffmpeg locally, which is much faster than browser-only merging for large TV seasons.

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
4. Click `Merge and Save`.
5. Pick where to save the merged file.

## Build

Create an unpacked Windows app folder:

```powershell
npm run pack
```

Create a Windows installer:

```powershell
npm run dist
```

The installer is written to `dist/Plex Part Merger Setup 1.0.0.exe`.
