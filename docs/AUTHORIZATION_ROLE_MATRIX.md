# CRM Authorization Role Matrix

This document is the business-readable companion to the enforced policy in
`shared/policy/matrix.ts`. Server authorization is authoritative; UI visibility
uses the same capability names but is not the security boundary.

## Scope legend

| Scope | Meaning |
|---|---|
| `ALL` | Firm-wide records |
| `OWN_PRACTICE` | Records belonging to the Head of Practice's configured practice |
| `ASSIGNED` | Matters assigned to the user and their clients |
| `REGISTRY` | Client intake/registry data |
| `OWN` | Tasks assigned directly to the user |
| `NONE` | No access |

## Approved account roles

| Role | Main responsibility | May see | May change | Must not see/do |
|---|---|---|---|---|
| Admin | System owner | Everything | Everything, including users/settings | No functional restriction |
| Manager | Read-only oversight | All clients, enquiries, matters, tasks, finance, reports, rates, audit, notes, actions, payments | Nothing | No create/edit/delete/assign/export/AI |
| Head of Practice | Own-practice leadership | Firm-wide operational and financial data; all tasks and reports | Clients, matters, rates, and finance in `OWN_PRACTICE`; create/assign tasks | Cannot write outside own practice; cannot delete |
| Senior Associate | Assigned-matter lead work | `ASSIGNED` clients/matters/finance/rates; `OWN` tasks | Assigned matter details; own tasks; may assign tasks | No firm-wide finance/reports; no deletes |
| Executive Associate | Assigned-matter legal work | `ASSIGNED` clients/matters; `OWN` tasks | Assigned matter details; own tasks; may assign tasks | No base financial access; no deletes |
| Associate | Assigned-matter legal work | `ASSIGNED` clients/matters; `OWN` tasks | Assigned matter details and own tasks | No finance, task assignment, or deletes |
| Junior Lawyer | Assigned-matter legal work | `ASSIGNED` clients/matters; `OWN` tasks | Assigned matter details and own tasks | No finance, task assignment, or deletes |
| Trainee | Supervised assigned work | `ASSIGNED` clients/matters; `OWN` tasks | Assigned matter details and own tasks | Cannot lead matters, assign tasks, access finance, or delete |
| Paralegal | Registry and matter support | All clients/matters; own tasks | Client/matter details and own tasks | No record creation, finance, assignment, or deletes |
| Finance | Financial operations | All clients/matters/finance/reports/rates; own tasks | Clients, matters, financial records, reports/exports, and rates | No client/matter delete; no task assignment |
| Coordinator | Intake and coordination | Registry/intake, all matters/tasks, payment-status-only financial projection | Enquiries, registry records, matters, tasks and task assignment | No monetary values, financial writes/reports, or deletes |

## Lead Lawyer designation

Lead Lawyer is a per-matter assignment, not an account role. On that matter only,
it adds read access to the matter/client/financials/rates and permits operational
matter-detail and task updates. It never permits financial writes, practice/team
changes, or firm-wide access.

## Assignment eligibility

- Leadership fields: Head of Practice, Senior Associate, Executive Associate,
  Associate, Junior Lawyer, plus legacy Partner/Lawyer during coexistence.
- Matter-team fields: all of the above plus Trainee.
- Admin and Manager are authority roles, not lawyer positions.
- Paralegal, Finance, and Coordinator may receive tasks where their policy allows,
  but are not lawyer-field assignees.

## Legacy accounts

`partner`, `lawyer`, `staff`, and `viewer` remain valid only during migration.
They are not offered for new accounts. Shared role names (`admin`, `manager`,
`finance`) carry an explicit `authorization_model` of `legacy` or `target`, so
their meaning is never inferred from the role name alone. Role/authorization
transitions are explicit and audited.
