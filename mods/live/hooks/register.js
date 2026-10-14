// pr-review live — a Claude Code mod that shows a running review as it happens.
//
// It is one more READER of the run directory (~/.pr-review/runs/<id>/): the same feeds
// `pr-review status` reads, never `status` itself (which can reap processes), and it
// writes nothing — not to the PR, not to the checkout, not to ~/.pr-review.
//
// What it draws (terminal and Desktop only; in the VS Code chat panel the hooks run but
// nothing shows, and /pr-review-live answers in text; in `claude -p` it is inert):
//   AbovePrompt — three lines: PR + phase + timer; delivered counts; counts by source.
//   Pane        — one row per reviewer (state, time, source), the project rules in context.
//   Spinner     — ` · pr-review m:ss · delivered/planned…` while the run is live.
//   /pr-review-live [run-id | off] — attach (newest run by default) or detach.
//
// How a run gets attached — always a validated id that exists under the runs root:
//   the banner a `--detach` launch prints (`Review started in the background` + `run-id:`),
//   a `status <id>` poll or a `--resume <id>` typed into the Bash tool, or the command.
//
// Where the facts come from (src/util/progress.ts, src/dispatch/reviewer-progress.ts,
// src/dispatch/delivery.ts, src/dispatch/pass-select.ts):
//   progress.ndjson          phase + heartbeat   {ts, phase, detail}
//   reviewer-progress.ndjson per-reviewer events {ts, kind, reviewer, attempt, …}
//   dispatch-plan.json       the roster: reviewers[] {name, kind, source, matchedBy, maxAttempts}
//   delivery-state.json      valid/invalid/missing, reviewerAttempts, runtimeAttempts[]
//   passes.json              {name, source, matchedBy}[] — `context` rows are the project rules
//   error.txt                the failure, when the run died before or without a terminal phase
//
// The run directory is written by the CLI, under the user's own account; the mod shows what
// it finds there and decides nothing from it. `pr-review status` and the summary stay the
// authoritative readings.
//
// The host reads on("<event>", …) and $.noun.method(…) from the source text, so every call
// is spelled out in full and helpers that take $ are top-level functions.

