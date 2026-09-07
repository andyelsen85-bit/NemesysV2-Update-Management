---
name: Active Directory policy targeting
description: Durable correctness rules for cached AD computer/group targeting.
---

Client synchronization must never query LDAP. Policies are selected from the last successfully replaced directory cache before the existing client response and ETag are generated. A failed refresh leaves the prior cache intact.

**Why:** LDAP availability and latency must not affect Windows client synchronization, and partial directory results must never broaden policy scope.

**How to apply:** Use paged searches, atomic replacement, and cross-instance synchronization exclusion. Preserve raw `objectGUID` identity across renames, include direct, nested, and primary-group membership, and fail closed for disabled, absent, stale, or unmatched cached computers. No policy targets means all workstations.