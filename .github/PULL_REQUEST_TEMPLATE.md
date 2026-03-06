## Description

<!-- What does this PR do? Why is it needed? -->

## Changes

- 

## Testing Done

<!-- How did you verify this works? -->

- [ ] Unit tests added/updated
- [ ] Tested locally with sample documents
- [ ] Tested against dev environment

## Rollback Plan

<!-- If this breaks prod, how do we revert? -->

## Checklist

- [ ] **Tests added** for new/changed functionality
- [ ] **No silent catches** — all error paths log with context
- [ ] **No hardcoded secrets** — using Secrets Manager only
- [ ] **Types defined** — no `any`, interfaces for all data shapes
- [ ] **Parameterized queries** — no string concatenation in SQL/DynamoDB expressions
- [ ] **Structured logging** — using logger, not `console.log`
- [ ] **Bundle size checked** — Lambda stays under 5MB
