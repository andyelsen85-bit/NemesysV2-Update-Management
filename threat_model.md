# Threat Model

## Project Overview

NemesysV2 is a centralized Windows software update-management platform. An
administrator uses the React control center over HTTPS to enroll Windows
clients, define software policies, configure authentication and TLS, and
review current compliance. An Express 5/Node.js API serves the console and the
Windows LocalSystem client. The API uses PostgreSQL through Drizzle ORM.
Windows clients poll for cached policy configuration, evaluate EXE and INI
requirements locally, optionally warn and close managed applications, run
configured update commands, and submit their latest audit state.

Administrator authentication supports a local account, LDAP, and optional AD
FS OIDC. LDAP directory data is cached for computer/group policy targeting;
client synchronization does not perform live LDAP queries. AD FS is an
external OIDC identity provider and is used only to establish the normal
NemesysV2 administrator session. Production PostgreSQL is an externally
managed CHdN service that CHdN backs up and monitors. Production availability
and restore procedures follow the CHdN operational agreement. Local
development uses a developer-provided PostgreSQL instance, while the
Kubernetes test overlay has an intentionally non-HA, single-replica
PostgreSQL Deployment for test and integration use.

## Assets

- **Administrator identities and sessions** -- local password material,
  LDAP/AD FS identity mappings, PostgreSQL-backed session rows, signed opaque
  session cookies, CSRF state, and administrator authorization. Compromise
  permits policy changes, client revocation, secret recovery, and access to
  all management data.
- **Client authentication material** -- the shared client API key, its
  SHA-256 authentication hash, encrypted recovery copy, Windows machine-DPAPI
  copy, and hostname enrollment records. A stolen key can submit reports and
  retrieve policy configuration as a client.
- **Application and infrastructure secrets** -- `SESSION_SECRET`,
  `DATABASE_URL`, bootstrap administrator credentials, LDAP bind credentials,
  AD FS confidential-client secrets, custom CA certificates, and TLS private
  keys. `SESSION_SECRET` signs sessions and derives the key used to encrypt
  stored secrets.
- **Update policy and execution data** -- executable paths, arguments, version
  checks, process names, and Update Mode state. Unauthorized changes can cause
  destructive process termination or arbitrary administrator-selected commands
  to run on managed Windows endpoints.
- **Client inventory and directory data** -- hostnames, client status and
  revocation state, Active Directory computer/group caches, administrator
  profiles, and target memberships. This data identifies infrastructure and
  determines which endpoints receive policy.
- **Compliance and operational records** -- the latest audit result per client,
  synchronization timestamps, API-key reveal records, application logs, and
  Windows client logs. These records support operational decisions but are
  not a complete immutable forensic history.
- **PostgreSQL and certificate state** -- policy, identity, secret, audit, and
  enrollment records, plus uploaded certificate/chain material and the
  encrypted private key. Integrity and recoverability are required for safe
  operation.
- **Availability and endpoint safety** -- the API, console, directory
  integrations, database, client synchronization, and the guarantee that an
  uncertain client enforcement action fails safely rather than closing or
  launching the wrong process.

## Trust Boundaries

- **Public HTTPS web endpoint to Nginx/console** -- administrator browsers and
  Windows clients cross the externally reachable `web` Service on TCP 443.
  Nginx terminates HTTPS and proxies `/api/*` to the API sidecar over Pod-local
  HTTP. Public HTTP must not become an alternate authenticated path; only the
  health probe is intentionally available over HTTP. Nginx replaces (rather
  than appends to) inbound `X-Forwarded-For`, and the API trusts exactly the
  one known Nginx hop; clients cannot choose the address used for request
  identity or rate-limit keys.
- **Browser to API** -- the browser is untrusted input even after login.
  `/api/auth/login`, AD FS start/callback, and `/api/healthz` are public;
  management and user routes require the signed administrator session.
  Cookie-authenticated mutations are checked by the server-side CSRF
  middleware as well as server-side authorization. Login and API-key
  authenticated machine-sync requests are separate authentication paths.
