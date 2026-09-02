# NemesysV2 Update Management

Windows software update enforcement with a server control center, client sync protocol, and audit visibility.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/nemesys-console` — React admin console for overview, clients, software policies, audit history, and server settings.
- `artifacts/api-server` — Express API used by the control center and future Windows service.
- `lib/api-spec/openapi.yaml` — source of truth for dashboard, policy, client, settings, audit, and sync contracts.
- `lib/db/src/schema/index.ts` — Drizzle schema for Nemesys clients, policies, audit records, and server settings.

## Architecture decisions

- The admin console and future Windows client use the same generated OpenAPI contract.
- Client sync configuration is separate from the admin surface so the sync port can later be exposed through IIS/firewall policy independently.
- Software policies support both Windows file-version checks and section/key/value checks for legacy INI files.
- The Windows service should remain non-interactive; a companion user-session process will own countdown notifications.

## Product

- Administrators can monitor enrolled clients, define enforcement policies, review sync history, and configure sync cadence and transport security.
- The uploaded Poste INI format is represented by rules such as `[Poste] Version=454` and `VersMedSyst=418`.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
