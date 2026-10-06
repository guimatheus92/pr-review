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
//   Spinner     — ` · pr-review m:ss · delivered/planned…` while the run is alive.
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
//
// The host reads on("<event>", …) and $.noun.method(…) from the source text, so every call
// is spelled out in full and helpers that take $ are top-level functions.

const PANE = 'pr-review-live';
const REFRESH_EVERY_TICKS = 2; // one tick per second; the feeds change slower than that
const HEARTBEAT_SILENCE_MS = 90_000; // 1.5x the 60 s `running` heartbeat the CLI appends
const RUN_CEILING_MS = 2 * 60 * 60 * 1000; // stop polling a run that outlives any realistic review (30 min session, recovery, verifier)
const STAMP_RE = /__(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/; // the UTC stamp ensureRunDir() ends a run id with
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/; // a run id is one path segment: letters, digits, `_`, `.`, `-` (`..` is refused separately)
const PACK_RE = /[\\/]\.pr-review[\\/]packs[\\/]([^\\/]+)[\\/]/; // <home>/.pr-review/packs/<pack>/… in a reviewer's source → the pack name
const BANNER = 'Review started in the background'; // the first line of a --detach launch (src/cli.ts)
const TERMINAL_PHASES = new Set(['done', 'error']);
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g; // C0, DEL and C1 controls: no escape sequence from a skill name reaches the terminal

const GLYPH = {
  pending: { glyph: '·', color: undefined, dim: true },
  running: { glyph: '●', color: 'yellow', dim: false },
  delivered: { glyph: '◐', color: 'yellow', dim: false },
  done: { glyph: '✓', color: 'green', dim: false },
  retry: { glyph: '↻', color: 'yellow', dim: false },
  failed: { glyph: '✗', color: 'red', dim: false },
};

let interactive = false;
let surface = null;
/** The attached run, or null. Module state: a reload drops it, and the next poll re-attaches. */
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
    } catch {
      // A taken name or a host without commands: the band and pane still work.
    }
    return next(e);
  });

  on('session.end', async ($, e, next) => {
    stopTimer(run);
    return next(e);
  });

  // An observer, never a gate: every command goes through unchanged, and a failure in the
  // bookkeeping around it must neither block the command nor run it twice.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!interactive) return next(e);
    const cmd = String(e.command ?? '');
    try {
      await attachFromCommand($, cmd);
    } catch {
      // The command still runs; the band simply does not appear.
    }
    const result = await next(e);
    try {
      await attachFromBanner($, cmd, result);
    } catch {
      // The result below is the command's; the band is a bonus.
    }
    return result;
  }).catch(async ($, e, next) => {
    // Fail open: a hook that broke before calling next lets the command run as usual; one
    // that broke after it keeps the result Claude Code already holds and runs nothing again.
    if (next.called) return undefined;
    return next(e);
  });

  on('command.run', { command: 'pr-review-live' }, async ($, e) => {
    const arg = clean(String(e.args ?? '').trim());
    if (arg === 'off') {
      const id = run ? run.id : null;
      await detachRun($);
      return { text: id ? 'pr-review live: detached from ' + id : 'pr-review live: nothing was attached' };
    }
    const id = arg || (await newestRunId($));
    if (!id) return { text: 'pr-review live: no run found under ' + (await runsRoot($)) };
    let attached = false;
    try {
      attached = await attach($, id, false);
    } catch {
      attached = false;
    }
    if (!attached) return { text: 'pr-review live: no run ' + id + ' under ' + (await runsRoot($)) };
    if (surface === 'terminal' || surface === 'desktop') {
      let placed = true;
      try {
        const opened = await $.ui.open({ id: PANE, title: 'pr-review live', focus: true, closeOnEscape: true });
        placed = !(opened && opened.isPlaced === false);
      } catch {
        placed = false;
      }
      // A pane the surface could not place (a narrow terminal, an older Desktop app) still
      // leaves the band above the prompt; the text reply carries the same rows meanwhile.
      return placed ? {} : { text: renderText(run) };
    }
    return { text: renderText(run) };
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const r = run;
    if (!r || e.props.hasSurvey) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    const theirs = await next(e);
    let mine;
    try {
      mine = band(Box, Text, r, e.props.bodyColumns || 80);
    } catch {
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
    } catch {
      return Text({ dimColor: true, children: ['pr-review live: could not draw ' + clean(r.id) + ' — /pr-review-live off'] });
    }
  });

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const r = run;
    if (!r || r.done) return next(e);
    try {
      const c = counts(r);
      return next({ ...e, props: { ...e.props, suffix: ' · pr-review ' + fmt(elapsedMs(r)) + ' · ' + c.delivered + '/' + c.planned + '…' } });
    } catch {
      return next(e);
    }
  });
}

