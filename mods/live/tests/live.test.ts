// Tests for the pr-review live mod (mods/live/hooks/register.js). Run with
// `claude plugin test mods/live` (npm run test:mod). No session, no sign-in, no network:
// every call the mod makes on `$` is answered by a stub registered here, and every file
// it reads comes from fixtures/run-798.ts, a pruned copy of a real run directory.
import { expect, mock, test } from 'claude-code/testing';
import { CUTOFF_MS, DONE, RUNNING, RUN_DIR, RUN_ID } from './fixtures/run-798.ts';

const INTERACTIVE = { surface: 'terminal', isInteractive: true, cwd: 'C:/work' } as const;
const HEADLESS = { surface: null, isInteractive: false, cwd: 'C:/work' } as const;
const PANE_ID = 'pr-review-live';

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

// What `pr-review review <url> --detach` prints (src/cli.ts), with the fixture's run.
const DETACH_OUT =
  'Review started in the background (this can take ~6–10 min).\n' +
  `  run-id: ${RUN_ID}\n  dir:    ${RUN_DIR}\n\n` +
  `Poll for progress and the final summary:\n  pr-review status ${RUN_ID}\n`;
const LAUNCH = `node "C:\\Users\\dev\\.claude\\plugins\\cache\\pr-review\\pr-review\\0.16.0\\dist\\cli.cjs" review https://github.com/Preco-Pratico/PrecoPratico-Backend/pull/798 --detach`;
const RUNS_ROOT = 'C:\\Users\\dev\\.pr-review\\runs';

type Counters = { stat: number; read: number; list: number };

/** The run directory as the mod's $.fs calls see it, served from a snapshot map. */
function stubRunDir(on: Parameters<Parameters<typeof test>[1]>[1], files: Record<string, string>, tornOnce: string[] = [], id = RUN_ID): Counters {
  const counters: Counters = { stat: 0, read: 0, list: 0 };
  const torn = new Set(tornOnce);
  const tail = (path: string): string | null => {
    const s = String(path).replace(/\\/g, '/');
    const i = s.indexOf(id);
    return i < 0 ? null : s.slice(i + id.length + 1);
  };
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  on('fs.stat', ($, e) => {
    counters.stat += 1;
    const name = tail(e.path);
    const body = name === null ? undefined : files[name];
    if (name === '' ) return { value: { kind: 'dir', size: 0, mtimeMs: CUTOFF_MS, isLink: false } };
    if (body === undefined) return { deny: `ENOENT: no such file or directory, stat '${e.path}'` };
    return { value: { kind: 'file', size: bytes(body), mtimeMs: CUTOFF_MS, isLink: false } };
  });
  on('fs.exists', ($, e) => {
    const name = tail(e.path);
    return { value: name !== null && (name === '' || files[name] !== undefined) };
  });
  on('fs.read', ($, e) => {
    counters.read += 1;
    const name = tail(e.path);
    const body = name === null ? undefined : files[name];
    if (body === undefined) return { deny: `ENOENT: no such file or directory, open '${e.path}'` };
    if (torn.has(name!)) {
      torn.delete(name!);
      return { value: body.slice(0, Math.floor(body.length / 2)) };
    }
    return { value: body };
  });
  on('fs.list', ($, e) => {
    counters.list += 1;
    const s = String(e.path).replace(/\\/g, '/');
    if (!s.endsWith('/.pr-review/runs')) return { deny: `ENOENT: ${e.path}` };
    return {
      value: [
        { name: 'local__o__r__main__abc123', kind: 'dir', size: 0, isLink: false },
        { name: RUN_ID, kind: 'dir', size: 0, isLink: false },
        { name: 'github__o__r__1__2026-09-01T00-00-00-000Z', kind: 'dir', size: 0, isLink: false },
      ],
    };
  });
  return counters;
}

