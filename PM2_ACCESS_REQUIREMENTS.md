# PM2 Access Requirements

The CRM currently runs under a root-owned PM2 daemon. The deployment user must
not receive root login, an unrestricted root shell, unrestricted `sudo`, or
general permission to run the PM2 binary.

## Preferred control

IT should create one root-owned, non-writable wrapper such as:

```text
/usr/local/sbin/reload-alghazzawi-crm
```

The wrapper must:

- accept no arguments;
- set a fixed safe `PATH` and the confirmed root PM2 home;
- call the absolute PM2 binary path;
- reload only the exact confirmed CRM process name with `--update-env`;
- reject symlinked or user-writable PM2 configuration;
- write a timestamped audit log without environment values; and
- return the PM2 exit status.

After IT confirms the real process name, the only proposed sudo authorization is
equivalent to:

```text
developer ALL=(root) NOPASSWD: /usr/local/sbin/reload-alghazzawi-crm
```

Do not authorize `/usr/lib/node_modules/pm2/bin/pm2 *`, shells, editors, file
copy tools, `systemctl *`, or arbitrary environment assignments.

If IT converts the application to a dedicated root-owned systemd unit, prefer
one exact command such as:

```text
developer ALL=(root) NOPASSWD: /usr/bin/systemctl reload legal-crm.service
```

Use `restart` only if the unit cannot implement a safe reload. The unit should
run as a dedicated non-root service account; moving away from the root PM2
daemon is the preferred hardening path.

## IT validation checklist

1. Confirm the exact PM2 process name, executable path, root PM2 home, working
   directory, and environment source.
2. Confirm the deployment user cannot list or read secret environment values.
3. Install the root-owned wrapper with mode 0755 and a root-owned parent.
4. Validate the sudoers syntax with `visudo -cf` before installation.
5. Test the wrapper in staging and prove extra arguments are rejected.
6. Prove the user cannot invoke any other command through `sudo -n`.
7. Confirm rollback uses the same fixed reload operation.
8. Record the change approval and recovery procedure.

No PM2 command, sudo change, or service restart was performed during this task.
