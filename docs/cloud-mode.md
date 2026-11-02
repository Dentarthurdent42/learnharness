# Cloud mode (multi-user)

`LH_MODE=cloud` turns one LearnHarness server into a shared, multi-user service: accounts, invite links, a per-user data directory, and the admin's API keys shared by everyone. Without it (the desktop app, `npm run dev`) nothing changes: one user, no login, own keys.

To deploy it, see [deploy-fly.md](deploy-fly.md).

## Configuration

| Variable | Purpose |
|---|---|
| `LH_MODE=cloud` | Turns cloud mode on. |
| `LH_DATA_DIR` | Root for all data (a persistent volume in production). |
| `LH_AUTH_FILE` | The shared API-key store the admin edits in Settings → Keys. Real environment variables (e.g. Fly secrets) still win over it. |
| `LH_ADMIN_USERNAME`, `LH_ADMIN_PASSWORD` | Creates the first admin on first boot, when no accounts exist yet. Ignored once any account exists. |

## Data layout

```
<LH_DATA_DIR>/
  accounts/            users.json, sessions.json, links.json  (server-wide)
  users/<userId>/      chats/, graph/, jobs/, settings.json, prompts/
                       (the desktop layout, one copy per user)
```

Passwords are stored as scrypt hashes. Session and link tokens are stored only as SHA-256 digests.

## How isolation works

- **Request scope.** Every `/api` route is wrapped in `withUser` (`src/server/auth.ts`), and every data-reading page in `asPageUser` (`lib/page-auth.ts`). The session cookie resolves to an account, and the handler runs inside `runAsUser` (`tenancy.ts`, an `AsyncLocalStorage`). Background work started by the request (turns, jobs, extraction) inherits the scope.
- **Paths.** The data paths in `config.ts` are getters resolved per call against the current user. **Reading one outside a user scope throws**, so a missed propagation is an error, never a shared directory.
- **In-memory registries.** Turn runs, liveness, compaction, extraction runs, job aborts and the wake pipeline are keyed per user through `ScopedMap`. The event bus tags each event with its emitting user, and `/api/events` delivers only the viewer's own events.
- **Agent sandboxing.** The learner-filesystem tools (`read`, `ls`, `find`, `grep`) and the `pdf` job read local paths, so cloud mode drops them. `web_fetch` and `web_fetch_pdf` refuse non-public destinations: the literal host, the socket's DNS answer, and every redirect hop are all checked (`src/agent/tools/net-guard.ts`). Headless Chrome pages (agent-built demos and figures) may load only public web addresses and their own job's files.

## Accounts

- **Invite links.** Admins create them on the Accounts page (`/admin`). They're single-use and expire after 7 days. A person picks their own username and password.
- **Password resets.** Admins create a reset link per account, single-use, valid for 24 hours. Redeeming it ends every other session for that account. There is no email sending.
- **Disabling an account** ends its sessions. An admin can't disable themselves.
- **Logins** last 30 days and are renewed when used. After 10 failed attempts in 15 minutes, that username is blocked for 15 minutes.
- **Usernames** are 3–32 characters (letters, numbers, `. _ -`) and case-insensitive. Passwords need at least 10 characters.
- **Keys.** Only the admin can change API keys. Other users see which providers have a key, never the values, and pick their own models from those providers.
