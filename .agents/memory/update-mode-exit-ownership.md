---
name: Update Mode exit ownership
description: Concurrency and cycle rules for per-policy self-update launches when leaving Update Mode.
---

Once a launch-on-exit cycle takes ownership of a policy, ordinary warning, process-closure, and silent-install enforcement must be cancelled and remain suppressed for that cycle. Destructive actions must validate cancellation and generation under the same synchronization boundary used to invalidate enforcement.

**Why:** Merely skipping new enforcement scheduling leaves an already-running task able to race the application-owned updater. Disabled or deleted policies also disappear from sync payloads, so absence must actively cancel their existing enforcement state.

**How to apply:** Reconcile enforcement state against every received enabled-policy set. Give each enabled Update Mode entry a fresh cycle identity, including re-enabling a policy already configured in Update Mode. A transition observed while launch-on-exit is disabled is consumed for that cycle while ordinary enforcement continues.