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

## Manual PostgreSQL Option

If Docker is unavailable, install PostgreSQL 16, start its service, and run as a
PostgreSQL administrator:

```sql
ALTER ROLE postgres PASSWORD 'postgres';
CREATE DATABASE app OWNER postgres;
```

Then use the same `.env`, migration, seed, and dev commands above.

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

- `corepack pnpm install --frozen-lockfile`: passed.
- `corepack pnpm check`: passed.
- `corepack pnpm build`: passed.
- `corepack pnpm test`: attempted; database-backed suites failed because no
  Docker or local PostgreSQL service is available on this machine. No test
  failure was attributed to the local setup source changes.
- Dev server startup with explicit local env: passed on port 3000.
- `GET /health`: passed; `databaseUrlSet: true`, `jwtSecretSet: true`, database
  host `127.0.0.1`, port `5432`.
- Credential scan: previously baked database and JWT values are absent from the
  working tree.
- Docker PostgreSQL, migrations, seed, `/health/db`, and login could not be run
  on this machine because Docker and local PostgreSQL are not installed. Exact
  Docker and manual commands are provided above.