// Attach and poll

/** `status <id>` polls and `--resume <id>` name the run up front, before the command runs. */
async function attachFromCommand($, cmd) {
  const status = /\bstatus\s+"?([A-Za-z0-9][A-Za-z0-9_.-]*)"?/.exec(cmd);
  if (status && !run) await attach($, status[1], false);
  const resume = /--resume\s+"?([A-Za-z0-9][A-Za-z0-9_.-]*)"?/.exec(cmd);
  if (resume) await attach($, resume[1], true);
}

/**
 * A `--detach` launch prints a fixed banner first (src/cli.ts); only that banner, at the
 * very start of stdout, names a run. A foreground summary (`--resume`, `--context-only`)
 * starts otherwise, and the finding bodies inside it are model output about PR content.
 */
async function attachFromBanner($, cmd, result) {
  if (!/\breview\b[\s\S]*--detach\b/.test(cmd)) return;
  const out = String((result && result.result && result.result.stdout) || '');
  if (!out.startsWith(BANNER)) return;
  const id = /^ {2}run-id: ([A-Za-z0-9][A-Za-z0-9_.-]*)$/m.exec(out);
  if (id) await attach($, id[1], false);
}

/** Follow one run. Resolves true once attached (or already followed), false for an id that is not a run directory. */
async function attach($, id, resume) {
  if (!ID_RE.test(id) || id.includes('..')) return false;
  if (run && run.id === id && !resume && !run.done && !run.stale) return true;
  const root = await runsRoot($);
  const dir = root + sepOf(root) + id;
  let exists = false;
  try {
    exists = await $.fs.exists(dir);
  } catch {
    exists = false;
  }
  if (!exists) return false;
  if (run && run.id === id && !resume && !run.done && !run.stale) return true;
  stopTimer(run);
  const r = {
    id,
    dir,
    resume,
    startedAtMs: stampMs(id),
    attachedAtMs: 0,
    nowMs: 0,
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
    done: false,
    preview: false,
    stale: false,
  };
  run = r;
  r.nowMs = await $.clock.now();
  if (run !== r) return true;
  r.attachedAtMs = r.nowMs;
  r.lastChangeMs = r.nowMs;
  await refresh($, r);
  if (run !== r) return true;
  if (!r.done) {
    r.timer = $.clock.every(1000, () => {
      tick($, r).catch(() => {});
    });
  }
  if (surface === 'terminal' || surface === 'desktop') {
    try {
      // Unasked, the pane waits for a wide terminal (>= 144 columns); the band shows anyway.
      await $.ui.open({ id: PANE, title: 'pr-review live' });
    } catch {
      // Nothing to do: the band carries the headline.
    }
  }
  $.ui.invalidate('ui.render');
  return true;
}

async function detachRun($) {
  stopTimer(run);
  run = null;
  try {
    await $.ui.close({ id: PANE });
  } catch {
    // Already closed.
  }
  $.ui.invalidate('ui.render');
}

function stopTimer(r) {
  if (r && r.timer) {
    r.timer.cancel();
    r.timer = null;
  }
}

async function tick($, r) {
  if (run !== r) return;
  r.ticks += 1;
  r.nowMs = await $.clock.now();
  if (run !== r) return;
  if (!r.done && r.ticks % REFRESH_EVERY_TICKS === 0) await refresh($, r);
  if (run !== r) return;
  if (r.done) stopTimer(r);
  else if (r.nowMs - r.attachedAtMs > RUN_CEILING_MS) {
    r.stale = true;
    stopTimer(r);
  }
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
  const terminal = last !== null && TERMINAL_PHASES.has(last.phase);
  let finalized = false;
  try {
    const stat = await $.fs.stat(pathOf(r, 'finalization.json'));
    finalized = !r.resume || stat.mtimeMs > r.attachedAtMs;
  } catch {
    finalized = false;
  }
  if (run !== r) return;
  r.preview = !r.plan && !terminal && !finalized && (await fileExists($, r, 'pr-review-summary.md'));
  r.done = r.preview || ((terminal || finalized) && fresh);
}

