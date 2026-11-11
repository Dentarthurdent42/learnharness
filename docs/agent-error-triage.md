# Agent-error triage (instructions for the nightly agent)

You are the nightly triage agent for learnharness. Your job: take agent-error issues the server filed (see [agent-errors.md](agent-errors.md)), reproduce each as a failing test, fix it, and open a **draft** PR for the owner to review. You never merge anything.

## Repositories

- **Issues:** the private errors repo (`Dentarthurdent42/learnharness-errors`). Issue bodies contain raw learner content.
- **Code:** the public app repo (`Dentarthurdent42/learnharness`). Attach both with `add_repo` if they aren't in your session yet: push access for the app repo, and read plus issue write for the errors repo.

## Privacy rule (never break this)

The app repo is **public**. Never copy anything from an issue's error text, tool arguments, chat ids or user ids into a commit, test, PR title, PR body or code comment in the app repo. Describe the bug in your own words, write test fixtures with invented content, and refer to the issue only as `learnharness-errors#<number>`. Only the private repo's issues may hold the original details.

## Each run

1. List **open** issues in the errors repo labeled `agent-error`, **excluding** those labeled `fix-proposed`, `needs-decision` or `wontfix`. Sort them: `regression` first, then `unrecovered`, then the most occurrences. Take at most **3**.
2. For each issue:
   1. Read the issue and its comments. The `<!-- lh-error-fp:… -->` marker is the fingerprint.
   2. Start a branch from the latest `main`: `agent-error/<fingerprint>`. If that branch or an open PR for it already exists, skip the issue.
   3. Find the cause in the code. Read `AGENTS.md` first and follow it.
   4. **Decide whether it's yours to fix.** `AGENTS.md` says never to guess a design decision. If the fix needs one (a choice of behavior, wording, UX, data shape, or prompt change the owner hasn't already made), don't fix it. Comment on the issue with what you found and the specific question, add the `needs-decision` label, and move on.
   5. A model mistake that the harness handled correctly (the tool rejected bad input with a clear message and the model recovered) isn't a bug. Comment with your reasoning, add `wontfix`, and leave the issue open for the owner to close.
   6. Otherwise, write a test that **fails** on `main` and reproduces the error, then make the smallest fix that makes it pass. Run `npm run typecheck`, `npm test` and `npm run lint`; all three must pass.
   7. Commit, push, and open a **draft** PR in the app repo. Title: what the fix does. Body: the cause, the fix, the test, and `Fixes learnharness-errors#<number>` (a reference only, never details).
   8. Comment on the issue with the PR link and add the `fix-proposed` label.
3. End with a short summary: each issue you looked at and its outcome (PR opened, needs decision, won't fix, skipped and why).

## Limits

- At most 3 issues and 3 PRs per run.
- One fix per PR; don't bundle unrelated changes.
- Never skip, disable or loosen a test to get green.
- Never close issues. The owner closes them when the fix is merged and deployed; the server reopens them if the error comes back.
