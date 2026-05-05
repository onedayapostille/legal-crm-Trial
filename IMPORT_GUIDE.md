# Excel → CRM Import Guide

Migrates client data from `Copy of Client_Tracker_Professional_v21.xlsx` into the CRM database.

## What gets imported

| Sheet | → Table | Records |
|---|---|---|
| Client List | `clients` | 168 clients (master records) |
| Automation | `client_matters` | ~172 matter records |
| Leads | `client_lead_details` | ~17 pipeline records |
| Rejected | `rejected_clients` | ~20 rejection records |
| Financial | `financial_records` | ~172 financial records |
| Client Action Log | `client_action_logs` | rows with action data |

## Prerequisites

1. **Database migrated** — the `0003_clients_module.sql` migration must be applied:
   ```bash
   pnpm db:migrate
   ```

2. **DATABASE_URL set** — either via `.env` file or environment:
   ```bash
   # .env
   DATABASE_URL=postgresql://user:pass@host:5432/dbname
   ```

3. **Excel file available** — place the workbook at one of:
   - `../Downloads/Copy of Client_Tracker_Professional_v21.xlsx` (default, relative to project root)
   - Any path — pass it as an argument (see below)

## Running the import

### Dry run (validate only — no DB writes)
Always run this first to check for unexpected errors:
```bash
pnpm import:clients:dry
# or with a custom path:
pnpm import:clients -- /path/to/file.xlsx --dry-run
```

### Live import
```bash
pnpm import:clients
# or with a custom path:
pnpm import:clients -- /path/to/file.xlsx
```

### Force reimport (wipe child tables and reimport)
Running the import twice is safe by default — clients are upserted by `file_number`, and child records (matters, financial, action logs) are cleared for affected clients and reinserted. No `--force` flag is needed for normal re-runs.

## Idempotency

- **`clients`** — upserted by `file_number` (unique key). Running twice updates existing records.
- **`client_lead_details`** — upserted by `client_id` (one per client).
- **`rejected_clients`** — upserted by `client_id` (one per client).
- **`client_matters`**, **`financial_records`**, **`client_action_logs`** — existing records for the affected clients are deleted and reinserted on each run. Running twice is safe.

## Expected output

```
══════════════════════════════════════════════════════
  AlGhazzawi CRM — Excel Import
  Mode   : LIVE
  Source : /path/to/Copy of Client_Tracker_Professional_v21.xlsx
══════════════════════════════════════════════════════

Step 1/6 — Importing clients from 'Client List'…
  ✓ 168 upserted, 0 skipped

Step 2/6 — Importing client matters from 'Automation'…
  ✓ 172 inserted, 8 skipped

...

══════════════════════════════════════════════════════
  IMPORT REPORT
══════════════════════════════════════════════════════
  Clients         : 168 upserted, 0 skipped
  Client Matters  : 172 inserted, 8 skipped
  Lead Details    : 17 upserted, 0 skipped
  Rejected        : 20 upserted, 0 skipped
  Financial       : 172 inserted, 8 skipped
  Action Logs     : N/A (source cells unfilled)
  Validation Errs : 12
```

## Expected validation errors (safe to ignore)

The workbook has **4 rows with broken `#REF!` formula references** (rows 111, 171, 175, 176 in the Excel). These rows appear in Automation, Financial, and Client Action Log sheets — producing 12 total errors. All are skipped automatically.

These are known broken Excel formulas in the source file — not a bug in the import.

## Verifying the import

After running, open the CRM and check:

1. **`/clients`** — should show 168+ clients with status breakdown
2. **`/clients/existing`** — existing clients with matters
3. **`/clients/leads`** — leads pipeline entries
4. **`/clients/rejected`** — rejected client records
5. **`/financial`** — financial records (requires `finance` or `admin` role)

Or query the database directly:
```sql
SELECT client_status, COUNT(*) FROM clients GROUP BY client_status;
SELECT COUNT(*) FROM client_matters;
SELECT COUNT(*) FROM financial_records;
```

## File location

```
scripts/
  import-excel.ts    ← the import script
IMPORT_GUIDE.md      ← this file
```

## Column mapping reference

### Client List → `clients`
| Excel col | DB field |
|---|---|
| Client Number | `client_number` |
| File Number | `file_number` (unique key) |
| Client Name | `client_name` |
| Client Status | `client_status` |
| City | `city` |
| Matter Type | `matter_type` |

### Automation → `client_matters`
| Excel col | DB field |
|---|---|
| Original Serial | `original_serial` |
| Matter / Reference | `matter_reference` |
| Matter Type | `matter_type` |
| Lead Partner | `lead_partner` |
| Lead Partner Full Name | `lead_partner_full_name` |
| Support Lead | `support_lead` |
| Attorney | `attorney_head` |
| Attorney Full Name | `attorney_full_name` |
| Matter Status | `matter_status` |
| Balance Work Left | `balance_work_left` |
| Achievement % | `achievement_percentage` |
| Achievement Status | `achievement_status` |
| Priority | `priority` |

### Financial → `financial_records`
| Excel col | DB field |
|---|---|
| Fee Type | `fee_type` |
| Agreed Fees | `agreed_fees` |
| Discount Approval | `discount_approval` |
| Discount % | `discount_percentage` |
| Discount Amount | `discount_amount` |
| Net Fees | `net_fees` |
| Billed Amount | `billed_amount` |
| Revenue | `revenue` |
| Collected Amount | `collected_amount` |
| Remaining Advanced | `remaining_advanced` |
| Outstanding Amount | `outstanding_amount` |
| Collection Status | `collection_status` |
| Billing Date | `billing_date` |
| Payment Date | `payment_date` |
| Invoice Number | `invoice_number` |
| Responsible Lawyer | `responsible_lawyer` |
| Finance Notes | `finance_notes` |
