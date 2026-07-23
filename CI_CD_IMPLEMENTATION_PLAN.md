# AlGhazzawi CRM Safe CI/CD Implementation Plan

**Status:** preparation only; production deployment is locked off  
**Repository:** `onedayapostille/legal-crm-Trial`  
**Production branch:** `main`  
**Prepared branch:** `chore/safe-cicd-setup`

No deployment, restart, production write, credential rotation, history rewrite,
symlink change, or GitHub settings change was performed.

> **Concurrent Git event:** while local validation was running, an external
> process created commit `8de6f48` and updated
> `origin/chore/safe-cicd-setup`. This audit did not run `git commit` or
> `git push`. The external commit also captured pre-existing `.gitignore` and
> `.repowise` worktree changes. The corrected database-free test allowlist and
> final report refinements remain uncommitted locally; do not deploy from
> `8de6f48`.

## Readiness summary

| Area                       | Status                                             | Evidence / remaining work                                                                                                                                                          |
| -------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI workflow                | Prepared, expected to remain red on secret history | Node 22, exact pnpm 10.4.1, ignored lifecycle scripts, typecheck, database-free tests, build, advisory Prettier, Docker assignment guard, full-history Gitleaks scan, safe reports |
| Deployment workflow        | Prepared but hard-disabled                         | Manual trigger, production environment, exact SHA and CI checks, verified host key, strict SSH, serialized deployment, HTTPS verification and rollback request                     |
| Startup migrations         | Fixed on this branch only                          | `server/_core/index.ts` no longer calls `runMigrations()`; `pnpm db:migrate` remains an explicit command                                                                           |
| Current-tip Docker secrets | Removed on this branch only                        | Runtime injection is required; exposed credentials still require rotation and history remediation                                                                                  |
| Server scripts             | Audited, changes required                          | See “Server script audit”                                                                                                                                                          |
| Release cutover            | Not started                                        | No release/shared directories or symlinks were changed                                                                                                                             |
| Production drift           | Inventoried, unresolved                            | See `PRODUCTION_DRIFT_REVIEW.md`                                                                                                                                                   |
| PM2 access                 | Unresolved                                         | IT action is described in `PM2_ACCESS_REQUIREMENTS.md`                                                                                                                             |

## Stop gate

The deployment job contains a literal `if: ${{ false }}`. Do not remove it until
all of the following are evidenced in a reviewed pull request:

- Every exposed database, JWT/auth, administrator, and NVIDIA credential has
  been rotated.
- Secret scanning no longer reports active credentials, and a separately
  approved history-remediation plan has been completed if required.
- The no-startup-migration change is merged and present in the selected release.
- The 15 modified and all production-only files have an approved disposition.
- `/var/www/legal-crm` has been frozen, backed up, and reviewed for drift.
- The release/shared/current model has completed a supervised one-time cutover.
- The guarded SSH command contract has been updated and tested in staging.
- IT has installed the dedicated public key and the narrow reload control.
- The root-owned PM2 application name and `PM2_HOME` behavior are confirmed.
- Port exposure, firewall rules, reverse-proxy routing, and ownership/modes are
  approved by IT.
- GitHub `main` rules and the `production` environment are configured.

## Server script audit

Audit date: 2026-07-23. The five scripts were read over the existing management
SSH connection. None was executed.

| Control                                   | Result                          | Notes                                                                                                                                                                                                                       |
| ----------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------------------------------------------- |
| No automatic database migrations          | Partial                         | `deploy-crm.sh` blocks a release whose startup contains `runMigrations()`. It does not directly invoke migrations. The branch removes the startup call.                                                                     |
| No secret values in scripts               | Pass                            | The scripts contain paths, URLs, names, and configuration references, but no reviewed secret values. `deploy.conf` contents were not copied.                                                                                |
| No wildcard deletion                      | Pass                            | No deletion command is present. Release cleanup is not automated.                                                                                                                                                           |
| No Git operations in `/var/www/legal-crm` | Pass                            | Git operations are confined to `/home/developer/legal-crm-source`; releases use `git archive`.                                                                                                                              |
| Separate release directory                | Pass                            | Releases target `/var/www/legal-crm-releases/<sha>`.                                                                                                                                                                        |
| Previous release retained                 | Pass                            | The prior target is recorded and the scripts do not delete it.                                                                                                                                                              |
| Health checks fail safely                 | Partial                         | `curl --fail`, timeouts, HTTPS, and `set -e` are present. JSON validation is only a substring match and should use a JSON parser and exact booleans.                                                                        |
| Preserve `.env`                           | Pass after cutover              | Release `.env` links to the shared `.env`; mode 600/640 is enforced.                                                                                                                                                        |
| Preserve uploads                          | Pass if shared directory exists | Releases link `uploads` only when the shared uploads directory exists. Make it mandatory if uploads are application data.                                                                                                   |
| Preserve persistent data and logs         | Fail / unspecified              | No shared persistent-data paths are declared and logs are not linked into releases. Inventory these before cutover.                                                                                                         |
| Backup current release                    | Partial                         | A restrictive code archive is created. Secrets, uploads, logs, SQL, ZIP files, and dependencies are intentionally excluded; separate verified backups are required for persistent data.                                     |
| Stop on live drift                        | Fail                            | `compare-production-to-github.sh` always returns success because its `diff` ends with `                                                                                                                                     |     | true`, and `deploy-crm.sh` does not call it. |
| Exact branch and commit contract          | Fail                            | The script hard-codes `main` and accepts a positional commit, but does not accept and verify the proposed `--branch main --commit <sha>` interface.                                                                         |
| CI-safe tests during release              | Fail                            | The deploy script runs the full `pnpm test` after linking production `.env`; database-backed tests could touch production data. Remove all tests from the server deploy or run only build artifacts already verified by CI. |
| Lifecycle scripts                         | Pass with operational caveat    | Install uses `--ignore-scripts`; currently ignored native build packages must be explicitly reviewed and the production build verified.                                                                                     |
| PM2 reload                                | Blocked                         | Uses passwordless sudo for the PM2 binary; no approved narrow policy exists.                                                                                                                                                |
| Deployment result record                  | Partial                         | Release paths are recorded, but the Actions contract requires value-free `DEPLOYED_COMMIT` and `PREVIOUS_COMMIT` output.                                                                                                    |

