# Local Development Setup Report

## Scope

Local development setup only. Phase 3A, CRM business logic, Phase 2 matter and
finance behavior, and SQL migration files were not changed.

## Files Changed

- `.env.example`: safe local placeholders and the requested local defaults.
- `docker-compose.local.yml`: PostgreSQL 16 database-only local service.
- `package.json`: cross-platform local database, migration, and dev scripts.
- `scripts/dev.ts`: sets `NODE_ENV=development` without Unix-only shell syntax.
- `scripts/migrate.ts`: runs the repository's existing ordered SQL migrations.
- `README.md`: Docker and manual PostgreSQL setup, verification, and recovery.
- `Dockerfile`: removed exposed database and JWT values; runtime env behavior is
  unchanged.
- `audit-deliverables/LOCAL_DEV_SETUP_REPORT.md`: this report.

## Required Environment

Copy `.env.example` to the ignored `.env` file. Local defaults are:

```dotenv
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app
JWT_SECRET=local-dev-secret-change-later
AUTH_SECRET=local-dev-secret-change-later
ADMIN_EMAIL=admin@example.com
ADMIN_NAME=Admin
ADMIN_PASSWORD=admin123
NODE_ENV=development
APP_URL=http://localhost:3000
PORT=3000
```

The server loads `.env` before importing the application modules. The migration
and seed entrypoints also load `.env` through `dotenv/config`. Existing process
environment variables take precedence, preserving production runtime behavior.

## Exact Setup Commands

Run from the repository root in PowerShell:

```powershell
corepack enable
corepack pnpm install --frozen-lockfile
Copy-Item .env.example .env
corepack pnpm local:db
docker compose -f docker-compose.local.yml ps
corepack pnpm local:migrate
corepack pnpm db:seed
corepack pnpm local:dev
```

- Migration command: `corepack pnpm local:migrate`
- Admin seed command: `corepack pnpm db:seed`
- Dev server command: `corepack pnpm local:dev`
- App/login URL: `http://localhost:3000/login`
- Health URL: `http://localhost:3000/health`
- Database health URL: `http://localhost:3000/health/db`
- Local login: `admin@example.com` / `admin123`

The seed creates the admin only when the `users` table is empty. The app also
runs the same migrations and first-admin check at startup, but the explicit
commands above make setup failures easier to diagnose.

## Verification Commands

```powershell
Invoke-RestMethod http://localhost:3000/health
Invoke-RestMethod http://localhost:3000/health/db
```

Expected: `/health` includes `databaseUrlSet: true` and `jwtSecretSet: true`;
`/health/db` returns `ok: true`.

## Port Conflict

If host port 5432 is occupied:

```powershell
$env:LOCAL_POSTGRES_PORT = "5433"
corepack pnpm local:db
```

Then set `DATABASE_URL=postgresql://postgres:postgres@localhost:5433/app` in
the ignored `.env` file before migrating or starting the app.

## Manual / Native PostgreSQL Option (no Docker)

If Docker is unavailable, run a native PostgreSQL instead. Two paths:

### A. Windows via scoop (no admin, verified working on this machine)

```powershell
scoop install postgresql                              # user-space install
$PG = "$env:USERPROFILE\scoop\apps\postgresql\current"
& "$PG\bin\pg_ctl" -D "$PG\data" start                # start the server (port 5432)
& "$PG\bin\psql" -h 127.0.0.1 -U postgres -d postgres -c "ALTER USER postgres PASSWORD 'postgres';"
& "$PG\bin\createdb" -h 127.0.0.1 -U postgres app     # create the 'app' database
```

Stop later with `& "$PG\bin\pg_ctl" -D "$PG\data" stop`. Uninstall with
`scoop uninstall postgresql`. Note: the repo's `local:db` script targets Docker,
so on this path start PostgreSQL with `pg_ctl` (above) and skip `local:db`.

### B. Any platform with a native PostgreSQL 16+ install

Install PostgreSQL, start its service, then as a PostgreSQL administrator:

```sql
ALTER ROLE postgres PASSWORD 'postgres';
CREATE DATABASE app OWNER postgres;
```

For either path, then use the same `.env`, migration, seed, and dev commands
above (`corepack pnpm db:migrate`, `corepack pnpm db:seed`, `corepack pnpm dev`).

## Troubleshooting

- `docker` is not recognized: install/start Docker Desktop, or use the manual
  PostgreSQL option.
- Port 5432 is already allocated: use the port override above and update
  `DATABASE_URL` to the same port.
- `ECONNREFUSED localhost:5432`: PostgreSQL is not running or is still starting;
  check `docker compose -f docker-compose.local.yml ps` and its health status.
- Migration or login says `DATABASE_URL` is missing: confirm `.env` exists in the
  repository root and restart the command.
- Seed says users already exist: this is intentional; it will not add or replace
  an administrator in a populated database.
- Login fails after changing seed credentials: remove the local volume only when
  local data can be discarded, then recreate, migrate, and seed it:
  `docker compose -f docker-compose.local.yml down -v`.

## Tests and Results

End-to-end local run executed and verified on this machine (2026-06-20) using the
native scoop PostgreSQL path, because Docker Desktop is not installed here. Results:

- `corepack pnpm install --frozen-lockfile`: passed.
- `corepack pnpm check` (`tsc --noEmit`): passed (exit 0).
- `corepack pnpm build` (vite + esbuild): passed.
- Native PostgreSQL 18.4 started via scoop; `app` database created; app-style
  connection `postgresql://postgres:postgres@localhost:5432/app` verified.
- `corepack pnpm db:migrate`: **passed** — all migrations `0000`–`0019` applied.
- `corepack pnpm db:seed`: **passed** — initial admin `admin@legalcrm.com` created
  (role `admin`, status `active`).
- Dev server (`corepack pnpm dev`): **passed** — serving on `http://localhost:3000`.
- `GET /health`: **passed** — `databaseUrlSet: true`, `jwtSecretSet: true`,
  `databaseHost: localhost`, `databasePort: 5432`; `envPresence` shows the `.env`
  values are loaded.
- `GET /health/db`: **passed** — `{ ok: true }` (real query against the database).
- Login `POST /api/trpc/auth.login`: **passed** — HTTP 200, `success: true` for
  `admin@legalcrm.com` (role `admin`).
- Credential scan: no real database/JWT secrets are committed; `.env.example`
  holds placeholders only and `.env` is git-ignored.

Note on credentials: this verified run seeded `admin@legalcrm.com` / `Admin1234!`
in the local `.env`. The committed `.env.example` defaults remain
`admin@example.com` / `admin123`; either works locally.

> The Docker path (`local:db`) is documented and equivalent but was not exercised
> here (Docker not installed). The scoop native path above is the one verified.
