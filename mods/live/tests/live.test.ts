// Tests for the pr-review live mod (mods/live/hooks/register.js). Run with
// `claude plugin test mods/live` (npm run test:mod). No session, no sign-in, no network:
// every call the mod makes on `$` is answered by a stub registered here, and every file
// it reads comes from fixtures/run-798.ts, a pruned copy of a real run directory with a
// neutral identity.
import { expect, mock, test } from 'claude-code/testing';
import { CUTOFF_MS, DONE, PR_LABEL, RUNNING, RUN_ID } from './fixtures/run-798.ts';

const INTERACTIVE = { surface: 'terminal', isInteractive: true, cwd: 'C:/work' } as const;
const HEADLESS = { surface: null, isInteractive: false, cwd: 'C:/work' } as const;
const SURFACES = ['terminal', 'desktop'] as const;
const PANE_ID = 'pr-review-live';
const PR_URL = 'https://github.com/acme/backend/pull/798';
const RUNS_ROOT = 'C:\\Users\\dev\\.pr-review\\runs';
const RUN_CEILING_MS = 2 * 60 * 60 * 1000;

// The run's start is the UTC stamp in its id; the timers below are computed from it.
const STAMP = /__(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(RUN_ID)!;
const RUN_STARTED_MS = Date.parse(`${STAMP[1]}T${STAMP[2]}:${STAMP[3]}:${STAMP[4]}.${STAMP[5]}Z`);
const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

// What Claude Code passes to a ui.render hook for the band above the prompt.
const BAND = {
  plugin: 'pr-review',
  component: 'AbovePrompt',
  viewport: { columns: 120, rows: 40, isFullscreen: false },
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const;

// ...and for the pane the mod opens.
const PANE = {
  plugin: 'pr-review',
  component: 'Pane',
  requestId: PANE_ID,
  viewport: { columns: 160, rows: 50, isFullscreen: true },
  props: { title: 'pr-review live', isFocused: false, bodyColumns: 72, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const;

// ...and for the spinner while Claude works.
const SPINNER = {
  plugin: 'pr-review',
  component: 'Spinner',
  props: { word: 'Thinking', message: null, suffix: '…', mode: 'thinking' },
} as const;

// What `pr-review review <url> --detach` prints (src/cli.ts), with the fixture's run...
const detachBanner = (id: string) =>
  'Review started in the background (this can take ~6–10 min).\n' +
  `  run-id: ${id}\n  dir:    ${RUNS_ROOT}\\${id}\n\n` +
  `Poll for progress and the final summary:\n  pr-review status ${id}\n`;
const DETACH_OUT = detachBanner(RUN_ID);
// ...and what the whole Step 1 block prints when it found the PR's checkout first: two
// lines of its own on stdout, then the CLI's banner. The no-checkout warnings go to stderr.
const PREAMBLE = 'repo: C:/Users/dev/repos/backend\nproject skills discoverable: 41 (the CLI reports the exact count it loads)\n';
const LAUNCH_OUT = PREAMBLE + DETACH_OUT;

// The Step 1 block of commands/pr-review.md, verbatim. `$CLI` is a shell variable, so it
// reaches the hook unexpanded whatever the host substitutes; launch detection keys on the
// banner, not on the command text. tests/mod-surface.test.ts pins this copy to the file.
const STEP1 =
  'CLI="${CLAUDE_PLUGIN_ROOT}/dist/cli.cjs"\n' +
  String.raw`if [ ! -f "$CLI" ]; then
  CLI=$(find ~/.claude/plugins/cache -name cli.cjs -path '*/pr-review/*/dist/*' -not -path '*/node_modules/*' 2>/dev/null | sort | tail -1)
fi
if [ -z "$CLI" ] || [ ! -f "$CLI" ]; then
  CLI=$(find ~/.copilot/installed-plugins -name cli.cjs -path '*/pr-review/dist/*' 2>/dev/null | sort | tail -1)
fi
if [ -z "$CLI" ] || [ ! -f "$CLI" ]; then
  echo "pr-review bundle not found (checked \${CLAUDE_PLUGIN_ROOT}, ~/.claude/plugins/cache, ~/.copilot/installed-plugins). Is the plugin installed?" >&2
  exit 1
fi

# Find the checkout this PR belongs to: the repo containing cwd, then cwd's subdirectories, then its siblings.
PR_URL=
for a in $ARGUMENTS; do
  case "$a" in http://*|https://*) PR_URL=$(printf %s "$a" | tr 'A-Z' 'a-z'); break ;; esac
done
REPO_DIR=; FALLBACK=
if [ -n "$PR_URL" ]; then
  for d in "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" */ ../*/; do
    [ -e "$d/.git" ] || continue
    o=$(git -C "$d" remote get-url origin 2>/dev/null) || continue
    # origin URL → "owner/repo" path: drop scheme, user@, host (and the ':' of scp-style) and .git; ADO ssh v3/org/proj/repo → org/proj/_git/repo
    o=$(printf '%s' "$o" | sed -e 's#^[a-z+]*://##' -e 's#^[^@]*@##' -e 's#^[^/:]*[:/]##' -e 's#\.git$##' -e 's#^v3/\([^/]*\)/\([^/]*\)/\([^/]*\)$#\1/\2/_git/\3#' | tr 'A-Z' 'a-z')
    [ -n "$o" ] || continue
    case "$PR_URL" in *"/$o/"*) ;; *) continue ;; esac
    if [ "$(git -C "$d" rev-parse --git-dir 2>/dev/null)" = "$(git -C "$d" rev-parse --git-common-dir 2>/dev/null)" ]; then
      REPO_DIR=$(cd "$d" && pwd); break
    fi
    [ -n "$FALLBACK" ] || FALLBACK=$(cd "$d" && pwd)
  done
fi
[ -n "$REPO_DIR" ] || REPO_DIR=$FALLBACK

if [ -n "$REPO_DIR" ]; then
  echo "repo: $REPO_DIR"
  cd "$REPO_DIR" || exit 1
  # Approximates the loader's rule — <dir>/SKILL.md plus flat .md files (README excluded) in the standard dirs; the CLI's own count is authoritative.
  n=$( { ls -d .claude/skills/*/SKILL.md .copilot/skills/*/SKILL.md .github/skills/*/SKILL.md .agents/skills/*/SKILL.md 2>/dev/null; ls .claude/skills/*.md .copilot/skills/*.md .github/skills/*.md .agents/skills/*.md .claude/rules/*.md .github/instructions/*.md 2>/dev/null | grep -vi '/readme\.md$'; } | wc -l)
  if [ "$n" -gt 0 ]; then
    echo "project skills discoverable: $n (the CLI reports the exact count it loads)"
  else
    echo "WARNING: no project skills under $REPO_DIR — review will use pack rules only." >&2
  fi
else
  echo "WARNING: no local checkout matches $PR_URL — running from $(pwd)." >&2
  echo "WARNING: the CLI will apply no project skills, skip stack detection, and cannot complete a provider-truncated file list from git (GitHub over 3000 files, GitLab N+)." >&2
fi

node "$CLI" review $ARGUMENTS --detach`;
const LAUNCH = STEP1.replace(/\$ARGUMENTS/g, PR_URL + ' --dry-run');
const STATUS_POLL = `node "$CLI" status ${RUN_ID}`;

type Counters = { stat: number; read: number; list: number };
type Stubs = Parameters<Parameters<typeof test>[1]>[1];
type RunDirs = Record<string, Record<string, string>>;

/** The runs root as the mod's $.fs calls see it: one snapshot map per run id. */
function stubRuns(on: Stubs, runs: RunDirs, options: { tornOnce?: string[]; unreadable?: string[] } = {}): Counters {
  const counters: Counters = { stat: 0, read: 0, list: 0 };
  const torn = new Set(options.tornOnce ?? []);
  const unreadable = new Set(options.unreadable ?? []);
  const normalize = (path: string) => String(path).replace(/\\/g, '/');
  const locate = (path: string): { files: Record<string, string>; name: string } | null => {
    const s = normalize(path);
    const i = s.indexOf('/.pr-review/runs/');
    if (i < 0) return null;
    const rest = s.slice(i + '/.pr-review/runs/'.length);
    for (const [id, files] of Object.entries(runs)) {
      if (rest === id) return { files, name: '' };
      if (rest.startsWith(id + '/')) return { files, name: rest.slice(id.length + 1) };
    }
    return null;
  };
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  on('fs.stat', ($, e) => {
    counters.stat += 1;
    const hit = locate(e.path);
    if (hit && hit.name === '') return { value: { kind: 'dir', size: 0, mtimeMs: CUTOFF_MS, isLink: false } };
    const body = hit ? hit.files[hit.name] : undefined;
    if (body === undefined) return { deny: `ENOENT: no such file or directory, stat '${e.path}'` };
    return { value: { kind: 'file', size: bytes(body), mtimeMs: CUTOFF_MS, isLink: false } };
  });
  on('fs.exists', ($, e) => {
    const hit = locate(e.path);
    return { value: hit !== null && (hit.name === '' || hit.files[hit.name] !== undefined) };
  });
  on('fs.read', ($, e) => {
    counters.read += 1;
    const hit = locate(e.path);
    const body = hit ? hit.files[hit.name] : undefined;
    if (body === undefined) return { deny: `ENOENT: no such file or directory, open '${e.path}'` };
    if (unreadable.has(hit!.name)) return { deny: `EACCES: permission denied, open '${e.path}'` };
    if (torn.has(hit!.name)) {
      torn.delete(hit!.name);
      return { value: body.slice(0, Math.floor(body.length / 2)) };
    }
    return { value: body };
  });
  on('fs.list', ($, e) => {
    counters.list += 1;
    if (!normalize(e.path).endsWith('/.pr-review/runs')) return { deny: `ENOENT: ${e.path}` };
    return {
      value: [
        { name: 'local__o__r__main__abc123', kind: 'dir', size: 0, isLink: false },
        ...Object.keys(runs).map((name) => ({ name, kind: 'dir', size: 0, isLink: false })),
        { name: 'github__o__r__1__2026-09-01T00-00-00-000Z', kind: 'dir', size: 0, isLink: false },
      ],
    };
  });
  return counters;
}

function stubRunDir(on: Stubs, files: Record<string, string>, tornOnce: string[] = [], id = RUN_ID): Counters {
  return stubRuns(on, { [id]: files }, { tornOnce });
}

/** The stubs every scenario needs, registered before the first call on $; `out` answers every Bash call. */
function stubSession(on: Stubs, out = LAUNCH_OUT) {
  const opened: string[] = [];
  const closed: string[] = [];
  const spinner: string[] = [];
  const logged: string[] = [];
  on('session.start', () => ({ cwd: 'C:/work' }));
  on('session.end', () => ({ sessionId: 'test-session' }));
  on('command.register', () => ({ value: undefined }));
  on('ui.open', ($, e) => {
    opened.push(e.id);
    return { value: undefined };
  });
  on('ui.close', ($, e) => {
    closed.push(e.id);
    return { value: undefined };
  });
  on('ui.log', ($, e) => {
    logged.push(e.text);
    return { value: undefined };
  });
  on('tool.call', () => ({ result: { stdout: out, stderr: '', interrupted: false } }));
  on('ui.render', ($, e) => {
    if (e.component === 'Spinner') spinner.push(String((e.props as { suffix?: string }).suffix ?? ''));
    return { type: 'Text', props: {}, children: ['drawn by Claude Code'] };
  });
  mock.env(on, { USERPROFILE: 'C:\\Users\\dev' });
  return { opened, closed, spinner, logged };
}

/** A snapshot with one JSON file rewritten. */
function withJson(files: Record<string, string>, name: string, edit: (value: any) => void): Record<string, string> {
  const value = JSON.parse(files[name]);
  edit(value);
  return { ...files, [name]: JSON.stringify(value) };
}

const line = (ts: number, phase: string, detail: string) => JSON.stringify({ ts, phase, detail }) + '\n';

/** Start an interactive session and launch the review the way the slash command does. */
async function attachViaLaunch($: any, clock: { advance: (ms: number) => Promise<void> }) {
  await $.session.start(INTERACTIVE);
  const result = await $.tool.call({ tool: 'Bash', command: LAUNCH });
  await clock.advance(2000);
  return result;
}

test('an interactive session registers /pr-review-live', async ($, on) => {
  const registered: string[] = [];
  on('session.start', () => ({ cwd: 'C:/work' }));
  on('command.register', ($, e) => {
    registered.push(e.name);
    return { value: undefined };
  });

  await $.session.start(INTERACTIVE);

  expect(registered).toEqual(['pr-review-live']);
});

test('a headless session (claude -p, the reviewer sessions pr-review itself starts) registers nothing', async ($, on) => {
  const registered: string[] = [];
  on('session.start', () => ({ cwd: 'C:/work' }));
  on('command.register', ($, e) => {
    registered.push(e.name);
    return { value: undefined };
  });

  await $.session.start(HEADLESS);

  expect(registered).toEqual([]);
});

test('the band yields to Claude Code while no review is attached', async ($, on) => {
  on('session.start', () => ({ cwd: 'C:/work' }));
  on('command.register', () => ({ value: undefined }));
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }));
  await $.session.start(INTERACTIVE);

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });

  expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined();
  await ui.unmount();
});

