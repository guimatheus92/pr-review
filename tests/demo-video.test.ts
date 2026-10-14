import { test } from 'node:test';
import assert from 'node:assert';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { answerSettled, buildProject, pickNewestRun, projectDirFor, recordCues, storyboard } from '../scripts/demo-video.mjs';
import { DONE, RUN_ID } from '../mods/live/tests/fixtures/run-798.ts';

/**
 * The README demo is cut from a real recording by scripts/demo-video.mjs. Everything that
 * decides WHERE to cut, zoom and caption is a pure function of the run directory and the
 * recording's clock, so it is pinned here on the kit's fixture (a real run, neutral
 * identity) instead of on "it looked right on my run".
 */
const runStartMs = 1791296654142; // the UTC stamp in RUN_ID
const doneTs = 1791298298313; // the fixture's `done` line
const recordingStartedAt = runStartMs - 8000; // eight seconds of Claude's banner before the launch
const defaultSummaryAt = doneTs - recordingStartedAt + 20000;
const recordingStoppedAt = recordingStartedAt + defaultSummaryAt + 20000;

function fixtureRun() {
  return {
    runId: RUN_ID,
    progress: DONE['progress.ndjson'].trim().split('\n').map((l) => JSON.parse(l)),
    reviewerProgress: DONE['reviewer-progress.ndjson'].trim().split('\n').map((l) => JSON.parse(l)),
    delivery: JSON.parse(DONE['delivery-state.json']),
    plan: JSON.parse(DONE['dispatch-plan.json']),
  };
}

test('pickNewestRun — only a run that started after the recording did, the newest of them, re-decided on every poll', () => {
  // A probe run from a minute earlier sat under the runs root when the real recording started;
  // locking onto it on the first poll kept the capture rolling past the real run's `done`.
  const probe = 'github__acme__backend__798__2026-10-07T00-10-42-567Z';
  const real = 'github__acme__backend__798__2026-10-07T00-11-46-793Z';
  const recordingStartedAt = Date.parse('2026-10-07T00:11:29.000Z');
  assert.equal(pickNewestRun([probe], recordingStartedAt), null, 'nothing newer than the recording yet');
  assert.equal(pickNewestRun([probe, real], recordingStartedAt), real);
  assert.equal(pickNewestRun(['local__o__r__main__abc', real, 'github__o__r__1__2026-09-01T00-00-00-000Z'], recordingStartedAt), real, 'unstamped and old ids are ignored');
});

test('projectDirFor — the transcript folder is named the way Claude Code names it: every character but letters, digits and hyphens becomes a hyphen', () => {
  // Measured: C:\Users\guilh\repos\pr-review\.claude\worktrees\feat+live-mod is stored under
  // C--Users-guilh-repos-pr-review--claude-worktrees-feat-live-mod. A dot or an underscore in
  // the path (first.last, my_repo) used to yield a folder that never exists, so `record`
  // waited the full ceiling and the findings segment fell back to scene detection.
  // `resolve` is the platform's, so each leg gets its own absolute path and the whole value is pinned.
  const [input, folder] = process.platform === 'win32'
    ? ['C:\\Users\\first.last\\repos\\my_repo\\feat+x', 'C--Users-first-last-repos-my-repo-feat-x']
    : ['/home/first.last/repos/my_repo/feat+x', '-home-first-last-repos-my-repo-feat-x'];
  assert.equal(projectDirFor(input), join(homedir(), '.claude', 'projects', folder));
});

