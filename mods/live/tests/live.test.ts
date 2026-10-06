// Tests for the pr-review live mod (hooks/register.js). Run with `claude plugin test hooks`
// (npm run test:mod). No session, no sign-in, no network: every call the mod makes on `$`
// is answered by a stub registered here, and every file it reads comes from
// tests/fixtures/run-798, a pruned copy of a real run directory.
import { expect, test } from 'claude-code/testing';

const INTERACTIVE = { surface: 'terminal', isInteractive: true, cwd: 'C:/work' } as const;
const HEADLESS = { surface: null, isInteractive: false, cwd: 'C:/work' } as const;

// What Claude Code passes to a ui.render hook for the band above the prompt.
const BAND = {
  plugin: 'pr-review',
  component: 'AbovePrompt',
  viewport: { columns: 120, rows: 40, isFullscreen: false },
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const;

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
