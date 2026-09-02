# NemesysV2 Update Management

Windows software update enforcement with a server control center, client sync protocol, and audit visibility.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (binds to `PORT`, 8080 in the preview workflow)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — PostgreSQL connection string, supplied by the target Kubernetes environment
- Runtime env: `PORT` — HTTP listen port; the Kubernetes Service/Ingress should route the admin console and API to this port
- Runtime env: `SESSION_SECRET` — session signing secret for administrator sessions
- Bootstrap env: `NEMESYS_ADMIN_USERNAME` and `NEMESYS_ADMIN_PASSWORD` — used only when the administrator credential has not yet been initialized

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/nemesys-console` — React admin console for overview, clients, software policies, audit history, and server settings.
- `artifacts/api-server` — Express API used by the control center and Windows service.
- `clients/windows-service` — Windows-targeted LocalSystem service, DPAPI key storage, hostname enrollment, policy evaluation, and user-session countdown companion.
- `lib/api-spec/openapi.yaml` — source of truth for dashboard, policy, client, settings, audit, and sync contracts.
- `lib/db/src/schema/index.ts` — Drizzle schema for Nemesys clients, policies, audit records, and server settings.

## Architecture decisions

- The admin console and future Windows client use the same generated OpenAPI contract.
- The server is designed to run as a stateless Kubernetes workload with PostgreSQL provided by the existing cluster/database stack; do not introduce a Replit-specific database or deployment dependency.
- Client sync configuration is separate from the admin surface so the sync port can later be exposed through IIS/firewall policy independently.
- Clients authenticate with one shared API key, while the server stores only its SHA-256 hash. Client identity is the Windows hostname; individual client certificates are not part of the design.
- API-key rotation returns the plaintext key once for silent installation/reconfiguration commands. Windows clients must protect the key with DPAPI; the server hostname may remain plain text in the local client configuration.
- The effective sync contract includes server-controlled Update Mode and the selected close-on-start timeout, so a running Windows client can apply policy changes without service restart.
- Software policies support both Windows file-version checks and section/key/value checks for legacy INI files.
- Administrator management routes require a signed HttpOnly session; `/sync/*` uses the shared API key and hostname headers instead.
- The Windows service remains non-interactive; a companion user-session process owns countdown notifications.

## Product

- Administrators can monitor enrolled clients, define enforcement policies, review sync history, and configure sync cadence, shared API-key transport, and global Update Mode.
- The uploaded Poste INI format is represented by rules such as `[Poste] Version=454` and `VersMedSyst=418`.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