- **Windows LocalSystem client to API** -- `/api/sync/*` accepts the shared
  API key and `x-nemesys-hostname`. The hostname is an operational identity
  signal, not proof of a unique machine. The client receives policy and can
  submit compliance data across this boundary.
- **API to web-sidecar and certificate volume** -- the API and Nginx share a
  Pod network namespace and a certificate PVC. The API materializes
  certificate files from encrypted PostgreSQL state; Pod and volume access
  must be restricted to the two intended containers.
- **API to externally managed PostgreSQL** -- production crosses the
  application-to-CHdN database boundary using `DATABASE_URL`; the database is
  outside the application deployment's lifecycle. In the test overlay the
  equivalent boundary is the single-replica PostgreSQL Pod/PVC. Database
  network access, role permissions, backups, restores, and monitoring follow
  CHdN's production database operations.
- **API to LDAP/Active Directory** -- LDAP credentials and directory results
  cross into an external directory. LDAP authentication and periodic computer,
  group, and membership synchronization can affect administrator access and
  policy targeting. Cached data can be stale or unavailable.
- **API to AD FS** -- discovery, authorization, token exchange, and JWKS
  retrieval cross into AD FS. The returned identity is accepted only after
  OIDC validation and matching to a pre-provisioned active NemesysV2
  administrator.
- **Administrator privilege boundary** -- any authenticated administrator can
  manage policies, users, clients, TLS, directory settings, and recover or
  rotate the shared API key. There is no documented fine-grained
  administrator role boundary, so every administrator account is highly
  privileged.
- **API to managed Windows process/session** -- the LocalSystem service
  launches a user-session companion over an ACL-protected named pipe and can
  close or launch managed processes. The service must not trust an arbitrary
  process or session response.
- **Environment boundary** -- local development and the Kubernetes test
  overlay are not production. Test PostgreSQL resources, example secrets,
  migration scripts, and `db push` must not be treated as production
  availability, backup, or secret-management controls.

## Scan Anchors

- **Production entry points:** public HTTPS `web` Service, Nginx
  configuration in `deploy/docker/nginx-console.conf`, API routes mounted
  under `/api` in `artifacts/api-server/src/routes/index.ts`, and
  `/api/healthz`, `/api/auth/*`, `/api/sync/*`, and management routes.
- **Highest-risk server areas:** `artifacts/api-server/src/routes/auth.ts`,
  `management.ts`, `security.ts`, `users.ts`, and `adfs.ts`; LDAP and OIDC
  clients in `src/lib/ldap.ts` and `src/lib/adfs-oidc.ts`; secret handling in
  `src/lib/secret-crypto.ts` and `src/lib/ssl.ts`; logging in
  `src/lib/logger.ts`; and database schema/bootstrap in
  `lib/db/src/schema/index.ts` and `lib/db/src/bootstrap.ts`.
- **Highest-risk endpoint areas:** policy CRUD and client revocation/API-key
  rotation or reveal in `management.ts`, directory and TLS settings in
  `security.ts`, and the client enrollment/configuration/report flow in the
  `/sync` routes.
- **Client enforcement area:** `clients/windows-service/SyncWorker.cs`,
  `Program.cs`, and `FileLogging.cs`; review policy parsing, process
  discovery/closure, installer and launch arguments, DPAPI storage, named
  pipe ACLs, and cached configuration handling.
- **Deployment/data anchors:** `deploy/kubernetes/base/`,
  `deploy/kubernetes/overlays/test/`, `deploy/kubernetes/README.md`, and
  `deploy/docker/`. The test overlay's PostgreSQL Deployment is dev/test-only;
  production's database is the CHdN-managed service named by
  `DATABASE_URL`.
- **Public versus protected surfaces:** health, login, AD FS discovery/start/
  callback, and client sync are not administrator-session routes; all
  console management, user, security, policy, client inventory, and audit
  operations must be checked server-side. Tests, `exports/`, the mockup
  artifact, migration recovery SQL, and local `db push` are not production
  request paths unless an operator deliberately invokes them.