test("the slash command's own launch block attaches through the two lines it echoes before the banner, and the Bash result reaches Claude untouched", async ($, on) => {
  const clock = mock.clock(on, { now: CUTOFF_MS });
  stubSession(on);
  stubRunDir(on, RUNNING);

  const result = await attachViaLaunch($, clock);

  expect((result as { result: { stdout: string } }).result.stdout).toBe(LAUNCH_OUT);
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...BAND, surface });
    expect(await band.find({ type: 'Text', text: PR_LABEL })).toBeDefined();
    await band.unmount();
  }
});

test('a launch that found no checkout prints the bare banner and attaches too', async ($, on) => {
  const clock = mock.clock(on, { now: CUTOFF_MS });
  stubSession(on, DETACH_OUT);
  stubRunDir(on, RUNNING);

  await attachViaLaunch($, clock);

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: PR_LABEL })).toBeDefined();
  await band.unmount();
});

test('the band is a box: title and status, a bar with one cell per reviewer, its legend, the counts and the sources', async ($, on) => {
  const clock = mock.clock(on, { now: CUTOFF_MS });
  stubSession(on);
  stubRunDir(on, RUNNING);
  await attachViaLaunch($, clock);

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...BAND, surface });
    const box = await band.find({ key: 'pr-review-band' });
    expect(box?.props.borderStyle).toBe('round');
    expect(await band.find({ type: 'Text', text: '◆ ' })).toBeDefined();
    expect(await band.find({ type: 'Text', text: `pr-review · ${PR_LABEL}` })).toBeDefined();
    expect(await band.find({ type: 'Text', text: `${mmss(CUTOFF_MS + 2000 - RUN_STARTED_MS)} · running — orchestrator 360s` })).toBeDefined();
    // 16 reviewers in 96 inner columns: 4 cells each; 7 delivered (cyan █), 9 running (yellow ▓), nothing valid yet.
    const delivered = await band.find({ type: 'Text', text: /^(████)+$/ });
    expect(delivered?.props.color).toBe('cyan');
    const running = await band.find({ type: 'Text', text: /^(▓▓▓▓)+$/ });
    expect(running?.props.color).toBe('yellow');
    expect(await band.find({ type: 'Text', text: /░/ })).toBeUndefined();
    expect(await band.find({ type: 'Text', text: '7/16 delivered' })).toBeDefined();
    expect(await band.find({ type: 'Text', text: 'delivered 7' })).toBeDefined();
    expect(await band.find({ type: 'Text', text: 'running 9' })).toBeDefined();
    expect(await band.find({ type: 'Text', text: /^pending \d+$/ })).toBeUndefined();
    expect(await band.find({ type: 'Text', text: 'passes 7/10 delivered · companions 0/6 delivered · codex off · verifier pending' })).toBeDefined();
    // Zero counts are left out: no `repo rules 0`, no `plugins 0`.
    expect(await band.find({ type: 'Text', text: /^packs 10 · companions 6 · 41 project rules in every pass · 3 on-demand/ })).toBeDefined();
    await band.unmount();
  }
});

