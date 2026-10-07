#!/usr/bin/env node
// The README demo video, end to end, from one recording of a real review:
//
//   node scripts/demo-video.mjs record  --work <dir> --pr <url> --checkout <dir> --plugin-dir <dir> [--context-only]
//   node scripts/demo-video.mjs compose --work <dir>                 # demo-record.json + the run dir → storyboard.json + demo.recordly
//   node scripts/demo-video.mjs cut     --work <dir>                 # ffmpeg: the four segments re-timed and joined → cut.mp4 (~55 s)
//   node scripts/demo-video.mjs export  --work <dir> [--project <p>] # Recordly, headless (its own smoke-export mode) → live-demo.mp4
//   node scripts/demo-video.mjs gif     --work <dir> --out assets/live-demo.gif
//   node scripts/demo-video.mjs frames  --work <dir>                 # one PNG per cue, to look at before committing
//   node scripts/demo-video.mjs all     --work <dir> --pr <url> --checkout <dir> --plugin-dir <dir> --out assets/live-demo.gif
//
// `record` opens a Windows Terminal window of its own, starts Claude Code there with the
// slash command as the initial prompt, captures that window with ffmpeg (gdigrab, by window
// title) and stops ~45 s after the run's `done`. `compose` is pure: the cues come from the
// run directory's own clock (progress.ndjson, reviewer-progress.ndjson, delivery-state.json,
// dispatch-plan.json) mapped onto the recording's clock, and the Recordly project (clips,
// zooms, captions) is derived from them — tests/demo-video.test.ts pins that on the kit
// fixture. Nothing here touches src/ or the run directory; ffmpeg must be on PATH and
// Recordly installed per user (%LOCALAPPDATA%\Programs\Recordly).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const WINDOW_TITLE = 'pr-review live demo';
const MIDDLE_MS = 20_000; // the squeezed middle of the review, on the timeline
const CAPTION_MS = 3_000;
const STAMP_RE = /__(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

// ---------------------------------------------------------------------------------------
// Pure: the storyboard and the Recordly project

/** The UTC ms in a run id (`…__2026-10-06T14-24-14-142Z`). */
export function runStartMs(runId) {
  const m = STAMP_RE.exec(runId);
  if (!m) throw new Error(`not a run id: ${runId}`);
  return Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Where the story beats fall in the recording, in video ms. `recordingStartedAt` and
 * `recordingStoppedAt` are wall-clock ms (the same clock the CLI stamps its feeds with);
 * `summaryAtMs` is the moment the summary appeared on screen when `detectSummary` found it.
 */
export function storyboard({ runId, progress, reviewerProgress, delivery, plan, recordingStartedAt, recordingStoppedAt, summaryAtMs }) {
  const v = (wallMs) => wallMs - recordingStartedAt;
  const start = runStartMs(runId);
  const done = progress.filter((e) => e.phase === 'done' || e.phase === 'error').at(-1);
  if (!done) throw new Error('the run has no terminal phase yet');
  const planned = Array.isArray(delivery.planned) ? delivery.planned.length : plan.reviewers.length;
  const seen = reviewerProgress
    .filter((e) => e.kind === 'output-first-seen' && typeof e.ts === 'number')
    .map((e) => e.ts)
    .sort((a, b) => a - b);
  const recordingMs = recordingStoppedAt - recordingStartedAt;
  const doneMs = v(done.ts);
  const summary = Math.min(summaryAtMs ?? doneMs + 20_000, recordingMs);
  const end = Math.min(recordingMs, summary + 12_000);
  const detail = /(\d+) posted, (\d+) findings/.exec(done.detail ?? '');
  const reviewers = Array.isArray(plan.reviewers) ? plan.reviewers : [];
  return {
    runId,
    cues: {
      launch: v(start) - 2_500,
      band: v(start) + 1_500,
      firstDelivered: seen.length > 0 ? v(seen[0]) : v(start) + 60_000,
      half: seen.length > 0 ? v(seen[Math.min(seen.length - 1, Math.ceil(planned / 2) - 1)]) : v(start) + 120_000,
      done: doneMs,
      summary,
      end,
    },
    counts: {
      planned,
      findings: detail ? Number(detail[2]) : 0,
      posted: detail ? Number(detail[1]) : 0,
      passes: reviewers.filter((r) => r.kind !== 'companion-agent').length,
      companions: reviewers.filter((r) => r.kind === 'companion-agent').length,
    },
    elapsedLabel: fmtElapsed(done.ts - start),
    prLabel: plan.pr && plan.pr.owner ? `${plan.pr.owner}/${plan.pr.repo} #${plan.pr.number}` : runId,
    outcome: done.phase,
  };
}

/** Recordly's zoom depths as picture scales (its ZOOM_DEPTH_SCALES). */
const ZOOM_SCALE = { 1: 1.25, 2: 1.5, 3: 1.8, 4: 2.2, 5: 3.5, 6: 5.0 };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function zoom(id, startMs, endMs, depth, cx, cy) {
  return { id, startMs, endMs, depth, focus: { cx, cy }, mode: 'manual' };
}

/**
 * A caption shown while `z` is zoomed in: white bold text on a translucent dark pill. A
 * Recordly annotation lives in the recording's own space (percent of the frame) and zooms
 * with it, so the box is placed at the top of the region the zoom shows and sized so the
 * text reads the same on screen whatever the depth (measured on the probe clip: a caption
 * placed for the full frame was cropped away under the zoom).
 */
function captionFor(id, startMs, text, z) {
  const s = ZOOM_SCALE[z.depth];
  const view = { left: (z.focus.cx - 0.5 / s) * 100, top: (z.focus.cy - 0.5 / s) * 100, size: 100 / s };
  // One line of up to ~48 characters at this size (measured on the export: Recordly draws the
  // font about 1.45x the number given, so 32/s reads as ~45 px on a 1080p frame at any depth).
  const width = 92 / s;
  const height = 12 / s;
  return {
    id,
    startMs,
    endMs: startMs + CAPTION_MS,
    type: 'text',
    content: text,
    textContent: text,
    position: {
      x: clamp(view.left + (view.size - width) / 2, 0, 100 - width),
      y: clamp(view.top + 4 / s, 0, 100 - height),
    },
    size: { width, height },
    style: {
      color: '#ffffff',
      backgroundColor: 'rgba(13, 17, 23, 0.86)',
      fontSize: Math.round(32 / s),
      fontFamily: '"Segoe UI", "SF Pro Display", "Helvetica Neue", sans-serif',
      fontWeight: 'bold',
      fontStyle: 'normal',
      textDecoration: 'none',
      textAlign: 'center',
      borderRadius: 14,
    },
    zIndex: 10,
  };
}

/**
 * The storyboard as a cut: four segments of the recording (source ranges with a speed),
 * which ffmpeg joins into the 55 s clip the project edits, plus the Recordly project
 * (`.recordly`, version 2) for that clip: zooms where the eye should go, captions that
 * appear and leave. The project never cuts — Recordly 1.4.0's clips carry no source
 * in-point, so a project cannot jump within its source — and so the clip's time IS the
 * timeline every zoom and caption is placed on.
 *
 * Focus points are fractions of the recorded window: the band sits at the bottom of the
 * transcript column (left ~55 %), the pane fills the right ~45 %.
 */
export function buildProject(s, { videoPath }) {
  const { cues } = s;
  const c1 = { sourceStartMs: Math.max(0, cues.launch - 3_000), sourceEndMs: cues.band + 6_000, speed: 1 };
  const middleSource = Math.max(1_000, cues.done - 5_000 - c1.sourceEndMs);
  const c2 = { sourceStartMs: c1.sourceEndMs, sourceEndMs: cues.done - 5_000, speed: Math.max(2, middleSource / MIDDLE_MS) };
  const c3 = { sourceStartMs: cues.done - 5_000, sourceEndMs: cues.done + 4_000, speed: 1 };
  const c4 = { sourceStartMs: Math.max(c3.sourceEndMs, cues.summary - 1_000), sourceEndMs: cues.end, speed: 1 };
  const segments = [];
  let at = 0;
  for (const [i, c] of [c1, c2, c3, c4].entries()) {
    const durationMs = Math.round((c.sourceEndMs - c.sourceStartMs) / c.speed);
    segments.push({ id: `segment-${i + 1}`, startMs: at, endMs: at + durationMs, sourceStartMs: c.sourceStartMs, sourceEndMs: c.sourceEndMs, speed: c.speed });
    at += durationMs;
  }
  const [intro, middle, finish, findings] = segments;
  const introBand = intro.endMs - 6_000; // the band has just appeared
  // Measured on a 160x44 Windows Terminal window (2290x1316): the band is the box at the
  // bottom of the transcript column (x 0.01-0.51, y 0.74-0.84), the pane fills the right
  // column (x 0.55-0.98) with its header and bar at y 0.09-0.13, the passes rows at
  // 0.17-0.43, the companions at 0.45-0.60, the siblings and the context at 0.62-0.72.
  const zoomRegions = [
    zoom('zoom-band', introBand, intro.endMs, 4, 0.26, 0.8),
    zoom('zoom-pane', middle.startMs, middle.startMs + 5_000, 4, 0.77, 0.14),
    zoom('zoom-passes', middle.startMs + 5_000, middle.startMs + 10_000, 4, 0.77, 0.3),
    zoom('zoom-companions', middle.startMs + 10_000, middle.startMs + 15_000, 4, 0.77, 0.53),
    zoom('zoom-siblings', middle.startMs + 15_000, middle.endMs, 4, 0.77, 0.66),
    // The finish segment starts 5 s before `done`: the timer zoom and its caption wait for the band to flip.
    zoom('zoom-timer', finish.startMs + 5_500, finish.endMs, 3, 0.275, 0.78),
    zoom('zoom-findings', findings.startMs + 2_000, Math.max(findings.startMs + 2_500, findings.endMs - 1_000), 2, 0.34, 0.45),
  ];
  const [zBand, , zPasses, zCompanions, zSiblings, zTimer, zFindings] = zoomRegions;
  const annotationRegions = [
    captionFor('cap-band', introBand + 500, 'the band — phase · timer · delivered · sources', zBand),
    captionFor('cap-passes', middle.startMs + 5_500, 'passes — one agent per skill, from skill packs', zPasses),
    captionFor('cap-companions', middle.startMs + 10_500, 'companions — installed plugins reviewing too', zCompanions),
    captionFor('cap-siblings', middle.startMs + 15_500, 'siblings — Codex, verifier · rules in every pass', zSiblings),
    captionFor('cap-done', finish.startMs + 6_000, `${s.elapsedLabel} · ${s.counts.findings} findings — every one retained`, zTimer),
    captionFor('cap-findings', findings.startMs + 2_500, 'the findings — inline threads (a dry run here)', zFindings),
  ];
  const project = {
    version: 2,
    videoPath,
    editor: {
      aspectRatio: '16:9',
      showCursor: false,
      padding: { top: 28, bottom: 28, left: 28, right: 28, linked: true },
      borderRadius: 2,
      shadowIntensity: 0.6,
      backgroundBlur: 0,
      clipRegions: [],
      zoomRegions,
      annotationRegions,
      speedRegions: [],
      trimRegions: [],
      audioRegions: [],
    },
  };
  return { project, segments, timeline: { durationMs: at, segments, zooms: zoomRegions, captions: annotationRegions } };
}

// ---------------------------------------------------------------------------------------
// Processes: record, export, gif, frames

const args = (argv) => {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
      else {
        out[a.slice(2)] = next;
        i += 1;
      }
    } else out._.push(a);
  }
  return out;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runsRoot = () => join(homedir(), '.pr-review', 'runs');

function ps(script) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`powershell failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/**
 * The visible Windows Terminal window with exactly this title, in physical pixels, or null.
 * gdigrab reads the region it is given in physical pixels (measured: a region sized from the
 * DPI-scaled rectangle captured only the top-left two thirds of the window, at native size)
 * while it bounds-checks the numbers against the scaled desktop — so the rectangle is read
 * DPI-aware, and a window at the top-left of the primary monitor keeps both happy.
 */
function findWindow(title) {
  const out = ps(`
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;
public static class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L, T, R, B; }
  public static List<string> Terminals() {
    SetProcessDPIAware();
    var r = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var c = new StringBuilder(256); GetClassNameW(h, c, 256);
      if (c.ToString() != "CASCADIA_HOSTING_WINDOW_CLASS") return true;
      var t = new StringBuilder(512); GetWindowTextW(h, t, 512);
      RECT rc; GetWindowRect(h, out rc);
      r.Add(t.ToString() + "|" + rc.L + "," + rc.T + "," + rc.R + "," + rc.B);
      return true;
    }, IntPtr.Zero);
    return r;
  }
}
'@
[W]::Terminals() | ForEach-Object { $_ }
`);
  const windows = out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.lastIndexOf('|');
    const [L, T, R, B] = l.slice(i + 1).split(',').map(Number);
    return { title: l.slice(0, i), left: L, top: T, width: R - L, height: B - T };
  });
  return windows.find((w) => w.title === title) ?? null;
}

/**
 * The desktop rectangle to grab for a window: borders inset, even-sized. gdigrab's offsets
 * are relative to the primary monitor's origin (measured: an offset computed from the
 * virtual screen's origin captured the monitor to the right), in the same DPI-unaware space
 * the window rectangle was read in.
 */
function captureRegion(rect) {
  // The invisible resize border is what pushes a window placed at 0,0 to a negative left.
  const border = rect.left < 0 ? -rect.left : 8;
  const even = (n) => Math.floor(n / 2) * 2;
  return {
    x: rect.left + border,
    y: rect.top,
    width: even(rect.width - 2 * border),
    height: even(rect.height - border),
  };
}

/**
 * The newest run id that started at or after `sinceMs`, or null. Pure, and decided afresh on
 * every poll: the review's own run dir appears a few seconds into the recording, and a run
 * from before it (a probe, an unrelated review) must never be the one the capture waits on.
 */
export function pickNewestRun(ids, sinceMs) {
  const candidates = ids.filter((n) => STAMP_RE.test(n) && runStartMs(n) >= sinceMs);
  candidates.sort((a, b) => runStartMs(a) - runStartMs(b));
  return candidates.at(-1) ?? null;
}

function newestRunSince(sinceMs) {
  const root = runsRoot();
  if (!existsSync(root)) return null;
  return pickNewestRun(readdirSync(root), sinceMs);
}

const ANSWER_MIN_CHARS = 400; // the findings digest; the poll narrations are one or two sentences
const SETTLE_MS = 12_000; // the transcript stops growing once the answer is complete

/**
 * Pure: whether the findings answer is on screen, from the session transcript's lines, the
 * run's `done` time and the transcript's last write. The slash command narrates every poll
 * (assistant text too, one of them right after `done`), so the answer that matters is long
 * AND the last thing written: nothing follows it for SETTLE_MS.
 */
export function answerSettled(lines, afterMs, { nowMs, lastWriteMs }) {
  if (nowMs - lastWriteMs < SETTLE_MS) return false;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.includes('"assistant"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a line still being written
    }
    if (entry.type !== 'assistant' || Date.parse(entry.timestamp) < afterMs) continue;
    const content = entry.message && Array.isArray(entry.message.content) ? entry.message.content : [];
    if (content.some((c) => c.type === 'text' && typeof c.text === 'string' && c.text.length >= ANSWER_MIN_CHARS)) return true;
  }
  return false;
}

/**
 * True once the demo session's transcript (~/.claude/projects/<checkout>/<session>.jsonl)
 * settled on a long assistant answer written after `afterMs`; false at the ceiling.
 */
async function waitForAnswer(checkout, afterMs, ceilingMs) {
  const projectDir = join(homedir(), '.claude', 'projects', resolve(checkout).replace(/[:\\/]/g, '-'));
  const started = Date.now();
  while (Date.now() - started < ceilingMs) {
    await sleep(3_000);
    if (!existsSync(projectDir)) continue;
    const transcripts = readdirSync(projectDir)
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => join(projectDir, n))
      .filter((p) => statSync(p).mtimeMs >= afterMs);
    for (const file of transcripts) {
      const lines = readFileSync(file, 'utf8').split('\n');
      if (answerSettled(lines, afterMs, { nowMs: Date.now(), lastWriteMs: statSync(file).mtimeMs })) return true;
    }
  }
  return false;
}

function readProgress(dir) {
  const p = join(dir, 'progress.ndjson');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Record one review in a fresh Windows Terminal window captured by ffmpeg. */
async function record(opts) {
  const work = resolve(opts.work);
  mkdirSync(work, { recursive: true });
  const checkout = resolve(opts.checkout);
  const pluginDir = resolve(opts['plugin-dir']);
  const mode = opts['context-only'] ? '--context-only' : '--dry-run --no-codex --runtime claude';
  const prompt = `/pr-review:pr-review ${opts.pr} ${mode}`;
  const launcher = join(work, 'launch.cmd');
  // Started from inside a Claude Code session, the demo session would inherit its parent's
  // child-session marker: transcript saving off, and a warning line across the recording.
  writeFileSync(launcher, `@echo off\r\nset "CLAUDE_CODE_CHILD_SESSION="\r\nset "CLAUDECODE="\r\nclaude --plugin-dir "${pluginDir}" "${prompt}"\r\n`, 'utf8');
  const rawPath = join(work, 'raw.mp4');
  console.log(`[record] window "${WINDOW_TITLE}" in ${checkout}\n[record] prompt: ${prompt}`);
  // A window of its own, at the top-left, with a title the shell may not overwrite. No
  // `windowsHide` here: Windows Terminal honours the hidden show-state it would carry, and
  // the window then exists, runs the review, and is neither visible nor capturable.
  const wt = spawn('wt.exe', ['-w', 'new', '--pos', '0,0', '--size', `${opts.cols ?? 170},${opts.rows ?? 46}`, 'new-tab', '--suppressApplicationTitle', '--title', WINDOW_TITLE, '-d', checkout, 'cmd', '/k', launcher], {
    detached: true,
    stdio: 'ignore',
  });
  wt.unref();
  let rect = null;
  for (let i = 0; i < 40 && !rect; i += 1) {
    await sleep(500);
    rect = findWindow(WINDOW_TITLE);
  }
  if (!rect) throw new Error(`the terminal window "${WINDOW_TITLE}" never appeared`);
  console.log(`[record] window at ${rect.left},${rect.top} ${rect.width}x${rect.height}`);
  await sleep(1_000);
  // gdigrab's window capture (`title=`) returns black frames for a window the compositor
  // draws (Windows Terminal is one), so the window's rectangle is cut out of the desktop:
  // offsets are relative to the primary monitor's origin, the invisible resize borders are
  // left out, and the size is kept even for the encoder. Fragmented MP4, so a capture cut
  // short by a kill is still a playable file (a plain MP4 writes its index at the end and is
  // unreadable without it — one ten-minute recording was lost so).
  const region = captureRegion(rect);
  const recordingStartedAt = Date.now();
  const ffmpeg = spawn(
    'ffmpeg',
    ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'gdigrab', '-framerate', '30', '-draw_mouse', '0', '-offset_x', String(region.x), '-offset_y', String(region.y), '-video_size', `${region.width}x${region.height}`, '-i', 'desktop', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+frag_keyframe+empty_moov', rawPath],
    { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true },
  );
  console.log(`[record] capturing desktop region ${region.width}x${region.height} at ${region.x},${region.y}`);
  const exited = new Promise((r) => ffmpeg.on('exit', (code) => r(code)));
  console.log(`[record] ffmpeg started at ${new Date(recordingStartedAt).toISOString()}`);
  // The review's own run dir appears a few seconds into the recording; which run to wait on
  // is decided afresh on every poll (locking onto a probe run from a minute earlier once kept
  // the capture rolling past the real run's `done`, until the 30-minute ceiling).
  let runId = null;
  if (opts['context-only']) {
    await sleep(Number(opts.seconds ?? 45) * 1_000);
    runId = newestRunSince(recordingStartedAt);
  } else {
    const ceiling = Date.now() + 30 * 60_000;
    while (Date.now() < ceiling) {
      await sleep(2_000);
      const newest = newestRunSince(recordingStartedAt);
      if (newest !== runId) {
        runId = newest;
        console.log(`[record] following run ${runId}`);
      }
      if (!runId) continue;
      const last = readProgress(join(runsRoot(), runId)).filter((e) => e.phase !== 'reap').at(-1);
      if (last && (last.phase === 'done' || last.phase === 'error')) {
        // The findings reach the screen only when Claude writes its answer after reading the
        // summary (the slash command's last step), 20-90 s after `done`: wait for that answer in
        // the session's transcript, then a little more so it is read, with a ceiling.
        console.log(`[record] run ${runId} reached ${last.phase}; waiting for the findings on screen`);
        const answered = await waitForAnswer(checkout, last.ts, 180_000);
        console.log(answered ? '[record] the findings are on screen; 8 s more' : '[record] no settled answer in 180 s; stopping anyway');
        await sleep(answered ? 8_000 : 2_000);
        break;
      }
    }
    if (!runId) throw new Error('no run appeared under the runs root');
  }
  ffmpeg.stdin.write('q');
  ffmpeg.stdin.end();
  const code = await exited;
  const recordingStoppedAt = Date.now();
  if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
  const record = { recordingStartedAt, recordingStoppedAt, runId, runDir: runId ? join(runsRoot(), runId) : null, window: rect, prompt, video: rawPath, title: WINDOW_TITLE };
  writeFileSync(join(work, 'demo-record.json'), JSON.stringify(record, null, 2) + '\n', 'utf8');
  console.log(`[record] ${rawPath} (${Math.round((recordingStoppedAt - recordingStartedAt) / 1000)} s); run ${runId ?? 'none'}`);
  return record;
}

/** The first big change of the picture after `fromSec`: the summary being printed. */
function detectSummary(video, fromSec, toSec) {
  // The summary is a few hundred lines printed at once: a clear cut on a mostly still picture
  // (measured 0.1–0.2 on the recording; nothing else after `done` comes near 0.1).
  const r = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(fromSec), '-to', String(toSec), '-i', video, '-vf', "select='gt(scene,0.1)',showinfo", '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
  const m = /pts_time:([\d.]+)/.exec(r.stderr);
  return m ? fromSec * 1000 + Math.round(Number(m[1]) * 1000) : null;
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function readNdjson(p) {
  return existsSync(p)
    ? readFileSync(p, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
}

function compose(opts) {
  const work = resolve(opts.work);
  const rec = readJson(join(work, 'demo-record.json'));
  const runDir = opts['run-dir'] ? resolve(opts['run-dir']) : rec.runDir;
  if (!runDir) throw new Error('no run dir recorded; pass --run-dir');
  const runId = runDir.split(/[\\/]/).at(-1);
  const progress = readNdjson(join(runDir, 'progress.ndjson'));
  const doneLine = progress.filter((e) => e.phase === 'done' || e.phase === 'error').at(-1);
  const doneSec = doneLine ? (doneLine.ts - rec.recordingStartedAt) / 1000 : null;
  const recSec = (rec.recordingStoppedAt - rec.recordingStartedAt) / 1000;
  const summaryAtMs = doneSec !== null && existsSync(rec.video) ? detectSummary(rec.video, doneSec + 2, recSec) : null;
  const s = storyboard({
    runId,
    progress,
    reviewerProgress: readNdjson(join(runDir, 'reviewer-progress.ndjson')),
    delivery: readJson(join(runDir, 'delivery-state.json')),
    plan: readJson(join(runDir, 'dispatch-plan.json')),
    recordingStartedAt: rec.recordingStartedAt,
    recordingStoppedAt: rec.recordingStoppedAt,
    summaryAtMs: summaryAtMs ?? undefined,
  });
  const { project, segments, timeline } = buildProject(s, { videoPath: join(work, 'cut.mp4') });
  writeFileSync(join(work, 'demo.recordly'), JSON.stringify(project, null, 2) + '\n', 'utf8');
  writeFileSync(join(work, 'storyboard.json'), JSON.stringify({ ...s, summaryDetected: summaryAtMs !== null, raw: resolve(rec.video), segments, timeline }, null, 2) + '\n', 'utf8');
  console.log(`[compose] ${s.prLabel}: ${Object.entries(s.cues).map(([k, v]) => `${k}=${(v / 1000).toFixed(1)}s`).join(' ')}\n[compose] timeline ${(timeline.durationMs / 1000).toFixed(1)} s, middle x${segments[1].speed.toFixed(1)}, summary ${summaryAtMs !== null ? 'detected' : 'assumed'}`);
  return { project, segments, timeline };
}

/** The 55 s clip: each segment of the recording re-timed by ffmpeg, then joined, no audio. */
function cut(opts) {
  const work = resolve(opts.work);
  const { raw, segments } = readJson(join(work, 'storyboard.json'));
  const dir = join(work, 'segments');
  mkdirSync(dir, { recursive: true });
  const parts = [];
  for (const seg of segments) {
    const part = join(dir, `${seg.id}.mp4`);
    const r = spawnSync(
      'ffmpeg',
      ['-y', '-hide_banner', '-loglevel', 'error', '-ss', (seg.sourceStartMs / 1000).toFixed(3), '-to', (seg.sourceEndMs / 1000).toFixed(3), '-i', raw, '-an', '-vf', `setpts=PTS/${seg.speed}`, '-r', '30', '-fps_mode', 'cfr', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', part],
      { encoding: 'utf8', windowsHide: true },
    );
    if (r.status !== 0) throw new Error(`ffmpeg ${seg.id}: ${r.stderr}`);
    parts.push(part);
  }
  const list = join(dir, 'list.txt');
  writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n', 'utf8');
  const out = join(work, 'cut.mp4');
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg concat: ${r.stderr}`);
  console.log(`[cut] ${out} from ${segments.length} segments (${segments.map((s) => `${((s.sourceEndMs - s.sourceStartMs) / 1000).toFixed(0)}s×${s.speed.toFixed(1)}`).join(' + ')})`);
  return out;
}

