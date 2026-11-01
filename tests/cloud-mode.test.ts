/**
 * Cloud mode (LH_MODE=cloud, 2026-11): the multi-user seams.
 *
 *  - tenancy: each user's records land in their own directory; a data
 *    path read outside any user scope THROWS (fail closed); the in-memory
 *    registries and the event bus never cross users.
 *  - accounts: scrypt passwords, hashed session/link tokens, single-use
 *    expiring links, disable ends sessions.
 *  - the auth gate: 401 signed out, 403 for non-admins on admin routes and
 *    for cross-origin writes, the handler runs in the caller's scope.
 *  - the login throttle and the first-admin bootstrap.
 *  - agent sandboxing: no learner-filesystem tools, no pdf job, and
 *    agent fetches refuse non-public destinations.
 *
 * CLOUD_MODE and the data root are read at MODULE LOAD, so the env is set
 * before the first (dynamic) import in this process — node --test runs
 * each file in its own process.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cloud-"));
process.env.LH_MODE = "cloud";
process.env.LH_DATA_DIR = TMP;
process.env.LH_ADMIN_USERNAME = "Root.Admin";
process.env.LH_ADMIN_PASSWORD = "correct horse battery";

const tenancy = await import("../tenancy.ts");
const { PATHS, settingsFile } = await import("../config.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { subscribe, emit } = await import("../src/core/events.ts");
const accounts = await import("../src/store/accounts.ts");
const auth = await import("../src/server/auth.ts");
const { isTurnRunning, beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
const { learnerFsTools, localFileToolsEnabled } = await import("../src/agent/tools/fs-shared.ts");
const { jobTools } = await import("../src/agent/tools/jobs.ts");
const netGuard = await import("../src/agent/tools/net-guard.ts");

const alice = { userId: "u_alice", username: "alice", role: "user" as const };
const bob = { userId: "u_bob", username: "bob", role: "user" as const };

describe("tenancy: per-user data", () => {
	it("is on", () => assert.equal(tenancy.CLOUD_MODE, true));

	it("resolves every data path under the current user's directory", () => {
		tenancy.runAsUser(alice, () => {
			assert.equal(PATHS.data, path.join(TMP, "users", "u_alice"));
			assert.equal(PATHS.chats, path.join(TMP, "users", "u_alice", "chats"));
			assert.equal(settingsFile(), path.join(TMP, "users", "u_alice", "settings.json"));
		});
	});

	it("keeps one user's chats invisible to another", () => {
		const id = tenancy.runAsUser(alice, () => chatStore.createChat("alice's lesson").id);
		tenancy.runAsUser(alice, () => assert.equal(chatStore.getChat(id)?.title, "alice's lesson"));
		tenancy.runAsUser(bob, () => {
			assert.equal(chatStore.getChat(id), null, "bob can't read alice's chat by id");
			assert.equal(chatStore.listChats().length, 0, "bob's list is empty");
		});
	});

	it("fails closed: a data path outside any user scope throws", () => {
		assert.throws(() => PATHS.chats, /outside a user scope/);
		// Stores that swallow fs errors degrade to "nothing" — never to a
		// shared directory.
		assert.deepEqual(chatStore.listChats(), []);
		assert.equal(fs.existsSync(path.join(TMP, "chats")), false, "no shared chats dir was created");
	});

	it("carries the scope through awaits and timers", async () => {
		const seen = await tenancy.runAsUser(alice, async () => {
			await new Promise((r) => setTimeout(r, 5));
			return new Promise<string>((resolve) => setImmediate(() => resolve(tenancy.currentUser()!.userId)));
		});
		assert.equal(seen, "u_alice");
	});

	it("refuses user ids that could escape the users directory", async () => {
		const { userDataDir } = await import("../config.ts");
		assert.throws(() => userDataDir("../etc"), /invalid user id/);
		assert.throws(() => userDataDir("a/b"), /invalid user id/);
	});
});

describe("tenancy: in-memory registries and events", () => {
	it("namespaces turn liveness per user", () => {
		tenancy.runAsUser(alice, () => assert.equal(beginTurn("chat_same"), true));
		tenancy.runAsUser(bob, () => {
			assert.equal(isTurnRunning("chat_same"), false, "alice's turn is not bob's");
			assert.equal(beginTurn("chat_same"), true, "bob's same-id chat is independent");
			endTurn("chat_same");
		});
		tenancy.runAsUser(alice, () => {
			assert.equal(isTurnRunning("chat_same"), true);
			endTurn("chat_same");
		});
	});

	it("ScopedMap lists only the current user's entries, unprefixed", () => {
		const inner = new Map<string, number>();
		const m = new tenancy.ScopedMap(inner);
		tenancy.runAsUser(alice, () => m.set("k", 1));
		tenancy.runAsUser(bob, () => m.set("k", 2));
		assert.equal(inner.size, 2);
		tenancy.runAsUser(alice, () => assert.deepEqual([...m.entries()], [["k", 1]]));
		tenancy.runAsUser(bob, () => assert.deepEqual([...m.entries()], [["k", 2]]));
	});

	it("tags each event with its emitting user", () => {
		const got: Array<[string, string | undefined]> = [];
		const off = subscribe((e, owner) => got.push([e.type, owner]));
		tenancy.runAsUser(alice, () => emit("chats-changed", {}));
		tenancy.runAsUser(bob, () => emit("record-changed", { chatId: "x" }));
		off();
		assert.deepEqual(got, [
			["chats-changed", "u_alice"],
			["record-changed", "u_bob"],
		]);
	});

	it("the SSE channel delivers only the viewer's events", async () => {
		const { eventsResponse } = await import("../src/server/events-stream.ts");
		const res = tenancy.runAsUser(alice, () => eventsResponse());
		const reader = res.body!.getReader();
		tenancy.runAsUser(bob, () => emit("chats-changed", {}));
		tenancy.runAsUser(alice, () => emit("record-changed", { chatId: "mine" }));
		const { value } = await reader.read();
		await reader.cancel();
		const text = new TextDecoder().decode(value);
		assert.match(text, /event: record-changed/);
		assert.doesNotMatch(text, /chats-changed/, "bob's event never reached alice's socket");
	});
});

describe("accounts store", () => {
	it("creates the first admin from the environment (no accounts yet)", async () => {
		await auth.ensureBootstrapAdmin();
		const admin = accounts.findUserByUsername("root.admin");
		assert.equal(admin?.role, "admin");
		assert.equal(admin?.username, "Root.Admin", "display form kept");
	});

	it("hashes passwords with scrypt and verifies them", async () => {
		const hash = await accounts.hashPassword("a long password");
		assert.match(hash, /^scrypt\$/);
		assert.equal(await accounts.verifyPassword("a long password", hash), true);
		assert.equal(await accounts.verifyPassword("a wrong password", hash), false);
	});

	it("enforces the username and password rules", async () => {
		await assert.rejects(accounts.createUser({ username: "ab", password: "long enough pw", role: "user" }), { code: "invalid_username" });
		await assert.rejects(accounts.createUser({ username: "has space", password: "long enough pw", role: "user" }), { code: "invalid_username" });
		await assert.rejects(accounts.createUser({ username: "carol", password: "short", role: "user" }), { code: "weak_password" });
		await accounts.createUser({ username: "Carol", password: "long enough pw", role: "user" });
		await assert.rejects(accounts.createUser({ username: "carol", password: "long enough pw", role: "user" }), { code: "username_taken" }, "case-insensitive");
	});

	it("stores sessions and links only as hashes", () => {
		const user = accounts.findUserByUsername("carol")!;
		const token = accounts.createSession(user.id);
		const link = accounts.createLink({ kind: "invite", createdBy: user.id });
		const raw = fs.readdirSync(path.join(TMP, "accounts")).map((f) => fs.readFileSync(path.join(TMP, "accounts", f), "utf-8")).join("\n");
		assert.equal(raw.includes(token), false, "no raw session token at rest");
		assert.equal(raw.includes(link), false, "no raw link token at rest");
		assert.equal(raw.includes("long enough pw"), false, "no plaintext password at rest");
	});

	it("expires sessions after 30 days and renews them on use", () => {
		const user = accounts.findUserByUsername("carol")!;
		const t0 = Date.now();
		const token = accounts.createSession(user.id, t0);
		const day = 24 * 60 * 60_000;
		const renewed = accounts.resolveSession(token, t0 + 2 * day)!;
		assert.equal(renewed.expiresAt, t0 + 2 * day + accounts.SESSION_TTL_MS, "renewed on use");
		assert.equal(accounts.resolveSession(token, renewed.expiresAt + 1), undefined, "expired");
	});

	it("invite links are single-use and expire after 7 days", async () => {
		const admin = accounts.findUserByUsername("carol")!;
		const t0 = Date.now();
		const stale = accounts.createLink({ kind: "invite", createdBy: admin.id }, t0 - accounts.INVITE_TTL_MS - 1);
		await assert.rejects(accounts.redeemInvite(stale, "dave", "long enough pw"), { code: "invalid_link" });

		const link = accounts.createLink({ kind: "invite", createdBy: admin.id });
		const dave = await accounts.redeemInvite(link, "dave", "long enough pw");
		assert.equal(dave.role, "user", "invites only make regular users");
		await assert.rejects(accounts.redeemInvite(link, "erin", "long enough pw"), { code: "invalid_link" }, "single use");
		assert.equal(accounts.findUserByUsername("erin"), undefined);
	});

	it("a taken username leaves the invite usable for a retry", async () => {
		const admin = accounts.findUserByUsername("carol")!;
		const link = accounts.createLink({ kind: "invite", createdBy: admin.id });
		await assert.rejects(accounts.redeemInvite(link, "dave", "long enough pw"), { code: "username_taken" });
		const frank = await accounts.redeemInvite(link, "frank", "long enough pw");
		assert.equal(frank.username, "frank");
	});

	it("reset links set the password once and end every session", async () => {
		const dave = accounts.findUserByUsername("dave")!;
		const session = accounts.createSession(dave.id);
		const link = accounts.createLink({ kind: "reset", createdBy: "admin", userId: dave.id });
		await accounts.redeemReset(link, "a brand new password");
		assert.equal(accounts.resolveSession(session), undefined, "old sessions end");
		assert.equal(await accounts.verifyPassword("a brand new password", accounts.getUser(dave.id)!.passwordHash), true);
		await assert.rejects(accounts.redeemReset(link, "another new password"), { code: "invalid_link" });
	});

	it("disabling an account ends its sessions", () => {
		const frank = accounts.findUserByUsername("frank")!;
		const token = accounts.createSession(frank.id);
		accounts.setUserDisabled(frank.id, true);
		assert.equal(accounts.resolveSession(token), undefined);
		assert.equal(auth.userForToken(token), undefined);
		accounts.setUserDisabled(frank.id, false);
	});
});

describe("the auth gate", () => {
	const handler = auth.withUser(async () => Response.json({ user: tenancy.currentUser()?.username, chats: PATHS.chats }));
	const adminOnly = auth.withUser(async () => Response.json({ ok: true }), { admin: true });

	function req(token?: string, init: RequestInit & { origin?: string } = {}) {
		const headers = new Headers({ host: "lh.example" });
		if (token) headers.set("cookie", `${auth.SESSION_COOKIE}=${encodeURIComponent(token)}`);
		if (init.origin) headers.set("origin", init.origin);
		return new Request("http://lh.example/api/x", { method: init.method ?? "GET", headers });
	}

	it("401s without a valid session", async () => {
		assert.equal((await handler(req())).status, 401);
		assert.equal((await handler(req("not-a-token"))).status, 401);
	});

	it("runs the handler in the caller's scope", async () => {
		const dave = accounts.findUserByUsername("dave")!;
		const res = await handler(req(accounts.createSession(dave.id)));
		const body = (await res.json()) as { user: string; chats: string };
		assert.equal(body.user, "dave");
		assert.equal(body.chats, path.join(TMP, "users", dave.id, "chats"));
	});

	it("403s non-admins on admin routes", async () => {
		const dave = accounts.findUserByUsername("dave")!;
		const admin = accounts.findUserByUsername("root.admin")!;
		assert.equal((await adminOnly(req(accounts.createSession(dave.id)))).status, 403);
		assert.equal((await adminOnly(req(accounts.createSession(admin.id)))).status, 200);
	});

	it("refuses cross-origin writes", async () => {
		const dave = accounts.findUserByUsername("dave")!;
		const token = accounts.createSession(dave.id);
		assert.equal((await handler(req(token, { method: "POST", origin: "https://evil.example" }))).status, 403);
		assert.equal((await handler(req(token, { method: "POST", origin: "http://lh.example" }))).status, 200);
	});

	it("blocks a username for 15 minutes after 10 failed logins in 15 minutes", async () => {
		const t0 = Date.now();
		for (let i = 0; i < 9; i++) assert.equal((await auth.checkLogin("dave", "wrong password!", t0 + i)).ok, false);
		assert.equal((await auth.checkLogin("dave", "a brand new password", t0 + 10)).ok, true, "9 failures: still open, success resets");
		for (let i = 0; i < 10; i++) await auth.checkLogin("dave", "wrong password!", t0 + 20 + i);
		const blocked = await auth.checkLogin("dave", "a brand new password", t0 + 40);
		assert.deepEqual(blocked, { ok: false, reason: "blocked" });
		assert.equal((await auth.checkLogin("dave", "a brand new password", t0 + 30 + 15 * 60_000)).ok, true);
	});

	it("login is case-insensitive on the username", async () => {
		assert.equal((await auth.checkLogin("DAVE", "a brand new password")).ok, true);
	});
});

describe("agent sandboxing", () => {
	it("drops the learner-filesystem tools", () => {
		assert.equal(localFileToolsEnabled, false);
		assert.deepEqual(learnerFsTools({ read: {} as never, ls: {} as never }), {});
	});

	it("drops the pdf job (it opens local paths)", () => {
		const tools = jobTools({ chatId: "c", jobStore: {} as never, spawn: () => {}, searchAvailable: () => true });
		assert.equal("pdf" in tools, false);
		assert.ok("research" in tools && "demo" in tools && "visual" in tools);
	});

	it("classifies addresses: private, loopback, link-local, Fly 6PN, mapped v4 are refused", () => {
		for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fdaa:0:1::2", "fe80::1", "::ffff:10.0.0.1"]) {
			assert.equal(netGuard.isPublicAddress(ip), false, ip);
		}
		for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
			assert.equal(netGuard.isPublicAddress(ip), true, ip);
		}
	});

	it("refuses private literals, internal names and non-http schemes before connecting", async () => {
		for (const url of ["http://127.0.0.1:3000/api/keys", "http://[::1]/", "http://localhost:8080/", "http://app.internal/", "http://169.254.169.254/latest/meta-data", "file:///etc/passwd"]) {
			await assert.rejects(netGuard.guardedFetch(url), netGuard.BlockedUrlError, url);
		}
	});

	it("refuses at the socket's DNS answer too (closes DNS rebinding)", async () => {
		// The name check above would catch "localhost" first; call the
		// socket-level lookup directly to pin the resolved-address check.
		const err = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
			netGuard.guardedLookup("localhost", {}, (e) => resolve(e)),
		);
		assert.equal(err?.code, "EBLOCKED");
	});

	it("re-checks redirect targets", () => {
		assert.throws(() => netGuard.assertFetchableUrl(new URL("/secret", "http://127.0.0.1:1/").href), netGuard.BlockedUrlError);
	});
});
