---
name: Backup and audit integrity
description: Durable database boundaries for portable backups and immutable latest-client audit records.
---

Every public Nemesys table must be classified as portable application data or an explicit operational exclusion. Sessions, distributed security buckets, and the live session-generation state are operational; restore must increment the live generation rather than restoring an older value.

**Why:** Silent table drift makes backups incomplete, while restoring security state can revalidate sessions revoked after the backup.

**How to apply:** Any new Nemesys table must update backup classification and drift tests. Restore must continue to revoke all administrator sessions atomically.

The latest-client audit table is owned by a dedicated NOLOGIN role. Application logins receive read access and narrowly scoped SECURITY DEFINER routines through a stable NOLOGIN group role, but never direct update, delete, or truncate privileges.

**Why:** A session-local bypass controlled by the application database role is not an immutability boundary. Separating ownership makes authorized replacement, cleanup, and restore auditable database capabilities.

**How to apply:** Privileged deployment migrations provision the owner/group roles and grant the runtime login group membership. API startup must fail closed if ownership, trigger attachment, group membership, routine privileges, or direct-mutation revocation drift.