test('a narrow band shortens the PR label, and a short one drops the legend and the sources', async ($, on) => {
  const clock = mock.clock(on, { now: CUTOFF_MS });
  stubSession(on);
  stubRunDir(on, RUNNING);
  await attachViaLaunch($, clock);

  const medium = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 70 } });
  expect(await medium.find({ type: 'Text', text: 'pr-review · backend #798' })).toBeDefined();
  expect(await medium.find({ type: 'Text', text: /acme/ })).toBeUndefined();
  await medium.unmount();

  const narrow = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 50 } });
  expect(await narrow.find({ type: 'Text', text: 'pr-review · #798' })).toBeDefined();
  await narrow.unmount();

  const short = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, maxRows: 4 } });
  expect(await short.find({ type: 'Text', text: /running — orchestrator 360s/ })).toBeDefined();
  expect(await short.find({ type: 'Text', text: '7/16 delivered' })).toBeDefined();
  expect(await short.find({ type: 'Text', text: 'delivered 7' })).toBeUndefined();
  expect(await short.find({ type: 'Text', text: /^packs 10/ })).toBeUndefined();
  await short.unmount();
});

test('the pane groups the reviewers under their source, one row each: state, time, short name, how it matched', async ($, on) => {
  const clock = mock.clock(on, { now: CUTOFF_MS });
  stubSession(on);
  stubRunDir(on, RUNNING);
  await attachViaLaunch($, clock);

  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface });
    // Two header lines, then the bar.
    expect(await pane.find({ type: 'Text', text: PR_LABEL })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: `${mmss(CUTOFF_MS + 2000 - RUN_STARTED_MS)} · running — orchestrator 360s` })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: '7/16 delivered' })).toBeDefined();
    // Group labels carry the source; rows carry the short name and the match kind.
    expect(await pane.find({ type: 'Text', text: 'pack awesome-copilot' })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: 'pack owasp' })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: 'plugin pr-review-toolkit' })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: /^logging$/ })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: /^nestjs$/ })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: /^code-reviewer$/ })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: /^baseline$/ })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: /^glob$/ })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: /owasp\/logging/ })).toBeUndefined();
    expect(await pane.find({ type: 'Text', text: /^◐ +\d+:\d\d$/ })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: /^● +\d+:\d\d$/ })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: /^context in every pass \(41\): rule-01, rule-02, rule-03, … \+38$/ })).toBeDefined();
    await pane.unmount();
  }
});

