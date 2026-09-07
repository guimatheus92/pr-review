# pr-review-acceptance

**Fixture repository. Do not use any of this code.**

It exists so the `pr-review` acceptance matrix can run against a real pull
request on GitHub, Azure DevOps and GitLab. Some files contain deliberate
security defects; the review is expected to find them.

The canonical source of this tree is `evals/acceptance/` in the pr-review
repository. Edit it there and re-run `node scripts/acceptance-seed.mjs`;
changes made here directly will be overwritten.
