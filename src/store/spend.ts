import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { TurnUsage } from "../core/contracts.ts";
import { turnCost } from "../core/prices.ts";
import type { SpendEntry } from "../core/allowance.ts";

/**
 * THE SPEND LEDGER (cloud mode allowance, 2026-11): one append-only JSONL
 * per user (<user data>/spend.jsonl) holding a copy of every teaching
 * turn's usage. It lives apart from the chat records on purpose:
 * deleting a session must not erase what it cost. Like every money
 * channel here it stores USAGE, never dollars — cost is inferred at read
 * time (core/prices.ts), unpriced turns read as $0.
 */

function ledgerFile(): string {
	return path.join(PATHS.data, "spend.jsonl");
}

export function appendSpend(turn: TurnUsage): void {
	const file = ledgerFile();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${JSON.stringify({ at: turn.at, model: turn.model, steps: turn.steps })}\n`, "utf-8");
}

/** The ledger as dated dollar amounts. Malformed lines are skipped. */
export function readSpend(): SpendEntry[] {
	let raw: string;
	try {
		raw = fs.readFileSync(ledgerFile(), "utf-8");
	} catch {
		return [];
	}
	const entries: SpendEntry[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const turn = JSON.parse(line) as Pick<TurnUsage, "at" | "model" | "steps">;
			const at = Date.parse(turn.at);
			if (!Number.isFinite(at) || !Array.isArray(turn.steps)) continue;
			entries.push({ at, usd: turnCost(turn as TurnUsage) ?? 0 });
		} catch {
			/* a torn final line — skip */
		}
	}
	return entries;
}