const PANE = 'pr-review-live';
const REFRESH_EVERY_TICKS = 2; // one tick per second; the feeds change slower than that
const HEARTBEAT_SILENCE_MS = 90_000; // 1.5x the 60 s `running` heartbeat the CLI appends
const RUN_CEILING_MS = 2 * 60 * 60 * 1000; // stop polling a run that outlives any realistic review (30 min session, recovery, verifier)
const STAMP_RE = /__(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/; // the UTC stamp ensureRunDir() ends a run id with
const PACK_RE = /[\\/]\.pr-review[\\/]packs[\\/]([^\\/]+)[\\/]/; // <home>/.pr-review/packs/<pack>/… in a reviewer's source → the pack name
const BANNER = 'Review started in the background'; // the first line a --detach launch prints (src/cli.ts)
// The launch block the model runs prints a few `key: value` lines of its own before the CLI's
// banner (`cli:`, `repo:`, `project skills discoverable:`) — the model composes that block
// from commands/pr-review.md, so their names, order and count vary. A line that is not one of
// those ends the preamble; a foreground summary starts with `# PR Review …`, never a key.
const PREAMBLE_LINE_RE = /^[a-z][a-z0-9 -]{0,40}: .*$/;
const PREAMBLE_MAX_LINES = 8;
const RUN_ID_LINE_RE = /^ {2}run-id: (.+?)\r?$/m; // the banner's second line; an Azure DevOps id can hold a space
const TERMINAL_PHASES = new Set(['done', 'error']);
// C0, DEL and C1 controls, zero-width and bidi format characters, line/paragraph separators:
// nothing from a skill name or a phase detail can move the cursor or reorder the terminal.
const UNSAFE_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

const GLYPH = {
  pending: { glyph: '·', color: undefined, dim: true },
  running: { glyph: '●', color: 'yellow', dim: false },
  delivered: { glyph: '◐', color: 'yellow', dim: false },
  done: { glyph: '✓', color: 'green', dim: false },
  retry: { glyph: '↻', color: 'yellow', dim: false },
  failed: { glyph: '✗', color: 'red', dim: false },
};
/** The bar above the prompt: one stretch of cells per reviewer, coloured by state; the legend uses the same colours. */
const BAR = {
  done: { cell: '█', color: 'green', dim: false },
  delivered: { cell: '█', color: 'cyan', dim: false },
  running: { cell: '▓', color: 'yellow', dim: false },
  retry: { cell: '▓', color: 'magenta', dim: false },
  failed: { cell: '█', color: 'red', dim: false },
  pending: { cell: '░', color: undefined, dim: true },
};
const STATE_ORDER = ['done', 'delivered', 'running', 'retry', 'failed', 'pending'];
const BAND_ROWS = 7; // border (2) + title, bar, legend, counts, sources: below this the band keeps title, bar and counts only

let interactive = false;
let surface = null;
/**
 * The attached run, or null. Module state: a reload drops it, and the next poll re-attaches.
 * `state` is `live` (polling) until the run settles as `done`, `failed`, `preview` (a
 * --context-only run) or `stale` (the polling ceiling); a settled run has no timer.
 */
let run = null;

export function register(on) {
  on('session.start', async ($, e, next) => {
    interactive = e.isInteractive === true;
    surface = e.surface ?? null;
    // pr-review's own reviewer sessions are `claude -p` runs that load the user's plugins
    // (INV-CTX-06 isolates Copilot only): there is nobody to draw for, so do nothing there.
    if (!interactive) return next(e);
    try {
      await $.command.register({
        name: 'pr-review-live',
        description: 'Show the live progress of a running pr-review (band above the prompt + pane)',
        argumentHint: '[run-id | off]',
        immediate: true,
      });
    } catch (err) {
      // A taken name or a host without commands: the band and pane still work.
      debug($, 'command.register: ' + message(err));
    }
    return next(e);
  });

  on('session.end', async ($, e, next) => {
    stopTimer(run);
    run = null;
    return next(e);
  });

  // An observer, never a gate: every command goes through unchanged, and a failure in the
  // bookkeeping around it must neither block the command nor run it twice.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!interactive) return next(e);
    const cmd = String(e.command ?? '');
    try {
      await attachFromCommand($, cmd);
    } catch (err) {
      debug($, 'attach from command: ' + message(err));
    }
    const result = await next(e);
    try {
      await attachFromBanner($, cmd, result);
    } catch (err) {
      debug($, 'attach from banner: ' + message(err));
    }
    return result;
  }).catch(async ($, e, next) => {
    // Fail open. `next` is replay-safe here: when the hook already called it, this resolves
    // to the result Claude Code holds and runs nothing again; otherwise the command runs now.
    return next(e);
  });

  on('command.run', { command: 'pr-review-live' }, async ($, e) => {
    const arg = clean(String(e.args ?? '').trim());
    try {
      return await liveCommand($, arg);
    } catch (err) {
      debug($, 'command: ' + message(err));
      return { text: 'pr-review live: could not run — ' + message(err) };
    }
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const r = run;
    if (!r || e.props.hasSurvey) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    const theirs = await next(e);
    let mine;
    try {
      mine = band(Box, Text, r, e.props.bodyColumns || 80, e.props.maxRows || 10);
    } catch (err) {
      debug($, 'band: ' + message(err));
      mine = Text({ dimColor: true, children: ['pr-review live: could not draw ' + clean(r.id) + ' — /pr-review-live off'] });
    }
    return theirs != null ? Box({ flexDirection: 'column', children: [mine, theirs] }) : mine;
  });

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    const r = run;
    const { Box, Text } = $.ui.resolve(e);
    if (!r) return Text({ dimColor: true, children: ['No pr-review run attached. /pr-review-live [run-id], or start a review.'] });
    try {
      return pane(Box, Text, r, e.props.bodyColumns || 80);
    } catch (err) {
      debug($, 'pane: ' + message(err));
      return Text({ dimColor: true, children: ['pr-review live: could not draw ' + clean(r.id) + ' — /pr-review-live off'] });
    }
  });

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const r = run;
    if (!r || !isLive(r)) return next(e);
    try {
      const c = counts(r, reviewerRows(r));
      return next({ ...e, props: { ...e.props, suffix: ' · pr-review ' + fmt(elapsedMs(r)) + ' · ' + c.delivered + '/' + c.planned + '…' } });
    } catch (err) {
      debug($, 'spinner: ' + message(err));
      return next(e);
    }
  });
}

// The command

async function liveCommand($, arg) {
  if (arg === 'off') {
    const id = run ? run.id : null;
    await detachRun($);
    return { text: id ? 'pr-review live: detached from ' + clean(id) : 'pr-review live: nothing was attached' };
  }
  let id = arg;
  if (!id) {
    id = await newestRunId($);
    if (!id) {
      const root = await runsRoot($);
      return { text: root ? 'pr-review live: no run found under ' + root : 'pr-review live: no home directory (USERPROFILE or HOME) to find ~/.pr-review/runs' };
    }
  }
  const problem = await attach($, id, false);
  if (problem) return { text: 'pr-review live: ' + problem };
  if (surface === 'terminal' || surface === 'desktop') {
    let placed = true;
    try {
      const opened = await $.ui.open({ id: PANE, title: 'pr-review live', focus: true, closeOnEscape: true });
      placed = !(opened && opened.isPlaced === false);
    } catch (err) {
      debug($, 'ui.open: ' + message(err));
      placed = false;
    }
    // A pane the surface could not place (a narrow terminal, an older Desktop app) still
    // leaves the band above the prompt; the text reply carries the same rows meanwhile.
    return placed ? {} : { text: renderText(run) };
  }
  return { text: renderText(run) };
}

// Attach and poll

/** `status <id>` polls and `--resume <id>` name the run up front, before the command runs. */
async function attachFromCommand($, cmd) {
  const status = /\bstatus\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(cmd);
  if (status && (!run || !isLive(run))) {
    const problem = await attach($, status[1] ?? status[2] ?? status[3], false);
    if (problem) debug($, 'status poll: ' + problem);
  }
  const resume = /--resume\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(cmd);
  if (resume) {
    const problem = await attach($, resume[1] ?? resume[2] ?? resume[3], true);
    if (problem) debug($, 'resume: ' + problem);
  }
}

