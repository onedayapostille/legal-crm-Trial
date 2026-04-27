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

## Local Development

```bash
pnpm install
cp .env.example .env
pnpm db:migrate
pnpm db:seed
pnpm dev
```

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
