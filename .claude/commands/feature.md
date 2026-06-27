Create a feature branch, implement the described feature, and raise a PR.

Steps:
1. Run `gh repo view --json nameWithOwner` to confirm the repo
2. Create a branch: `git checkout -b feature/<kebab-case-summary-of-$ARGUMENTS>`
3. Implement the feature described in: $ARGUMENTS
4. Commit with a clear message
5. Push the branch and run `gh pr create` with a summary and test plan in the body
