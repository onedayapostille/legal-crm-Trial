# Legal CRM

Production-ready CRM for legal practice enquiry intake, matters, tasks, payments, analytics, and team access control.

## Stack

| Layer | Technology |
| --- | --- |
| Runtime | Node.js, TypeScript |
| Backend | Express, tRPC |
| Frontend | React, Vite |
| Database | PostgreSQL, Drizzle ORM |
| Auth | Email/password, signed JWT httpOnly cookie |
| UI | TailwindCSS, Radix UI |

## Authentication

Users sign in with email and password only. Passwords are salted and hashed with Node `scrypt`. Session tokens are signed with `JWT_SECRET` or `AUTH_SECRET` and stored in an httpOnly cookie.

Supported roles:

- Admin: full access, including user management
- Manager: operational access to leads, matters, tasks, analytics, and payments
- Lawyer: leads, matters, tasks, and analytics
- Staff: leads, tasks, and analytics
- Viewer: dashboard and analytics only

Inactive and suspended users cannot sign in or use protected APIs.

## Initial Admin

No default credentials are shown in the UI. To create the first administrator, set these environment variables and run the seed script:

```bash
ADMIN_EMAIL=admin@your-domain.com
ADMIN_PASSWORD=Use-A-Strong-Password-123
ADMIN_NAME="System Administrator"
pnpm db:seed
```

The seed script creates an admin only when the users table is empty. After the first admin exists, create and manage users from `/user-management`.

## Environment Variables

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` or `AUTH_SECRET` | Yes | Long random session signing secret |
| `APP_URL` | Yes | Public deployed app URL, for example `https://crm.alghazzawi.com` |
| `API_BASE_URL` | No | API origin if frontend and backend are split; blank for same-origin |
| `ADMIN_EMAIL` | First setup only | Initial admin email |
| `ADMIN_PASSWORD` | First setup only | Initial admin password |
| `ADMIN_NAME` | No | Initial admin display name |
| `PORT` | No | Defaults to `3000` |

## Secrets & Security

Secrets are read **only** from environment variables at runtime. They are never
hard-coded in source, the `Dockerfile`, or any committed file:

- The `Dockerfile` builds a secret-free image. Supply secrets at run time, e.g.
  `docker run -e DATABASE_URL=... -e JWT_SECRET=... ...`, or via
  `docker-compose` (`env_file: .env`).
- `.env` and its variants are git-ignored; commit only `.env.example` with
  placeholder values.
- The server logs a clear, actionable error at startup when `DATABASE_URL` is
  missing (and the same guidance is raised if a request reaches the database
  before it is configured), and warns loudly when `JWT_SECRET`/`AUTH_SECRET` is
  unset. Startup logs print only `SET ✓ / NOT SET ✗` markers — never the secret
  values themselves. See **Troubleshooting** below.

> **⚠️ Credential rotation (action required outside the codebase).**
> Earlier commits baked a real `DATABASE_URL` (Supabase), `JWT_SECRET`, and
> `ADMIN_PASSWORD` into the `Dockerfile` and `docker-compose.yml`. Removing them
> from the working tree does **not** remove them from git history or from any
> image already built. Before delivery you MUST:
> 1. Rotate the Supabase database password (and re-issue the connection string).
> 2. Generate a new `JWT_SECRET` (`openssl rand -hex 32`). Rotating it
>    invalidates existing sessions, which is the desired effect.
> 3. Change the admin account password (the old `ADMIN_PASSWORD` is exposed).
> 4. Update the deployment secret store / `.env` with the new values.
> 5. Optionally purge the secrets from git history (e.g. `git filter-repo`) and
>    force-push, coordinating with the team.

## Deployment

The app reads every secret from `process.env` at runtime — nothing is hard-coded
in source, the `Dockerfile`, or `docker-compose.yml`. The compose file only
references variable **names** as placeholders (e.g. `DATABASE_URL: ${DATABASE_URL}`);
the real values come from the environment at run time.

To deploy:

1. In your hosting platform, open **App Settings → Edit Environment Variables**
   and add the real runtime values (do **not** commit them anywhere):

   ```env
   DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DB_NAME?sslmode=require
   JWT_SECRET=<secure-random-secret>          # generate: openssl rand -hex 32
   NODE_ENV=production
   ```

   These variables must be scoped to **runtime** (not build-only). `AUTH_SECRET`
   is accepted as a fallback for `JWT_SECRET`; set `ADMIN_EMAIL` /
   `ADMIN_PASSWORD` only for the first-admin seed.

2. **Save & Redeploy** — a full rebuild/redeploy, not just a restart — so the
   running container receives the new values.

3. Verify the *running container* actually got them (the endpoint exposes
   booleans only, never the secret values):

   ```bash
   curl https://<your-app>/health
   ```

   ```json
   {
     "databaseUrlSet": true,
     "jwtSecretSet": true
   }
   ```

   If either is `false` after a clean redeploy, the values were not injected into
   the container's runtime environment — re-check the variable names and runtime
   scope in App Settings (see **Troubleshooting** below). Editing
   `docker-compose.yml` has no effect on a platform that builds from the
   `Dockerfile`.

When running the compose file yourself, supply the values via a git-ignored
`.env` file in the same directory (Compose interpolates `${DATABASE_URL}` etc.
from it) or via your shell environment.

## Local Development

Prerequisites: Node.js 22 or newer, Corepack, and Docker Desktop (or PostgreSQL
16 installed locally). The app runs on the host and uses a database-only Docker
Compose service, with no Dublyo dependency.

