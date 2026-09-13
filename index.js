#!/usr/bin/env node
const prompts = require("prompts");
const chalk = require("chalk");
const fs = require("fs");
const path = require("path");

const MUSICS_URL = "https://sekai-world.github.io/sekai-master-db-diff/musics.json";
const VOCALS_URL = "https://sekai-world.github.io/sekai-master-db-diff/musicVocals.json";

async function fetchJson(url, label) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${label}: ${res.status} ${res.statusText}`);
  return res.json();
}

function normalize(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\s\-_'".,!?:;~()\[\]]/g, "");
}

function subsequenceScore(needle, haystack) {
  if (haystack.includes(needle)) {
    return needle.length === haystack.length ? 0 : 1;
  }
  let hi = 0;
  let gaps = 0;
  for (const ch of needle) {
    const idx = haystack.indexOf(ch, hi);
    if (idx === -1) return -1;
    gaps += idx - hi;
    hi = idx + 1;
  }
  return 2 + gaps;
}

function getTitleFields(song) {
  const fields = [];
  if (song.title) fields.push(song.title);
  return fields;
}

function searchSongs(query, songs) {
  const q = normalize(query);
  const scored = [];
  for (const song of songs) {
    let best = -1;
    for (const title of getTitleFields(song)) {
      const score = subsequenceScore(q, normalize(title));
      if (score !== -1 && (best === -1 || score < best)) best = score;
    }
    if (best !== -1) scored.push({ song, score: best });
  }
  scored.sort((a, b) => a.score - b.score || a.song.title.length - b.song.title.length);
  return scored.map((s) => s.song);
}

function describeVocalType(vocal) {
  return vocal.musicVocalType || vocal.vocalType || vocal.type || "unknown";
}

function getVocalsForSong(musicId, vocals) {
  return vocals.filter((v) => v.musicId === musicId);
}

function printResult(song, vocals) {
  console.log(chalk.bold(`\n${song.title}`));
  console.log(chalk.green(`  id: ${song.id}`));

  const songVocals = getVocalsForSong(song.id, vocals);
  if (songVocals.length > 0) {
    const types = [...new Set(songVocals.map(describeVocalType))];
    console.log(chalk.dim(`  vocal variants: ${types.join(", ")}`));
  }
  console.log();
}

const VOCAL_PREFIXES = {
  "SEKAI cover": "se",
  "Virtual Singer": "vs",
};
const FORMAT_INFO = {
  mp3: "common, lossy",
  wav: "uncompressed",
  flac: "lossless",
};
const SUPPORTED_FORMATS = ["mp3", "wav", "flac"];
const DOWNLOAD_BASE = "https://storage.sekai.best/sekai-jp-assets/music/long";

function padSongId(id) {
  return String(id).padStart(4, "0");
}

function buildDownloadUrl(prefix, songId, format) {
  const padded = padSongId(songId);
  const bundle = `${prefix}_${padded}_01`;
  const filename = `${prefix}_${padded}_01.${format}`;
  return `${DOWNLOAD_BASE}/${bundle}/${filename}`;
}

// Songs with only one vocal type have no se_/vs_ prefix at all —
// just songid_01.format.
function buildNoPrefixUrl(songId, format) {
  const padded = padSongId(songId);
  const bundle = `${padded}_01`;
  const filename = `${padded}_01.${format}`;
  return `${DOWNLOAD_BASE}/${bundle}/${filename}`;
}

async function checkUrlExists(url) {
  try {
    const res = await fetch(url, { method: "HEAD" });
    if (res.ok) return true;
    if (res.status === 405 || res.status === 403) {
      const getRes = await fetch(url, { headers: { Range: "bytes=0-0" } });
      return getRes.ok || getRes.status === 206;
    }
    return false;
  } catch {
    return false;
  }
}

async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return destPath;
}

async function offerDownload(song) {
  const { vocalChoice } = await prompts(
    {
      type: "select",
      name: "vocalChoice",
      message: "Which vocal version?",
      choices: [
        { title: "SEKAI cover", value: "SEKAI cover" },
        { title: "Virtual Singer", value: "Virtual Singer" },
        { title: "(skip download)", value: null },
      ],
    },
    { onCancel: () => process.exit(0) }
  );

  if (!vocalChoice) return;

  const { format } = await prompts(
    {
      type: "select",
      name: "format",
      message: "Format?",
      choices: SUPPORTED_FORMATS.map((f) => ({
        title: `${f.toUpperCase()} (${FORMAT_INFO[f]})`,
        value: f,
      })),
    },
    { onCancel: () => process.exit(0) }
  );

  const prefix = VOCAL_PREFIXES[vocalChoice];
  let url = buildDownloadUrl(prefix, song.id, format);

  console.log(chalk.dim(`\nChecking ${url} ...`));
  let exists = await checkUrlExists(url);

  if (!exists) {
    // Songs with only one vocal variant don't use a se_/vs_ prefix at all.
    const fallbackUrl = buildNoPrefixUrl(song.id, format);
    console.log(chalk.dim(`Not found. Checking ${fallbackUrl} ...`));
    const fallbackExists = await checkUrlExists(fallbackUrl);
    if (fallbackExists) {
      url = fallbackUrl;
      exists = true;
    }
  }

  if (!exists) {
    console.log(
      chalk.red(
        `\nNo ${vocalChoice} (${format}) version found for "${song.title}". ` +
          `This song may not have that vocal variant, or it may not exist in this format.\n`
      )
    );
    return;
  }

  const filename = path.basename(url);
  const destPath = path.join(process.cwd(), filename);

  try {
    console.log(chalk.dim(`Downloading to ${destPath} ...`));
    await downloadFile(url, destPath);
    console.log(chalk.green(`Saved: ${destPath}\n`));
  } catch (err) {
    console.log(chalk.red(`\nDownload failed: ${err.message}\n`));
  }
}

async function main() {
  console.log(chalk.bold.cyan("\n♪ PJSK-DL ♪\n"));

  let songs, vocals;
  try {
    console.log(chalk.dim("Fetching master music data.."));
    songs = await fetchJson(MUSICS_URL, "musics.json");
    console.log(chalk.dim("Fetching music vocals..."));
    vocals = await fetchJson(VOCALS_URL, "musicVocals.json");
    console.log(chalk.green(`Loaded ${songs.length} songs, ${vocals.length} vocal entries.\n`));
  } catch (err) {
    console.error(chalk.red(`\nError loading data: ${err.message}`));
    process.exit(1);
  }

  let keepGoing = true;
  while (keepGoing) {
    const { query } = await prompts(
      {
        type: "text",
        name: "query",
        message: "Song name:",
      },
      { onCancel: () => process.exit(0) }
    );

    if (!query || !query.trim()) break;

    const matches = searchSongs(query.trim(), songs);

    if (matches.length === 0) {
      console.log(chalk.red("No matches found.\n"));
    } else if (matches.length === 1) {
      printResult(matches[0], vocals);
      await offerDownload(matches[0]);
    } else {
      const top = matches.slice(0, 10);
      const { chosen } = await prompts(
        {
          type: "select",
          name: "chosen",
          message: `${matches.length} matches found, pick one:`,
          choices: top.map((s) => ({
            title: `${s.title}`,
            description: s.composer || s.creatorArtistName || "",
            value: s,
          })),
        },
        { onCancel: () => process.exit(0) }
      );
      if (chosen) {
        printResult(chosen, vocals);
        await offerDownload(chosen);
      }
    }

    const { again } = await prompts({
      type: "confirm",
      name: "again",
      message: "Look up another song?",
      initial: true,
    });
    keepGoing = !!again;
  }

  console.log(chalk.dim("\nBye!"));
}

main();

