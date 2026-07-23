# Dedicated GitHub Actions SSH Key Setup

This key is exclusively for **GitHub Actions → production server**. Do not reuse
the Windows management key or the server’s read-only GitHub deploy key.

No key was generated, installed, or added to GitHub during this task.

## 1. Obtain approval

Security/IT must approve:

- creation and custody of the new key;
- the forced-command wrapper;
- the exact `authorized_keys` restriction;
- the narrow reload permission in `PM2_ACCESS_REQUIREMENTS.md`; and
- the GitHub administrators allowed to manage the production environment.

Stop if approval is absent.

## 2. Generate locally

On the approved administrator workstation, review and run:

```powershell
.\scripts\generate-actions-ssh-key.ps1
```

The helper creates an Ed25519 key with a dedicated comment, refuses to overwrite
an existing pair, prints only paths and the public fingerprint, and never prints
private-key content. Store the private key in the approved password vault until
it is entered directly into GitHub.

## 3. Review and install the forced command

Review `scripts/github-actions-deploy-guard.sh` together with revised server
deploy/rollback scripts. IT—not the workflow—must install the approved wrapper
at:

```text
/home/developer/alghazzawi-server-admin/scripts/github-actions-deploy-guard.sh
```

The current proposal permits only exact `deploy` and failure-triggered
`rollback` requests. It provides no shell, file transfer, forwarding, PTY, or
arbitrary command facility.

After approval, IT adds the public key to the `developer` account with a
restriction equivalent to:

```text
restrict,command="/home/developer/alghazzawi-server-admin/scripts/github-actions-deploy-guard.sh" ssh-ed25519 PUBLIC_KEY_MATERIAL github-actions-alghazzawi-production
```

On an OpenSSH version without `restrict`, explicitly use:

```text
no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding,command="/home/developer/alghazzawi-server-admin/scripts/github-actions-deploy-guard.sh" ssh-ed25519 PUBLIC_KEY_MATERIAL github-actions-alghazzawi-production
```

Never add the private key to the server. Do not enable root SSH login.

## 4. Record the host fingerprint out of band

IT obtains the active server host-key fingerprint locally on the server, for
example:

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

Transmit the `SHA256:...` fingerprint through an approved channel independent of
the SSH connection. The workflow compares this value to `ssh-keyscan` output
before creating `known_hosts`; it always uses `StrictHostKeyChecking=yes`.

## 5. Add production environment secrets

Only after approval, add these environment-level secrets to GitHub:

- `ALGHAZZAWI_SSH_HOST`
- `ALGHAZZAWI_SSH_PORT`
- `ALGHAZZAWI_SSH_USER`
- `ALGHAZZAWI_SSH_PRIVATE_KEY`
- `ALGHAZZAWI_SSH_HOST_FINGERPRINT`

The SSH user is `developer`, never `root`. Paste private-key content directly
into the GitHub secret UI; do not copy it into a ticket, report, shell history,
repository file, or workflow output.

## 6. Acceptance test before production enablement

In staging, prove:

- ordinary SSH shell and PTY requests are refused;
- port, agent, and X11 forwarding are refused;
- malformed branch, short SHA, extra arguments, and arbitrary commands fail;
- an exact main SHA can create only its own immutable release;
- unreviewed drift stops deployment;
- health failure restores the previous release;
- output contains commit IDs and statuses but no environment values; and
- the user has only the fixed reload permission.

Keep the workflow’s literal `if: false` until these tests and all other blockers
are signed off.