/** Re-read an append-only NDJSON feed only when its size changed; skip a torn last line. */
async function readFeed($, r, file, key) {
  let stat;
  try {
    stat = await $.fs.stat(pathOf(r, file));
  } catch {
    return;
  }
  if (r.sizes[file] === stat.size) return;
  let text;
  try {
    text = await $.fs.read(pathOf(r, file));
  } catch {
    return;
  }
  r.sizes[file] = stat.size;
  r.lastChangeMs = r.nowMs;
  const events = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const ev = JSON.parse(t);
      if (typeof ev.ts === 'number') events.push(ev);
    } catch {
      // The writer is mid-line; the next size change brings the rest.
    }
  }
  r[key] = events;
}

/** A write-once JSON artifact: null until it exists and parses (a torn write is retried). */
async function readJson($, r, file) {
  try {
    return JSON.parse(await $.fs.read(pathOf(r, file)));
  } catch {
    return null;
  }
}

/** delivery-state.json is replaced atomically; re-read on a new stamp, and again after a torn read. */
async function readDelivery($, r) {
  let stat;
  try {
    stat = await $.fs.stat(pathOf(r, 'delivery-state.json'));
  } catch {
    return;
  }
  const stamp = stat.mtimeMs + ':' + stat.size;
  if (stamp === r.deliveryStamp) return;
  for (const file of ['delivery-state.json', '.delivery-state.json.bak']) {
    try {
      const state = JSON.parse(await $.fs.read(pathOf(r, file)));
      if (!Array.isArray(state.planned)) continue;
      r.delivery = state;
      // Only a parsed read retires the stamp: a torn one is read again next refresh.
      r.deliveryStamp = stamp;
      r.lastChangeMs = r.nowMs;
      return;
    } catch {
      // Torn or absent; try the backup, then again next refresh.
    }
  }
}

async function fileExists($, r, file) {
  try {
    return await $.fs.exists(pathOf(r, file));
  } catch {
    return false;
  }
}

async function runsRoot($) {
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '.';
  const sep = sepOf(home);
  return home + sep + '.pr-review' + sep + 'runs';
}

/** The newest run by the UTC stamp in its name (`<provider>__<owner>__<repo>__<n>__<stamp>`). */
async function newestRunId($) {
  let entries;
  try {
    entries = await $.fs.list(await runsRoot($));
  } catch {
    return null;
  }
  const ids = entries.filter((x) => x.kind === 'dir' && STAMP_RE.test(x.name)).map((x) => x.name);
  ids.sort((a, b) => (STAMP_RE.exec(a)[0] < STAMP_RE.exec(b)[0] ? -1 : 1));
  return ids.length > 0 ? ids[ids.length - 1] : null;
}

// Derivation