## Threat Categories

### Spoofing

Administrator sessions use `express-session` with a PostgreSQL
`connect-pg-simple` store. The HttpOnly cookie is a signed, opaque session
identifier; it is not a self-contained authorization token. The store
enforces a rolling idle limit and a configurable absolute limit, and logout,
expiry, account deactivation, and restore can revoke the server-side row.
Local passwords use scrypt; LDAP binds user credentials to the configured
directory; and AD FS uses authorization-code OIDC with S256 PKCE, signed
state/nonce, issuer and audience checks, token time validation, and JWKS
signature validation. An attacker who steals a live cookie, defeats
directory/AD FS validation, or abuses an unprotected route can become an
administrator.

The effective session revocation epoch is the centrally authoritative state of
the PostgreSQL session store. A deployment-wide emergency invalidation or
restore must clear the affected rows (and treat that operation as advancing
the revocation epoch) before accepting traffic again. The numeric generation
is held in the one-row `nemesys_security_state` table, which is outside the
application backup/restore contract; restore advances it with an atomic
database increment. The former `nemesys_server_settings` generation column is
retained only for compatibility and is not authoritative. There is no
independent cookie revocation mechanism: a cookie signature by itself does not
keep a revoked session valid. If multiple API replicas introduce a numeric
revocation epoch, it MUST be persisted centrally and checked on every
authenticated request rather than kept in process memory.

**Accepted operational risk: hostname + shared API key.** NemesysV2
intentionally uses one shared bearer key for client sync and the Windows
hostname as the client identity. It does not provide cryptographic,
per-device identity or client certificates. Anyone who obtains the key and
can present a matching hostname can impersonate that client; a hostname is
also not proof that a request came from the named Windows machine. This is an
accepted operational risk for the current deployment model, not a claim that
the mechanism is equivalent to mTLS.

Compensating controls are HTTPS with Windows certificate and hostname
validation, machine-scoped DPAPI storage of the key, a server-side SHA-256
authentication hash plus encrypted recovery copy, administrator-only
rotation/reveal with reveal records, deterministic hostname enrollment,
hostname matching on subsequent sync, explicit revocation tombstones, and
stale-client detection. Production must additionally restrict client
network reachability and monitor duplicate/unexpected hostname activity.
Operators must rotate the shared key after suspected disclosure and
reconfigure clients through protected deployment tooling.

Required guarantees:

- Every protected management request MUST validate the signed session and
  perform server-side authorization; frontend visibility is not authorization.
- Session signing, AD FS state, nonce, issuer, audience, JWKS, and PKCE
  validation MUST NOT be weakened to accommodate provider or proxy errors.
- Sync requests MUST require HTTPS, the configured key, the hostname header,
  and the enrolled/non-revoked hostname match. The hostname/key limitation
  MUST remain documented as a residual risk.
- Shared-key reveal and rotation MUST be restricted to an authenticated
  administrator, exposed only through the deliberate management flow, and
  followed by client rollout/rotation procedures.
- AD FS MUST map only to a pre-provisioned active administrator; successful
  upstream authentication alone MUST NOT create administrative access.

### Tampering

Management changes alter endpoint behavior, and policy commands are delivered
to a LocalSystem service. A forged sync report can corrupt current compliance
visibility; a forged configuration, compromised database role, or malicious
administrator can change executable paths, installer commands, group targets,
TLS settings, or client revocation. Cached directory targeting also creates a
window in which old membership data can continue to drive policy assignment.

The API validates request schemas and uses Drizzle queries, while the client
rechecks policy generation, compliance, process state, cancellation, and
companion authentication before destructive actions. The companion is
authenticated through a service-owned named pipe, and uncertain enforcement
fails safely. These controls reduce, but do not eliminate, the impact of
administrator, database, or shared-key compromise.

Required guarantees:

