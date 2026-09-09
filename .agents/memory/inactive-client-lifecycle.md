---
name: Inactive client lifecycle
description: Rules for aging, deleting, and safely restoring Windows client enrollments.
---

Clients become inactive after 72 hours without a poll. Administrators may bulk-delete inactive clients and their latest audit rows, but revoked client rows must remain durable tombstones and must never enter automatic cleanup.

**Why:** Workstations may legitimately be shut down over a weekend, while a 72-hour window still makes decommissioned inventory visible and removable without weakening explicit access revocation.

**How to apply:** Base activity on the last poll with older sync timestamps as fallbacks. Exclude both status-revoked and certificate-revoked rows from aging and deletion, and recheck those conditions transactionally during cleanup.

Deleted hostname identities must be recreated automatically when they reconnect, including clients installed before cleanup support was added.

**Why:** Older Windows services otherwise keep polling a deleted deterministic client ID and cannot recover without a service update or restart.

**How to apply:** Transparently recreate only a missing client ID that exactly matches the deterministic hostname identity. Keep client-side 404 re-enrollment as an additional recovery path, and never recreate an existing revoked row.