test('answerSettled — the findings are on screen once a long assistant answer after done is followed by silence', () => {
  // The slash command narrates every poll ("still running, I'll keep polling"); those are
  // assistant text too, and one of them lands right after `done` — a take ended there, 13 s
  // after done, with the findings still being written. The answer that matters is the newest
  // LONG assistant text after done, once the file has been silent for a while: a short
  // narration written after it ("The review of PR #798 finished…") does not undo it.
  const doneMs = Date.parse('2026-10-07T01:30:52.000Z');
  const entry = (type, text, atMs) => JSON.stringify({ type, timestamp: new Date(atMs).toISOString(), message: { content: [{ type: 'text', text }] } });
  const narration = entry('assistant', 'The review is still running; I will keep polling the run status every 25 seconds until it ends.', doneMs + 3000);
  const findings = entry('assistant', '## Findings\n' + '- a finding with its file and line, body and severity\n'.repeat(30), doneMs + 40000);
  const tool = JSON.stringify({ type: 'assistant', timestamp: new Date(doneMs + 6000).toISOString(), message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } });
  // Narration only, and the file still being written: not settled.
  assert.equal(answerSettled([narration, tool], doneMs, { nowMs: doneMs + 7000, lastWriteMs: doneMs + 6000 }), null);
  // Narration only, silent for a while: still not settled (nothing long was written).
  assert.equal(answerSettled([narration], doneMs, { nowMs: doneMs + 30000, lastWriteMs: doneMs + 3000 }), null);
  // The long answer, but written just now: wait for the silence.
  assert.equal(answerSettled([narration, tool, findings], doneMs, { nowMs: doneMs + 42000, lastWriteMs: doneMs + 40000 }), null);
  // The long answer, then 12 s of silence: settled — and WHEN it landed is the answer, because
  // that moment is where the findings segment of the cut starts (scene detection missed it on a
  // take: the answer streams in over seconds, so there is no single big change of the picture).
  assert.equal(answerSettled([narration, tool, findings], doneMs, { nowMs: doneMs + 53000, lastWriteMs: doneMs + 40000 }), doneMs + 40000);
  // A long answer from before done does not count.
  const old = entry('assistant', 'x'.repeat(2000), doneMs - 60000);
  assert.equal(answerSettled([old, narration], doneMs, { nowMs: doneMs + 60000, lastWriteMs: doneMs + 3000 }), null);
  // The real shape of every take: a short closing line after the findings, and a tool call
  // after that — the findings' own moment is still the answer.
  const closing = entry('assistant', 'The review of PR #798 finished: 13 findings, nothing posted (dry run).', doneMs + 45000);
  const laterTool = JSON.stringify({ type: 'assistant', timestamp: new Date(doneMs + 46000).toISOString(), message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } });
  assert.equal(answerSettled([narration, tool, findings, closing, laterTool], doneMs, { nowMs: doneMs + 58000, lastWriteMs: doneMs + 46000 }), doneMs + 40000);
});

test('recordCues — a covered recording is refused, and the findings start where the transcript says', () => {
  // ffmpeg reads the desktop: one take shipped an editor with the author's notes to the QA
  // frames before `record` checked what was on top. The refusal is the privacy guard.
  const rec = { recordingStartedAt, recordingStoppedAt, answerAtMs: recordingStartedAt + 400000, covered: [] };
  assert.deepEqual(recordCues(rec), { summaryAtMs: 400000 });
  assert.deepEqual(recordCues({ ...rec, answerAtMs: null }), { summaryAtMs: null }, 'no settled answer: the caller falls back to scene detection');
  assert.throws(() => recordCues({ ...rec, covered: [{ atMs: 5000, title: 'notes.md - Editor' }] }), /covered at 5 s by "notes.md - Editor"; record again/);
});

test('storyboard — the cues come from the run clock mapped onto the recording clock', () => {
  const s = storyboard({ ...fixtureRun(), recordingStartedAt, recordingStoppedAt });
  assert.equal(s.cues.launch, 5500, 'the command was accepted ~2.5 s before the run dir existed');
  assert.equal(s.cues.band, 9500, 'the band shows ~1.5 s after the run dir exists');
  assert.equal(s.cues.firstDelivered, 1791296747894 - recordingStartedAt);
  assert.equal(s.cues.half, 1791297090088 - recordingStartedAt, 'the 8th of 16 reviewers delivered');
  assert.equal(s.cues.done, doneTs - recordingStartedAt);
  assert.equal(s.cues.summary, defaultSummaryAt, 'without a detected summary, 20 s after done');
  assert.equal(s.cues.end, defaultSummaryAt + 12000);
  assert.deepEqual(s.counts, { planned: 16, findings: 33, posted: 33, passes: 10, companions: 6, codex: false });
  assert.equal(s.elapsedLabel, '27:24', 'done minus the run start, as the band shows it');
  assert.equal(s.prLabel, 'acme/backend #798');
});

test('storyboard — a dry run says "0 posted, N findings", and N is the findings count', () => {
  // The fixture's done line reads "33 posted, 33 findings", which cannot tell the two numbers
  // apart; every take this script records is a dry run.
  const run = fixtureRun();
  const last = run.progress.length - 1;
  run.progress[last] = { ...run.progress[last], detail: '0 posted, 13 findings' };
  const s = storyboard({ ...run, recordingStartedAt, recordingStoppedAt });
  assert.equal(s.counts.findings, 13);
  assert.equal(s.counts.posted, 0);
  const texts = buildProject(s, { videoPath: 'C:\\demo\\cut.mp4' }).project.editor.annotationRegions.map((c: { textContent: string }) => c.textContent);
  assert.match(texts[4]!, /27:24 · 13 findings/);
});

