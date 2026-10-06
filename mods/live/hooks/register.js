// pr-review live — a Claude Code mod that shows a running review as it happens.
//
// It is one more READER of the run directory (~/.pr-review/runs/<id>/): the same feeds
// `pr-review status` reads, never `status` itself (which can reap processes), and it
// writes nothing — not to the PR, not to the checkout, not to ~/.pr-review.
//
// What it draws (terminal and Desktop only; hooks still run elsewhere, nothing shows):
//   AbovePrompt — three lines: PR + phase + timer; delivered counts; counts by source.
//   Pane        — one row per reviewer (state, time, source), the project rules in context.
//   Spinner     — ` · pr-review m:ss · delivered/planned…` while the run is alive.
//   /pr-review-live [run-id | off] — attach (newest run by default) or detach; answers in
//   text where nothing draws.
//
// Where the facts come from (src/util/progress.ts, src/dispatch/reviewer-progress.ts,
// src/dispatch/delivery.ts, src/dispatch/pass-select.ts):
//   progress.ndjson          phase + heartbeat   {ts, phase, detail}
//   reviewer-progress.ndjson per-reviewer events {ts, kind, reviewer, attempt, …}
//   dispatch-plan.json       the roster: reviewers[] {name, kind, source, matchedBy, maxAttempts}
//   delivery-state.json      valid/invalid/missing, reviewerAttempts, runtimeAttempts[]
//   passes.json              {name, source, matchedBy}[] — `context` rows are the project rules
//   companions.json          recognized / missing companion plugins
//
// The host reads on("<event>", …) and $.noun.method(…) from the source text, so every call
// is spelled out in full and helpers that take $ are top-level functions.

const PANE = 'pr-review-live';
const REFRESH_EVERY_TICKS = 2; // one tick per second
const HEARTBEAT_SILENCE_MS = 90_000;
const RUN_CEILING_MS = 2 * 60 * 60 * 1000;
const STAMP_RE = /__(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;
const PACK_RE = /[\\/]\.pr-review[\\/]packs[\\/]([^\\/]+)[\\/]/;
const TERMINAL_PHASES = new Set(['done', 'error']);

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
    stopTimer();
    return next(e);
  });

  // The slash command (and the personal alias) launch `node "$CLI" review <url> --detach`,
  // whose output names the run; `status <id>` polls and `--resume <id>` name it up front.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!interactive) return next(e);
    const cmd = String(e.command ?? '');
    const status = /(?:cli\.cjs"?|\bpr-review)\s+status\s+(\S+)/.exec(cmd);
    if (status && !run) await attach($, status[1], null);
    if (!/(?:cli\.cjs"?|\bpr-review)\s+review\b/.test(cmd)) return next(e);
    const resume = /--resume\s+(\S+)/.exec(cmd);
    const runDir = /--run-dir\s+"?([^"\s]+)"?/.exec(cmd);
    if (resume) await attach($, resume[1], runDir ? runDir[1] : null);
    const result = await next(e);
    const out = String((result && result.result && result.result.stdout) || (result && result.text) || '');
    const id = /run-id:\s*(\S+)/.exec(out);
    const dir = /^[ \t]*dir:[ \t]*(.+?)[ \t]*$/m.exec(out);
    if (id) await attach($, id[1], dir ? dir[1] : null);
    return result;
  });

  on('command.run', { command: 'pr-review-live' }, async ($, e) => {
    const arg = String(e.args ?? '').trim();
    if (arg === 'off') {
      const id = run ? run.id : null;
      await detachRun($);
      return { text: id ? 'pr-review live: detached from ' + id : 'pr-review live: nothing was attached' };
    }
    const id = arg || (await newestRunId($));
    if (!id) return { text: 'pr-review live: no run found under ' + (await runsRoot($)) };
    await attach($, id, null);
    if (surface === 'terminal' || surface === 'desktop') {
      try {
        await $.ui.open({ id: PANE, title: 'pr-review live', focus: true, closeOnEscape: true });
      } catch {
        // A refused open leaves the band; the text below says where to look.
      }
      return {};
    }
    return { text: renderText() };
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!run || e.props.hasSurvey) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    const theirs = await next(e);
    const mine = band(Box, Text, e.props.bodyColumns || 80);
    return theirs && typeof theirs === 'object' ? Box({ flexDirection: 'column', children: [mine, theirs] }) : mine;
  });

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    if (!run) return Text({ dimColor: true, children: ['No pr-review run attached. /pr-review-live [run-id], or start a review.'] });
    return pane(Box, Text, e.props.bodyColumns || 80);
  });

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (!run || run.done) return next(e);
    const c = counts();
    return next({ ...e, props: { ...e.props, suffix: ' · pr-review ' + fmt(elapsedMs()) + ' · ' + c.delivered + '/' + c.planned + '…' } });
  });
}

