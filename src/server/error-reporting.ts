import { currentUser } from "../../tenancy.ts";
import { turnErrorEvents, type AgentErrorEvent } from "../core/agent-errors.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { errorLedger, toLedgerEntry, type ErrorLedger, type ErrorLedgerEntry } from "../store/error-ledger.ts";

/**
 * ERROR REPORTING — the server seam every failure point calls (2026-11).
 *
 * Callers hand over AgentErrorEvents; this module stamps them (user,
 * version, fingerprint), appends them to the ledger, and fans each batch
 * out to subscribers (the GitHub issue filer subscribes here). It NEVER
 * throws: reporting an error must not become a second error in the turn
 * that hit the first one.
 *
 * Skipped under NODE_ENV=test unless a test installs its own ledger
 * (scripted fixture chats error on purpose; their failures are not bugs).
 */

type Listener = (entries: readonly ErrorLedgerEntry[]) => void;

interface LhErrorReportingGlobal {
	__lhErrorReporting?: { listeners: Set<Listener>; ledger?: ErrorLedger };
}

// globalThis-pinned like the other registries: Next can load this module
// more than once (route bundles), and every copy must share one listener set.
function state(): { listeners: Set<Listener>; ledger?: ErrorLedger } {
	const g = globalThis as typeof globalThis & LhErrorReportingGlobal;
	return (g.__lhErrorReporting ??= { listeners: new Set() });
}

/** Test seam: route reports to a scratch ledger (undefined restores). */
export function setErrorLedgerForTests(ledger: ErrorLedger | undefined): void {
	state().ledger = ledger;
}

/** Subscribe to every recorded batch; returns the unsubscribe. */
export function onAgentErrors(listener: Listener): () => void {
	state().listeners.add(listener);
	return () => state().listeners.delete(listener);
}

/** Record failures (any kind). Never throws. */
export function reportAgentErrors(events: readonly AgentErrorEvent[]): void {
	if (events.length === 0) return;
	const s = state();
	const ledger = s.ledger ?? (process.env.NODE_ENV === "test" ? undefined : errorLedger);
	if (!ledger) return;
	try {
		const userId = currentUser()?.userId;
		const entries = events.map((e) => toLedgerEntry(e, { userId }));
		ledger.append(entries);
		for (const listener of s.listeners) {
			try {
				listener(entries);
			} catch (err) {
				console.error("[errors] listener failed:", err);
			}
		}
	} catch (err) {
		console.error("[errors] could not record agent errors:", err);
	}
}

/** One failure from a catch block. */
export function reportAgentError(
	kind: AgentErrorEvent["kind"],
	err: unknown,
	ctx: { chatId?: string; tool?: string; model?: string } = {},
): void {
	const message = err instanceof Error ? err.message : String(err);
	const detail = err instanceof Error ? err.stack : undefined;
	reportAgentErrors([{ kind, message, unrecovered: true, ...(detail ? { detail } : {}), ...ctx }]);
}

/** Every failure inside a turn's newly persisted messages. */
export function reportTurnErrors(chatId: string, stamped: readonly LhMessage[]): void {
	try {
		reportAgentErrors(turnErrorEvents(stamped, chatId));
	} catch (err) {
		console.error(`[chat ${chatId}] error scan failed:`, err);
	}
}
