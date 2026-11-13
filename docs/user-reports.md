# User reports

People can send a bug report or an idea from inside the app. Reports go to the same private repo as agent errors ([agent-errors.md](agent-errors.md)).

## What's sent

- **Kind:** bug or idea.
- **Their text:** up to 5,000 characters.
- **Screenshots:** up to 3 images (PNG, JPEG or WebP), shrunk in the browser to at most 1,600 px and about 1 MB each.
- **Context, for reports made from an agent message:** the chat, the message, and the model that wrote it. With **Include this conversation** checked (the default), the report also carries the reported message, the 4 messages before it and 1 after, plus that chat's logged errors.
- **Always:** the app version, and the reporter's username and user id.

Each person can send 10 reports per hour.

## Where it goes

1. Every report is saved on the server first: `<data>/feedback/reports.jsonl`, with screenshots in `<data>/feedback/screens/`. Admins can read them at `GET /api/admin/feedback`.
2. When `LH_ERROR_ISSUES_TOKEN` and `LH_ERROR_ISSUES_REPO` are set, the server also opens an issue in that repo:
   - Screenshots are committed to `screenshots/` in the repo and shown inline.
   - Labels: `user-report`, plus `user-bug` for bugs or `feedback` for ideas.
   - Each body starts with an `<!-- lh-report:<id> -->` marker.

Bugs (`user-bug`) are picked up by the nightly triage agent ([agent-error-triage.md](agent-error-triage.md)). Ideas (`feedback`) wait for the owner.

## Token permission

Committing screenshots needs one more permission on the fine-grained token: **Contents: Read and write** on the errors repo, in addition to **Issues: Read and write**. Without it, issues are still filed, with a note that the screenshots stayed on the server.