// ---------------------------------------------------------------- attach and poll

async function attach($, id, dir) {
  if (run && run.id === id) return;
  stopTimer();
  const base = dir || (await runsRoot($)) + sepOf(await runsRoot($)) + id;
  run = {
    id,
    dir: base,
    startedAtMs: stampMs(id),
    attachedAtMs: 0,
    nowMs: 0,
    ticks: 0,
    timer: null,
    plan: null,
    passes: null,
    companions: null,
    delivery: null,
    deliveryStamp: '',
    progress: [],
    reviewerProgress: [],
    sizes: {},
    lastChangeMs: 0,
    done: false,
    preview: false,
  };
  run.nowMs = await $.clock.now();
  run.attachedAtMs = run.nowMs;
  run.lastChangeMs = run.nowMs;
  await refresh($);
  if (!run.done) run.timer = $.clock.every(1000, () => tick($));
  if (surface === 'terminal' || surface === 'desktop') {
    try {
      // Unasked, the pane waits for a wide terminal (>= 144 columns); the band shows anyway.
      await $.ui.open({ id: PANE, title: 'pr-review live' });
    } catch {
      // Nothing to do: the band carries the headline.
    }
  }
  $.ui.invalidate('ui.render');
}

async function detachRun($) {
  stopTimer();
  run = null;
  try {
    await $.ui.close({ id: PANE });
  } catch {
    // Already closed.
  }
  $.ui.invalidate('ui.render');
}

function stopTimer() {
  if (run && run.timer) {
    run.timer.cancel();
    run.timer = null;
  }
}

async function tick($) {
  if (!run) return;
  run.ticks += 1;
  run.nowMs = await $.clock.now();
  if (!run.done && run.ticks % REFRESH_EVERY_TICKS === 0) await refresh($);
  if (run.done || run.nowMs - run.attachedAtMs > RUN_CEILING_MS) stopTimer();
  $.ui.invalidate('ui.render');
}

async function refresh($) {
  const r = run;
  if (!r) return;
  r.nowMs = await $.clock.now();
  if (r.startedAtMs === null) {
    try {
      r.startedAtMs = (await $.fs.stat(pathOf(r, 'run.pid'))).mtimeMs;
    } catch {
      // No beacon yet; elapsed counts from the attach until it appears.
    }
  }
  await readFeed($, 'progress.ndjson', 'progress');
  await readFeed($, 'reviewer-progress.ndjson', 'reviewerProgress');
  if (!r.plan) r.plan = await readJson($, 'dispatch-plan.json');
  if (!r.passes) r.passes = await readJson($, 'passes.json');
  if (!r.companions) r.companions = await readJson($, 'companions.json');
  await readDelivery($);
  const last = lastEvent(r);
  r.done = (await fileExists($, 'finalization.json')) || (last !== null && TERMINAL_PHASES.has(last.phase));
  r.preview = !r.plan && !r.done && (await fileExists($, 'pr-review-summary.md'));
}