### Required guarded-command contract

The forced-command wrapper must accept only:

```text
deploy --branch main --commit <40-lowercase-hex-sha>
rollback --failed-commit <40-lowercase-hex-sha>
```

Before changing the live symlink, the guarded server path must:

1. verify the commit is the exact commit requested and is reachable from
   `origin/main`;
2. fail on any unresolved current-live drift;
3. verify the startup-migration and Docker secret-assignment guards;
4. create a new release without linking production secrets into test execution;
5. record the previous and proposed commits;
6. atomically switch only after all pre-switch checks pass;
7. reload through the IT-approved fixed command;
8. run exact HTTPS and database-readiness checks; and
9. atomically restore the previous release on any post-switch failure.

The checked-in guard is a proposal for IT review, not an installed server file.
The existing server deploy script must be revised to emit the expected commit
records before the disabled workflow can be unlocked.

## Release structure and one-time migration plan

Target:

```text
/var/www/legal-crm-releases/<commit-sha>   immutable application releases
/var/www/legal-crm-current                 symlink to one release
/var/www/legal-crm-shared/
  .env                                     mode 600 or 640
  uploads/                                 persistent user uploads
  data/                                    only confirmed persistent app data
  logs/                                    only logs required across releases
```

No part of this structure was created or switched during this task.

Supervised cutover plan:

1. Inventory ownership, modes, PM2 working directory, application-written paths,
   reverse-proxy target, open ports, and all data under `/var/www/legal-crm`.
2. Classify and resolve every drift entry; obtain business sign-off.
3. Rotate exposed credentials and place new values only in the protected runtime
   environment.
4. Take and verify independent code, upload, persistent-data, and database
   backups.
5. IT creates shared and release directories with least-privilege ownership.
6. Copy—not move—approved persistent content into shared paths and verify hashes.
7. Build a release for an exact reviewed commit without production database
   access or migrations.
8. In a change window, stop writes, take final incremental backups, create the
   current symlink, update the PM2 working directory, and reload once.
9. Run HTTPS, database-readiness, login, upload, and critical business smoke
   checks.
10. If any check fails, restore the original PM2 working directory; do not delete
    either copy.

Database schema changes are a separate change-management operation with their
own backup, approval, compatibility review, execution, and rollback plan. The
code deployment workflow never runs them.

## CI behavior

- `packageManager` declares exact pnpm `10.4.1`; CI verifies that exact version.
- Installation always uses `--frozen-lockfile --ignore-scripts`.
- `pnpm ignored-builds` records which lifecycle builds were suppressed. Nothing
  is automatically approved.
- `test:unit` is a conservative allowlist of three suites verified with no
  database: logout cookie behavior, conflict-name normalization, and safe NVIDIA
  configuration/RBAC behavior.
- `test:integration` includes every other suite and is not invoked by CI.
- No `DATABASE_URL` or production secret is supplied.
- Prettier is advisory while existing drift is remediated.
- Gitleaks scans full history and is expected to block until exposed history is
  addressed.
- Uploaded reports contain statuses, filenames, and lifecycle package names—not
  environment values, application output, or credentials.

## Remaining blockers and owner

| Blocker                  | Owner                         | Required evidence                                                                                                                                                                                                         |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential rotation      | Security/IT                   | Rotation record for every affected credential; old values revoked                                                                                                                                                         |
| Git history exposure     | Repository admin + Security   | Approved remediation approach and clean full-history scan                                                                                                                                                                 |
| Startup migration change | Engineering                   | Merged commit and test/build evidence                                                                                                                                                                                     |
| PM2 reload access        | IT                            | Root-owned fixed wrapper and exact sudoers entry                                                                                                                                                                          |
| Drift disposition        | Engineering + business owners | Signed classification and merged source decisions                                                                                                                                                                         |
| Release cutover          | IT + Engineering              | Supervised cutover record and rollback test                                                                                                                                                                               |
| Port and permissions     | IT                            | Port 5000 listens on `0.0.0.0`; restrict it to the reverse proxy. Live code is `root:developer` mode 0775, source is `developer:developer` 0755, and admin scripts are 0700. Approve least-privilege ownership and modes. |
| GitHub controls          | Repository admin              | Active main ruleset and production environment                                                                                                                                                                            |
| Server script fixes      | IT + Engineering              | Reviewed script diff and staging dry run                                                                                                                                                                                  |

## Exact next safe action

Review this branch locally, then rotate and revoke all exposed credentials under
Security/IT control. Do not push this branch while it contains references to
still-active leaked history unless Security approves that handling. After
rotation, resolve the production drift decisions and revise the guarded server
scripts in a staging copy; production remains locked.
