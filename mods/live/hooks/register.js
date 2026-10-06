// pr-review live — a Claude Code mod that shows a running review as it happens.
//
// It is one more READER of the run directory (~/.pr-review/runs/<id>/): the same feeds
// `pr-review status` reads, never `status` itself (which can reap processes), and it
// writes nothing — not to the PR, not to the checkout, not to ~/.pr-review.
//
// The host reads on("<event>", ...) and $.noun.method(...) from the source text, so
// every call is spelled out in full and helpers that take $ are top-level functions.

let interactive = false;
let surface = null;

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
}
