---
name: Comparison-operator rollout
description: Compatibility rule for rolling out relational EXE and INI policy checks.
---

Deploy the operator-aware Windows client before configuring `<`, `<=`, `>=`, or `>` checks. Policies without an operator remain exact equality.

**Why:** Older clients ignore the new operator field and continue evaluating every check as equality, which could incorrectly remediate a newer self-updated application.

**How to apply:** Roll out the new MSI first, confirm managed clients have upgraded, and only then change policies from `=` to a relational operator.