/** Recordly's own headless export mode (the one its smoke tests use): env in, MP4 + a JSON report out. */
async function exportVideo(opts) {
  const work = resolve(opts.work);
  const project = resolve(opts.project ?? join(work, 'demo.recordly'));
  const out = resolve(opts.out ?? join(work, 'live-demo.mp4'));
  const exe = opts.recordly ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Recordly', 'Recordly.exe');
  if (!existsSync(exe)) throw new Error(`Recordly not found at ${exe}`);
  if (!existsSync(project)) throw new Error(`project not found: ${project}`);
  // Measured on 2026-10-06 (Recordly 1.4.0, Windows 11): spawned from Node the app either
  // exits at once with code 0 and no output, or hangs as a single silent process. Launched by
  // PowerShell's Start-Process right after a one-shot run of the same binary in Node mode
  // (`& Recordly.exe -e process.exit(0)`, not waited), with Electron's logging on, it starts,
  // exports and quits by itself — every time it was tried. So the launch is delegated to
  // PowerShell, whole, until one part of the recipe is shown to be enough.
  const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
  const script = [
    `$env:ELECTRON_RUN_AS_NODE = '1'`,
    `$null = & ${q(exe)} -e 'process.exit(0)' 2>&1`,
    `$env:ELECTRON_RUN_AS_NODE = $null`,
    `$env:ELECTRON_ENABLE_LOGGING = '1'`,
    `$env:ELECTRON_ENABLE_STACK_DUMPING = '1'`,
    `$env:RECORDLY_SMOKE_EXPORT = '1'`,
    `$env:RECORDLY_SMOKE_EXPORT_PROJECT = ${q(project)}`,
    `$env:RECORDLY_SMOKE_EXPORT_OUTPUT = ${q(out)}`,
    `$env:RECORDLY_SMOKE_EXPORT_QUALITY = ${q(opts.quality ?? 'good')}`,
    `$env:RECORDLY_SMOKE_EXPORT_FPS = ${q(String(opts.fps ?? 30))}`,
    `$env:RECORDLY_SMOKE_EXPORT_ENCODING_MODE = ${q(opts.encoding ?? 'balanced')}`,
    `$p = Start-Process -FilePath ${q(exe)} -WorkingDirectory ${q(resolve(exe, '..'))} -PassThru -Wait -RedirectStandardOutput ${q(join(work, 'recordly-stdout.txt'))} -RedirectStandardError ${q(join(work, 'recordly-stderr.txt'))}`,
    `exit $p.ExitCode`,
  ].join('\n');
  console.log(`[export] ${exe}\n[export] project ${project}\n[export] out ${out}`);
  const started = Date.now();
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: Number(opts.timeout ?? 600) * 1000 });
  const code = r.status;
  const log = existsSync(join(work, 'recordly-stdout.txt')) ? readFileSync(join(work, 'recordly-stdout.txt'), 'utf8') : '';
  if (r.error) {
    spawnSync('taskkill', ['/IM', 'Recordly.exe', '/F'], { stdio: 'ignore', windowsHide: true });
    throw new Error(`Recordly did not finish the export in time (${Math.round((Date.now() - started) / 1000)} s)`);
  }
  // The app writes `<out>.report.json` beside the export, success or not.
  const reportPath = `${out}.report.json`;
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
  if (!existsSync(out) || statSync(out).size === 0 || (report && report.success === false)) {
    const smoke = log.split('\n').filter((l) => l.includes('smoke')).join('\n');
    throw new Error(`no export at ${out} (exit ${code})\n${report ? JSON.stringify(report, null, 2) : 'no report'}\n${smoke}`);
  }
  console.log(`[export] ${out} (${(statSync(out).size / 1048576).toFixed(1)} MB); exit ${code}; report: ${report ? `success=${report.success} phase=${report.phase ?? '-'}` : 'none'}`);
  return out;
}

