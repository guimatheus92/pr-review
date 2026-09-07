---
description: Team rules for this service — audit logging on request handlers and SQL access conventions. Applies to handlers and scripts.
applies_to:
  - "src/**"
  - "scripts/**"
---

# Team rules

These are project conventions. They are not generic best practice, and a
reviewer that has not read this file cannot know them.

## ACC-LOG-002 — every request handler must audit-log

Every HTTP request handler MUST call `audit.log(req)` before it returns a
response. A handler that returns any response without that call is a
violation, regardless of what else it does.

When you report it, cite the rule id `ACC-LOG-002` in the finding body.

## ACC-SQL-001 — all SQL goes through `db.q()`

Every SQL statement MUST go through the `db.q()` helper, which parameterises
its arguments. Calling `db.query(` directly is banned in this repository, even
when the values look safe.

When you report it, cite the rule id `ACC-SQL-001` in the finding body.