test('a repo rule running as a pass and an installed-plugin pass are labelled and counted as such', async ($, on) => {
  const extra = withJson(RUNNING, 'dispatch-plan.json', (plan) => {
    const template = plan.reviewers[0];
    plan.reviewers.push(
      { ...template, name: 'team-rules', source: 'C:\\Users\\dev\\repos\\backend\\.claude\\skills\\team-rules\\SKILL.md', matchedBy: 'repo' },
      { ...template, name: 'validate/validate', source: 'C:\\Users\\dev\\.claude\\plugins\\cache\\validate\\validate\\0.8.0\\skills\\validate\\SKILL.md', matchedBy: 'plugin' },
    );
  });
  const clock = mock.clock(on, { now: CUTOFF_MS });
  stubSession(on);
  stubRunDir(on, extra);
  await attachViaLaunch($, clock);

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: /^packs 10 · repo rules 1 · plugins 1 · companions 6/ })).toBeDefined();
  await band.unmount();
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect(await pane.find({ type: 'Text', text: 'repo rule' })).toBeDefined();
  expect(await pane.find({ type: 'Text', text: /^team-rules$/ })).toBeDefined();
  expect(await pane.find({ type: 'Text', text: 'plugin validate' })).toBeDefined();
  expect(await pane.find({ type: 'Text', text: /^validate$/ })).toBeDefined();
  await pane.unmount();
});

test('the spinner carries the exact timer, counted from the run id stamp, and the delivered count', async ($, on) => {
  const clock = mock.clock(on, { now: CUTOFF_MS });
  const { spinner } = stubSession(on);
  stubRunDir(on, RUNNING);
  await attachViaLaunch($, clock);

  for (const surface of SURFACES) {
    spinner.length = 0;
    const spin = await $.ui.mount({ ...SPINNER, surface });
    expect(spinner).toEqual([` · pr-review ${mmss(CUTOFF_MS + 2000 - RUN_STARTED_MS)} · 7/16…`]);
    await spin.unmount();
  }
});

test('a headless session never reads the run directory, even after a launch', async ($, on) => {
  const clock = mock.clock(on);
  stubSession(on);
  const counters = stubRunDir(on, RUNNING);
  await $.session.start(HEADLESS);

  await $.tool.call({ tool: 'Bash', command: LAUNCH });
  await clock.advance(5000);

  expect(counters).toEqual({ stat: 0, read: 0, list: 0 });
});