function gif(opts) {
  const work = resolve(opts.work);
  const input = resolve(opts.input ?? join(work, 'live-demo.mp4'));
  const out = resolve(opts.out ?? join(work, 'live-demo.gif'));
  const attempts = [
    { width: Number(opts.width ?? 1280), fps: Number(opts.fps ?? 12) },
    { width: 1024, fps: 10 },
    { width: 960, fps: 8 },
  ];
  const limit = Number(opts['max-mb'] ?? 10) * 1048576;
  for (const a of attempts) {
    const filters = `fps=${a.fps},scale=${a.width}:-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
    const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vf', filters, '-loop', '0', out], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`ffmpeg gif failed: ${r.stderr}`);
    const size = statSync(out).size;
    console.log(`[gif] ${out}: ${(size / 1048576).toFixed(1)} MB at ${a.width}px/${a.fps}fps`);
    if (size <= limit) return out;
    console.log(`[gif] over ${limit / 1048576} MB, trying smaller`);
  }
  throw new Error('the gif stays over the size limit at every preset');
}

function frames(opts) {
  const work = resolve(opts.work);
  const input = resolve(opts.input ?? join(work, 'live-demo.mp4'));
  const dir = join(work, 'frames');
  mkdirSync(dir, { recursive: true });
  const timeline = readJson(join(work, 'storyboard.json')).timeline;
  const moments = [
    ...timeline.zooms.map((z) => ({ name: z.id, ms: z.startMs + Math.min(2_000, (z.endMs - z.startMs) / 2) })),
    ...timeline.captions.map((c) => ({ name: c.id, ms: c.startMs + 1_000 })),
  ];
  for (const m of moments) {
    const png = join(dir, `${m.name}.png`);
    const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', (m.ms / 1000).toFixed(3), '-i', input, '-frames:v', '1', png], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`frame ${m.name}: ${r.stderr}`);
  }
  console.log(`[frames] ${moments.length} frames in ${dir}`);
  return dir;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = args(rest);
  if (!opts.work) throw new Error('--work <dir> is required');
  switch (cmd) {
    case 'record':
      return record(opts);
    case 'compose':
      return compose(opts);
    case 'cut':
      return cut(opts);
    case 'export':
      return exportVideo(opts);
    case 'gif':
      return gif(opts);
    case 'frames':
      return frames(opts);
    case 'all': {
      await record(opts);
      compose(opts);
      cut(opts);
      await exportVideo({ ...opts, out: undefined });
      frames(opts);
      return gif(opts);
    }
    default:
      throw new Error('usage: demo-video.mjs <record|compose|cut|export|gif|frames|all> --work <dir> …');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`[demo-video] ${err.message}`);
    process.exit(1);
  });
}
