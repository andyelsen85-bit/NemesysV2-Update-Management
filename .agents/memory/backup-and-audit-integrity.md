---
name: Backup and audit lifecycle
description: Durable database boundaries for portable backups and latest-client audit records.
---

Every public Nemesys table must be classified as portable application data or an explicit operational exclusion. Sessions, distributed security buckets, and the live session-generation state are operational; restore must increment the live generation rather than restoring an older value.

**Why:** Silent table drift makes backups incomplete, while restoring security state can revalidate sessions revoked after the backup.

**How to apply:** Any new Nemesys table must update backup classification and drift tests. Restore must continue to revoke all administrator sessions atomically.

The latest-client audit table uses the same ownership and permissions model as other application tables. The API transaction and unique client identity constraint preserve one latest report per client; database-level immutability is not required.

**Why:** The project does not require audit records to be immutable, and avoiding dedicated owner/group roles removes the need for elevated PostgreSQL role-management permissions.

**How to apply:** Perform audit replacement, inactive cleanup, and backup restore through ordinary application transactions. Do not add dedicated PostgreSQL roles or SECURITY DEFINER routines unless the security requirement changes.