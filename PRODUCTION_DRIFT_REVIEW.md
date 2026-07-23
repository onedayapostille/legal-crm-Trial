# Production Drift Review

**Method:** read-only recursive comparison between
`/home/developer/legal-crm-source` and `/var/www/legal-crm` on 2026-07-23.
The prepared comparison script itself was inspected but not executed. No file
was copied, overwritten, moved, or deleted.

## Decision

Deployment must remain disabled. The live tree has 15 modified files and four
production-only entries in the reviewed comparison. GitHub/source-only files
also exist and are evidence that the live directory is a stale, manually
modified checkout—not a release artifact.

## Fifteen modified files

| File | Classification | Finding | Required decision |
|---|---|---|---|
| `Dockerfile` | Security-sensitive; Must merge into GitHub | Both compared revisions predate this branch’s remediation and contain unsafe runtime-secret workarounds. This branch removes secret assignments. | Rotate credentials, merge the value-free Dockerfile, and remediate history before release. Never copy the live version. |
| `FINANCIAL_FORMULAS.md` | Requires business confirmation | Live is materially shorter (8 additions/17 removals relative to source). | Finance owner must confirm GitHub is authoritative or identify non-secret live wording to merge. |
| `README.md` | Obsolete; Requires business confirmation | Live is substantially shorter (5 additions/102 removals relative to source). | Treat GitHub as presumptive source; documentation owner confirms no unique operational instruction is lost. |
| `docker-compose.yml` | Security-sensitive; Obsolete | Live embeds credentials and admin bootstrap values; GitHub uses runtime references. | Never merge live values. Rotate every affected value and retain the value-free GitHub structure. |
| `package.json` | Must merge into GitHub | Live lacks newer dependencies, tests, and tooling declared in source. | Use reviewed GitHub package metadata; do not hand-merge from live. |
| `pnpm-lock.yaml` | Must merge into GitHub | Lockfile follows the package metadata drift. | Regenerate only through reviewed dependency changes; use frozen install in CI/release. |
| `server/clientTasks.test.ts` | Obsolete live test copy | Live and source tests differ. Tests are not production runtime data. | Keep reviewed GitHub test; never preserve live test drift as runtime state. |
| `server/conflictCheck.test.ts` | Obsolete live test copy | Live and source tests differ. | Keep reviewed GitHub test. |
| `server/conversionRate.test.ts` | Obsolete live test copy | Large test drift; source contains substantially more coverage. | Keep reviewed GitHub test and run database-backed cases only in an isolated integration environment. |
| `server/enquiryDatetime.test.ts` | Obsolete live test copy | Small test drift. | Keep reviewed GitHub test. |
| `server/financialRevenue.test.ts` | Obsolete live test copy | Live lacks source coverage. | Keep reviewed GitHub test; finance owner reviews behavior separately from live test files. |
| `server/originalSerial.test.ts` | Obsolete live test copy | Live lacks source coverage. | Keep reviewed GitHub test. |
| `server/recentLeads.test.ts` | Obsolete live test copy | Large test drift; live lacks source coverage. | Keep reviewed GitHub test. |
| `server/taskVisibility.test.ts` | Obsolete live test copy | Test drift exists. | Keep reviewed GitHub test. |
| `vite.config.ts` | Security-sensitive; Obsolete | Live uses `allowedHosts: true`; GitHub has an allowlist. | Keep/review the restricted GitHub configuration. Confirm the exact production host is on the allowlist. |

## Production-only entries

| File | Classification | Finding | Required decision |
|---|---|---|---|
| `.replit` | Obsolete; Requires business confirmation | Platform-specific source/config file not present in GitHub. | Confirm Replit is no longer an approved production mechanism, then exclude it from releases. |
| `audit-deliverables/~$gal_CRM_Implementation_Audit_CRM001_CRM020.docx` | Generated/runtime only | Office temporary lock file. | Do not merge or preserve as application state; remove only during an approved cleanup. |
| `client/src/pages/KPIDashboard.tsx` | Obsolete; Requires business confirmation | Zero-byte placeholder; historical non-empty versions exist in Git. | Confirm the current dashboard supersedes this route, then omit it. Do not overwrite GitHub with an empty file. |
| `client/src/pages/PipelineForecast.tsx` | Obsolete; Requires business confirmation | Zero-byte placeholder; a historical non-empty version exists in Git. | Confirm the feature was intentionally retired or incorporated elsewhere, then omit it. |

## Specifically requested related files

- `docker-compose.local.yml` showed no live/source difference in the reviewed
  comparison. It is local-development infrastructure and must never supply a
  production database.
- `KPIDashboard.tsx` and `PipelineForecast.tsx` are empty live placeholders, not
  recoverable production-only source implementations.
- Package and lockfile must move as one reviewed change.
- The live Compose and Vite settings are less secure than the reviewed source
  direction and must not be treated as production truth.

## Source-only evidence

The comparison also found source-only configuration, documentation, scripts, and
tests, including `.mcp.json`, `docs/`, two scripts, and several newer tests.
These are further evidence that `/var/www/legal-crm` must not be updated in
place. An immutable exact-SHA release should be created only after drift
resolution.

## Drift gate required before deployment

`compare-production-to-github.sh` currently reports differences but always exits
success. A reviewed replacement must emit a machine-readable manifest, compare
against an approved baseline, and exit nonzero for every unapproved difference.
It must exclude only explicitly catalogued runtime paths. The deploy script must
call that gate before backup, release creation, or symlink switching.
