Work through a GitHub issue end-to-end.

1. Run `gh issue view $ARGUMENTS` to read the full issue including comments
2. Create a branch named `issue-$ARGUMENTS-<short-kebab-description>`
3. Implement what the issue describes
4. Commit with a clear message referencing the issue
5. Push and run `gh pr create` with a body that includes "Closes #$ARGUMENTS"