test('storyboard — a run that ended in error has no findings to show and is refused', () => {
  // `record` stops on `error` too (nothing more will happen on screen), but the done line then
  // reads "N operational failure(s)": the caption would say "0 findings — every one retained".
  const run = fixtureRun();
  const last = run.progress.length - 1;
  run.progress[last] = { ...run.progress[last], phase: 'error', detail: '3 operational failure(s)' };
  assert.throws(() => storyboard({ ...run, recordingStartedAt, recordingStoppedAt }), /ended in error \(3 operational failure\(s\)\); nothing to show/);
});

test('storyboard — a detected summary moment replaces the default, and the end never passes the recording', () => {
  const s = storyboard({ ...fixtureRun(), recordingStartedAt, recordingStoppedAt, summaryAtMs: recordingStoppedAt - recordingStartedAt - 5000 });
  assert.equal(s.cues.summary, recordingStoppedAt - recordingStartedAt - 5000);
  assert.equal(s.cues.end, recordingStoppedAt - recordingStartedAt, 'clamped to the recording');
});

test('buildProject — four segments cut from the recording by ffmpeg: intro at 1x, the middle squeezed into 20 s, the finish at 1x, the findings at 1x', () => {
  // Recordly 1.4.0 cannot jump within the source from a project (its clips carry no source
  // in-point), so the cut and the speed-up are ffmpeg's; the project then edits a 55 s clip
  // whose time IS the timeline.
  const s = storyboard({ ...fixtureRun(), recordingStartedAt, recordingStoppedAt });
  const { project, segments, timeline } = buildProject(s, { videoPath: 'C:\\demo\\cut.mp4' });
  assert.equal(segments.length, 4);
  assert.deepEqual(segments.map((c) => c.speed === 1), [true, false, true, true]);
  assert.equal(segments[0].sourceStartMs, s.cues.launch - 3000);
  assert.equal(segments[0].startMs, 0);
  assert.equal(segments[1].endMs - segments[1].startMs, 20000, 'the middle lasts exactly 20 s on the timeline');
  assert.ok(segments[1].speed > 10, `the middle is sped up far beyond a speed region's 2x: ${segments[1].speed}`);
  // Contiguous on the timeline, in order, and the source never runs backwards.
  for (let i = 1; i < segments.length; i += 1) {
    assert.equal(segments[i].startMs, segments[i - 1].endMs, `segment ${i} starts where ${i - 1} ends`);
    assert.ok(segments[i].sourceStartMs >= segments[i - 1].sourceEndMs, 'sources in order, never overlapping');
    assert.equal(Math.round((segments[i].sourceEndMs - segments[i].sourceStartMs) / segments[i].speed), segments[i].endMs - segments[i].startMs);
  }
  assert.ok(timeline.durationMs >= 45000 && timeline.durationMs <= 65000, `a launch cut: ${timeline.durationMs} ms`);
  assert.equal(timeline.durationMs, segments.at(-1)!.endMs);
  assert.deepEqual(project.editor.clipRegions, [], 'the project itself never cuts: the cut clip is its source');
  assert.deepEqual(project.editor.trimRegions, []);
});

