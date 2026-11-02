import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { CLOUD_MODE, currentUser, requireUser } from "../../tenancy.ts";
import { allowanceStatus, type AllowanceStatus } from "../core/allowance.ts";
import type { ChatSettings } from "../core/contracts.ts";
import { PRICES } from "../core/prices.ts";
import { resolveConversationSpec } from "../core/settings-resolution.ts";
import { CURRENT_SETTINGS_VERSION, type ModelSlot } from "../core/settings.ts";
import { getUser, readAllowanceSettings } from "../store/accounts.ts";
import { readSpend } from "../store/spend.ts";
import { stores, effectiveSettings } from "./stores.ts";

/**
 * THE ALLOWANCE SERVICE (cloud mode, owner design 2026-11): the current
 * user's faded spend against their limit, the user-started turn gate, and
 * the economy switch. Desktop never reaches any of it.
 *
 * Owner rulings carried here:
 *  - only teaching turns count, and only USER-STARTED turns are refused at
 *    100% (wake-pipeline turns deliver work already running — they count
 *    but always run);
 *  - the admin is under the same rules (a per-user override can raise it);
 *  - regular users can only run priced models (an unpriced model would
 *    count as $0 — unlimited);
 *  - "Switch to economy" moves the open session AND the default for new
 *    ones to the admin's preset; "Switch back" restores both.
 */

export function isPricedModel(provider: string, id: string): boolean {
	return Boolean(PRICES[`${provider}:${id}`]);
}

/** May the current user pick / run this model? Desktop and the admin:
 *  anything; everyone else: priced models only. */
export function modelAllowedForUser(provider: string, id: string): boolean {
	if (!CLOUD_MODE || currentUser()?.role === "admin") return true;
	return isPricedModel(provider, id);
}

/** The current user's allowance, now. */
export function currentAllowance(now = Date.now()): AllowanceStatus {
	const scope = requireUser();
	const settings = readAllowanceSettings();
	const limit = getUser(scope.userId)?.limitUsd ?? settings.limitUsd;
	return allowanceStatus(readSpend(), settings, limit, now);
}

/**
 * The user-started turn gate (handleChatRequest): null = proceed, or the
 * refusal response. Placed before the turn composition, so nothing about
 * the session changes on a refusal.
 */
export function allowanceRefusal(chatId: string): Response | null {
	if (!CLOUD_MODE) return null;
	const record = stores.chatStore.getChat(chatId);
	if (!record) return null; // the composition's own 404 answers
	const spec = resolveConversationSpec(record.settings, effectiveSettings().models.strong);
	if (spec && !modelAllowedForUser(spec.provider, spec.id)) {
		return Response.json(
			{
				code: "model_unavailable",
				error: "This session's model isn't available on this server. Pick another model for it.",
			},
			{ status: 403 },
		);
	}
	const status = currentAllowance();
	if (status.level !== "exhausted") return null;
	return Response.json(
		{
			code: "allowance_exhausted",
			error: "You've used your allowance for now. It comes back gradually as your recent spending fades.",
			...(status.resumesAt ? { resumesAt: status.resumesAt } : {}),
		},
		{ status: 429 },
	);
}

// ─── the economy switch ──────────────────────────────────────────────────────

/** What "Switch back" restores: the default (strong slot) and each session
 *  switched while economy was on. null = the value was unset before. */
interface EconomyState {
	previousDefault: ModelSlot | null;
	sessions: Record<string, ChatSettings | null>;
}

function economyFile(): string {
	return path.join(PATHS.data, "economy.json");
}

function readEconomyState(): EconomyState | null {
	try {
		return JSON.parse(fs.readFileSync(economyFile(), "utf-8")) as EconomyState;
	} catch {
		return null;
	}
}

function writeEconomyState(state: EconomyState | null): void {
	if (state === null) {
		fs.rmSync(economyFile(), { force: true });
		return;
	}
	fs.mkdirSync(path.dirname(economyFile()), { recursive: true });
	fs.writeFileSync(economyFile(), JSON.stringify(state, null, "\t"), "utf-8");
}

export function economyActive(): boolean {
	return readEconomyState() !== null;
}

function setDefaultSlot(slot: ModelSlot | null): void {
	const record = stores.settingsStore.readSettings();
	const models = { ...(record?.models ?? {}) };
	if (slot) models.strong = slot;
	else delete models.strong;
	stores.settingsStore.writeSettings({ ...(record ?? {}), version: record?.version ?? CURRENT_SETTINGS_VERSION, models });
}

export class EconomyError extends Error {}

/**
 * Switch the given session (if any) and the new-session default to the
 * admin's economy preset. Idempotent: switching again while on adds the
 * session without touching what "Switch back" restores.
 */
export function switchToEconomy(chatId?: string): void {
	const preset = readAllowanceSettings().economy;
	if (!preset) throw new EconomyError("No economy preset is set up on this server.");
	const target: ModelSlot = { model: preset.model, ...(preset.thinkingLevel ? { thinkingLevel: preset.thinkingLevel } : {}) };
	const state: EconomyState = readEconomyState() ?? {
		previousDefault: stores.settingsStore.readSettings()?.models?.strong ?? null,
		sessions: {},
	};
	setDefaultSlot(target);
	if (chatId) {
		const record = stores.chatStore.getChat(chatId);
		if (!record) throw new EconomyError("Unknown session.");
		if (!(chatId in state.sessions)) state.sessions[chatId] = record.settings ?? null;
		stores.chatStore.saveSettings(chatId, { model: preset.model, ...(preset.thinkingLevel ? { thinkingLevel: preset.thinkingLevel } : {}) });
	}
	writeEconomyState(state);
}

/** Restore the default and every switched session (deleted ones skipped). */
export function switchBack(): void {
	const state = readEconomyState();
	if (!state) return;
	setDefaultSlot(state.previousDefault);
	for (const [chatId, previous] of Object.entries(state.sessions)) {
		if (stores.chatStore.getChat(chatId)) stores.chatStore.saveSettings(chatId, previous ?? {});
	}
	writeEconomyState(null);
}
