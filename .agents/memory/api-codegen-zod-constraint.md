---
name: API codegen Zod constraint
description: OpenAPI integer schemas currently generate zod.int(), which is unavailable in the workspace's Zod 3 runtime.
---

Use numeric schemas in the OpenAPI contract when targeting this workspace's current generated Zod runtime; preserve integer validation at the application boundary where it matters. Some generated request models are type-only, so optional request bodies may need explicit runtime checks in route code.

**Why:** Code generation succeeds, but the generated Zod package fails the shared TypeScript build if it emits zod.int(); Orval also emits interfaces for some request schemas rather than runtime parsers.

**How to apply:** Re-check the workspace Zod version before changing integer schemas back to OpenAPI integer.