/** The output past the launch block's own `key: value` lines (and blank lines), at most PREAMBLE_MAX_LINES of them. */
function pastPreamble(out) {
  const lines = out.split('\n');
  let i = 0;
  while (i < lines.length && i < PREAMBLE_MAX_LINES) {
    const line = lines[i].replace(/\r$/, '');
    if (line.trim() !== '' && !PREAMBLE_LINE_RE.test(line)) break;
    i += 1;
  }
  return lines.slice(i).join('\n');
}

/**
 * A `--detach` launch prints a fixed banner first (src/cli.ts). Past the launch block's own
 * `key: value` lines, only that banner at the start of stdout names a run. A foreground
 * summary (`--resume`, `--context-only`) starts otherwise, and the finding bodies inside it
 * are model output about PR content. Every reason not to attach goes to the debug file:
 * a launch the band missed must be explainable from `claude --debug-file`.
 */
async function attachFromBanner($, cmd, result) {
  if (!/\breview\b[\s\S]*--detach\b/.test(cmd)) return;
  const out = pastPreamble(String((result && result.result && result.result.stdout) || ''));
  if (!out.startsWith(BANNER)) {
    debug($, 'launch without the detach banner at the start of its output: ' + firstLine(out));
    return;
  }
  const id = RUN_ID_LINE_RE.exec(out);
  if (!id) {
    debug($, 'detach banner without a run-id line');
    return;
  }
  const problem = await attach($, id[1], false);
  if (problem) debug($, 'attach from banner: ' + problem);
}

/**
 * A run id is one directory name under the runs root (`<provider>__<owner>__<repo>__<n>__<stamp>`,
 * src/util/tmp.ts), so anything that could leave that directory, or hide in a terminal, is out.
 */
function validId(id) {
  return (
    id.length > 0 &&
    id.length <= 255 &&
    !id.includes('/') &&
    !id.includes('\\') &&
    !id.includes('..') &&
    !id.startsWith('.') &&
    !id.startsWith('-') &&
    clean(id) === id
  );
}

/** Follow one run. Resolves null once attached (or already followed live), else the problem, worded for the user. */
async function attach($, id, resume) {
  if (!validId(id)) return 'not a run id — ' + clean(id);
  if (run && run.id === id && !resume && isLive(run)) return null;
  const root = await runsRoot($);
  if (!root) return 'no home directory (USERPROFILE or HOME) to find ~/.pr-review/runs';
  const dir = root + sepOf(root) + id;
  let exists = false;
  try {
    exists = await $.fs.exists(dir);
  } catch (err) {
    return 'cannot read ' + dir + ': ' + message(err);
  }
  if (!exists) return 'no run ' + id + ' under ' + root;
  if (run && run.id === id && !resume && isLive(run)) return null;
  stopTimer(run);
  const r = {
    id,
    dir,
    resume,
    state: 'live',
    startedAtMs: stampMs(id),
    attachedAtMs: 0,
    nowMs: 0,
    endedAtMs: null,
    ticks: 0,
    timer: null,
    plan: null,
    passes: null,
    delivery: null,
    deliveryStamp: '',
    progress: [],
    reviewerProgress: [],
    eventsAtAttach: -1,
    sizes: {},
    lastChangeMs: 0,
    failure: null,
    problems: new Map(),
  };
  run = r;
  r.nowMs = await $.clock.now();
  if (run !== r) return null;
  r.attachedAtMs = r.nowMs;
  r.lastChangeMs = r.nowMs;
  await refresh($, r);
  if (run !== r) return null;
  if (isLive(r)) {
    r.timer = $.clock.every(1000, () => {
      tick($, r).catch((err) => {
        debug($, 'tick: ' + message(err));
      });
    });
  }
  if (surface === 'terminal' || surface === 'desktop') {
    try {
      // Unasked, the pane waits for a wide terminal (>= 144 columns); the band shows anyway.
      await $.ui.open({ id: PANE, title: 'pr-review live' });
    } catch (err) {
      // Nothing to do: the band carries the headline.
      debug($, 'ui.open: ' + message(err));
    }
  }
  $.ui.invalidate('ui.render');
  return null;
}

async function detachRun($) {
  stopTimer(run);
  run = null;
  try {
    await $.ui.close({ id: PANE });
  } catch (err) {
    // Already closed.
    debug($, 'ui.close: ' + message(err));
  }
  $.ui.invalidate('ui.render');
}

function isLive(r) {
  return r.state === 'live';
}

/** The run is over for the mod: freeze the clock at `endedAtMs` and stop polling. */
function settle(r, state, endedAtMs) {
  r.state = state;
  r.endedAtMs = endedAtMs;
  stopTimer(r);
}

function stopTimer(r) {
  if (r && r.timer) {
    r.timer.cancel();
    r.timer = null;
  }
}

async function tick($, r) {
  if (run !== r || !isLive(r)) return;
  r.ticks += 1;
  r.nowMs = await $.clock.now();
  if (run !== r || !isLive(r)) return;
  if (r.ticks % REFRESH_EVERY_TICKS === 0) {
    try {
      await refresh($, r);
      r.problems.delete('refresh');
    } catch (err) {
      // Shown on the band until a refresh succeeds; the timer keeps trying.
      r.problems.set('refresh', 'cannot refresh: ' + message(err));
    }
  }
  if (run !== r) return;
  if (isLive(r) && r.nowMs - r.attachedAtMs > RUN_CEILING_MS) settle(r, 'stale', r.nowMs);
  $.ui.invalidate('ui.render');
}

