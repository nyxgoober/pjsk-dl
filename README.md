# pjsk-dl

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-linux%20%7C%20macos%20%7C%20windows-lightgrey)](#-standalone-binaries)

Interactive CLI to look up a Project Sekai song's ID by title and download its vocal tracks — SEKAI cover or Virtual Singer, in MP3, WAV, or FLAC.

Data is pulled live from [sekai.best](https://sekai.best)'s [sekai-master-db-diff](https://github.com/Sekai-World/sekai-master-db-diff) on every run, so results always reflect the current game data.

## ✨ Features

- 🔍 Fuzzy song title search (typo/partial tolerant, no romanization matching)
- 🆔 Instant song ID lookup
- 🎤 Shows all vocal variants for a song (original, SEKAI cover, Another Vocal, etc.)
- ⬇️ Direct download of SEKAI cover / Virtual Singer vocal tracks
- 🎧 Choice of MP3 (common, lossy), WAV (uncompressed), or FLAC (lossless)
- 💻 Cross-platform: Linux, macOS, and Windows, on both x64 and ARM64

## 📦 Installation

### Option A — Standalone binary (no Node.js required)

Grab the binary for your platform from the [Releases](https://github.com/nyxgoober/pjsk-dl/releases) page:

| Platform | File |
|---|---|
| Linux (x64) | `pjsk-dl-linux-x64` |
| Linux (ARM64) | `pjsk-dl-linux-arm64` |
| macOS (Intel) | `pjsk-dl-macos-x64` |
| macOS (Apple Silicon) | `pjsk-dl-macos-arm64` |
| Windows (x64) | `pjsk-dl-win-x64.exe` |
| Windows (ARM64) | `pjsk-dl-win-arm64.exe` |

**Linux / macOS:**
```bash
chmod +x pjsk-dl-linux-x64
./pjsk-dl-linux-x64
```

**Windows:** double-click the `.exe`, or run it from a terminal.

> **macOS note:** the binaries aren't code-signed, so Gatekeeper will block them on first run. Fix once per machine:
> ```bash
> xattr -d com.apple.quarantine ./pjsk-dl-macos-x64   # or -arm64
> codesign --sign - ./pjsk-dl-macos-x64
> ```

> **Windows note:** SmartScreen may warn since the `.exe` is unsigned — click **More info → Run anyway**.

### Option B — From source (requires Node.js ≥ 18)

```bash
git clone https://github.com/nyxgoober/pjsk-dl.git
cd pjsk-dl
npm install
node index.js
```

## 🚀 Usage

Just run the binary or `node index.js`, then follow the prompts:

```
♪ PJSK-DL ♪

Fetching master music data..
Fetching music vocals...
Loaded 717 songs, 1786 vocal entries.

? Song name: › ロストアンブレラ

ロストアンブレラ
  id: 551
  vocal variants: original_song, sekai, another_vocal

✔ Which vocal version? › SEKAI cover
✔ Format? › WAV (uncompressed)

Checking https://storage.sekai.best/sekai-jp-assets/music/long/se_0551_01/se_0551_01.wav ...
Downloading to ./se_0551_01.wav ...
Saved: ./se_0551_01.wav

✔ Look up another song? … no

Bye!
```

If a vocal version doesn't exist for a song in the chosen format, PJSK-DL tells you gracefully instead of crashing.

## 🔨 Building from source

To produce your own standalone binaries:

```bash
npm install
npm run build
```

Binaries land in `dist/` for all six targets (Linux/macOS/Windows × x64/ARM64). This uses [`pkg`](https://github.com/vercel/pkg) under the hood.

## 🗃️ Data source

- Song metadata: [`musics.json`](https://sekai-world.github.io/sekai-master-db-diff/musics.json)
- Vocal variants: [`musicVocals.json`](https://sekai-world.github.io/sekai-master-db-diff/musicVocals.json)
- Audio CDN: `storage.sekai.best`

All credit for data goes to [Sekai World](https://github.com/Sekai-World) and [sekai.best](https://sekai.best). This project is unofficial and not affiliated with SEGA, Colorful Palette, or Crypton Future Media.

## 📄 License

[MIT](LICENSE)

