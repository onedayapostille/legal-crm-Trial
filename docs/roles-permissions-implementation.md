# Roles & Permissions Implementation

Implements the approved **AGP_CRM_Roles_Permissions_Specification v1.1** (14 July 2026,
BR‑01…BR‑15) and the companion **AGP_CRM_Roles_Permissions_Matrix** workbook.

Source-of-truth order applied: BR‑01…BR‑15 → Excel capability rows → role authority
summaries → existing CRM behavior only where it does not conflict. Conflicts were
resolved by **least privilege** and are documented in [Known specification
conflicts & ambiguities](#known-specification-conflicts--ambiguities).

---

## Canonical account roles

The persistent account roles (the only values assignable in User Management —
`users.create` / `users.update` validate against exactly this set):

| Slug | Label | One-line authority |
|------|-------|--------------------|
| `admin` | Admin | Unrestricted, incl. User Management & System Settings |
| `manager` | Manager | Strictly read-only oversight of everything (BR‑08) |
| `head_of_practice` | Head of Practice | Views all; creates/edits clients, matters, financials **within own practice** (BR‑02) |
| `senior_associate` | Senior Associate | Assigned matters + their clients; assigned-matter financials **read-only** (BR‑04); own tasks; may assign tasks |
| `executive_associate` | Executive Associate | Assigned matters + clients; **no financial visibility** (BR‑05); own tasks; may assign tasks |
| `associate` | Associate | Assigned matters + clients; no financials; own tasks only |
| `junior_lawyer` | Junior Lawyer | Same base profile as Associate |
| `trainee` | Trainee | Same base profile as Associate; **not Lead-Lawyer-eligible** (see conflicts) |
| `paralegal` | Paralegal | Views/edits **existing** clients; views/edits all matters (details only); no financials; own tasks (BR‑11) |
| `finance` | Finance | Full clients/matters/financials access; views reports; own tasks, cannot assign (BR‑12) |
| `coordinator` | Coordinator | Intake/registry: manages enquiries (BR‑15), leads & existing clients + their matters (BR‑13); financials firm-wide **read-only** (BR‑07); all tasks; may assign |

**Legacy roles** (`partner`, `lawyer`, `staff`, `viewer`) remain in the pg enum —
enum values are never dropped — but are **not assignable**:

- `partner` → data-migrated to `head_of_practice` (approved mapping); the policy
  layer also aliases any remaining `partner` row to `head_of_practice`.
- `staff` → data-migrated to `coordinator`; aliased likewise.
- `lawyer` → **not auto-migrated** (each account needs an explicit HR grade).
  Until re-graded, a `lawyer` account behaves as the least-privilege lawyer
  baseline (= `associate` profile). `scripts/role-migration-report.ts` lists every
  such account.
- `viewer` → not part of the approved role set; **no capabilities** until an
  admin assigns a canonical role (also listed by the report script).

`lead_lawyer` is **NOT** a role anywhere — not in the enum, not in the dropdown.

## Lead Lawyer overlay (per-matter designation)

Carried by the pre-existing `client_matters.lead_lawyer_id → users.id` FK (reused,
no duplicate field). Additive on top of the base role, for the led matter only
(BR‑03):

- view the matter and edit its permitted details (already granted by ASSIGNED scope —
  the lead is one of the team FK columns);
- view the client the matter belongs to;
- view the matter's financial records **read-only** (BR‑04) — this is the overlay's
  main additive effect for grades with no base financial visibility (e.g. an
  Executive Associate designated Lead Lawyer sees that matter's financials only);
- view/update **all** tasks of that matter and assign them to others;
- **never** create/edit/delete financial records through the overlay (BR‑06);
- never any firm-wide widening.

Designation eligibility (`LEAD_LAWYER_ELIGIBLE_ROLES`): `head_of_practice`,
`senior_associate`, `executive_associate`, `associate`, `junior_lawyer`
(+ legacy `partner`/`lawyer` for un-migrated accounts). **Trainee is excluded** —
see conflicts. The overlay is honored only for eligible roles: a designation held
by a since-demoted trainee confers nothing until the designation is moved.

Changing the designation (`clientMatters.reassignLeadLawyer`, or `leadLawyerId`
in a matter update) requires `matters.assignTeam` (Admin firm-wide, Head of
Practice within own practice).

## Scopes

`shared/permissions.ts` — `Scope`:

| Scope | Meaning |
|-------|---------|
| `ALL` | Firm-wide records of the resource type |
| `OWN_PRACTICE` | Records whose responsible Head of Practice is the user, resolved via `practice_heads` (city + matter type, BR‑01) |
| `ASSIGNED` | Matters where the user is Lead Lawyer or on the matter team (authoritative FK columns `lead_lawyer_id`, `support_lead_id`, `attorney_head_id`, `attorney_1_id..attorney_4_id`), plus the clients those matters belong to |
| `REGISTRY` | The client registry lists (existing / leads / rejected); does not itself grant matter or financial authority |
| `OWN` | Records assigned directly to the user (tasks: assignee or creator) |
| `NONE` | No access |

Assignment is **never** resolved from free-text name mirrors — only user-id FKs.

## Capabilities

`shared/permissions.ts` — `Capability` (the matrix maps capability × role → scope):

`clients.view/create/edit/delete` · `matters.view/create/edit/assignTeam/delete` ·
`financial.view/create/edit/delete` · `financialReports.view` ·
`enquiries.view/manage/delete` · `tasks.view/update/assign/delete` ·
`dashboard.view` · `users.manage` · `settings.manage` · `ai.use` · `import.clients`

Notes:

- **`matters.assignTeam`** is the separate authority for authorization-defining
  matter fields (lead lawyer, all team FKs, client link, matter type). "Edit
  matter details" never includes those. Only Admin (ALL) and Head of Practice
  (OWN_PRACTICE, both old and new state inside the practice) hold it. Creators
  may set the *initial* team when creating a matter.
- **Delete capabilities** were not invented — they follow the Excel F-codes and
  the pre-existing surface: Admin holds delete on clients/matters/tasks/enquiries/
  action-logs; financial deletes (incl. rate rows) are Admin + Finance
  (`financial:manage` was already exactly that pair). Several previously broad
  delete grants (e.g. manager/lawyer/staff deleting clients, any user deleting any
  note) were **tightened**.
- `ai.use` / `import.clients` cover pre-existing modules: AI stays with the roles
  that had it (data scoped by capability inside `server/aiAnalytics.ts` — financial
  sections require `financial.view = ALL`); bulk import (writes firm-wide client
  data) is Admin + Finance.

## Practice ownership (BR‑01)

New table **`practice_heads`** (`0024`): `(city, matter_type) → head_of_practice_id`,
`UNIQUE (city, matter_type)`, admin-managed via the `practices.*` router
(list/set/remove; `set` validates an active Head-of-Practice user). Resolution:

- Client → (`clients.city`, `clients.matter_type`).
- Matter → client city + **effective matter type** (the matter's own
  `matter_type` when it is a supported value, else the client's — legacy varchar
  tolerance).
- Financial record → its client (+ matter's effective type when matter-linked).
- **Null-safe transitional behavior:** an unmapped (city, type) combination —
  or missing city/type — belongs to *no* practice, so no HoP gains edit rights
  over it (least privilege). Nothing was backfilled.
- The `financialReports.byHeadOfPractice` dimension (previously
  `configured: false`) now resolves through this map; unmapped records group as
  "Unassigned practice".
- The legacy standalone `matters` table has no city/type: it resolves to no
  practice (HoP can view via ALL but not create/edit legacy matters).

## Migration notes

- `0023_rbac_roles.sql` — `ALTER TYPE user_role ADD VALUE IF NOT EXISTS` for the 8
  new roles. Separate file because new enum values cannot be used in the same
  transaction that adds them.
- `0024_rbac_practices_and_remap.sql` — creates `practice_heads` (+ index), writes
  `role_changed` audit rows, then applies the **approved** remaps
  `partner → head_of_practice` and `staff → coordinator`, and sets the column
  default to the least-privilege `trainee`.
- **No enum value, column, or table is dropped.** Nothing destructive; both
  migrations are idempotent (`IF NOT EXISTS`, re-runnable UPDATEs).
- `lawyer` and `viewer` rows are intentionally untouched;
  `scripts/role-migration-report.ts` (read-only) prints the accounts an admin must
  re-grade, plus drift detection for any surviving partner/staff rows.

## Server enforcement rules

- The acting user always comes from the session (`ctx.user`, re-read from the DB
  per request). No role/user/scope/ownership value from request input is ever
  trusted; assignee/lawyer ids are validated (exists + active + role-eligible,
  change-only preservation for historical assignments).
- Gates: `capabilityProcedure(cap)` / `anyCapabilityProcedure([...])`
  (`server/_core/trpc.ts`) resolve the caller's scope from the central matrix;
  `adminProcedure` remains for user management/settings/AI audit.
  `capabilityProcedure(cap, { allowLeadLawyerOverlay: true })` admits
  overlay-eligible lawyers to financial **read** endpoints; row filters then
  restrict them to led matters.
- Row filters are compiled into SQL (`server/authorization.ts`:
  `clientScopeCondition`, `matterScopeCondition`, `financialViewCondition`,
  `taskScopeCondition`, `matterTeamCondition`, practice EXISTS conditions) and
  applied inside `server/db.ts` list/aggregate queries — lists never over-fetch
  and filter client-side.
- Record-level checks re-fetch the authoritative row before mutating
  (`assertCanEditClient`, `assertCanEditClientMatter`,
  `assertCanCreate/MutateFinancialRecord`, `assertTaskVisible`,
  `assertTaskAssignmentAllowed`, `assertCanLogClientAction`, …). Records outside
  the caller's *view* scope yield `NOT_FOUND`/`null` (no existence leak);
  visible-but-not-editable yields `FORBIDDEN`.
- Field-level authorization: matter scope-defining fields
  (`leadLawyerId`, team FKs, `clientId`, `matterType`), client practice fields
  (`city`, `matterType`) and financial link fields (`clientId`, `clientMatterId`)
  are guarded separately; OWN_PRACTICE editors must keep **both the current and
  resulting state** inside their practice (no pulling records in, no pushing them
  out).
- Aggregates/exports/secondary endpoints are scoped: dashboard KPIs, client
  status counts, conversion metrics, recent leads/activity, financial
  summary/to-be-billed, financial reports + CSV export
  (`financialReports.view`), audit histories (entity-scoped), notes (entity
  access + private-note author-only), companies/chat (enquiry-capability gated),
  payments (firm-wide financial visibility; writes admin/finance — fixes the
  pre-existing view-permission-gates-write bug), `users.activityStats`
  (self/admin), lawyer directories (matter viewers), task-assignee directory
  (assign-capable roles only), conflict search (client/matter creators).
- Existing safeguards preserved: last-admin protection, self-demote/self-delete
  guards, `role_changed`/`password_reset`/`status_changed` audit logging,
  Rejected-client write lock (incl. the approved reactivation path), change-only
  assignment validation, matter–client link validation (CRM‑010).

## Frontend

- `client/src/hooks/usePermissions.ts` wraps `can()`/`scopeFor()` around the
  authenticated user; `client/src/components/AccessDenied.tsx` is the shared
  Forbidden state; `ProtectedRoute` takes `capability` / `anyCapability`.
  Navigation (`DashboardLayout`) and all routes (`App.tsx`) are gated by
  capabilities; registry lists (Leads Pipeline / Rejected) are hidden from
  ASSIGNED-scope lawyers whose scoped list is always empty.
- Manager renders read-only everywhere (no create/edit/delete affordances);
  financial modules are hidden for no-visibility roles; Senior Associate /
  Coordinator / overlay Lead Lawyers see financials read-only.
- Per-record authority is **server-computed**, not duplicated client-side:
  client rows/detail carry `viewerCanEdit`; matter rows carry
  `viewerCanEdit`/`viewerIsLeadLawyer` — this is how a Head of Practice sees all
  records but edit actions only on own-practice ones.
- The frontend is explicitly *not* the security boundary — every rule is
  enforced server-side.

## User Management

- Role dropdown shows exactly the 11 canonical roles with labels + concise
  descriptions (`ACCOUNT_ROLE_LABELS` / `ACCOUNT_ROLE_DESCRIPTIONS`). No
  Lead Lawyer entry. Editing an account that still holds a legacy role forces the
  admin to pick a canonical role before saving (nothing is silently remapped).
- Server inputs (`users.create`/`users.update`/`users.updateRole`) validate
  `z.enum(ACCOUNT_ROLES)`.
- "Reports To" now targets Heads of Practice and appears for lawyer grades below
  HoP (informational hierarchy; task visibility no longer depends on it).
- User Management remains Admin-only at UI and server levels.

## Known specification conflicts & ambiguities

Resolved by least privilege; revisit with the business owner as needed:

1. **Trainee Lead-Lawyer eligibility (documented conflict).** DOCX §2: "any
   lawyer of any grade"; XLSX Position Mapping: "Head of Practice, Senior,
   Executive, Associate, or Junior" — Trainee omitted. → Trainee is **not**
   eligible and the overlay is not honored for the trainee role.
2. **Paralegal "views and edits all existing clients".** Interpreted as edit
   rights over *Existing Client* records only — no create, no general edit over
   Leads/Rejected.
3. **ASSIGNED client scope is strictly matters-derived.** Lead-clients assigned
   to a lawyer via `client_lead_details.assigned_lawyer_id` are **no longer
   visible** to lawyer grades (intake is Coordinator/HoP/Admin territory in the
   new model). The assignment field itself is preserved.
4. **Client-level financial records** (no matter link) are visible only to
   firm-wide financial viewers — BR‑04/BR‑05 tie assigned/lead visibility to "the
   financial records of their assigned matters".
5. **Team assignment by Finance/Coordinator.** Both may *create* matters (incl.
   initial team); *changing* team/lead/type afterwards requires
   `matters.assignTeam` (Admin/HoP) — "edit … including their matters" was not
   read as re-staffing authority.
6. **Payments (legacy lead-linked table)** carry no matter/practice resolution:
   reads need firm-wide financial visibility; writes are Admin/Finance. HoP
   own-practice writes cannot be resolved for lead-level rows → excluded.
7. **Task deletion** is Admin-only (matrix codes tasks as E, Full only for
   Admin) — previously any task-visible manage-role could delete.
8. **Legacy `viewer`** gets no capabilities (the approved role set has no viewer);
   accounts are flagged for reassignment rather than silently mapped.
9. **Hourly-rate rows** are treated as financial data (rates are money):
   view = financial visibility (overlay-aware per matter), mutations =
   financial create/edit, delete = Admin/Finance.
10. **AI assistant financial sections** require `financial.view = ALL` — a Senior
    Associate's ASSIGNED financial scope does not unlock firm-wide AI financial
    aggregates.

## Test coverage

- `server/permissionsMatrix.test.ts` (pure): full 11-role × capability matrix
  against a transcription of the approved matrix; Manager read-only sweep; legacy
  aliasing (partner/staff/lawyer/viewer); Lead-Lawyer eligibility incl. the
  Trainee conflict; paralegal existing-only rule; unknown-role denial.
- `server/rbacEnforcement.test.ts` (DB integration): two practices (Riyadh/
  Litigation vs Jeddah/Corporate) with real user-FK teams; Manager mutation
  rejection across modules; HoP practice bounds (edit in/out, create in/out,
  move-out attempts on city/matter-type, team changes, lead reassignment);
  Senior/Executive/Associate assigned scopes; Executive-Associate-as-Lead-Lawyer
  financial visibility (and its absence without the designation); overlay task
  visibility; matter-team privilege-escalation attempts; task-assignment rights
  (BR‑10) incl. Finance/Paralegal denial and Coordinator/Senior grant; Coordinator
  read-only financials + enquiry management + no reports; Finance full financials
  + no enquiries; Trainee designation rejection; canonical-role-only user
  management; legacy-lawyer baseline (no silent migration); scoped aggregates
  (financial summary, status counts); IDOR probes (get/update of unrelated
  records); audit-history scoping; payments visibility.
- Updated for the spec: `taskVisibility.test.ts` (HoP sees all tasks; task delete
  admin-only), `financialReports.test.ts` (byHeadOfPractice now configured),
  `aiAssistant.test.ts` (HoP gets financial sections; lawyer grades do not), and
  legacy-role fixtures across test files moved to canonical roles.