test('a status poll through the Bash tool, in its real form, attaches when nothing is attached yet', async ($, on) => {
  const clock = mock.clock(on, { now: CUTOFF_MS });
  stubSession(on, '⏳ running — orchestrator 60s  ·  6m51s elapsed\n');
  stubRunDir(on, RUNNING);
  await $.session.start(INTERACTIVE);

  await $.tool.call({ tool: 'Bash', command: STATUS_POLL });
  await clock.advance(2000);

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: PR_LABEL })).toBeDefined();
  expect(await band.find({ type: 'Text', text: /passes 7\/10 delivered/ })).toBeDefined();
  await band.unmount();
});

test('a status poll for another run replaces a finished one, and a launch replaces anything', async ($, on) => {
  const OTHER = 'github__acme__frontend__12__2026-10-06T16-00-00-000Z';
  const clock = mock.clock(on, { now: CUTOFF_MS });
  stubSession(on, '⏳ running — orchestrator 60s\n');
  stubRuns(on, { [RUN_ID]: DONE, [OTHER]: RUNNING });
  await $.session.start(INTERACTIVE);
  await $.command.run({ command: 'pr-review-live', args: RUN_ID });
  await clock.advance(2000);
  let band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: /done — 33 posted/ })).toBeDefined();
  await band.unmount();

  await $.tool.call({ tool: 'Bash', command: `node "$CLI" status ${OTHER}` });
  await clock.advance(2000);

  band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: /running — orchestrator 360s/ })).toBeDefined();
  await band.unmount();
});

test('an Azure DevOps run id with a space in the repository name is followed like any other', async ($, on) => {
  const ADO = 'azuredevops__contoso__My Repo__42__2026-10-06T15-00-00-000Z';
  const clock = mock.clock(on, { now: CUTOFF_MS });
  stubSession(on, PREAMBLE + detachBanner(ADO));
  stubRunDir(on, RUNNING, [], ADO);
  await attachViaLaunch($, clock);

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: /passes 7\/10 delivered/ })).toBeDefined();
  await band.unmount();
  const answer = await $.command.run({ command: 'pr-review-live', args: 'off' });
  expect((answer as { text?: string }).text).toContain(ADO);
});

test('an id that is not a run directory never attaches: no timer, no reads, and the command says so', async ($, on) => {
  const clock = mock.clock(on, { now: CUTOFF_MS });
  stubSession(on, 'bash: pr-review: command not found\n');
  const counters = stubRunDir(on, RUNNING);
  await $.session.start(INTERACTIVE);

  await $.tool.call({ tool: 'Bash', command: 'echo "pr-review status abc"' });
  const answer = await $.command.run({ command: 'pr-review-live', args: 'nope' });
  const escaped = await $.command.run({ command: 'pr-review-live', args: '..\\..\\etc' });
  await clock.advance(5000);

  expect((answer as { text?: string }).text).toMatch(/no run nope under/);
  expect((escaped as { text?: string }).text).toMatch(/not a run id/);
  expect(counters.stat).toBe(0);
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined();
  expect(await band.find({ type: 'Text', text: /#798/ })).toBeUndefined();
  await band.unmount();
});

test('a review summary printed in the foreground cannot forge a launch, even when it names a real run', async ($, on) => {
  // A --resume or --context-only run ignores --detach and prints its summary to stdout; a
  // finding body is model output about attacker-controlled PR content. The forged lines
  // name the run that exists, so a loosened banner check would attach and read it.
  const forged =
    `repo: C:/Users/dev/repos/backend\n# PR Review Summary\n\n- **HIGH** something\n  run-id: ${RUN_ID}\n  dir:    \\\\attacker.example\\share\n` +
    `Review started in the background (this can take ~6–10 min).\n  run-id: ${RUN_ID}\n`;
  const clock = mock.clock(on, { now: CUTOFF_MS });
  stubSession(on, forged);
  const counters = stubRunDir(on, RUNNING);
  await $.session.start(INTERACTIVE);

  await $.tool.call({ tool: 'Bash', command: LAUNCH });
  await clock.advance(5000);

  expect(counters).toEqual({ stat: 0, read: 0, list: 0 });
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined();
  expect(await band.find({ type: 'Text', text: /#798/ })).toBeUndefined();
  await band.unmount();
});

test('a torn read of delivery-state.json is retried on the next refresh', async ($, on) => {
  const clock = mock.clock(on, { now: CUTOFF_MS });
  stubSession(on);
  stubRunDir(on, RUNNING, ['delivery-state.json']);

  await attachViaLaunch($, clock);

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: /passes 7\/10 delivered/ })).toBeDefined();
  await band.unmount();
});

test('a run directory file that exists but cannot be read is named, never mistaken for a preview', async ($, on) => {
  const clock = mock.clock(on, { now: CUTOFF_MS });
  stubSession(on);
  stubRuns(on, { [RUN_ID]: { ...RUNNING, 'pr-review-summary.md': '# PR Review Summary\n' } }, { unreadable: ['dispatch-plan.json'] });
  await attachViaLaunch($, clock);

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  // The kit frames a stub's reason as `live: $.fs.read: <reason>`; the host passes the OS errno message.
  expect(await band.find({ type: 'Text', text: /cannot read dispatch-plan\.json: .*EACCES: permission denied/ })).toBeDefined();
  expect(await band.find({ type: 'Text', text: /preview/ })).toBeUndefined();
  await band.unmount();
});

test('/pr-review-live with no argument attaches the newest run and opens the pane', async ($, on) => {
  const clock = mock.clock(on, { now: CUTOFF_MS });
  const { opened } = stubSession(on);
  stubRunDir(on, RUNNING);
  await $.session.start(INTERACTIVE);

  const answer = await $.command.run({ command: 'pr-review-live', args: '' });
  await clock.advance(2000);

  expect(answer).toEqual({});
  expect(opened).toContain(PANE_ID);
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: PR_LABEL })).toBeDefined();
  await band.unmount();
});

