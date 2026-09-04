---
name: Automatic schema upgrades
description: Deployment invariant for database changes required by the running Nemesys API contract.
---

Database changes required by the current API contract must run automatically during API startup, inside one transaction protected by a PostgreSQL transaction-scoped advisory lock. The server must not listen until schema upgrade and seed initialization succeed.

**Why:** Deploying a new API image against an existing Kubernetes database caused every policy and client-sync request to return HTTP 500 when the database lacked the matching columns. Operators require deployment to be self-contained rather than applying SQL manually.

**How to apply:** Keep startup DDL idempotent and preserve legacy values before removing old columns. The deployment startup probe must cover expected migration and lock-wait time so liveness cannot interrupt and restart a transactional upgrade.