async function refresh($, r) {
  r.nowMs = await $.clock.now();
  if (run !== r) return;
  if (r.startedAtMs === null) {
    try {
      r.startedAtMs = (await $.fs.stat(pathOf(r, 'run.pid'))).mtimeMs;
    } catch {
      // No beacon yet; elapsed counts from the attach until it appears.
    }
  }
  await readFeed($, r, 'progress.ndjson', 'progress');
  await readFeed($, r, 'reviewer-progress.ndjson', 'reviewerProgress');
  if (!r.plan) r.plan = await readJson($, r, 'dispatch-plan.json');
  if (!r.passes) r.passes = await readJson($, r, 'passes.json');
  await readDelivery($, r);
  if (run !== r) return;
  // A resume attaches before the CLI appends its `resume` line, over a feed that still ends
  // in the previous attempt's `error`: only events written after the attach can finish it.
  if (r.resume && r.eventsAtAttach < 0) r.eventsAtAttach = r.progress.length;
  const fresh = !r.resume || r.progress.length > r.eventsAtAttach;
  const last = lastEvent(r);
  if (last && TERMINAL_PHASES.has(last.phase) && fresh) {
    settle(r, last.phase === 'error' ? 'failed' : 'done', last.ts);
    return;
  }
  const finalization = await freshStat($, r, 'finalization.json');
  if (run !== r) return;
  if (finalization) {
    settle(r, 'done', last ? last.ts : finalization.mtimeMs);
    return;
  }
  // The CLI writes error.txt where it fails (a gather, auth or runtime failure appends no
  // terminal phase at all); one older than the newest progress line belongs to an attempt a
  // resume already superseded.
  const failure = await freshStat($, r, 'error.txt');
  if (run !== r) return;
  if (failure && !(last && failure.mtimeMs < last.ts)) {
    const text = await readText($, r, 'error.txt');
    if (run !== r) return;
    r.failure = text === null ? 'see error.txt' : firstLine(text);
    settle(r, 'failed', failure.mtimeMs);
    return;
  }
  // A --context-only preview writes a summary with no plan and dispatches nothing. A plan
  // that exists but cannot be read is a problem the band names, not a preview.
  const dispatched = r.progress.some((ev) => ev.phase === 'dispatch');
  if (!r.plan && !r.problems.has('dispatch-plan.json') && !dispatched && (await pathExists($, pathOf(r, 'pr-review-summary.md')))) {
    if (run !== r) return;
    settle(r, 'preview', last ? last.ts : r.nowMs);
  }
}

/** Re-read an append-only NDJSON feed only when its size changed; skip a torn last line. */
async function readFeed($, r, file, key) {
  let stat;
  try {
    stat = await $.fs.stat(pathOf(r, file));
  } catch {
    return; // not written yet
  }
  if (r.sizes[file] === stat.size) return;
  const text = await readText($, r, file);
  if (text === null) return;
  r.sizes[file] = stat.size;
  r.lastChangeMs = r.nowMs;
  const events = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const ev = parseJson(t);
    // A line that does not parse is the writer's, mid-line; the next size change brings the rest.
    if (ev && typeof ev.ts === 'number') events.push(ev);
  }
  r[key] = events;
}

/** A write-once JSON artifact: null until it exists and parses (a torn write is retried). */
async function readJson($, r, file) {
  if (!(await pathExists($, pathOf(r, file)))) return null;
  const text = await readText($, r, file);
  return text === null ? null : parseJson(text);
}

/**
 * delivery-state.json is replaced atomically; re-read on a new stamp. Only a parsed read of
 * the canonical file retires the stamp — the backup is shown meanwhile, and the canonical
 * file is read again next refresh.
 */
async function readDelivery($, r) {
  let stat;
  try {
    stat = await $.fs.stat(pathOf(r, 'delivery-state.json'));
  } catch {
    return; // not written yet
  }
  const stamp = stat.mtimeMs + ':' + stat.size;
  if (stamp === r.deliveryStamp) return;
  const text = await readText($, r, 'delivery-state.json');
  const state = text === null ? null : parseJson(text);
  if (state && Array.isArray(state.planned)) {
    r.delivery = state;
    r.deliveryStamp = stamp;
    r.lastChangeMs = r.nowMs;
    return;
  }
  let backup = null;
  try {
    backup = parseJson(await $.fs.read(pathOf(r, '.delivery-state.json.bak')));
  } catch {
    backup = null; // no backup: keep what was shown
  }
  if (backup && Array.isArray(backup.planned)) r.delivery = backup;
}

/** The file's text, or null when it cannot be read — named on the band, since the caller saw it exist. */
async function readText($, r, file) {
  try {
    const text = await $.fs.read(pathOf(r, file));
    r.problems.delete(file);
    return text;
  } catch (err) {
    r.problems.set(file, 'cannot read ' + file + ': ' + message(err));
    return null;
  }
}

/** The stat of a run artifact that counts for this attach: present, and written after a resume's attach. */
async function freshStat($, r, file) {
  let stat;
  try {
    stat = await $.fs.stat(pathOf(r, file));
  } catch {
    return null;
  }
  return !r.resume || stat.mtimeMs > r.attachedAtMs ? stat : null;
}

