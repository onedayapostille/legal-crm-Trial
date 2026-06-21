# Ensures the local scoop PostgreSQL is running (idempotent).
# Safe to run repeatedly and at logon: it no-ops if the DB already accepts
# connections, otherwise it clears a stale postmaster.pid and starts the server.
#
# Register as a per-user logon task (no admin required):
#   schtasks /Create /TN "LegalCRM-LocalPostgres" /SC ONLOGON /F `
#     /TR "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"<repo>\scripts\start-local-db.ps1\""

$ErrorActionPreference = 'SilentlyContinue'

$pgBin = Join-Path $env:USERPROFILE 'scoop\apps\postgresql\current\bin'
$data  = Join-Path $env:USERPROFILE 'scoop\persist\postgresql\data'

$pgIsReady = Join-Path $pgBin 'pg_isready.exe'
$pgCtl     = Join-Path $pgBin 'pg_ctl.exe'

# Already accepting connections? Nothing to do.
& $pgIsReady -h localhost -p 5432 | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Output 'Local PostgreSQL already running.'
    exit 0
}

# Remove a stale pidfile left by a crashed/stopped server, then start.
Remove-Item (Join-Path $data 'postmaster.pid') -Force -ErrorAction SilentlyContinue
& $pgCtl -D $data -l (Join-Path $data 'server.log') -w -t 30 start

# Report final state.
& $pgIsReady -h localhost -p 5432 | Out-Null
if ($LASTEXITCODE -eq 0) { Write-Output 'Local PostgreSQL started.' } else { Write-Output 'Local PostgreSQL failed to start - check server.log.' ; exit 1 }
