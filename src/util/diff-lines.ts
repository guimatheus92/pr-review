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
 * additions/deletions counts, and GitLab position 400s), so the four diff
 * consumers (line-snap, GitLab mapDiff/positionForLine, the ADO counter)
 * all route through this one filter.
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