test('when the run finishes while attached, the band freezes on the outcome and polling stops', async ($, on) => {
  const clock = mock.clock(on, { now: CUTOFF_MS });
  stubSession(on);
  const files: Record<string, string> = { ...RUNNING };
  const counters = stubRunDir(on, files);
  let redraws = 0;
  on('ui.invalidate', () => {
    redraws += 1;
    return { value: undefined };
  });
  await attachViaLaunch($, clock);
  let band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: /running — orchestrator/ })).toBeDefined();
  await band.unmount();

  // The run finishes: every file takes its final shape, and the next refresh sees it.
  Object.assign(files, DONE);
  await clock.advance(2000);

  const doneTs = JSON.parse(DONE['progress.ndjson'].trim().split('\n').at(-1)!).ts as number;
  band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: `${mmss(doneTs - RUN_STARTED_MS)} · done — 33 posted, 33 findings` })).toBeDefined();
  expect(await band.find({ type: 'Text', text: /passes 10\/10 ✓ · companions 6\/6 ✓/ })).toBeDefined();
  // The bar is one green run of 16 × 4 cells, the legend one entry.
  const bar = await band.find({ type: 'Text', text: /^█{64}$/ });
  expect(bar?.props.color).toBe('green');
  expect(await band.find({ type: 'Text', text: 'done 16' })).toBeDefined();
  expect(await band.find({ type: 'Text', text: '16/16 ✓' })).toBeDefined();
  await band.unmount();

  // No more reads and no more redraws: the timer is gone, not just idle.
  const statsAfterDone = counters.stat;
  const redrawsAfterDone = redraws;
  await clock.advance(10_000);
  expect(counters.stat).toBe(statsAfterDone);
  expect(redraws).toBe(redrawsAfterDone);
});

test('a run that failed before its first progress line (error.txt only) is shown as failed, not as starting', async ($, on) => {
  // runGather, auth and runtime failures write error.txt and append nothing to progress.ndjson.
  const FAILED = 'github__acme__backend__799__2026-10-06T14-30-00-000Z';
  const clock = mock.clock(on, { now: CUTOFF_MS });
  const { spinner } = stubSession(on, PREAMBLE + detachBanner(FAILED));
  const counters = stubRuns(on, { [FAILED]: { 'run.pid': '4242\n', 'error.txt': 'github: Bad credentials\nsecond line\n' } });
  await attachViaLaunch($, clock);

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: '✗ ' })).toBeDefined();
  expect(await band.find({ type: 'Text', text: `failed — github: Bad credentials · pr-review status ${FAILED}` })).toBeDefined();
  expect(await band.find({ type: 'Text', text: /starting/ })).toBeUndefined();
  await band.unmount();
  const spin = await $.ui.mount({ ...SPINNER, surface: 'terminal' });
  expect(spinner.at(-1)).toBe('…');
  await spin.unmount();
  const statsAfterFailure = counters.stat;
  await clock.advance(10_000);
  expect(counters.stat).toBe(statsAfterFailure);
});

test('a --resume of a finished run re-attaches and follows the new attempt, timing it from the resume', async ($, on) => {
  // The run that needs a resume ended in `error`; the resume appends `resume` only once it runs.
  const errorTs = CUTOFF_MS - 1000;
  const files: Record<string, string> = { ...RUNNING, 'progress.ndjson': RUNNING['progress.ndjson'] + line(errorTs, 'error', '0/16 reviewers delivered; incomplete') };
  const clock = mock.clock(on, { now: CUTOFF_MS });
  const { spinner } = stubSession(on);
  stubRunDir(on, files);
  await attachViaLaunch($, clock);
  let band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: /error — 0\/16 reviewers delivered/ })).toBeDefined();
  await band.unmount();

  // Claude runs the recovery command status printed; it runs in the foreground inside this call.
  await $.tool.call({ tool: 'Bash', command: `node "$CLI" review ${PR_URL} --resume ${RUN_ID} --dry-run --detach` });
  const resumeTs = CUTOFF_MS + 500;
  files['progress.ndjson'] += line(resumeTs, 'resume', 'selective reviewer recovery') + line(resumeTs + 100, 'running', 'orchestrator 60s');
  await clock.advance(4000);

  // The clock stood at CUTOFF + 2 s when the resume was typed; four more seconds have passed.
  band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: `${mmss(CUTOFF_MS + 6000 - resumeTs)} · running — orchestrator 60s` })).toBeDefined();
  await band.unmount();
  const spin = await $.ui.mount({ ...SPINNER, surface: 'terminal' });
  expect(spinner.at(-1)).toMatch(/^ · pr-review 0:0\d · 7\/16…$/);
  await spin.unmount();
});

