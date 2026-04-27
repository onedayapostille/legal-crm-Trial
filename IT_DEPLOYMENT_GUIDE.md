# IT Deployment Guide

## AlGhazzawi Hosting Checklist

Set these environment variables on the server:

```bash
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/legal_crm?sslmode=require
JWT_SECRET=<long-random-secret>
APP_URL=https://crm.alghazzawi.com
API_BASE_URL=
NODE_ENV=production
PORT=3000
```

For the first deployment only, also set:

```bash
ADMIN_EMAIL=<initial-admin-email>
ADMIN_PASSWORD=<strong-temporary-password>
ADMIN_NAME="System Administrator"
```

Run:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate
pnpm db:seed
pnpm start
```

After the first admin signs in, create real team users in `/user-management`. You may remove `ADMIN_PASSWORD` from the hosting environment after seeding.

## Domain Changes

Moving from a preview domain to the AlGhazzawi domain should require environment changes only:

- Set `APP_URL` to the public CRM URL.
- Leave `API_BASE_URL` blank when API and frontend are served by the same Express app.
- Set `API_BASE_URL=https://api.example.com` only if the frontend and API are split across domains.
- Ensure the reverse proxy forwards `X-Forwarded-Proto: https` so secure cookies are set correctly.

## Reverse Proxy

Recommended proxy behavior:

- Terminate TLS at the proxy or load balancer.
- Forward requests to the Node process on `PORT`.
- Preserve `Host`.
- Send `X-Forwarded-Proto`.
- Route all non-API paths to the Node app; the app serves SPA fallback for refresh-safe routes.

## Database

The application uses PostgreSQL and Drizzle migrations in `drizzle/migrations`.

Important user table requirements:

- `email` is unique.
- `password_hash` stores the salted hash.
- `role` uses `admin`, `manager`, `lawyer`, `staff`, or `viewer`.
- `status` uses `active`, `inactive`, or `suspended`.

## Security Operations

- Use a long random `JWT_SECRET`.
- Do not commit `.env` files.
- Rotate the initial admin password after first login.
- Keep at least two active admins for operational continuity.
- Use HTTPS in production.
- Back up PostgreSQL before running migrations on an existing deployment.