function clean(value) {
  return String(value ?? '').replace(CONTROL_RE, '');
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

function prLabel(r) {
  const pr = r.plan && r.plan.pr;
  if (pr && pr.owner && pr.repo) return clean(pr.owner + '/' + pr.repo + ' #' + pr.number);
  const parts = r.id.split('__');
  return clean(parts.length >= 5 ? parts[1] + '/' + parts[2] + ' #' + parts[3] : r.id);
}

/** Since the run started — or since the newest `resume` event, when the run was resumed. */
function elapsedMs(r) {
  let start = r.startedAtMs !== null ? r.startedAtMs : r.attachedAtMs;
  for (let i = r.progress.length - 1; i >= 0; i -= 1) {
    if (r.progress[i].phase === 'resume') {
      start = Math.max(start, r.progress[i].ts);
      break;
    }
  }
  const last = lastEvent(r);
  const end = r.done && last ? last.ts : r.nowMs;
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

function sourceLabel(reviewer) {
  const name = clean(reviewer.name);
  const source = clean(reviewer.source);
  if (reviewer.kind === 'companion-agent') return 'plugin ' + (source || 'companion');
  if (reviewer.matchedBy === 'plugin') return 'plugin ' + name.split('/')[0];
  const pack = PACK_RE.exec(source);
  if (pack) return 'pack ' + pack[1] + (reviewer.matchedBy ? ' · ' + clean(reviewer.matchedBy) : '');
  if (reviewer.matchedBy === 'forced') return 'forced skill';
  if (reviewer.matchedBy === 'configured') return 'configured dir';
  return 'repo rule';
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
    const attempt = d && d.reviewerAttempts ? d.reviewerAttempts[name] || 0 : 0;
    const batches = d && Array.isArray(d.runtimeAttempts) ? d.runtimeAttempts.filter((a) => Array.isArray(a.reviewers) && a.reviewers.includes(name)) : [];
    const batch = batches.length > 0 ? batches[batches.length - 1] : null;
    // Attempts written before lifecycle tracking carry no status: they are over unless the run says otherwise.
    const status = batch ? batch.status || (d.kind === 'running' ? 'started' : 'completed') : null;
    const seenTs = firstSeen.get(name + '#' + attempt);
    let state = 'pending';
    if (d && d.valid && d.valid.includes(name)) state = 'done';
    else if (status === 'spawn-rejected') state = 'failed';
    else if (status === 'completed') {
      const unresolved = (d.invalid && d.invalid.includes(name)) || (d.missing && d.missing.includes(name));
      state = unresolved ? (attempt < (reviewer.maxAttempts || 1) && d.kind !== 'terminal-incomplete' ? 'retry' : 'failed') : 'pending';
    } else if (status === 'started') state = seenTs ? 'delivered' : 'running';
    const startMs = batch ? Date.parse(batch.startedAt) : NaN;
    let endMs = r.nowMs;
    if (state === 'done' || state === 'delivered') endMs = seenTs || (batch ? Date.parse(batch.endedAt) : r.nowMs);
    else if (state === 'failed' || state === 'retry') endMs = batch ? Date.parse(batch.endedAt) : r.nowMs;
    const elapsed = state !== 'pending' && Number.isFinite(startMs) && Number.isFinite(endMs) ? fmt(endMs - startMs) : '';
    return {
      name,
      shown: clean(name).replace(/^companion:/, ''),
      kind: reviewer.kind === 'companion-agent' ? 'companion' : 'pass',
      state,
      source: sourceLabel(reviewer),
      elapsed,
    };
  });
}