- All policy, settings, user, client, and audit writes MUST be validated and
  authorized on the server; client-supplied identity and compliance fields
  MUST NOT override the enrolled record.
- Sync configuration MUST be scoped to the authenticated enrolled hostname
  and revoked clients MUST remain denied, including after reconnect attempts.
- Update commands and executable paths MUST be treated as high-impact
  administrator data, validated as intended by the client contract, and
  MUST NOT be routed through a shell or silently broadened by client input.
- The client MUST fail closed when configuration, process state, companion
  authentication, launch ledger, or persistence cannot be verified.
- Production database roles MUST use least privilege and only the API's
  required schema permissions; database administration and migrations MUST be
  controlled separately.

### Repudiation

The API keeps one latest audit entry per client rather than an append-only
history. It also records API-key reveal events. Pino request logging redacts
authorization headers, cookies, and set-cookie headers, and AD FS handling
does not log tokens, codes, secrets, PEM contents, or full sensitive claims.
Nginx access logging records the method and normalized URI path, plus status,
request timing, and upstream metadata; it deliberately excludes the request
query string so AD FS callback code and state values are not logged.
The Windows client retains only the current daily log and sends synchronization
failures to the Windows Application Event Log.

These are operational diagnostics and current-state evidence, not a complete
or tamper-evident administrative audit trail. Deleting inactive clients also
deletes their latest audit rows, and a database restore can roll back both
state and reveal records. Logs retained only in Pods or on an endpoint cannot
prove what an administrator did if that host is compromised.

Required guarantees:

- Sensitive changes (administrator lifecycle, policy, targeting, client
  revocation/reactivation/deletion, TLS and directory settings, and API-key
  rotation/reveal) MUST be attributable to an administrator, timestamped, and
  exported to an access-controlled, append-only or tamper-evident operational
  log when forensic accountability is required.
- Audit and log pipelines MUST state their retention, clock, access, and
  integrity guarantees; the latest-per-client table MUST NOT be represented
  as a historical audit log.
- Logs MUST exclude passwords, API keys, session cookies, authorization codes,
  tokens, private keys, secret plaintext, and unnecessary directory claims.
- Backup/restore events and emergency key rotations MUST be recorded outside
  the restored application database so restoration cannot erase the evidence.

### Information Disclosure

The database contains inventory, directory identities, policy commands,
certificate material, and encrypted secrets. TLS private keys, LDAP bind
passwords, AD FS confidential-client secrets, and the recoverable client key
are encrypted at rest with AES-256-GCM using a key derived from
`SESSION_SECRET`. The client stores its key with machine DPAPI. TLS clients
validate certificate trust, hostname, and validity; AD FS and LDAP can use
configured CA material without disabling certificate validation.

Disclosure risks include a stolen `SESSION_SECRET` plus database dump, a
mis-scoped production database or backup, accidental secret values in
environment/configuration repositories, certificate files on the shared PVC,
verbose upstream directory errors, browser/session theft, and a
misconfigured CORS allowlist. Browser CORS is credentialed but exact-origin
allowlisted from `CORS_ALLOWED_ORIGINS` (or `ALLOWED_ORIGINS`); requests
without an origin and origins outside that set receive no CORS permission.
This is not a substitute for CSRF protection or network policy.

Required guarantees:

- Production secrets MUST be supplied by protected secret management and MUST
  never be committed to Git, ConfigMaps, images, shell history, or logs.
- `SESSION_SECRET` MUST be high entropy, access restricted, backed up
  separately from the database, and kept stable across restore; changing or
  losing it makes existing sessions invalid and prevents decryption of
  encrypted database secrets.
- API keys, LDAP credentials, AD FS client secrets, and TLS private keys MUST
  remain encrypted at rest and MUST never be returned except through their
  explicit, authenticated management flow. Certificate/CA public material
  must not be confused with private-key material.
- Production ingress MUST enforce HTTPS, correct public hostname
  certificates, secure cookie handling, appropriate origin policy, and
  network policies that prevent direct exposure of the API or database.
