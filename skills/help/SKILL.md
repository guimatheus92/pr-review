---
description: "pr-review help & documentation. Use for any question about the pr-review tool: how to review a PR, install, authenticate, daily usage and flags; configuration (5-level merge, YAML, env vars, models, extra paths); reviewers vs skills and how to add/remove/override/list reviewers and skills; caching (stale data, bypass, clearing); CI/CD integration (GitHub Actions, Azure DevOps Pipelines, exit codes, --fail-on gating); companion plugins (pr-review-toolkit, code-review); performance/speed/cost/token usage and size limits; and the internal architecture (single-session dispatch, source map, why a CLI not a pure skill)."
---

# pr-review — help & documentation

One skill, all the docs. Read the matching reference file for the topic — each is
the full guide, kept short so this index stays cheap to load.

| If asked about… | Read |
|---|---|
| Quickstart: install, authenticate, daily usage, common flags | [reference/pr-review-usage.md](reference/pr-review-usage.md) |
| Configuration: 5-level merge, YAML, env vars, models, extra paths | [reference/configuration.md](reference/configuration.md) |
| Reviewers vs skills: the two file types, when to author which, frontmatter, injection | [reference/reviewers-vs-skills.md](reference/reviewers-vs-skills.md) |
| Managing reviewers/skills: add, remove, override, disable, list what's loaded | [reference/adding-your-own-md.md](reference/adding-your-own-md.md) |
| Companion plugins: pr-review-toolkit, code-review — install, auto-invocation, opting out | [reference/companion-plugins.md](reference/companion-plugins.md) |
| CI/CD: GitHub Actions, Azure DevOps Pipelines, exit codes, `--fail-on` gating | [reference/ci-integration.md](reference/ci-integration.md) |
| Caching: gather cache, invalidation, bypass flags, clearing | [reference/caching.md](reference/caching.md) |
| Performance: diff exclusion, pre-filtering, single-session, early-exit, size limits | [reference/performance.md](reference/performance.md) |
| Architecture: execution model, source map, design decisions, resume/background | [reference/architecture.md](reference/architecture.md) |

Answer from the reference file's content; don't guess. When a question spans
topics (e.g. "why is my large PR rejected and how do I speed it up?"), read both
relevant files.