async function pathExists($, path) {
  try {
    return await $.fs.exists(path);
  } catch {
    return false;
  }
}

/** `<home>/.pr-review/runs`, or null when the session has no home directory to find it under. */
async function runsRoot($) {
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'));
  if (!home) return null;
  const sep = sepOf(home);
  return home + sep + '.pr-review' + sep + 'runs';
}

/** The newest run by the UTC stamp in its name (`<provider>__<owner>__<repo>__<n>__<stamp>`). */
async function newestRunId($) {
  const root = await runsRoot($);
  if (!root) return null;
  let entries;
  try {
    entries = await $.fs.list(root);
  } catch (err) {
    debug($, 'fs.list: ' + message(err));
    return null;
  }
  const ids = entries.filter((x) => x.kind === 'dir' && STAMP_RE.test(x.name) && validId(x.name)).map((x) => x.name);
  ids.sort((a, b) => (STAMP_RE.exec(a)[0] < STAMP_RE.exec(b)[0] ? -1 : 1));
  return ids.length > 0 ? ids[ids.length - 1] : null;
}

/** A line for the debug log (`claude --debug-file`); never the transcript, never a throw. */
function debug($, text) {
  try {
    Promise.resolve($.ui.log('pr-review live: ' + text, { to: 'debug' })).catch(() => {});
  } catch {
    // A host without a debug log: nothing to say it to.
  }
}

// Derivation

function clean(value) {
  return String(value ?? '').replace(UNSAFE_RE, '');
}

function message(err) {
  return firstLine(err && err.message ? err.message : String(err));
}

function firstLine(text) {
  const line = clean(String(text).split('\n')[0]);
  return line.length > 120 ? line.slice(0, 119) + '…' : line;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sepOf(path) {
  return path.includes('\\') ? '\\' : '/';
}

function pathOf(r, file) {
  return r.dir + sepOf(r.dir) + file;
}

function stampMs(id) {
  const m = STAMP_RE.exec(id);
  if (!m) return null;
  const ms = Date.parse(m[1] + 'T' + m[2] + ':' + m[3] + ':' + m[4] + '.' + m[5] + 'Z');
  return Number.isFinite(ms) ? ms : null;
}

function lastEvent(r) {
  for (let i = r.progress.length - 1; i >= 0; i -= 1) {
    if (r.progress[i].phase !== 'reap') return r.progress[i];
  }
  return null;
}

/** `owner/repo #n` from the plan (or the run id); a narrow band gets `repo #n`, a narrower one `#n`. */
function prLabel(r, columns) {
  const pr = r.plan && r.plan.pr;
  const parts = r.id.split('__');
  const fromId = parts.length >= 5;
  const owner = pr && pr.owner ? pr.owner : fromId ? parts[1] : '';
  const repo = pr && pr.repo ? pr.repo : fromId ? parts[2] : '';
  const number = pr && pr.number != null ? pr.number : fromId ? parts[3] : '';
  if (!repo) return clean(r.id);
  if (columns === undefined || columns >= 96) return clean(owner + '/' + repo + ' #' + number);
  if (columns >= 64) return clean(repo + ' #' + number);
  return clean('#' + number);
}

/** Since the run started — or since the newest `resume` event, when the run was resumed — until it settled. */
function elapsedMs(r) {
  let start = r.startedAtMs ?? r.attachedAtMs;
  for (let i = r.progress.length - 1; i >= 0; i -= 1) {
    if (r.progress[i].phase === 'resume') {
      start = Math.max(start, r.progress[i].ts);
      break;
    }
  }
  const end = r.endedAtMs ?? r.nowMs;
  return Math.max(0, end - start);
}

function fmt(ms) {
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60) % 60;
  const h = Math.floor(s / 3600);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + ss : m + ':' + ss;
}

/**
 * Where a reviewer came from: the group the pane lists it under, and the match kind shown
 * beside a pack row (`matchedBy` is src/dispatch/pass-select.ts's; a plugin, companion or
 * repo rule says it all in the group).
 */
function sourceOf(reviewer) {
  const name = clean(reviewer.name);
  const source = clean(reviewer.source);
  if (reviewer.kind === 'companion-agent') return { group: 'plugin ' + (source || 'companion'), tag: '' };
  if (reviewer.matchedBy === 'plugin') return { group: 'plugin ' + name.split('/')[0], tag: '' };
  const pack = PACK_RE.exec(source);
  if (pack) return { group: 'pack ' + pack[1], tag: clean(reviewer.matchedBy ?? '') };
  if (reviewer.matchedBy === 'forced') return { group: 'forced skill', tag: '' };
  return { group: 'repo rule', tag: '' };
}

/** `<pack>/<skill>` and `<plugin>/<agent>` lose their prefix inside their group; a repo rule keeps its plain name. */
function shortName(name, group) {
  const shown = clean(name).replace(/^companion:/, '');
  const slash = shown.indexOf('/');
  return slash > 0 && (group.startsWith('pack ') || group.startsWith('plugin ')) ? shown.slice(slash + 1) : shown;
}

function has(list, name) {
  return Array.isArray(list) && list.includes(name);
}