/** Re-read an append-only NDJSON feed only when its size changed; skip a torn last line. */
async function readFeed($, file, key) {
  const r = run;
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
async function readJson($, file) {
  try {
    return JSON.parse(await $.fs.read(pathOf(run, file)));
  } catch {
    return null;
  }
}

/** delivery-state.json is replaced atomically; re-read on a new stamp or after a failed parse. */
async function readDelivery($) {
  const r = run;
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

async function fileExists($, file) {
  try {
    return await $.fs.exists(pathOf(run, file));
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

// ---------------------------------------------------------------- derivation

function sepOf(path) {
  return path.includes('\\') ? '\\' : '/';
}

function pathOf(r, file) {
  return r.dir + sepOf(r.dir) + file;
}

function stampMs(id) {
  const m = STAMP_RE.exec(id);
  return m ? Date.parse(m[1] + 'T' + m[2] + ':' + m[3] + ':' + m[4] + '.' + m[5] + 'Z') : null;
}

function lastEvent(r) {
  for (let i = r.progress.length - 1; i >= 0; i -= 1) {
    if (r.progress[i].phase !== 'reap') return r.progress[i];
  }
  return null;
}

function prLabel() {
  const pr = run.plan && run.plan.pr;
  if (pr && pr.owner && pr.repo) return pr.owner + '/' + pr.repo + ' #' + pr.number;
  const parts = run.id.split('__');
  return parts.length >= 5 ? parts[1] + '/' + parts[2] + ' #' + parts[3] : run.id;
}

function elapsedMs() {
  const start = run.startedAtMs !== null ? run.startedAtMs : run.attachedAtMs;
  const last = lastEvent(run);
  const end = run.done && last && TERMINAL_PHASES.has(last.phase) ? last.ts : run.nowMs;
  return Math.max(0, end - start);
}

function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60) % 60;
  const h = Math.floor(s / 3600);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + ss : m + ':' + ss;
}

function sourceLabel(reviewer) {
  if (reviewer.kind === 'companion-agent') return 'plugin ' + (reviewer.source || 'companion');
  if (reviewer.matchedBy === 'plugin') return 'plugin ' + String(reviewer.name).split('/')[0];
  const pack = PACK_RE.exec(String(reviewer.source || ''));
  if (pack) return 'pack ' + pack[1] + (reviewer.matchedBy ? ' · ' + reviewer.matchedBy : '');
  if (reviewer.matchedBy === 'forced') return 'forced skill';
  if (reviewer.matchedBy === 'configured') return 'configured dir';
  return 'repo rule';
}

/** One row per planned reviewer: state, time and source, from the plan, delivery and timeline. */
function reviewerRows() {
  const plan = run.plan;
  if (!plan || !Array.isArray(plan.reviewers)) return [];
  const d = run.delivery;
  const firstSeen = new Map();
  for (const ev of run.reviewerProgress) {
    if (ev.kind === 'output-first-seen' && ev.reviewer) firstSeen.set(ev.reviewer + '#' + ev.attempt, ev.ts);
  }
  return plan.reviewers.map((reviewer) => {
    const name = reviewer.name;
    const attempt = d && d.reviewerAttempts ? d.reviewerAttempts[name] || 0 : 0;
    const batches = d && Array.isArray(d.runtimeAttempts) ? d.runtimeAttempts.filter((a) => Array.isArray(a.reviewers) && a.reviewers.includes(name)) : [];
    const batch = batches.length > 0 ? batches[batches.length - 1] : null;
    const seenTs = firstSeen.get(name + '#' + attempt);
    let state = 'pending';
    if (d && d.valid && d.valid.includes(name)) state = 'done';
    else if (batch && batch.status === 'spawn-rejected') state = 'failed';
    else if (batch && batch.status === 'completed') {
      const unresolved = (d.invalid && d.invalid.includes(name)) || (d.missing && d.missing.includes(name));
      state = unresolved ? (attempt < (reviewer.maxAttempts || 1) && d.kind !== 'terminal-incomplete' ? 'retry' : 'failed') : 'pending';
    } else if (batch) state = seenTs ? 'delivered' : 'running';
    const startMs = batch ? Date.parse(batch.startedAt) : null;
    let endMs = run.nowMs;
    if (state === 'done' || state === 'delivered') endMs = seenTs || (batch ? Date.parse(batch.endedAt) : run.nowMs);
    else if (state === 'failed' || state === 'retry') endMs = batch ? Date.parse(batch.endedAt) : run.nowMs;
    return {
      name,
      shown: String(name).replace(/^companion:/, ''),
      kind: reviewer.kind === 'companion-agent' ? 'companion' : 'pass',
      state,
      source: sourceLabel(reviewer),
      elapsed: startMs !== null && endMs !== null && state !== 'pending' ? fmt(endMs - startMs) : '',
    };
  });
}

function counts() {
  const rows = reviewerRows();
  const by = (kind) => rows.filter((r) => r.kind === kind);
  const delivered = (list) => list.filter((r) => r.state === 'done' || r.state === 'delivered').length;
  const valid = (list) => list.filter((r) => r.state === 'done').length;
  const passes = by('pass');
  const companions = by('companion');
  const passesJson = Array.isArray(run.passes) ? run.passes : [];
  return {
    planned: rows.length,
    delivered: delivered(rows),
    valid: valid(rows),
    passes: { total: passes.length, delivered: delivered(passes), valid: valid(passes) },
    companions: { total: companions.length, delivered: delivered(companions), valid: valid(companions) },
    packs: passes.filter((r) => r.source.startsWith('pack ')).length,
    repoRules: passes.filter((r) => r.source === 'repo rule' || r.source === 'forced skill' || r.source === 'configured dir').length,
    plugins: passes.filter((r) => r.source.startsWith('plugin ')).length,
    context: passesJson.filter((p) => p.matchedBy === 'context'),
    onDemand: passesJson.filter((p) => p.matchedBy === 'index').length,
  };
}

function verifierLabel() {
  const plan = run.plan;
  if (plan && plan.verifier && plan.verifier.enabled === false) return 'verifier off';
  const state = run.delivery && run.delivery.verifier ? run.delivery.verifier.state : 'not-evaluated';
  const words = {
    'not-evaluated': 'verifier pending',
    'skipped-disabled': 'verifier off',
    'skipped-no-severe': 'verifier skipped',
    required: 'verifier ●',
    valid: 'verifier ✓',
    missing: 'verifier ✗',
    invalid: 'verifier ✗',
  };
  return words[state] || 'verifier ' + state;
}

function codexLabel() {
  const plan = run.plan;
  if (plan && plan.codex && plan.codex.enabled === false) return 'codex off';
  const state = run.delivery && run.delivery.codex ? run.delivery.codex.state : 'pending';
  const words = { disabled: 'codex off', pending: 'codex ●', valid: 'codex ✓', failed: 'codex ✗' };
  return words[state] || 'codex ' + state;
}

function headline() {
  const last = lastEvent(run);
  if (run.preview) return { glyph: GLYPH.done, text: fmt(elapsedMs()) + ' · preview — no dispatch' };
  if (!last) return { glyph: GLYPH.running, text: fmt(elapsedMs()) + ' · starting…' };
  const phase = last.phase + (last.detail ? ' — ' + last.detail : '');
  if (run.done) return { glyph: last.phase === 'error' ? GLYPH.failed : GLYPH.done, text: fmt(elapsedMs()) + ' · ' + phase };
  const silent = run.nowMs - run.lastChangeMs;
  const note = silent > HEARTBEAT_SILENCE_MS ? ' · no heartbeat for ' + fmt(silent) : '';
  return { glyph: GLYPH.running, text: fmt(elapsedMs()) + ' · ' + phase + note };
}

function countsLine(c) {
  const passes = run.done ? 'passes ' + c.passes.valid + '/' + c.passes.total + ' ✓' : 'passes ' + c.passes.delivered + '/' + c.passes.total + ' delivered';
  const companions = run.done ? 'companions ' + c.companions.valid + '/' + c.companions.total + ' ✓' : 'companions ' + c.companions.delivered + '/' + c.companions.total + ' delivered';
  return passes + ' · ' + companions + ' · ' + codexLabel() + ' · ' + verifierLabel();
}

function sourcesLine(c) {
  return 'packs ' + c.packs + ' · repo rules ' + c.repoRules + ' · plugins ' + c.plugins + ' · companions ' + c.companions.total +
    ' · context: ' + c.context.length + ' project rules in every pass · ' + c.onDemand + ' on-demand';
}

// ---------------------------------------------------------------- drawing

function band(Box, Text, columns) {
  const h = headline();
  const c = counts();
  const line = (children) => Text({ wrap: 'truncate-end', children });
  return Box({
    flexDirection: 'column',
    paddingX: 1,
    width: columns,
    children: [
      Box({
        flexDirection: 'row',
        children: [
          Text({ bold: true, children: ['pr-review · ' + prLabel() + ' · '] }),
          Text({ color: h.glyph.color, children: [h.glyph.glyph + ' '] }),
          line([h.text]),
        ],
      }),
      line([countsLine(c)]),
      Text({ dimColor: true, wrap: 'truncate-end', children: [sourcesLine(c) + ' · /pr-review-live'] }),
    ],
  });
}

function pane(Box, Text, columns) {
  const h = headline();
  const c = counts();
  const rows = reviewerRows();
  const nameWidth = Math.max(12, Math.min(44, columns - 36));
  const row = (r) => {
    const g = GLYPH[r.state] || GLYPH.pending;
    return Box({
      flexDirection: 'row',
      columnGap: 1,
      children: [
        Text({ color: g.color, dimColor: g.dim, children: [g.glyph + ' ' + r.elapsed.padStart(5)] }),
        Text({ wrap: 'truncate-end', children: [r.shown.length > nameWidth ? r.shown.slice(0, nameWidth - 1) + '…' : r.shown.padEnd(nameWidth)] }),
        Text({ dimColor: true, wrap: 'truncate-end', children: [r.source] }),
      ],
    });
  };
  const section = (title) => Text({ bold: true, children: [title] });
  const passes = rows.filter((r) => r.kind === 'pass');
  const companions = rows.filter((r) => r.kind === 'companion');
  const siblings = [];
  if (run.plan && run.plan.codex && run.plan.codex.enabled) siblings.push(Text({ children: ['  ' + codexLabel() + ' · codex exec (read-only sibling)'] }));
  if (run.plan && run.plan.verifier && run.plan.verifier.enabled) siblings.push(Text({ children: ['  ' + verifierLabel() + ' · only with HIGH/CRITICAL findings'] }));
  const contextNames = c.context.map((p) => p.name);
  const contextText = contextNames.length === 0 ? 'none' : contextNames.slice(0, 3).join(', ') + (contextNames.length > 3 ? ', … +' + (contextNames.length - 3) : '');
  return Box({
    flexDirection: 'column',
    children: [
      Box({
        flexDirection: 'row',
        children: [
          Text({ bold: true, children: [prLabel() + ' · '] }),
          Text({ color: h.glyph.color, children: [h.glyph.glyph + ' '] }),
          Text({ wrap: 'truncate-end', children: [h.text] }),
        ],
      }),
      Text({ children: [' '] }),
      section(run.done ? 'passes ' + c.passes.valid + '/' + c.passes.total + ' ✓' : 'passes ' + c.passes.delivered + '/' + c.passes.total + ' delivered'),
      ...passes.map(row),
      section(run.done ? 'companions ' + c.companions.valid + '/' + c.companions.total + ' ✓' : 'companions ' + c.companions.delivered + '/' + c.companions.total + ' delivered'),
      ...(companions.length > 0 ? companions.map(row) : [Text({ dimColor: true, children: ['  none installed for this runtime'] })]),
      ...(siblings.length > 0 ? [section('siblings'), ...siblings] : []),
      Text({ children: [' '] }),
      Text({ children: ['context in every pass (' + c.context.length + '): ' + contextText] }),
      Text({ children: ['on-demand (index): ' + c.onDemand] }),
      Text({ dimColor: true, children: ['esc closes · /pr-review-live off detaches'] }),
    ],
  });
}

/** The pane as text, for a surface that draws nothing (the VS Code chat panel, -p). */
function renderText() {
  const h = headline();
  const c = counts();
  const lines = ['pr-review · ' + prLabel() + ' · ' + h.glyph.glyph + ' ' + h.text, countsLine(c), sourcesLine(c), ''];
  for (const r of reviewerRows()) lines.push((GLYPH[r.state] || GLYPH.pending).glyph + ' ' + r.elapsed.padStart(5) + '  ' + r.shown + '  ' + r.source);
  return lines.join('\n');
}
