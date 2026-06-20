# Online Deployment Audit

Date: 2026-06-21

## Executive Result

The application image and server startup are capable of running online with a
Supabase PostgreSQL connection. The current Dublyo deployment is blocked before
any database connection attempt: Dublyo is not injecting App Settings into the
running application container.

The supplied runtime logs prove this independently of Supabase:

- `DATABASE_URL: NOT SET`
- `JWT_SECRET: NOT SET`
- the server falls back to port 3000, showing that the configured `PORT` is also
  absent

Changing the database hostname, password, or SSL options cannot fix a value that
never reaches `process.env`.

## Findings

### Critical: Dublyo runtime environment injection is absent

The Docker image starts with `node dist/index.js`. Node inherits runtime
environment variables normally, and the application reads them before importing
the rest of the server. The absence of multiple unrelated variables means this
is not a parsing or Supabase issue.

Required Dublyo action:

1. Confirm the variables are configured on the application container, not the
   old Dublyo PostgreSQL service.
2. Use a full Save & Redeploy and confirm a new image/container is created.
3. Inspect `/health`; `envPresence.ADMIN_NAME` provides a non-secret injection
   check in addition to the two required secrets.
4. If values remain false, raise a Dublyo platform ticket with the runtime logs.

Do not put database or JWT secrets in the Dockerfile, source code, build args, or
Git as a workaround.

### High: `.env` was included in the Docker build context

`.env` was Git-ignored but not Docker-ignored. Multi-stage copying kept it out of
the final runtime filesystem, but it was still sent into the Docker build context
and copied into the builder stage. `.dockerignore` now excludes `.env` and all
environment variants while allowing the safe `.env.example` template.

Any secret that was previously included in a remote build context should be
rotated.

### High: credentials shown during troubleshooting must be rotated

The previously shared screenshots exposed an administrator password, a JWT
secret, and an old database credential. Rotate the JWT secret and administrator
password before declaring the deployment ready. Rotate the old database password
if that database remains active.

### Medium: database migrations run after the HTTP listener starts

The server begins listening and then starts migrations asynchronously. `/health`
can return `ok: true` before migrations or database initialization finish. Use
`/health/db` as the readiness check and do not treat `/health` alone as proof the
CRM is ready for traffic.

### Medium: migrations have no applied-migration ledger

The custom runtime runner executes every SQL file on each startup and relies on
idempotent SQL or `already exists` errors. This is existing migration behavior and
was not changed during this audit. For the first deployment to an empty Supabase
database, run migrations once as an explicit release step before normal traffic.

## Supabase Configuration

The direct project database endpoint resolves to IPv6 and was not reachable from
the tested machine. The project-provided shared/session pooler is reachable over
IPv4 and should be used:

```text
host: aws-1-eu-central-1.pooler.supabase.com
port: 5432
database: postgres
user: postgres.pdjqncgbuclsugqbcyhe
sslmode: require
```

Set the following only in the hosting provider's runtime secret store:

```dotenv
DATABASE_URL=postgresql://postgres.pdjqncgbuclsugqbcyhe:<URL_ENCODED_PASSWORD>@aws-1-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require
JWT_SECRET=<NEW_RANDOM_SECRET>
AUTH_SECRET=<NEW_RANDOM_SECRET>
ADMIN_EMAIL=<ADMIN_EMAIL>
ADMIN_NAME=<ADMIN_NAME>
ADMIN_PASSWORD=<NEW_ADMIN_PASSWORD>
NODE_ENV=production
PORT=3000
APP_URL=https://<PUBLIC_APP_HOST>
```

`HOST` is not an application setting and should be removed. The Supabase password
must be URL-encoded; the URI copied from the Supabase Connect panel is preferred.

## Deployment Gates

Run these checks in order:

1. `GET /health` returns HTTP 200.
2. `databaseUrlSet` and `jwtSecretSet` are both `true`.
3. `envPresence.ADMIN_NAME`, `envPresence.PORT`, and `envPresence.APP_URL` are
   `true`.
4. `databaseHost` is `aws-1-eu-central-1.pooler.supabase.com`.
5. `GET /health/db` returns HTTP 200 with `ok: true`.
6. Migrations finish without a startup warning.
7. The initial admin can sign in and a protected page loads.

## Viable Online Paths

### Path A: Keep Dublyo

This path is viable only after Dublyo confirms runtime environment injection.
No repository change can safely manufacture secrets that the platform refuses to
pass to the container.

### Path B: Deploy the same Dockerfile elsewhere

Use a Docker host that supports runtime secrets, such as a managed container
service or a VPS with Docker Compose. Configure the variables above at runtime.
The existing `docker-compose.yml` already passes runtime variables and does not
require the Dublyo database.

For a self-hosted server:

```bash
docker compose build
docker compose up -d app
docker compose logs -f app
curl -fsS https://<PUBLIC_APP_HOST>/health
curl -fsS https://<PUBLIC_APP_HOST>/health/db
```

The application runs migrations automatically on startup. Watch the logs until
the migrations complete before sending normal traffic. Keep `.env` only on the
host, outside Git, with restrictive filesystem permissions.

## Scope Confirmation

No CRM business logic, Phase 2 matter/finance behavior, schema, or SQL migration
was changed by this audit. Existing uncommitted business-logic edits were left
untouched.
