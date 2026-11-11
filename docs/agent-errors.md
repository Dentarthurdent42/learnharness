# Agent errors

The teaching agent's failures are mostly invisible in the UI: a tool call that errors back to the model shows as one "Retrying…" line. The server records every failure so a developer (or a developer agent) can see them.

## The error log

Every failure is appended to `<data>/errors/errors.jsonl` (server-wide, not per user). It rotates to `errors.1.jsonl` at 5 MB, keeping one older file.

What gets recorded:

| Kind | When |
|---|---|
| `tool_error` | A tool call returned an error result to the model (user aborts are skipped). |
| `turn_error` | An assistant message ended with `stopReason: "error"`. |
| `stream_error` | The agent loop itself threw. |
| `turn_start_failed` | The turn could not be started. |
| `job_failed` | A sub-agent (research, demo, visual, pdf) delivered a failure. |
| `extraction_failed` | The extraction pipeline threw. |

Each entry has a **fingerprint**: a hash of the kind, the tool, and the error text with quoted values, ids and numbers stripped out. The same bug in twenty chats is one fingerprint with a count of twenty.

An entry is **unrecovered** when the agent didn't work around it: the turn ended in an error, the same tool failed 3 times in a row, or it's one of the non-tool kinds.

Entries hold raw error text and tool arguments, which can include learner content. Treat the file as private.

## Reading it

`GET /api/admin/errors` (admins only) returns the log grouped by fingerprint, most recently seen first. `GET /api/admin/errors?fp=<fingerprint>` returns that group's individual occurrences.

On Fly, you can also read the file directly:

```sh
fly ssh console -C "tail -n 20 /data/errors/errors.jsonl"
```

## GitHub issues

When configured, the server opens a GitHub issue for each error fingerprint that matters, in a **private** repo. The app repo is public and entries can contain learner content, so issues never go there.

A fingerprint is filed when it has happened 3 times (in any chats), or right away when an occurrence was unrecovered. After that:

- Repeats never open a new issue. At most once an hour, the issue gets a "seen again" comment with the new count and the latest occurrence.
- If a closed issue's error comes back, the issue is reopened and labeled `regression`, but only when the server was deployed after the issue was closed. Before that, the fix simply hasn't shipped yet.
- At most 10 new issues are opened per hour.

Issues are labeled `agent-error` (plus `unrecovered` when it applies). Each body starts with an `<!-- lh-error-fp:<fingerprint> -->` marker. Which fingerprint maps to which issue is saved in `<data>/errors/issues.json`.

### Setup

1. Create a private repo, e.g. `learnharness-errors`.
2. Create a fine-grained personal access token with access to **only that repo** and the **Issues: Read and write** permission.
3. Set both as Fly secrets:
   ```sh
   fly secrets set LH_ERROR_ISSUES_REPO=<owner>/learnharness-errors LH_ERROR_ISSUES_TOKEN=<token>
   ```

With either secret unset, nothing is filed and the error log still works.