- Database backups, certificate volumes, and exported logs MUST have
  equivalent access control and encryption to the live data.

### Denial of Service

The API depends on CHdN PostgreSQL, LDAP, AD FS, cluster networking, and
Windows clients polling on a normal or Update Mode cadence. A public login,
health, AD FS callback, or sync endpoint can be abused for request floods;
slow directory/provider calls, database exhaustion, or a client fleet
configured for aggressive polling can prevent administration or timely policy
delivery. The test database's one replica and PVC are especially unsuitable
for production availability.

The API applies endpoint-specific throttles to login, AD FS start/callback,
and expensive machine operations, with progressive login lockout. Counters
and lockout state are stored atomically in PostgreSQL so all API replicas use
the same limits. Ingress-level limits remain a recommended additional control
against traffic that could exhaust application or database capacity before an
application-level response is produced.

Required guarantees:

- Production ingress and API operations MUST have bounded request sizes,
  connection and upstream timeouts, authentication/login and sync abuse
  controls, and distributed rate limits appropriate to the endpoint.
- Database connection pools, directory calls, OIDC calls, and migrations MUST
  be bounded so an external dependency cannot exhaust API workers.
- CHdN production database monitoring and backup commitments, together with
  the agreed availability and restore procedures, MUST define and meet the
  service's RPO/RTO; the Kubernetes test PostgreSQL Deployment MUST NOT be
  promoted as that guarantee.
- Client retry and polling behavior MUST remain bounded and jittered, and
  an unavailable API MUST not cause destructive local enforcement.

### Elevation of Privilege

Administrator routes control all tenants of the deployment's authority:
software policy, executable launch/close behavior, users, directory mapping,
TLS, API-key recovery, and client lifecycle. A route authorization mistake,
IDOR, SQL injection, command injection, path traversal, or unsafe handling of
directory/identity mappings could turn a client or lower-trust browser into a
full administrator or LocalSystem execution path. A compromised LDAP/AD FS
identity that maps to an active administrator has the same impact.

The service/companion named-pipe handshake, server-side `requireAdmin` checks,
active-account checks, pre-provisioned AD FS mapping, parameter validation,
and client cancellation/revalidation are important controls. They do not
replace independent authorization tests or database and deployment
hardening.

Required guarantees:

- Every management route MUST enforce server-side administrator authorization
  and object-level checks; IDs, hostnames, groups, and claims MUST NOT grant
  access merely because they are client-supplied.
- Administrator creation and external identity mapping MUST be
  allowlisted/pre-provisioned and must reject inactive, duplicate, conflicting,
  or ambiguous matches.
- LDAP filters and all database operations MUST safely escape/parameterize
  untrusted values; directory configuration MUST be restricted to trusted
  administrators and protected egress.
- Only the installed service-owned companion in the selected user session
  may authorize warning responses. Named-pipe ACLs and process identity MUST
  be checked on every connection.
- Production images, Pods, service accounts, volumes, PostgreSQL roles, and
  secret access MUST be least-privileged; debug, migration, and test
  resources MUST not be reachable as production application paths.

## Backup, Restore, and Recovery Risks

CHdN provides backup and monitoring for the externally managed production
PostgreSQL service, with availability and restore procedures governed by the
CHdN operational agreement. NemesysV2 does not create a production PostgreSQL
Deployment or assume that a Kubernetes PVC is a backup. The test overlay's
PVC and one-replica database are useful for test/integration operation only and
can lose data or become unavailable.

Before schema-changing releases or manual recovery SQL, operators MUST take a
normal CHdN-managed PostgreSQL backup and verify that it is restorable. A
restore plan must cover the database, certificate material as represented by
the database/PVC, protected deployment secrets, and the CHdN service
endpoint. `SESSION_SECRET` is not recoverable from ciphertext: restoring a
database without the matching secret makes stored LDAP, AD FS, API-key, or
TLS private-key material undecryptable. Restoring an older database can also
reintroduce revoked clients, old policies, or old API-key state; after
restore, operators must reconcile revocations and rotate credentials when
rollback exposure is possible.

