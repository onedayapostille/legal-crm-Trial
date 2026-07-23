# GitHub Actions and Repository Settings Guide

These are administrator instructions only. No GitHub setting or secret was
changed during this task.

## 1. Protect `main` with a repository ruleset

1. Open `onedayapostille/legal-crm-Trial`.
2. Go to **Settings → Rules → Rulesets → New ruleset → New branch ruleset**.
3. Name it `Protect main`; set **Enforcement status** to **Active**.
4. Under **Target branches**, include the default branch or pattern `main`.
5. Do not add broad bypass actors. If an emergency bypass is required, restrict
   it to the smallest administrator group and require a recorded incident.
6. Enable **Restrict deletions** and **Block force pushes**.
7. Enable **Require a pull request before merging**:
   - require at least one approval (two for security/deployment changes);
   - dismiss stale approvals when new commits are pushed;
   - require conversation resolution;
   - require approval of the most recent reviewable push where available.
8. Enable **Require status checks to pass** and require:
   - `TypeScript, unit tests, and build`
   - `Secret controls`
9. Enable **Require branches to be up to date before merging**.
10. Save, then test with a disposable feature-branch pull request.

GitHub documents the available rules—including required pull requests, required
checks, and blocked force pushes—at
<https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets>.
The checks may need to run once before they appear in the selector.

## 2. Create the production environment

1. Go to **Settings → Environments → New environment**.
2. Name it exactly `production`.
3. Under **Deployment branches and tags**, choose **Selected branches and tags**.
4. Add branch `main` only. Do not add tag or pull-request patterns.
5. If the repository plan supports required reviewers for this private
   repository, add the responsible production approvers and enable prevention of
   self-review.
6. If reviewers are unavailable, retain `workflow_dispatch` as the manual
   approval and do not add an automatic push trigger.
7. Do not allow administrators to bypass protections where the plan exposes that
   control.

As of this review, GitHub documents that required reviewers on GitHub Free, Pro,
or Team are available only for public repositories; private repositories need
the applicable Enterprise capability. Deployment branch restrictions for
private repositories are available on Pro or Team. Verify the controls shown for
this repository before relying on them:
<https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments>.

## 3. Add environment secrets

Inside **Settings → Environments → production → Environment secrets**, add:

```text
ALGHAZZAWI_SSH_HOST
ALGHAZZAWI_SSH_PORT
ALGHAZZAWI_SSH_USER
ALGHAZZAWI_SSH_PRIVATE_KEY
ALGHAZZAWI_SSH_HOST_FINGERPRINT
```

Use environment secrets, not repository variables or plaintext workflow values.
Do not add `DATABASE_URL`, `.env`, JWT/auth values, admin credentials, or any
application secret to GitHub Actions. Environment secrets are exposed only to a
job that references that environment and, when supported, only after approval.

## 4. Enable secret scanning and push protection

1. Go to **Settings → Security → Advanced Security**.
2. Under **Secret Protection**, enable secret scanning for the repository.
3. Enable **Push protection**.
4. Enable non-provider pattern detection if the plan supports it, especially
   private-key detection.
5. Keep bypass privileges minimal; require documented review of any bypass.
6. Review all existing alerts and rotate/revoke before closing an alert.

GitHub’s current push-protection behavior is documented at
<https://docs.github.com/en/code-security/concepts/secret-security/push-protection>.
Push protection requires the applicable Secret Protection feature for the
repository/organization plan.

## 5. Validate without deploying

1. Push only after Security approves handling of the already-exposed history.
2. Open a pull request from `chore/safe-cicd-setup` to `main`.
3. Confirm both required CI checks run.
4. Expect `Secret controls` to fail while leaked history remains; do not bypass
   it.
5. Confirm formatting appears as advisory rather than blocking.
6. Confirm `Deploy production (disabled pending blockers)` can be selected
   manually but its deployment job is skipped because of the literal safety
   lock.
7. Do not remove the safety lock until the implementation plan’s stop gate is
   fully approved.