test('/pr-review-live off detaches: the band yields again and the pane closes', async ($, on) => {
  const clock = mock.clock(on, { now: CUTOFF_MS });
  const { closed } = stubSession(on);
  stubRunDir(on, RUNNING);
  await attachViaLaunch($, clock);

  const answer = await $.command.run({ command: 'pr-review-live', args: 'off' });

  expect((answer as { text?: string }).text).toMatch(/detached/);
  expect(closed).toEqual([PANE_ID]);
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined();
  expect(await band.find({ type: 'Text', text: /#798/ })).toBeUndefined();
  await band.unmount();
});

test('the session ending drops the run: nothing draws and nothing polls afterwards', async ($, on) => {
  const clock = mock.clock(on, { now: CUTOFF_MS });
  stubSession(on);
  const counters = stubRunDir(on, RUNNING);
  await attachViaLaunch($, clock);

  await $.session.end({ reason: 'clear' });
  const statsAtEnd = counters.stat;
  await clock.advance(5000);

  expect(counters.stat).toBe(statsAtEnd);
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined();
  expect(await band.find({ type: 'Text', text: /#798/ })).toBeUndefined();
  await band.unmount();
});

test('attaching a second run cancels the first run’s timer', async ($, on) => {
  const OTHER = 'github__acme__frontend__12__2026-10-06T16-00-00-000Z';
  const clock = mock.clock(on, { now: CUTOFF_MS });
  stubSession(on);
  stubRuns(on, { [RUN_ID]: RUNNING, [OTHER]: RUNNING });
  let redraws = 0;
  on('ui.invalidate', () => {
    redraws += 1;
    return { value: undefined };
  });
  await attachViaLaunch($, clock);

  await $.command.run({ command: 'pr-review-live', args: OTHER });
  const before = redraws;
  await clock.advance(5000);

  // One timer redraws once a second; a leaked first timer would double that.
  expect(redraws - before).toBeLessThanOrEqual(6);
  expect(redraws - before).toBeGreaterThanOrEqual(5);
});

test('a run whose files stop changing is reported as silent once 90 seconds have passed, not before', async ($, on) => {
  const clock = mock.clock(on, { now: CUTOFF_MS });
  stubSession(on);
  stubRunDir(on, RUNNING);
  await $.session.start(INTERACTIVE);
  await $.tool.call({ tool: 'Bash', command: LAUNCH });

  await clock.advance(89_000);
  let band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: /no heartbeat/ })).toBeUndefined();
  await band.unmount();

  await clock.advance(2_000);
  band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: /no heartbeat for 1:31/ })).toBeDefined();
  await band.unmount();
});

test('after two hours the mod stops polling, says so, and /pr-review-live re-attaches', { timeoutMs: 120_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: CUTOFF_MS });
  const { spinner } = stubSession(on);
  const counters = stubRunDir(on, RUNNING);
  await attachViaLaunch($, clock);

  await clock.advance(RUN_CEILING_MS + 2000);

  let band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: `polling stopped after 2:00:00, /pr-review-live ${RUN_ID} to reattach` })).toBeDefined();
  await band.unmount();
  const spin = await $.ui.mount({ ...SPINNER, surface: 'terminal' });
  expect(spinner.at(-1)).toBe('…');
  await spin.unmount();
  const statsWhenStale = counters.stat;
  await clock.advance(10_000);
  expect(counters.stat).toBe(statsWhenStale);

  await $.command.run({ command: 'pr-review-live', args: RUN_ID });
  await clock.advance(4000);
  expect(counters.stat).toBeGreaterThan(statsWhenStale);
  band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: /polling stopped/ })).toBeUndefined();
  await band.unmount();
});

test('a --context-only preview is named as a preview and treated as finished: no timer, no spinner suffix', async ($, on) => {
  // The real preview run next to the fixture: one gather line, a preview summary, no plan.
  const PREVIEW_ID = 'github__acme__backend__798__2026-10-06T14-20-20-874Z';
  const PREVIEW: Record<string, string> = {
    'progress.ndjson': '{"ts":1791296421867,"phase":"gather","detail":"39 files"}\n',
    'pr-review-summary.md': '# PR Review Context Preview\n',
  };
  const clock = mock.clock(on, { now: CUTOFF_MS });
  const { spinner } = stubSession(on);
  const counters = stubRunDir(on, PREVIEW, [], PREVIEW_ID);
  await $.session.start(INTERACTIVE);

  await $.command.run({ command: 'pr-review-live', args: PREVIEW_ID });
  await clock.advance(2000);

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: /preview — no dispatch/ })).toBeDefined();
  await band.unmount();
  const spin = await $.ui.mount({ ...SPINNER, surface: 'terminal' });
  expect(spinner.at(-1)).toBe('…');
  await spin.unmount();
  const statsAfterPreview = counters.stat;
  await clock.advance(10_000);
  expect(counters.stat).toBe(statsAfterPreview);
});

