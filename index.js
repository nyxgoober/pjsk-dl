#!/usr/bin/env node
const prompts = require("prompts");
const chalk = require("chalk");
const fs = require("fs");
const path = require("path");
const { trimWav } = require("./wavtrim");
const { trimMp3 } = require("./mp3trim");
const { trimFlac } = require("./flactrim");

const MUSICS_URL = "https://sekai-world.github.io/sekai-master-db-diff/musics.json";
const VOCALS_URL = "https://sekai-world.github.io/sekai-master-db-diff/musicVocals.json";
const GAME_CHARS_URL = "https://sekai-world.github.io/sekai-master-db-diff/gameCharacters.json";
const OUTSIDE_CHARS_URL = "https://sekai-world.github.io/sekai-master-db-diff/outsideCharacters.json";

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

// Build id -> display name lookups from the character master tables.
function buildCharacterLookup(gameChars, outsideChars) {
  const game = new Map();
  for (const c of gameChars) {
    const name = [c.givenNameEnglish, c.firstNameEnglish]
      .filter(Boolean)
      .map((s) => s.charAt(0) + s.slice(1).toLowerCase())
      .join(" ");
    // Use the given name only (e.g. "Ichika"), which is how fans refer to them.
    const given = c.givenNameEnglish
      ? c.givenNameEnglish.charAt(0) + c.givenNameEnglish.slice(1).toLowerCase()
      : name;
    game.set(c.id, given || `#${c.id}`);
  }
  const outside = new Map();
  for (const c of outsideChars) outside.set(c.id, c.name);
  return { game, outside };
}

function characterName(ch, lookup) {
  if (ch.characterType === "outside_character") {
    return lookup.outside.get(ch.characterId) || `outside#${ch.characterId}`;
  }
  return lookup.game.get(ch.characterId) || `char#${ch.characterId}`;
}

