/**
 * Iterate a unified-diff patch yielding hunk headers (`@@ …`) and content
 * lines, with the file-header preamble (`--- a/…`, `+++ b/…`) and `\ No
 * newline` markers stripped.
 *
 * The subtlety every consumer must share: `---`/`+++` are file headers ONLY
 * before content starts (ADO's synthesized patches carry them; GitLab and
 * Octokit patches are hunks-only). Once inside a hunk — or, for hunkless
 * synthesized add/delete patches, once past the `+++` header — a line
 * starting `+++` or `---` is REAL content: an added line whose text begins
 * `++` (e.g. `++counter;`) or a removed markdown `---` rule. Skipping those
 * desyncs every line cursor downstream (wrong valid-line sets, wrong
 * additions/deletions counts, and GitLab position 400s), so every diff
 * consumer (line-snap, GitLab mapDiff/positionForLine, and countChangedLines
 * below, which serves the ADO provider and the git completion in gather)
 * routes through this one filter.
 */
export function* diffLines(patch: string): Generator<string> {
  let contentStarted = false;
  for (const ln of patch.split('\n')) {
    if (ln.startsWith('@@')) {
      contentStarted = true;
      yield ln;
      continue;
    }
    if (!contentStarted) {
      if (ln.startsWith('+++')) {
        // The `+++ b/…` header is the last preamble line in hunkless patches.
        contentStarted = true;
        continue;
      }
      if (ln.startsWith('---')) continue;
    }
    if (ln.startsWith('\\')) continue; // "\ No newline at end of file"
    yield ln;
  }
}

/** Additions and deletions of a patch — content lines only, hunk headers skipped — through the preamble filter above, so a `++counter;` line inside a hunk counts as content and a `+++ b/…` header never does. */
export function countChangedLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diffLines(patch)) {
    if (line.startsWith('@@')) continue;
    if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}