/** The stubs every attached scenario needs, registered before the first call on $. */
function stubSession(on: Parameters<Parameters<typeof test>[1]>[1], out = DETACH_OUT) {
  const opened: string[] = [];
  const spinner: string[] = [];
  on('session.start', () => ({ cwd: 'C:/work' }));
  on('command.register', () => ({ value: undefined }));
  on('ui.open', ($, e) => {
    opened.push(e.id);
    return { value: undefined };
  });
  on('ui.close', () => ({ value: undefined }));
  on('tool.call', () => ({ result: { stdout: out, stderr: '', interrupted: false } }));
  on('ui.render', ($, e) => {
    if (e.component === 'Spinner') spinner.push(String((e.props as { suffix?: string }).suffix ?? ''));
    return { type: 'Text', props: {}, children: ['drawn by Claude Code'] };
  });
  mock.env(on, { USERPROFILE: 'C:\\Users\\dev' });
  return { opened, spinner };
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

test('launching a review with --detach attaches to the run its output names and draws its feeds', async ($, on) => {
  const clock = mock.clock(on, { now: CUTOFF_MS });
  const { spinner } = stubSession(on);
  stubRunDir(on, RUNNING);
  await $.session.start(INTERACTIVE);

  const result = await $.tool.call({ tool: 'Bash', command: LAUNCH });
  await clock.advance(2000);

  // The Bash result reaches Claude untouched.
  expect((result as { result: { stdout: string } }).result.stdout).toBe(DETACH_OUT);

  // The band: the PR, the phase, the counts by delivery and by source, the context line.
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: /PrecoPratico-Backend #798/ })).toBeDefined();
  expect(await band.find({ type: 'Text', text: /running — orchestrator/ })).toBeDefined();
  expect(await band.find({ type: 'Text', text: /passes 7\/10 delivered/ })).toBeDefined();
  expect(await band.find({ type: 'Text', text: /companions 0\/6 delivered/ })).toBeDefined();
  expect(await band.find({ type: 'Text', text: /packs 10 · repo rules 0 · plugins 0 · companions 6/ })).toBeDefined();
  expect(await band.find({ type: 'Text', text: /41 project rules in every pass · 3 on-demand/ })).toBeDefined();
  await band.unmount();

  // The pane: one row per reviewer with its state, its time and where it came from.
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect(await pane.find({ type: 'Text', text: /owasp\/logging/ })).toBeDefined();
  expect(await pane.find({ type: 'Text', text: /pack owasp · baseline/ })).toBeDefined();
  expect(await pane.find({ type: 'Text', text: /pack awesome-copilot · glob/ })).toBeDefined();
  expect(await pane.find({ type: 'Text', text: /pr-review-toolkit\/code-reviewer/ })).toBeDefined();
  expect(await pane.find({ type: 'Text', text: /plugin pr-review-toolkit/ })).toBeDefined();
  expect(await pane.find({ type: 'Text', text: /context in every pass \(41\)/ })).toBeDefined();
  await pane.unmount();

  // The spinner carries the timer and the delivered count while the run is alive.
  const spin = await $.ui.mount({ ...SPINNER, surface: 'terminal' });
  expect(spinner.at(-1)).toMatch(/^ · pr-review \d+:\d\d · 7\/16…$/);
  await spin.unmount();
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

test('a status poll attaches to its run when nothing is attached yet', async ($, on) => {
  const clock = mock.clock(on, { now: CUTOFF_MS });
  stubSession(on, '⏳ running — orchestrator 60s  ·  6m51s elapsed\n');
  stubRunDir(on, RUNNING);
  await $.session.start(INTERACTIVE);

  await $.tool.call({ tool: 'Bash', command: `node "C:\\x\\dist\\cli.cjs" status ${RUN_ID}` });
  await clock.advance(2000);

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: /PrecoPratico-Backend #798/ })).toBeDefined();
  expect(await band.find({ type: 'Text', text: /passes 7\/10 delivered/ })).toBeDefined();
  await band.unmount();
});

test('a torn read of delivery-state.json is retried on the next refresh', async ($, on) => {
  const clock = mock.clock(on, { now: CUTOFF_MS });
  stubSession(on);
  stubRunDir(on, RUNNING, ['delivery-state.json']);
  await $.session.start(INTERACTIVE);

  await $.tool.call({ tool: 'Bash', command: LAUNCH });
  await clock.advance(2000);

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: /passes 7\/10 delivered/ })).toBeDefined();
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
  expect(await band.find({ type: 'Text', text: /PrecoPratico-Backend #798/ })).toBeDefined();
  await band.unmount();
});

test('when the run finishes while attached, the band shows the outcome and polling stops', async ($, on) => {
  const clock = mock.clock(on, { now: CUTOFF_MS });
  stubSession(on);
  const files: Record<string, string> = { ...RUNNING };
  const counters = stubRunDir(on, files);
  let redraws = 0;
  on('ui.invalidate', () => {
    redraws += 1;
    return { value: undefined };
  });
  await $.session.start(INTERACTIVE);
  await $.tool.call({ tool: 'Bash', command: LAUNCH });
  await clock.advance(2000);
  let band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: /running — orchestrator/ })).toBeDefined();
  await band.unmount();

  // The run finishes: every file takes its final shape, and the next refresh sees it.
  Object.assign(files, DONE);
  await clock.advance(2000);

  band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: /done — 33 posted, 33 findings/ })).toBeDefined();
  expect(await band.find({ type: 'Text', text: /passes 10\/10 ✓ · companions 6\/6 ✓/ })).toBeDefined();
  await band.unmount();

  // No more reads and no more redraws: the timer is gone, not just idle.
  const statsAfterDone = counters.stat;
  const redrawsAfterDone = redraws;
  await clock.advance(10_000);
  expect(counters.stat).toBe(statsAfterDone);
  expect(redraws).toBe(redrawsAfterDone);
});