/** One reviewer's state from the delivery record and its newest batch. */
function reviewerState(d, name, status, attempt, maxAttempts, seen) {
  if (d && has(d.valid, name)) return 'done';
  if (status === 'spawn-rejected') return 'failed';
  if (status === 'completed') {
    if (!has(d.invalid, name) && !has(d.missing, name)) return 'pending';
    return attempt < maxAttempts && d.kind !== 'terminal-incomplete' ? 'retry' : 'failed';
  }
  if (status === 'started') return seen ? 'delivered' : 'running';
  return 'pending';
}

/** One row per planned reviewer: state, time and source, from the plan, delivery and timeline. */
function reviewerRows(r) {
  const plan = r.plan;
  if (!plan || !Array.isArray(plan.reviewers)) return [];
  const d = r.delivery;
  const firstSeen = new Map();
  for (const ev of r.reviewerProgress) {
    if (ev.kind === 'output-first-seen' && ev.reviewer) firstSeen.set(ev.reviewer + '#' + ev.attempt, ev.ts);
  }
  return plan.reviewers.map((reviewer) => {
    const name = String(reviewer.name ?? '');
    const attempt = (d && d.reviewerAttempts && d.reviewerAttempts[name]) || 0;
    const batches = d && Array.isArray(d.runtimeAttempts) ? d.runtimeAttempts.filter((a) => has(a.reviewers, name)) : [];
    const batch = batches.length > 0 ? batches[batches.length - 1] : null;
    // Attempts written before lifecycle tracking carry no status: they are over unless the run says otherwise.
    const status = batch ? batch.status || (d.kind === 'running' ? 'started' : 'completed') : null;
    const seenTs = firstSeen.get(name + '#' + attempt);
    const state = reviewerState(d, name, status, attempt, reviewer.maxAttempts || 1, seenTs !== undefined);
    const startMs = batch ? Date.parse(batch.startedAt) : NaN;
    let endMs = r.nowMs;
    if (state === 'done' || state === 'delivered') endMs = seenTs ?? (batch ? Date.parse(batch.endedAt) : r.nowMs);
    else if (state === 'failed' || state === 'retry') endMs = batch ? Date.parse(batch.endedAt) : r.nowMs;
    const elapsed = state !== 'pending' && Number.isFinite(startMs) && Number.isFinite(endMs) ? fmt(endMs - startMs) : '';
    const { group, tag } = sourceOf(reviewer);
    return {
      name,
      short: shortName(name, group),
      kind: reviewer.kind === 'companion-agent' ? 'companion' : 'pass',
      state,
      group,
      tag,
      source: group + (tag ? ' · ' + tag : ''),
      elapsed,
    };
  });
}

/** The rows under their source, in order of first appearance. */
function groupRows(rows) {
  const groups = [];
  for (const row of rows) {
    const last = groups.find((g) => g.label === row.group);
    if (last) last.rows.push(row);
    else groups.push({ label: row.group, rows: [row] });
  }
  return groups;
}

/** One cell run per stretch of same-state reviewers, in plan order, `cells` wide per reviewer. */
function barRuns(rows, cells) {
  const runs = [];
  for (const row of rows) {
    const last = runs[runs.length - 1];
    if (last && last.state === row.state) last.count += 1;
    else runs.push({ state: row.state, count: 1 });
  }
  return runs.map((run) => ({ ...BAR[run.state], text: BAR[run.state].cell.repeat(run.count * cells) }));
}

/** Cells per reviewer so the bar and its count fit the room: 1 to 4. */
function barCells(rowCount, inner) {
  return Math.max(1, Math.min(4, Math.floor((inner - 20) / Math.max(1, rowCount))));
}

/** The states present, with their counts, in a fixed order. */
function legend(rows) {
  return STATE_ORDER.map((state) => ({ state, ...BAR[state], count: rows.filter((row) => row.state === state).length })).filter((item) => item.count > 0);
}

function tally(rows) {
  return {
    total: rows.length,
    delivered: rows.filter((row) => row.state === 'done' || row.state === 'delivered').length,
    valid: rows.filter((row) => row.state === 'done').length,
  };
}

function counts(r, rows) {
  const all = tally(rows);
  const passes = rows.filter((row) => row.kind === 'pass');
  const passesJson = Array.isArray(r.passes) ? r.passes : [];
  return {
    planned: all.total,
    delivered: all.delivered,
    valid: all.valid,
    passes: tally(passes),
    companions: tally(rows.filter((row) => row.kind === 'companion')),
    packs: passes.filter((row) => row.source.startsWith('pack ')).length,
    repoRules: passes.filter((row) => row.source === 'repo rule' || row.source === 'forced skill').length,
    plugins: passes.filter((row) => row.source.startsWith('plugin ')).length,
    context: passesJson.filter((p) => p && p.matchedBy === 'context'),
    onDemand: passesJson.filter((p) => p && p.matchedBy === 'index').length,
  };
}

function verifierLabel(r) {
  const plan = r.plan;
  if (plan && plan.verifier && plan.verifier.enabled === false) return 'verifier off';
  const state = r.delivery && r.delivery.verifier ? r.delivery.verifier.state : 'not-evaluated';
  const words = {
    'not-evaluated': 'verifier pending',
    'skipped-disabled': 'verifier off',
    'skipped-no-severe': 'verifier skipped',
    required: 'verifier ●',
    valid: 'verifier ✓',
    missing: 'verifier ✗',
    invalid: 'verifier ✗',
  };
  return words[state] || 'verifier ' + clean(state);
}