Any in-application backup/restore capability is a privileged data-export and
destructive write path. A backup can contain every administrator, policy,
identity, enrollment, and encrypted-secret row; a leaked file is therefore
equivalent to a sensitive database export. Backup download and restore MUST be
administrator-only and CSRF-protected, use bounded upload/download sizes,
validate the backup version and complete table set, require deliberate
confirmation, and restore all tables transactionally with dependency and
sequence handling. The application backup is format version 2 and has an
explicit schema manifest containing the application tables
`nemesys_admin_users`, `nemesys_audit_entries`,
`nemesys_api_key_reveal_audits`, `nemesys_clients`,
`nemesys_ldap_settings`, `nemesys_directory_cache_status`,
`nemesys_directory_computers`, `nemesys_directory_groups`,
`nemesys_directory_computer_groups`,
`nemesys_software_policy_target_groups`, `nemesys_server_settings`,
`nemesys_software_policies`, `nemesys_ssl_settings`,
`nemesys_adfs_settings`, and `nemesys_adfs_identity_mappings`. The manifest
must match exactly; session rows and the security-state singleton are
intentionally excluded, and restore also checks each row against the live
table columns. Before any destructive delete, restore requires exactly one
live `nemesys_server_settings` row with `id='default'` and exactly one
matching default row in the upload. Schema or singleton invariant failures
are rejected as controlled invalid uploads and issue no delete. A failed
restore MUST roll back completely; a successful restore MUST atomically
advance the generation in `nemesys_security_state`, invalidate active sessions
(thus advance the effective session revocation epoch), and trigger
post-restore key, revocation, and audit verification.

CHdN and NemesysV2 operations must agree on tested RPO/RTO, backup retention,
restore authorization, encryption, and post-restore verification. Restore
drills must verify administrator login, secret decryption, TLS material
materialization, AD FS/LDAP behavior, client revocation, policy delivery, and
audit/log forwarding before production traffic is reopened.

## Required Guarantees

The following guarantees are required for a production deployment:

- All authenticated access MUST be encrypted in transit and all
  administrator/client authorization MUST be enforced server-side.
- Browser API access MUST use an explicit same-origin/approved-origin
  allowlist; wildcard CORS MUST NOT be combined with credentials or treated as
  an authentication control.
- Every cookie-authenticated state-changing endpoint MUST enforce the CSRF
  token check, including management, user, security, password, backup, and
  restore operations.
- Administrator sessions MUST be centrally revocable, expire on the defined
  inactivity/absolute limits, and be destroyed on logout or account
  deactivation; a self-validating cookie alone is not a revocation guarantee.
- Login, AD FS callback, enrollment, and other credential/expensive unauthenticated
  paths MUST have bounded rate limiting and progressive brute-force protection.
- The hostname-plus-shared-key model MUST remain explicitly accepted as an
  operational risk with its compensating controls, and key exposure MUST
  trigger rotation, client reconfiguration, and review of affected records.
- Production MUST use the CHdN externally managed, backed-up, and monitored
  PostgreSQL service, with availability and restore governed by the agreed
  CHdN operating procedures; the test PostgreSQL Deployment/PVC MUST NOT be
  used as the production database or backup plan.
- Secrets MUST use protected delivery and encryption at rest; `SESSION_SECRET`
  continuity and independent recovery MUST be part of the backup plan.
- AD FS and LDAP certificate validation, identity mapping, bind protection,
  and egress controls MUST not be bypassed to make an integration succeed.
- Policy and process enforcement MUST fail safely whenever identity, state,
  process, companion, persistence, or configuration integrity is uncertain.
- Audit and logging limitations MUST be disclosed to operators, and
  security-sensitive events requiring accountability MUST be sent to
  access-controlled, tamper-evident external retention.
- Backup restore MUST be tested against the required RPO/RTO and MUST include
  post-restore credential, revocation, TLS, policy, and audit verification.