test('/pr-review-live off detaches: the band yields again and the pane closes', async ($, on) => {
  const clock = mock.clock(on, { now: CUTOFF_MS });
  stubSession(on);
  stubRunDir(on, RUNNING);
  await $.session.start(INTERACTIVE);
  await $.tool.call({ tool: 'Bash', command: LAUNCH });
  await clock.advance(2000);

  const answer = await $.command.run({ command: 'pr-review-live', args: 'off' });

  expect((answer as { text?: string }).text).toMatch(/detached/);
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined();
  expect(await band.find({ type: 'Text', text: /#798/ })).toBeUndefined();
  await band.unmount();
});

test('a run whose files stop changing is reported as silent after 90 seconds', async ($, on) => {
  const clock = mock.clock(on, { now: CUTOFF_MS });
  stubSession(on);
  stubRunDir(on, RUNNING);
  await $.session.start(INTERACTIVE);
  await $.tool.call({ tool: 'Bash', command: LAUNCH });

  await clock.advance(120_000);

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: /no heartbeat for 2:0\d/ })).toBeDefined();
  await band.unmount();
});

test('a --context-only preview is named as a preview, not a stalled run', async ($, on) => {
  // The real preview run next to the fixture: one gather line, a preview summary, no plan.
  const PREVIEW_ID = 'github__Preco-Pratico__PrecoPratico-Backend__798__2026-10-06T14-20-20-874Z';
  const PREVIEW: Record<string, string> = {
    'progress.ndjson': '{"ts":1791296421867,"phase":"gather","detail":"39 files"}\n',
    'pr-review-summary.md': '# PR Review Context Preview\n',
  };
  const clock = mock.clock(on, { now: CUTOFF_MS });
  stubSession(on);
  stubRunDir(on, PREVIEW, [], PREVIEW_ID);
  await $.session.start(INTERACTIVE);

  await $.command.run({ command: 'pr-review-live', args: PREVIEW_ID });
  await clock.advance(2000);

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await band.find({ type: 'Text', text: /preview — no dispatch/ })).toBeDefined();
  await band.unmount();
});

test('where nothing draws (the VS Code chat panel), /pr-review-live answers in text', async ($, on) => {
  const clock = mock.clock(on, { now: CUTOFF_MS });
  const { opened } = stubSession(on);
  stubRunDir(on, RUNNING);
  await $.session.start({ surface: 'vscode', isInteractive: true, cwd: 'C:/work' });

  const answer = await $.command.run({ command: 'pr-review-live', args: RUN_ID });
  await clock.advance(2000);

  const text = (answer as { text?: string }).text ?? '';
  expect(text).toMatch(/PrecoPratico-Backend #798/);
  expect(text).toMatch(/passes 7\/10 delivered/);
  expect(text).toMatch(/owasp\/logging\s+pack owasp · baseline/);
  expect(opened).toEqual([]);
});