function counts(r) {
  const rows = reviewerRows(r);
  const by = (kind) => rows.filter((row) => row.kind === kind);
  const delivered = (list) => list.filter((row) => row.state === 'done' || row.state === 'delivered').length;
  const valid = (list) => list.filter((row) => row.state === 'done').length;
  const passes = by('pass');
  const companions = by('companion');
  const passesJson = Array.isArray(r.passes) ? r.passes : [];
  return {
    planned: rows.length,
    delivered: delivered(rows),
    valid: valid(rows),
    passes: { total: passes.length, delivered: delivered(passes), valid: valid(passes) },
    companions: { total: companions.length, delivered: delivered(companions), valid: valid(companions) },
    packs: passes.filter((row) => row.source.startsWith('pack ')).length,
    repoRules: passes.filter((row) => row.source === 'repo rule' || row.source === 'forced skill' || row.source === 'configured dir').length,
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
  if (r.preview) return { glyph: GLYPH.done, text: fmt(elapsedMs(r)) + ' · preview — no dispatch' };
  if (!last) return { glyph: GLYPH.running, text: fmt(elapsedMs(r)) + ' · starting…' };
  const phase = clean(last.phase) + (last.detail ? ' — ' + clean(last.detail) : '');
  if (r.done) return { glyph: last.phase === 'error' ? GLYPH.failed : GLYPH.done, text: fmt(elapsedMs(r)) + ' · ' + phase };
  if (r.stale) return { glyph: GLYPH.pending, text: fmt(elapsedMs(r)) + ' · ' + phase + ' · polling stopped after ' + fmt(RUN_CEILING_MS) + ', /pr-review-live ' + clean(r.id) + ' to reattach' };
  const silent = r.nowMs - r.lastChangeMs;
  const note = silent > HEARTBEAT_SILENCE_MS ? ' · no heartbeat for ' + fmt(silent) : '';
  return { glyph: GLYPH.running, text: fmt(elapsedMs(r)) + ' · ' + phase + note };
}

function countsLine(r, c) {
  const passes = r.done ? 'passes ' + c.passes.valid + '/' + c.passes.total + ' ✓' : 'passes ' + c.passes.delivered + '/' + c.passes.total + ' delivered';
  const companions = r.done ? 'companions ' + c.companions.valid + '/' + c.companions.total + ' ✓' : 'companions ' + c.companions.delivered + '/' + c.companions.total + ' delivered';
  return passes + ' · ' + companions + ' · ' + codexLabel(r) + ' · ' + verifierLabel(r);
}

function sourcesLine(c) {
  return 'packs ' + c.packs + ' · repo rules ' + c.repoRules + ' · plugins ' + c.plugins + ' · companions ' + c.companions.total +
    ' · context: ' + c.context.length + ' project rules in every pass · ' + c.onDemand + ' on-demand';
}

// Drawing

function band(Box, Text, r, columns) {
  const h = headline(r);
  const c = counts(r);
  const line = (children) => Text({ wrap: 'truncate-end', children });
  return Box({
    flexDirection: 'column',
    paddingX: 1,
    width: columns,
    children: [
      Box({
        flexDirection: 'row',
        children: [
          Text({ bold: true, children: ['pr-review · ' + prLabel(r) + ' · '] }),
          Text({ color: h.glyph.color, dimColor: h.glyph.dim, children: [h.glyph.glyph + ' '] }),
          line([h.text]),
        ],
      }),
      line([countsLine(r, c)]),
      Text({ dimColor: true, wrap: 'truncate-end', children: [sourcesLine(c) + ' · /pr-review-live'] }),
    ],
  });
}

function pane(Box, Text, r, columns) {
  const h = headline(r);
  const c = counts(r);
  const rows = reviewerRows(r);
  const nameWidth = Math.max(12, Math.min(44, columns - 36));
  const row = (x) => {
    const g = GLYPH[x.state] || GLYPH.pending;
    return Box({
      flexDirection: 'row',
      columnGap: 1,
      children: [
        Text({ color: g.color, dimColor: g.dim, children: [g.glyph + ' ' + x.elapsed.padStart(5)] }),
        Text({ wrap: 'truncate-end', children: [x.shown.length > nameWidth ? x.shown.slice(0, nameWidth - 1) + '…' : x.shown.padEnd(nameWidth)] }),
        Text({ dimColor: true, wrap: 'truncate-end', children: [x.source] }),
      ],
    });
  };
  const section = (title) => Text({ bold: true, children: [title] });
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
      Box({
        flexDirection: 'row',
        children: [
          Text({ bold: true, children: [prLabel(r) + ' · '] }),
          Text({ color: h.glyph.color, dimColor: h.glyph.dim, children: [h.glyph.glyph + ' '] }),
          Text({ wrap: 'truncate-end', children: [h.text] }),
        ],
      }),
      Text({ children: [' '] }),
      section(r.done ? 'passes ' + c.passes.valid + '/' + c.passes.total + ' ✓' : 'passes ' + c.passes.delivered + '/' + c.passes.total + ' delivered'),
      ...passes.map(row),
      section(r.done ? 'companions ' + c.companions.valid + '/' + c.companions.total + ' ✓' : 'companions ' + c.companions.delivered + '/' + c.companions.total + ' delivered'),
      ...(companions.length > 0 ? companions.map(row) : [Text({ dimColor: true, children: ['  none installed for this runtime'] })]),
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
  const c = counts(r);
  const lines = ['pr-review · ' + prLabel(r) + ' · ' + h.glyph.glyph + ' ' + h.text, countsLine(r, c), sourcesLine(c), ''];
  for (const x of reviewerRows(r)) lines.push((GLYPH[x.state] || GLYPH.pending).glyph + ' ' + x.elapsed.padStart(5) + '  ' + x.shown + '  ' + x.source);
  return lines.join('\n');
}