test('buildProject — zooms and captions land inside the timeline, in story order, with the real numbers', () => {
  const s = storyboard({ ...fixtureRun(), recordingStartedAt, recordingStoppedAt });
  const { project, timeline } = buildProject(s, { videoPath: 'C:\\demo\\raw.mp4' });
  const zooms = project.editor.zoomRegions;
  const captions = project.editor.annotationRegions;
  assert.equal(zooms.length, 7);
  assert.equal(captions.length, 6);
  for (const z of zooms) {
    assert.ok(z.startMs >= 0 && z.endMs <= timeline.durationMs && z.endMs > z.startMs, `zoom ${z.id} inside the timeline`);
    assert.ok(z.depth >= 1 && z.depth <= 6 && z.focus.cx >= 0 && z.focus.cx <= 1 && z.focus.cy >= 0 && z.focus.cy <= 1);
  }
  for (let i = 1; i < zooms.length; i += 1) assert.ok(zooms[i].startMs >= zooms[i - 1].endMs, 'zooms never overlap');
  for (const c of captions) {
    assert.equal(c.type, 'text');
    assert.ok(c.startMs >= 0 && c.endMs <= timeline.durationMs);
    assert.ok(c.endMs - c.startMs >= 2500 && c.endMs - c.startMs <= 4000, 'short, then gone');
  }
  // A caption is drawn in the recording's own space, so it zooms with the picture: each one
  // must sit inside the region its zoom shows, or it is cropped away (seen on the probe clip).
  const scale: Record<number, number> = { 1: 1.25, 2: 1.5, 3: 1.8, 4: 2.2, 5: 3.5, 6: 5.0 };
  for (const c of captions) {
    const z = zooms.find((z) => c.startMs >= z.startMs && c.startMs < z.endMs);
    assert.ok(z, `caption ${c.id} shows while a zoom is active`);
    const s = scale[z!.depth]!;
    const view = { left: (z!.focus.cx - 0.5 / s) * 100, top: (z!.focus.cy - 0.5 / s) * 100, width: 100 / s, height: 100 / s };
    assert.ok(c.position.x >= view.left - 0.01 && c.position.x + c.size.width <= view.left + view.width + 0.01, `${c.id} fits the zoom's width`);
    assert.ok(c.position.y >= view.top - 0.01 && c.position.y + c.size.height <= view.top + view.height + 0.01, `${c.id} fits the zoom's height`);
    assert.ok(c.style.fontSize * s >= 30 && c.style.fontSize * s <= 48, `${c.id} reads at the same size on screen whatever the zoom: ${c.style.fontSize * s}`);
  }
  const texts = captions.map((c) => c.textContent);
  assert.match(texts[0]!, /band/i);
  assert.match(texts[1]!, /passes/);
  assert.match(texts[2]!, /companions/);
  assert.doesNotMatch(texts[2]!, /none/, 'six companions ran: the caption does not say none');
  // A machine with no companion installed shows "none installed for this runtime" under the
  // caption, so the caption must not claim plugins are reviewing (seen on the seventh take).
  const none = buildProject({ ...s, counts: { ...s.counts, companions: 0 } }, { videoPath: 'C:\\demo\\cut.mp4' }).project.editor.annotationRegions.map((c: { textContent: string }) => c.textContent);
  assert.match(none[2]!, /companions/);
  assert.match(none[2]!, /none/);
  // Same for the siblings: the pane draws the Codex row only when the plan enabled it, and
  // every take this script records runs with --no-codex.
  assert.match(texts[3]!, /siblings/);
  assert.match(texts[3]!, /Codex off/);
  const codex = buildProject({ ...s, counts: { ...s.counts, codex: true } }, { videoPath: 'C:\\demo\\cut.mp4' }).project.editor.annotationRegions.map((c: { textContent: string }) => c.textContent);
  assert.match(codex[3]!, /siblings — Codex, verifier/);
  assert.match(texts[4]!, /27:24 · 33 findings/);
  assert.match(texts[5]!, /findings/);
  // The first zoom is on the band as it appears; the timer zoom sits in the finish segment.
  const { segments } = buildProject(s, { videoPath: 'C:\\demo\\cut.mp4' });
  assert.ok(zooms[0].startMs >= segments[0].startMs && zooms[0].endMs <= segments[0].endMs);
  assert.ok(zooms[5].startMs >= segments[2].startMs && zooms[5].endMs <= segments[2].endMs);
});

test('buildProject — a run too short for the four segments is refused by name, not by ffmpeg', () => {
  // The middle runs from the end of the intro (band + 6 s) to done - 5 s: a run that reached
  // its terminal phase sooner than that (a fast error, a docs-only PR with no passes) would
  // make that segment's source run backwards and `cut` fail inside ffmpeg (-to before -ss).
  const s = storyboard({ ...fixtureRun(), recordingStartedAt, recordingStoppedAt });
  const short = { ...s, cues: { ...s.cues, done: s.cues.band + 8000, summary: s.cues.band + 20000, end: s.cues.band + 30000 } };
  assert.throws(() => buildProject(short, { videoPath: 'C:\\demo\\cut.mp4' }), /run too short for the storyboard: done 8\.0 s after the band/);
});

test('buildProject — the project is what Recordly loads: version 2, the recording, a 16:9 frame, no cursor', () => {
  const s = storyboard({ ...fixtureRun(), recordingStartedAt, recordingStoppedAt });
  const { project } = buildProject(s, { videoPath: 'C:\\demo\\cut.mp4' });
  assert.equal(project.version, 2);
  assert.equal(project.videoPath, 'C:\\demo\\cut.mp4');
  assert.equal(project.editor.aspectRatio, '16:9');
  assert.equal(project.editor.showCursor, false);
  assert.deepEqual(project.editor.speedRegions, []);
  assert.deepEqual(project.editor.trimRegions, []);
  const ids = [...project.editor.zoomRegions, ...project.editor.annotationRegions].map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
});
