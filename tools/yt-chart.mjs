#!/usr/bin/env node
// Builds a note-analysis file for one song so the game can play a YouTube link with notes that follow the sound.
//
//   node tools/yt-chart.mjs <YouTube link>            downloads the audio with yt-dlp, analyzes it, deletes the audio
//   node tools/yt-chart.mjs <audio or video file> --id <YouTube video id> [--title "name"]
//
// Needs yt-dlp and ffmpeg on the PATH. Writes charts/<video id>.json. Only the analysis is kept, never the audio.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf("--" + name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
let id = opt("id"), title = opt("title");
const input = args[0];
if (!input) { console.error("usage: node tools/yt-chart.mjs <YouTube link | file --id VIDEO_ID> [--title name]"); process.exit(2); }

const YT_ID = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/))([\w-]{11})/i;
const run = (cmd, a, o = {}) => {
  const r = spawnSync(cmd, a, { encoding: "buffer", maxBuffer: 1 << 30, ...o });
  if (r.error) throw new Error(cmd + " could not be started: " + r.error.message);
  if (r.status !== 0) throw new Error(cmd + " failed:\n" + r.stderr.toString().trim().split("\n").slice(-6).join("\n"));
  return r.stdout;
};

let audioPath = input, tmp = null;
if (/^https?:\/\//i.test(input)) {
  const m = input.match(YT_ID);
  if (!m) { console.error("This does not look like a YouTube video link."); process.exit(2); }
  id = m[1];
  tmp = mkdtempSync(join(tmpdir(), "ytchart-"));
  const url = "https://www.youtube.com/watch?v=" + id;
  console.log("Downloading audio for", id, "...");
  let info;
  try {
    info = run("yt-dlp", ["--no-playlist", "--js-runtimes", "node", "--remote-components", "ejs:github", "-f", "bestaudio/best", "--no-progress",
      "--print", "after_move:%(title)s", "-o", join(tmp, "audio.%(ext)s"), url]);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    if (/not a bot|Sign in to confirm/i.test(e.message)) {
      console.error("YouTube refused this computer (\"Sign in to confirm you're not a bot\").\n" +
        "YouTube blocks downloads from servers and cloud machines. Run this tool on a home computer instead.\n" +
        "유튜브가 이 컴퓨터의 접속을 막았습니다. 서버나 클라우드에서는 막히는 경우가 많으니 집 컴퓨터에서 실행해 주세요.");
      process.exit(1);
    }
    throw e;
  }
  title = title || info.toString().trim().split("\n").pop();
  const f = readdirSync(tmp).find(n => n.startsWith("audio."));
  if (!f) throw new Error("yt-dlp finished but no audio file was written");
  audioPath = join(tmp, f);
} else {
  if (!existsSync(input)) { console.error("File not found:", input); process.exit(2); }
  if (!id || !/^[\w-]{11}$/.test(id)) { console.error("With a file, pass the YouTube video id it belongs to: --id VIDEO_ID"); process.exit(2); }
}

try {
  // decode to mono 44.1 kHz float samples
  const SR = 44100;
  const pcm = run("ffmpeg", ["-v", "error", "-i", audioPath, "-vn", "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"]);
  const samples = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 4));
  if (samples.length < SR * 5) throw new Error("The audio is shorter than 5 seconds.");

  // run the very same analysis the game uses in the browser, taken straight from index.html
  const html = readFileSync(join(root, "index.html"), "utf8");
  const a = html.indexOf("/* ---------- beat analysis"), b = html.indexOf("/* ---------- chart: pick notes");
  if (a < 0 || b < 0) throw new Error("Could not find the analysis code in index.html");
  const version = Number((html.match(/const AN_VERSION = (\d+)/) || [])[1] || 0);
  const analyze = new Function("tick", html.slice(a, b) + "\nreturn analyze;")(() => Promise.resolve());
  const buffer = { sampleRate: SR, length: samples.length, numberOfChannels: 1, duration: samples.length / SR, getChannelData: () => samples };
  console.log("Analyzing", (buffer.duration / 60).toFixed(1), "minutes of audio ...");
  const an = await analyze(buffer, () => {});

  const r3 = x => Math.round(x * 1000) / 1000;
  const out = {
    v: version, id, title: title || id, dur: r3(buffer.duration), bpm: r3(an.bpm), ft: an.ft,
    beats: an.beats.map(r3),
    onsets: an.onsets.map(o => [r3(o.t), r3(o.s), r3(o.v), r3(o.c), o.g, o.bi, o.qx, r3(o.tq)]),   // t, s, v, c, g, bi, qx, tq
    eng: Array.from(an.eng, x => Number(x.toPrecision(3)))
  };
  mkdirSync(join(root, "charts"), { recursive: true });
  const file = join(root, "charts", id + ".json");
  writeFileSync(file, JSON.stringify(out));
  console.log(`Wrote charts/${id}.json  (${out.onsets.length} sound onsets, ${out.beats.length} beats, about ${Math.round(out.bpm)} BPM)`);
} finally {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}
