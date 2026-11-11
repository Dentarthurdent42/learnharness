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