```powershell
# 1. Install dependencies
corepack enable
corepack pnpm install --frozen-lockfile

# 2. Create your local env file from the template, then edit .env and set
#    DATABASE_URL (and JWT_SECRET). .env is git-ignored.
Copy-Item .env.example .env
#    Defaults already match docker-compose.local.yml.

# 3. Create the schema (applies drizzle migrations)
corepack pnpm local:db
docker compose -f docker-compose.local.yml ps
corepack pnpm local:migrate

# 4. Seed the first admin user (uses ADMIN_EMAIL / ADMIN_PASSWORD from .env)
corepack pnpm db:seed

# 5. Start the dev server (http://localhost:3000)
corepack pnpm local:dev
```

The Compose service uses PostgreSQL user/password `postgres`, database `app`,
and host port `5432`. Open `http://localhost:3000/login` and sign in with
`admin@example.com` / `admin123` after seeding. These are local defaults only.

The equivalent one-off Docker command is:

```bash
docker run --name legal-crm-db -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=app -p 5432:5432 -d postgres:16-alpine
# .env: DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app
```

Use `docker-compose.local.yml` for the maintained local database configuration.

### Health and login verification

```powershell
Invoke-RestMethod http://localhost:3000/health
Invoke-RestMethod http://localhost:3000/health/db
```

`/health` must show `databaseUrlSet: true` and `jwtSecretSet: true`.
`/health/db` must show `ok: true`.

### Port 5432 conflicts

Choose another host port before starting the database and update `.env` to
match. For example:

```powershell
$env:LOCAL_POSTGRES_PORT = "5433"
corepack pnpm local:db
# .env: DATABASE_URL=postgresql://postgres:postgres@localhost:5433/app
```

### Manual PostgreSQL setup (no Docker)

If Docker is unavailable, run a native PostgreSQL instead.

**Windows via scoop (no admin — verified path):**

```powershell
scoop install postgresql
$PG = "$env:USERPROFILE\scoop\apps\postgresql\current"
& "$PG\bin\pg_ctl" -D "$PG\data" start
& "$PG\bin\psql" -h 127.0.0.1 -U postgres -d postgres -c "ALTER USER postgres PASSWORD 'postgres';"
& "$PG\bin\createdb" -h 127.0.0.1 -U postgres app
```

**Any platform with a native PostgreSQL 16+ install:** start its service, then in
`psql` or a PostgreSQL admin tool:

```sql
ALTER ROLE postgres PASSWORD 'postgres';
CREATE DATABASE app OWNER postgres;
```

Either way, keep the default `DATABASE_URL` in `.env`, then run
`corepack pnpm db:migrate`, `corepack pnpm db:seed`, and `corepack pnpm dev`.
(On the native path, start PostgreSQL with `pg_ctl` above — `local:db` is Docker-only.)

## Troubleshooting

**`DB: DATABASE_URL environment variable is required` (e.g. on the login page)**

The app could not find a database connection string. It is read **only** from the
environment — nothing is hard-coded. Fix it:

1. `Copy-Item .env.example .env` (if you haven't already).
2. Edit `.env` and set a real `DATABASE_URL`, for example
   `postgresql://postgres:postgres@localhost:5432/app`
   (append `?sslmode=require` for managed/remote databases).
3. Make sure that PostgreSQL is actually running and reachable.
4. Restart the app (`pnpm dev`). For Docker, pass it via `env_file: .env` or
   `docker run -e DATABASE_URL=...`.

Check configuration without exposing secrets:

```bash
curl http://localhost:3000/health      # databaseUrlSet / jwtSecretSet booleans
curl http://localhost:3000/health/db   # actually pings the database
```

The startup logs also print `DATABASE_URL: SET ✓ / NOT SET ✗` (markers only,
never the value).

**Hosted platform (Dublyo): `databaseUrlSet:false` even though App Settings has the value**

On the hosted Dublyo deployment the app is built from the **`Dockerfile`** and run as
a single container. **Dublyo does not use `docker-compose.yml`** — editing the
`environment:` block there has no effect on the live app. Variables must arrive as
the container's **runtime** environment:

1. Set `DATABASE_URL` (and `JWT_SECRET`) in **App Settings → Edit Environment
   Variables**, then **Save & Redeploy** (a full rebuild, not just a restart).
2. Confirm what the *running container* actually sees:
   ```bash
   curl https://<your-app>.dublyo.co/health   # want databaseUrlSet:true, jwtSecretSet:true
   ```
3. If `/health` still reports `false` after a clean redeploy, the platform is not
   injecting App Settings into the container — a **platform-configuration issue**,
   not a code or compose issue. Re-check the variable names and that they are
   scoped to runtime (not build-only), or raise it with Dublyo support.

> Note: `NODE_ENV` / `APP_RELEASE` showing as set proves nothing — they are baked
> into the image by the `Dockerfile`, independent of platform injection. Only the
> `/health` booleans for `DATABASE_URL` / `JWT_SECRET` are authoritative.

## Production Build

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate
pnpm db:seed
pnpm start
```

## User Management

Admins can:

- Add users with any valid email domain
- Edit name, email, role, and status
- Reset passwords
- Delete users
- Suspend or deactivate accounts

Server-side safeguards prevent duplicate emails, self deletion, self deactivation, self admin removal, and deletion or demotion of the last active admin.

## Audit Logs

The system records user management events in `audit_logs`:

- user created
- user deleted
- role changed
- status changed
- password reset

## Routing

The production server serves the React app with SPA fallback, so refreshed routes such as `/login`, `/dashboard`, and `/user-management` work directly.
