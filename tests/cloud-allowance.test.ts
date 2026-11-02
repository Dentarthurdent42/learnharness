/**
 * The fading-spend allowance (cloud mode, owner design 2026-11): the pure
 * math, the per-user spend ledger, the user-started turn gate, the economy
 * switch, and the priced-models-only rule for regular users.
 *
 * CLOUD_MODE and the data root are read at MODULE LOAD — env first, then
 * dynamic imports (node --test runs each file in its own process).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-allowance-"));
process.env.LH_MODE = "cloud";
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
process.env.ANTHROPIC_API_KEY = "sk-ant-test-key-for-catalog";

const tenancy = await import("../tenancy.ts");
const allowanceCore = await import("../src/core/allowance.ts");
const { appendSpend, readSpend } = await import("../src/store/spend.ts");
const { chatStore } = await import("../src/store/chats.ts");
const accounts = await import("../src/store/accounts.ts");
const allowance = await import("../src/server/allowance.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { modelCatalog, validateChatSettings } = await import("../src/server/model-catalog.ts");
const { settingsStore } = await import("../src/store/settings.ts");
const { PRICES } = await import("../src/core/prices.ts");

const HOUR = 3_600_000;
const PRICED = { provider: "anthropic", id: "claude-haiku-4-5" };

function turn(usd: number, at: number, id = `t_${Math.random()}`) {
	// claude-haiku-4-5: $5 per 1M output tokens → usd dollars of output.
	return { id, messageId: "m", at: new Date(at).toISOString(), model: "anthropic:claude-haiku-4-5", steps: [{ inputTokens: 0, outputTokens: Math.round((usd / 5) * 1e6), cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }] };
}

describe("the fading-spend math", () => {
	it("halves a dollar every half-life", () => {
		const now = Date.now();
		assert.equal(allowanceCore.fadedSpend([{ at: now, usd: 4 }], 24, now), 4);
		assert.ok(Math.abs(allowanceCore.fadedSpend([{ at: now - 24 * HOUR, usd: 4 }], 24, now) - 2) < 1e-9);
		assert.ok(Math.abs(allowanceCore.fadedSpend([{ at: now - 48 * HOUR, usd: 4 }], 24, now) - 1) < 1e-9);
	});

	it("levels: notice at 50%, warn at 85%, exhausted at 100%", () => {
		assert.equal(allowanceCore.allowanceLevel(0.49), "ok");
		assert.equal(allowanceCore.allowanceLevel(0.5), "notice");
		assert.equal(allowanceCore.allowanceLevel(0.85), "warn");
		assert.equal(allowanceCore.allowanceLevel(1), "exhausted");
	});

	it("predicts when turns resume: h·log2(S/L)", () => {
		const now = Date.now();
		const status = allowanceCore.allowanceStatus([{ at: now, usd: 4 }], { limitUsd: 2, halfLifeHours: 24 }, 2, now);
		assert.equal(status.level, "exhausted");
		// $4 against $2 halves once: 24 hours (+ the one-minute margin).
		assert.equal(status.resumesAt, now + 24 * HOUR + 60_000);
		const after = allowanceCore.allowanceStatus([{ at: now, usd: 4 }], { limitUsd: 2, halfLifeHours: 24 }, 2, status.resumesAt!);
		assert.notEqual(after.level, "exhausted");
	});

	it("a $0 limit is always exhausted and never resumes on its own", () => {
		const s = allowanceCore.allowanceStatus([], { limitUsd: 2, halfLifeHours: 24 }, 0, Date.now());
		assert.equal(s.level, "exhausted");
		assert.equal(s.resumesAt, undefined);
	});

	it("defaults: $2, 24-hour half-life", () => {
		assert.deepEqual(allowanceCore.DEFAULT_ALLOWANCE, { limitUsd: 2, halfLifeHours: 24 });
	});
});

describe("the per-user ledger", () => {
	const ann = { userId: "u_ann", username: "ann", role: "user" as const };
	const ben = { userId: "u_ben", username: "ben", role: "user" as const };

	it("records each turn once, per user, and survives deleting the session", () => {
		tenancy.runAsUser(ann, () => {
			const chat = chatStore.createChat("ann's lesson");
			const t = turn(1, Date.now(), "turn_1");
			chatStore.appendTurnUsage(chat.id, t);
			chatStore.appendTurnUsage(chat.id, t); // a replayed append
			chatStore.deleteChat(chat.id);
			const spend = readSpend();
			assert.equal(spend.length, 1, "idempotent per turn id");
			assert.ok(Math.abs(spend[0]!.usd - 1) < 1e-6);
		});
		tenancy.runAsUser(ben, () => assert.deepEqual(readSpend(), [], "ben's ledger is his own"));
	});
});

describe("the turn gate", () => {
	const cara = { userId: "u_cara", username: "cara", role: "user" as const };

	async function send(chatId: string) {
		return handleChatRequest(
			new Request("http://x/api/chat", { method: "POST", body: JSON.stringify({ chatId, input: { type: "text", text: "hi" } }) }),
		);
	}

	it("refuses a user-started turn at 100% with when it comes back", async () => {
		await tenancy.runAsUser(cara, async () => {
			const chat = chatStore.createChat("cara's lesson");
			appendSpend(turn(3, Date.now()));
			const res = await send(chat.id);
			assert.equal(res.status, 429);
			const body = (await res.json()) as { code: string; resumesAt: number };
			assert.equal(body.code, "allowance_exhausted");
			assert.ok(body.resumesAt > Date.now());
			assert.equal(chatStore.getChat(chat.id)!.messages.length, 0, "nothing written on a refusal");
		});
	});

	it("a per-user override raises the limit", async () => {
		const user = await accounts.createUser({ username: "dora", password: "long enough pw", role: "user" });
		accounts.setUserLimit(user.id, 10);
		const scope = { userId: user.id, username: "dora", role: "user" as const };
		tenancy.runAsUser(scope, () => {
			appendSpend(turn(3, Date.now()));
			const status = allowance.currentAllowance();
			assert.equal(status.limitUsd, 10);
			assert.equal(status.level, "ok");
		});
	});

	it("refuses a session pinned to an unpriced model for regular users", async () => {
		const unpriced = Object.entries(PRICES).length > 0 ? { provider: "anthropic", id: "definitely-not-a-priced-model" } : null;
		assert.ok(unpriced);
		await tenancy.runAsUser({ userId: "u_eve", username: "eve", role: "user" }, async () => {
			const chat = chatStore.createChat("eve's lesson");
			chatStore.saveSettings(chat.id, { model: unpriced });
			const res = await send(chat.id);
			assert.equal(res.status, 403);
			assert.equal(((await res.json()) as { code: string }).code, "model_unavailable");
		});
	});
});

describe("priced models only for regular users", () => {
	it("the catalog hides unpriced models from users, not from the admin", () => {
		const userModels = tenancy.runAsUser({ userId: "u_fay", username: "fay", role: "user" }, () => modelCatalog().models);
		const adminModels = tenancy.runAsUser({ userId: "u_adm", username: "adm", role: "admin" }, () => modelCatalog().models);
		assert.ok(userModels.length > 0, "the keyed provider lists models");
		assert.ok(userModels.every((m) => PRICES[`${m.provider}:${m.id}`]), "every user-visible model is priced");
		assert.ok(adminModels.length >= userModels.length);
	});

	it("a regular user can't pin an unpriced model", () => {
		const unpricedModel = tenancy.runAsUser({ userId: "u_adm", username: "adm", role: "admin" }, () =>
			modelCatalog().models.find((m) => !PRICES[`${m.provider}:${m.id}`]),
		);
		if (!unpricedModel) return; // every catalog model priced — nothing to refuse
		const verdict = tenancy.runAsUser({ userId: "u_fay", username: "fay", role: "user" }, () =>
			validateChatSettings({ model: { provider: unpricedModel.provider, id: unpricedModel.id } }),
		);
		assert.equal(verdict.ok, false);
	});
});

describe("the economy switch", () => {
	const gus = { userId: "u_gus", username: "gus", role: "user" as const };

	it("needs an admin preset", () => {
		tenancy.runAsUser(gus, () => assert.throws(() => allowance.switchToEconomy(), allowance.EconomyError));
	});

	it("moves the open session and the default, and Switch back restores both", () => {
		accounts.writeAllowanceSettings({ limitUsd: 2, halfLifeHours: 24, economy: { model: PRICED, thinkingLevel: "low" } });
		tenancy.runAsUser(gus, () => {
			const strong = { model: { provider: "anthropic", id: "claude-fable-5" }, thinkingLevel: "high" as const };
			settingsStore.writeSettings({ version: 1, models: { strong } });
			const chat = chatStore.createChat("gus's lesson");
			chatStore.saveSettings(chat.id, { model: strong.model, thinkingLevel: "high" });
			const other = chatStore.createChat("another lesson");
			chatStore.saveSettings(other.id, { model: strong.model });

			allowance.switchToEconomy(chat.id);
			assert.equal(allowance.economyActive(), true);
			assert.deepEqual(chatStore.getChat(chat.id)!.settings, { model: PRICED, thinkingLevel: "low" });
			assert.deepEqual(settingsStore.readSettings()!.models!.strong, { model: PRICED, thinkingLevel: "low" });
			assert.deepEqual(chatStore.getChat(other.id)!.settings, { model: strong.model }, "other sessions untouched");

			allowance.switchBack();
			assert.equal(allowance.economyActive(), false);
			assert.deepEqual(chatStore.getChat(chat.id)!.settings, { model: strong.model, thinkingLevel: "high" });
			assert.deepEqual(settingsStore.readSettings()!.models!.strong, strong);
		});
	});
});