test('where nothing draws (the VS Code chat panel), /pr-review-live answers in text', async ($, on) => {
  const clock = mock.clock(on, { now: CUTOFF_MS });
  const { opened } = stubSession(on);
  stubRunDir(on, RUNNING);
  await $.session.start({ surface: 'vscode', isInteractive: true, cwd: 'C:/work' });

  const answer = await $.command.run({ command: 'pr-review-live', args: RUN_ID });
  await clock.advance(2000);

  const text = (answer as { text?: string }).text ?? '';
  expect(text).toMatch(new RegExp(PR_LABEL.replace('/', '\\/')));
  expect(text).toMatch(/passes 7\/10 delivered/);
  expect(text).toMatch(/7\/16 delivered/);
  expect(text).toMatch(/\n\s+pack owasp\n[\s\S]*?\d+:\d\d\s+logging\s+baseline/);
  expect(opened).toEqual([]);
});

test('a reviewer whose attempt came back invalid is shown as retrying while attempts remain, failed when none do', async ($, on) => {
  const victim = 'awesome-copilot/nestjs';
  const retrying = withJson(DONE, 'delivery-state.json', (s) => {
    s.kind = 'recoverable-incomplete';
    s.valid = s.valid.filter((n: string) => n !== victim);
    s.invalid = [victim];
  });
  const exhausted = withJson(retrying, 'delivery-state.json', (s) => {
    s.kind = 'terminal-incomplete';
  });
  const clock = mock.clock(on, { now: CUTOFF_MS });
  stubSession(on);
  const files: Record<string, string> = { ...retrying };
  stubRunDir(on, files);
  await attachViaLaunch($, clock);

  let pane = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect(await pane.find({ type: 'Text', text: /^↻ +\d+:\d\d$/ })).toBeDefined();
  expect(await pane.find({ type: 'Text', text: /^✗/ })).toBeUndefined();
  await pane.unmount();

  // A finished run is not polled again, so the exhausted state is read on a fresh attach.
  Object.assign(files, exhausted);
  await $.command.run({ command: 'pr-review-live', args: RUN_ID });
  await clock.advance(2000);
  pane = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect(await pane.find({ type: 'Text', text: /^✗ +\d+:\d\d$/ })).toBeDefined();
  expect(await pane.find({ type: 'Text', text: /^↻/ })).toBeUndefined();
  await pane.unmount();
});

test('a rejected runtime spawn shows every reviewer of that batch as failed, and an error phase as a failed headline', async ($, on) => {
  const rejected = withJson(RUNNING, 'delivery-state.json', (s) => {
    s.runtimeAttempts[0].status = 'spawn-rejected';
    s.reasonCodes = ['runtime-spawn-rejected', 'attempts-exhausted'];
  });
  const files = { ...rejected, 'progress.ndjson': RUNNING['progress.ndjson'] + line(CUTOFF_MS - 1, 'error', '0/16 reviewers delivered; incomplete') };
  const clock = mock.clock(on, { now: CUTOFF_MS });
  stubSession(on);
  stubRunDir(on, files);
  await attachViaLaunch($, clock);

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect(await pane.find({ type: 'Text', text: /^● / })).toBeUndefined();
  expect(await pane.find({ type: 'Text', text: /^✗ +\d+:\d\d$/ })).toBeDefined();
  await pane.unmount();
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: '✗ ' })).toBeDefined();
  expect(await band.find({ type: 'Text', text: /error — 0\/16 reviewers delivered; incomplete$/ })).toBeDefined();
  await band.unmount();
});

test('a legacy run whose attempts carry no status is read as finished, never as still running', async ($, on) => {
  const victim = 'awesome-copilot/nestjs';
  const legacy = withJson(DONE, 'delivery-state.json', (s) => {
    s.kind = 'terminal-incomplete';
    s.valid = s.valid.filter((n: string) => n !== victim);
    s.missing = [victim];
    for (const attempt of s.runtimeAttempts) delete attempt.status;
  });
  const clock = mock.clock(on, { now: CUTOFF_MS });
  stubSession(on);
  stubRunDir(on, legacy);
  await attachViaLaunch($, clock);

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect(await pane.find({ type: 'Text', text: /^● / })).toBeUndefined();
  expect(await pane.find({ type: 'Text', text: /^◐ / })).toBeUndefined();
  expect(await pane.find({ type: 'Text', text: /^✗ +\d+:\d\d$/ })).toBeDefined();
  await pane.unmount();
});

test('control and format characters in a reviewer name or a phase detail never reach the terminal', async ($, on) => {
  const hostile = withJson(RUNNING, 'dispatch-plan.json', (plan) => {
    plan.reviewers[0].name = 'pack/\u001b[2Jevil\u009bX\u202ename\u2028extra';
  });
  const files = { ...hostile, 'progress.ndjson': RUNNING['progress.ndjson'] + line(CUTOFF_MS - 1, 'running', 'orchestrator \u001b]52;c;ZXZpbA==\u0007 420s') };
  const clock = mock.clock(on, { now: CUTOFF_MS });
  stubSession(on);
  stubRunDir(on, files);
  await attachViaLaunch($, clock);

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect(await pane.find({ type: 'Text', text: /evilXnameextra/ })).toBeDefined();
  expect(await pane.find({ type: 'Text', text: /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/ })).toBeUndefined();
  await pane.unmount();
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: /orchestrator \]52;c;ZXZpbA== 420s/ })).toBeDefined();
  expect(await band.find({ type: 'Text', text: /[\u0000-\u001f\u007f-\u009f]/ })).toBeUndefined();
  await band.unmount();
});