function singersFor(vocal, lookup) {
  return (vocal.characters || [])
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((ch) => characterName(ch, lookup))
    .join(", ");
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

const FORMAT_INFO = {
  mp3: "common, lossy",
  wav: "uncompressed",
  flac: "lossless",
};
const SUPPORTED_FORMATS = ["mp3", "wav", "flac"];
const TRIM_SECONDS = 8;
const DOWNLOAD_BASE = "https://storage.sekai.best/sekai-jp-assets/music/long";

// Human-readable labels for each musicVocalType in the master data.
const VOCAL_TYPE_LABELS = {
  original_song: "Original",
  sekai: "SEKAI cover",
  virtual_singer: "Virtual Singer",
  another_vocal: "Another Vocal",
  streaming_live: "Streaming Live",
  april_fool_2022: "April Fool 2022",
  instrumental: "Instrumental",
};

// Order used when listing variants in the menu.
const VOCAL_TYPE_ORDER = [
  "original_song",
  "sekai",
  "virtual_singer",
  "another_vocal",
  "streaming_live",
  "april_fool_2022",
  "instrumental",
];

// The master data gives us the exact asset bundle name for every vocal
// (e.g. "an_0006_01", "0006_02", "vs_0052_02"), so we use it directly
// instead of guessing a prefix.
function buildDownloadUrl(assetbundleName, format) {
  return `${DOWNLOAD_BASE}/${assetbundleName}/${assetbundleName}.${format}`;
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

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

// Turn a song's vocal entries into menu choices. Another Vocals get one
// entry each, labelled with the singer(s) from the character mapping.
function buildVocalChoices(song, vocals, lookup) {
  const songVocals = getVocalsForSong(song.id, vocals)
    .filter((v) => v.assetbundleName)
    .sort((a, b) => {
      const ta = VOCAL_TYPE_ORDER.indexOf(a.musicVocalType);
      const tb = VOCAL_TYPE_ORDER.indexOf(b.musicVocalType);
      return (ta === -1 ? 99 : ta) - (tb === -1 ? 99 : tb) || a.seq - b.seq;
    });

  return songVocals.map((v) => {
    const label = VOCAL_TYPE_LABELS[v.musicVocalType] || v.musicVocalType;
    const singers = singersFor(v, lookup);
    // Bundle name goes in the row itself so every entry shows it, not just
    // the highlighted one.
    return {
      title: `${singers ? `${label} — ${singers}` : label} - ${v.assetbundleName}`,
      value: v,
    };
  });
}

// Trimmers by format. WAV skips PCM samples; MP3 and FLAC drop whole frames.
const TRIMMERS = { wav: trimWav, mp3: trimMp3, flac: trimFlac };

// Ask every question up front. Returns null if the user backs out; otherwise
// a plan describing exactly what will be downloaded. Nothing touches the
// network until the plan has been confirmed.
async function askDownloadPlan(song, vocals, lookup) {
  const choices = buildVocalChoices(song, vocals, lookup);

  if (choices.length === 0) {
    console.log(
      chalk.yellow(`No vocal entries listed in the master data for "${song.title}".\n`)
    );
    return null;
  }

  choices.push({ title: "(skip download)", value: null });

  const { vocalChoice } = await prompts(
    {
      type: "select",
      name: "vocalChoice",
      message: "Which vocal version?",
      choices,
    },
    { onCancel: () => process.exit(0) }
  );
  if (!vocalChoice) return null;

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

  let trim = false;
  if (TRIMMERS[format]) {
    ({ trim } = await prompts(
      {
        type: "confirm",
        name: "trim",
        message: `Trim the first ${TRIM_SECONDS} seconds?`,
        initial: false,
      },
      { onCancel: () => process.exit(0) }
    ));
  }

  const url = buildDownloadUrl(vocalChoice.assetbundleName, format);
  const base = path.basename(url);
  const filename = base;
  const destPath = path.join(process.cwd(), filename);

  const plan = { song, vocalChoice, format, trim, url, filename, destPath };

  // Summary, then the last chance to back out before any download starts.
  const label = VOCAL_TYPE_LABELS[vocalChoice.musicVocalType] || vocalChoice.musicVocalType;
  const singers = singersFor(vocalChoice, lookup);
  console.log(chalk.bold("\nAbout to download:"));
  console.log(`  Song:    ${song.title}`);
  console.log(`  Vocal:   ${label}${singers ? ` — ${singers}` : ""}`);
  console.log(`  Format:  ${format.toUpperCase()}${trim ? `, first ${TRIM_SECONDS}s trimmed` : ""}`);
  console.log(`  Saves:   ${destPath}`);
  console.log();

  // If the file is already there, ask before anything is downloaded. Defaults
  // to "no" so a stray Enter can't replace a file the user already has.
  if (fs.existsSync(destPath)) {
    const { overwrite } = await prompts(
      {
        type: "confirm",
        name: "overwrite",
        message: `${filename} already exists. Overwrite it?`,
        initial: false,
      },
      { onCancel: () => process.exit(0) }
    );
    if (!overwrite) return null;
  }

  const { proceed } = await prompts(
    {
      type: "confirm",
      name: "proceed",
      message: "Download?",
      initial: true,
    },
    { onCancel: () => process.exit(0) }
  );

  return proceed ? plan : null;
}

// Runs the confirmed plan: check the file exists, download it, trim if asked.
async function runDownloadPlan(plan) {
  const { song, vocalChoice, format, trim, url, destPath } = plan;
  const label = VOCAL_TYPE_LABELS[vocalChoice.musicVocalType] || vocalChoice.musicVocalType;

  console.log(chalk.dim(`\nChecking ${url} ...`));
  const exists = await checkUrlExists(url);

  if (!exists) {
    console.log(
      chalk.red(
        `\nNo ${label} (${format}) file found for "${song.title}" at ${vocalChoice.assetbundleName}. ` +
          `It may not exist in this format.\n`
      )
    );
    return;
  }

  let data;
  try {
    console.log(chalk.dim(`Downloading to ${destPath} ...`));
    data = await fetchBuffer(url);
  } catch (err) {
    console.log(chalk.red(`\nDownload failed: ${err.message}\n`));
    return;
  }

  // Trimming is best-effort: if it can't be done, save the untrimmed file
  // rather than throwing away a completed download.
  if (trim) {
    try {
      const { buffer, info } = TRIMMERS[format](data, TRIM_SECONDS);
      data = buffer;
      const cut = info.cutSeconds !== undefined ? info.cutSeconds : TRIM_SECONDS;
      console.log(chalk.dim(`Trimmed ${cut.toFixed(3)}s, ${info.remainingSeconds.toFixed(1)}s remaining.`));
    } catch (err) {
      console.log(chalk.yellow(`Couldn't trim (${err.message}); saving the untrimmed file instead.`));
    }
  }

  try {
    fs.writeFileSync(destPath, data);
    console.log(chalk.green(`Saved: ${destPath}\n`));
  } catch (err) {
    console.log(chalk.red(`\nCouldn't save file: ${err.message}\n`));
  }
}

async function offerDownload(song, vocals, lookup) {
  const plan = await askDownloadPlan(song, vocals, lookup);
  if (!plan) {
    console.log(chalk.dim("Skipped.\n"));
    return;
  }
  await runDownloadPlan(plan);
}

async function main() {
  console.log(chalk.bold.cyan("\n♪ PJSK-DL ♪\n"));

  let songs, vocals, lookup;
  try {
    console.log(chalk.dim("Fetching master music data.."));
    songs = await fetchJson(MUSICS_URL, "musics.json");
    console.log(chalk.dim("Fetching music vocals..."));
    vocals = await fetchJson(VOCALS_URL, "musicVocals.json");
    console.log(chalk.dim("Fetching characters..."));
    const [gameChars, outsideChars] = await Promise.all([
      fetchJson(GAME_CHARS_URL, "gameCharacters.json"),
      fetchJson(OUTSIDE_CHARS_URL, "outsideCharacters.json"),
    ]);
    lookup = buildCharacterLookup(gameChars, outsideChars);
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
      await offerDownload(matches[0], vocals, lookup);
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
        await offerDownload(chosen, vocals, lookup);
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