function codexLabel(r) {
  const plan = r.plan;
  if (plan && plan.codex && plan.codex.enabled === false) return 'codex off';
  const state = r.delivery && r.delivery.codex ? r.delivery.codex.state : 'pending';
  const words = { disabled: 'codex off', pending: 'codex ●', valid: 'codex ✓', failed: 'codex ✗' };
  return words[state] || 'codex ' + clean(state);
}

function headline(r) {
  const last = lastEvent(r);
  const time = fmt(elapsedMs(r));
  const phase = last ? clean(last.phase) + (last.detail ? ' — ' + clean(last.detail) : '') : 'starting…';
  let glyph = GLYPH.running;
  let text;
  if (r.state === 'preview') {
    glyph = GLYPH.done;
    text = time + ' · preview — no dispatch';
  } else if (r.state === 'failed' && r.failure !== null) {
    glyph = GLYPH.failed;
    text = time + ' · failed — ' + r.failure + ' · pr-review status ' + clean(r.id);
  } else if (r.state === 'failed') {
    glyph = GLYPH.failed;
    text = time + ' · ' + phase;
  } else if (r.state === 'done') {
    glyph = GLYPH.done;
    text = time + ' · ' + phase;
  } else if (r.state === 'stale') {
    glyph = GLYPH.pending;
    text = time + ' · ' + phase + ' · polling stopped after ' + fmt(RUN_CEILING_MS) + ', /pr-review-live ' + clean(r.id) + ' to reattach';
  } else {
    const silent = r.nowMs - r.lastChangeMs;
    text = time + ' · ' + phase + (silent > HEARTBEAT_SILENCE_MS ? ' · no heartbeat for ' + fmt(silent) : '');
  }
  for (const problem of r.problems.values()) text += ' · ' + problem;
  return { glyph, text };
}

function progressLine(label, t, settled) {
  return settled ? label + ' ' + t.valid + '/' + t.total + ' ✓' : label + ' ' + t.delivered + '/' + t.total + ' delivered';
}

function countsLine(r, c) {
  const settled = !isLive(r);
  return progressLine('passes', c.passes, settled) + ' · ' + progressLine('companions', c.companions, settled) + ' · ' + codexLabel(r) + ' · ' + verifierLabel(r);
}

/** Where the roster came from; a zero is left out, the project rules in context are always said. */
function sourcesLine(c) {
  const parts = [];
  if (c.packs > 0) parts.push('packs ' + c.packs);
  if (c.repoRules > 0) parts.push('repo rules ' + c.repoRules);
  if (c.plugins > 0) parts.push('plugins ' + c.plugins);
  if (c.companions.total > 0) parts.push('companions ' + c.companions.total);
  parts.push(c.context.length + ' project rules in every pass');
  if (c.onDemand > 0) parts.push(c.onDemand + ' on-demand');
  return parts.join(' · ');
}

/** `7/16 delivered` while the run is live, `16/16 ✓` once it settled. */
function totalLabel(r, c) {
  return isLive(r) ? c.delivered + '/' + c.planned + ' delivered' : c.valid + '/' + c.planned + ' ✓';
}

// Drawing

/** The status: the state glyph in its colour, then the headline text, truncated to the room. */
function statusRow(Box, Text, h) {
  return Box({
    flexDirection: 'row',
    flexShrink: 1,
    children: [
      Text({ color: h.glyph.color, dimColor: h.glyph.dim, children: [h.glyph.glyph + ' '] }),
      Text({ wrap: 'truncate-end', children: [h.text] }),
    ],
  });
}

/** The bar — one coloured run per stretch of same-state reviewers — and the delivered count beside it. */
function barRow(Box, Text, r, rows, c, inner) {
  const runs = barRuns(rows, barCells(rows.length, inner));
  return Box({
    flexDirection: 'row',
    columnGap: 2,
    children: [
      Box({ flexDirection: 'row', flexShrink: 0, children: runs.map((run) => Text({ color: run.color, dimColor: run.dim, children: [run.text] })) }),
      Text({ dimColor: true, wrap: 'truncate-end', children: [totalLabel(r, c)] }),
    ],
  });
}

/** `■ delivered 7   ■ running 9`: one square per state present, flowing onto a second row when narrow. */
function legendRow(Box, Text, rows) {
  return Box({
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 3,
    children: legend(rows).map((item) =>
      Box({
        flexDirection: 'row',
        flexShrink: 0,
        children: [Text({ color: item.color, dimColor: item.dim, children: ['■ '] }), Text({ children: [item.state + ' ' + item.count] })],
      }),
    ),
  });
}

/**
 * The band above the prompt: a rounded box with the title and the status on one row, the
 * bar, its legend, the counts and the sources. A band with fewer than BAND_ROWS rows of room
 * keeps the title, the bar and the counts; a narrow one shortens the PR label.
 */
