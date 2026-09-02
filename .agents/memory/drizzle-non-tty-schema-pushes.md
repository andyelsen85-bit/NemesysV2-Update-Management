---
name: Drizzle non-TTY schema pushes
description: Development database schema changes in this workspace can encounter interactive Drizzle rename prompts.
---

When a development schema change is clearly additive, an explicit idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` can unblock the environment if Drizzle's push command cannot open a TTY for its conflict decision.

**Why:** The managed shell is non-interactive, so Drizzle's otherwise valid column-conflict prompt can fail before applying unrelated additive columns.

**How to apply:** Inspect `information_schema` first, use only additive and reversible statements, then run the workspace typecheck and restart the affected services.