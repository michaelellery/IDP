# Branch Protection Rules

Apply these settings to the `main` branch in GitHub repo settings → Branches → Branch protection rules.

## Required Settings

### 1. Require Pull Request Reviews
- **Required approving reviews:** 1 (minimum)
- **Dismiss stale pull request approvals when new commits are pushed:** ✅
- **Require review from code owners:** ✅ (when CODEOWNERS is set up)

### 2. Require Status Checks
- **Require status checks to pass before merging:** ✅
- **Required checks:**
  - `ESLint`
  - `Type Check`
  - `Unit Tests`
  - `Build Lambda Bundles`
  - `Code Quality Scan`
- **Require branches to be up to date before merging:** ✅

### 3. Restrict Direct Pushes
- **Restrict who can push to matching branches:** ✅
- No one pushes directly to `main`. Period.

### 4. Merge Strategy
- **Allow squash merging:** ✅
- **Allow merge commits:** ❌
- **Allow rebase merging:** ❌
- Squash merge keeps `main` clean with one commit per PR.

### 5. Additional
- **Require signed commits:** Recommended
- **Require linear history:** ✅
- **Do not allow bypassing the above settings:** ✅

## Applying via GitHub CLI

```bash
gh api repos/michaelellery/IDP/branches/main/protection \
  -X PUT \
  -f required_status_checks='{"strict":true,"contexts":["ESLint","Type Check","Unit Tests","Build Lambda Bundles","Code Quality Scan"]}' \
  -f enforce_admins=true \
  -f required_pull_request_reviews='{"required_approving_review_count":1,"dismiss_stale_reviews":true}' \
  -f restrictions=null
```