function band(Box, Text, r, columns, maxRows) {
  const h = headline(r);
  const rows = reviewerRows(r);
  const c = counts(r, rows);
  const inner = Math.max(20, columns - 4);
  const compact = maxRows < BAND_ROWS;
  const line = (children, props) => Text({ wrap: 'truncate-end', ...props, children });
  const children = [
    Box({
      flexDirection: 'row',
      justifyContent: 'space-between',
      columnGap: 2,
      children: [
        Box({
          flexDirection: 'row',
          flexShrink: 0,
          children: [Text({ color: h.glyph.color, dimColor: h.glyph.dim, children: ['◆ '] }), Text({ bold: true, children: ['pr-review · ' + prLabel(r, columns)] })],
        }),
        statusRow(Box, Text, h),
      ],
    }),
  ];
  if (rows.length > 0) children.push(barRow(Box, Text, r, rows, c, inner));
  if (!compact && rows.length > 0) children.push(legendRow(Box, Text, rows));
  children.push(line([countsLine(r, c)]));
  if (!compact) children.push(line([sourcesLine(c) + ' · /pr-review-live'], { dimColor: true }));
  return Box({ key: 'pr-review-band', flexDirection: 'column', borderStyle: 'round', borderDimColor: true, paddingX: 1, width: columns, children });
}

/**
 * The pane: two header lines and the bar, then the reviewers grouped under their source —
 * one row each with the state glyph, the time, the short name and how it matched — the
 * siblings, and the project rules in context.
 */
function pane(Box, Text, r, columns) {
  const h = headline(r);
  const rows = reviewerRows(r);
  const c = counts(r, rows);
  const settled = !isLive(r);
  const row = (x) => {
    const g = GLYPH[x.state] || GLYPH.pending;
    return Box({
      flexDirection: 'row',
      paddingLeft: 2,
      columnGap: 2,
      children: [
        Box({ width: 7, flexShrink: 0, children: [Text({ color: g.color, dimColor: g.dim, children: [g.glyph + ' ' + x.elapsed.padStart(5)] })] }),
        Box({ flexGrow: 1, flexShrink: 1, children: [Text({ wrap: 'truncate-end', children: [x.short] })] }),
        ...(x.tag ? [Box({ flexShrink: 0, children: [Text({ dimColor: true, children: [x.tag] })] })] : []),
      ],
    });
  };
  const section = (title) => Text({ bold: true, children: [title] });
  const grouped = (list) => groupRows(list).flatMap((g) => [Text({ dimColor: true, children: ['  ' + g.label] }), ...g.rows.map(row)]);
  const passes = rows.filter((x) => x.kind === 'pass');
  const companions = rows.filter((x) => x.kind === 'companion');
  const siblings = [];
  if (r.plan && r.plan.codex && r.plan.codex.enabled) siblings.push(Text({ children: ['  ' + codexLabel(r) + ' · codex exec (read-only sibling)'] }));
  if (r.plan && r.plan.verifier && r.plan.verifier.enabled) siblings.push(Text({ children: ['  ' + verifierLabel(r) + ' · only with HIGH/CRITICAL findings'] }));
  const contextNames = c.context.map((p) => clean(p.name));
  const contextText = contextNames.length === 0 ? 'none' : contextNames.slice(0, 3).join(', ') + (contextNames.length > 3 ? ', … +' + (contextNames.length - 3) : '');
  return Box({
    flexDirection: 'column',
    children: [
      Text({ bold: true, wrap: 'truncate-end', children: [prLabel(r)] }),
      statusRow(Box, Text, h),
      ...(rows.length > 0 ? [barRow(Box, Text, r, rows, c, Math.max(30, columns))] : []),
      Text({ children: [' '] }),
      section(progressLine('passes', c.passes, settled)),
      ...grouped(passes),
      section(progressLine('companions', c.companions, settled)),
      ...(companions.length > 0 ? grouped(companions) : [Text({ dimColor: true, children: ['  none installed for this runtime'] })]),
      ...(siblings.length > 0 ? [section('siblings'), ...siblings] : []),
      Text({ children: [' '] }),
      Text({ children: ['context in every pass (' + c.context.length + '): ' + contextText] }),
      Text({ children: ['on-demand (index): ' + c.onDemand] }),
      Text({ dimColor: true, children: ['esc closes · /pr-review-live off detaches'] }),
    ],
  });
}

/** The pane as text, for an interactive surface that draws nothing (the VS Code chat panel). */
function renderText(r) {
  if (!r) return 'pr-review live: nothing attached';
  const h = headline(r);
  const rows = reviewerRows(r);
  const c = counts(r, rows);
  const settled = !isLive(r);
  const lines = ['pr-review · ' + prLabel(r) + ' · ' + h.glyph.glyph + ' ' + h.text];
  if (rows.length > 0) lines.push(barRuns(rows, barCells(rows.length, 80)).map((run) => run.text).join('') + '  ' + totalLabel(r, c));
  lines.push(countsLine(r, c), sourcesLine(c), '');
  const listed = (title, list) => {
    lines.push(title);
    for (const g of groupRows(list)) {
      lines.push('  ' + g.label);
      for (const x of g.rows) lines.push('  ' + (GLYPH[x.state] || GLYPH.pending).glyph + ' ' + x.elapsed.padStart(5) + '  ' + x.short + (x.tag ? '  ' + x.tag : ''));
    }
  };
  listed(progressLine('passes', c.passes, settled), rows.filter((x) => x.kind === 'pass'));
  listed(progressLine('companions', c.companions, settled), rows.filter((x) => x.kind === 'companion'));
  return lines.join('\n');
}
