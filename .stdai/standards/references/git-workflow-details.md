---
type: references
name: git-workflow-details
description: DCO sign-off mechanics for this repo, the one allowed rebase exception on an unreviewed personal pull request branch, and the commands to run before opening a pull request
---

# Git Workflow Details

These are the mechanical details of the XID git workflow, moved out of the `git-commit` rule so the
always-loaded rules stay small. Read it when a commit is rejected for a missing sign-off, when you
need the exact `git commit -s` / `git rebase --signoff` invocation, when you think you have a case
for rebasing a branch, or before opening a pull request. The `git-commit` rule keeps the binding
constraints (message format, secrets, never rewrite pushed history) and points here.

## DCO sign-off (mandatory)

This project uses the Developer Certificate of Origin 1.1 instead of a CLA. Every commit MUST carry
a `Signed-off-by` trailer:

```bash
git commit -s -m "fix(protocol): reject plain PKCE challenge at token endpoint"
```

The trailer is built from the configured `user.name` and `user.email`, and both MUST match the
commit author. Pull requests with unsigned commits are blocked until amended. Full terms are in
`CONTRIBUTING.md`.

## The one rebase exception

The `git-commit` rule forbids rewriting pushed history. There is exactly one carve-out, and this is
its full text:

- One exception: a pull request branch that is solely yours, has not been reviewed, and carries no
  other contributor's commits may be rebased once with `git rebase --signoff <base>` to add missing
  DCO trailers. Once review has started, add commits instead.

## Before opening a pull request

Run `pnpm run check` and `pnpm test` locally, then fill in the pull request template. CI runs the
same two commands and must be green before review.
