import { createHash } from "node:crypto";
import type { LhMessage } from "./native-messages.ts";

/**
 * AGENT ERRORS — the pure half of the error ledger (2026-11, the
 * "report errors so a developer agent can see them" plan).
 *
 * A teaching turn's failures are mostly INVISIBLE: a tool call that errors
 * back to the model renders as one quiet "Retrying…" line (chat.tsx), and
 * the error text only survives inside the chat record. This module turns a
 * turn's persisted messages (and the server's other failure points) into
 * flat, fingerprinted events the ledger can count and group:
 *
 * - kind + tool + NORMALIZED error text → a stable fingerprint, so the
 *   same bug seen in twenty chats is one row with a count of twenty (ids,
 *   numbers, and quoted values are stripped before hashing);
 * - "unrecovered" marks the failures the agent did NOT work around — the
 *   turn itself ended in an error, or the same tool failed
 *   UNRECOVERED_STREAK times in a row. Those are the ones worth a human
 *   (or a triage agent) right away; one-off slips wait for repeats.
 */

export type AgentErrorKind =
	/** A tool call returned an error result to the model. */
	| "tool_error"
	/** The assistant message itself ended with stopReason "error". */
	| "turn_error"
	/** The turn's stream failed (provider/transport). */
	| "stream_error"
	/** The turn never started (the composition threw). */
	| "turn_start_failed"
	/** A sub-agent job ended failed. */
	| "job_failed"
	/** The extraction pipeline run threw. */
	| "extraction_failed";

export interface AgentErrorEvent {
	kind: AgentErrorKind;
	/** The tool (tool_error) or job kind (job_failed); absent otherwise. */
	tool?: string;
	/** The raw error text (truncated by the ledger, never here). */
	message: string;
	/** The failing call's arguments (tool_error only). */
	args?: unknown;
	/** A stack trace or other detail — stored, never fingerprinted
	 *  (bundle paths and line numbers change every build). */
	detail?: string;
	model?: string;
	chatId?: string;
	/** True when the agent did not recover (see module doc). */
	unrecovered: boolean;
}

/** Consecutive failures of one tool within a turn that count as "stuck". */
export const UNRECOVERED_STREAK = 3;

/** pi's abort wording — a user abort is terminal, never a bug. */
const ABORT_TEXT = "Operation aborted";

/**
 * Strip the volatile parts of an error message so repeats group: quoted
 * values, uuids/long hex/ids with digits, and bare numbers. Whitespace is
 * collapsed and the result capped (fingerprints hash the first 500 chars).
 */
export function normalizeErrorText(text: string): string {
	return text
		.replace(/"(?:[^"\\]|\\.)*"/g, '"…"')
		.replace(/'(?:[^'\\]|\\.){1,200}'/g, "'…'")
		.replace(/`[^`]{1,200}`/g, "`…`")
		.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
		.replace(/\b[0-9a-f]{12,}\b/gi, "<id>")
		.replace(/\b[A-Za-z_]*\d[A-Za-z0-9_-]{5,}\b/g, "<id>")
		.replace(/\d+(?:\.\d+)?/g, "N")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 500);
}

/** The grouping key: 12 hex chars of sha256(kind | tool | normalized text). */
export function errorFingerprint(kind: AgentErrorKind, tool: string | undefined, message: string): string {
	return createHash("sha256")
		.update(`${kind}|${tool ?? ""}|${normalizeErrorText(message)}`)
		.digest("hex")
		.slice(0, 12);
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is { type: "text"; text: string } => !!c && (c as { type?: string }).type === "text")
		.map((c) => c.text)
		.join("\n");
}

/**
 * Every failure inside one turn's persisted messages, in order. Tool
 * errors carry the failing call's arguments (looked up by toolCallId in
 * the turn's assistant messages) and the model that made the call; a tool
 * is "unrecovered" once it has failed UNRECOVERED_STREAK times with no
 * success of that tool in between — every event in the streak from that
 * point on is marked, so the filer sees it whichever event it reads.
 */
export function turnErrorEvents(messages: readonly LhMessage[], chatId?: string): AgentErrorEvent[] {
	const calls = new Map<string, { args: unknown; model?: string }>();
	const streak = new Map<string, number>();
	const events: AgentErrorEvent[] = [];
	for (const m of messages) {
		const role = (m as { role?: string }).role;
		if (role === "assistant") {
			const a = m as { content?: unknown[]; model?: string; stopReason?: string; errorMessage?: string };
			for (const part of a.content ?? []) {
				const p = part as { type?: string; id?: string; arguments?: unknown };
				if (p.type === "toolCall" && p.id) calls.set(p.id, { args: p.arguments, model: a.model });
			}
			if (a.stopReason === "error") {
				events.push({
					kind: "turn_error",
					message: a.errorMessage || "Assistant message ended with an error",
					model: a.model,
					chatId,
					unrecovered: true,
				});
			}
		} else if (role === "toolResult") {
			const r = m as { toolCallId: string; toolName: string; isError?: boolean; content?: unknown };
			if (!r.isError) {
				streak.set(r.toolName, 0);
				continue;
			}
			const message = textOf(r.content) || "Tool returned an error with no text";
			if (message.trim() === ABORT_TEXT) continue;
			const n = (streak.get(r.toolName) ?? 0) + 1;
			streak.set(r.toolName, n);
			const call = calls.get(r.toolCallId);
			events.push({
				kind: "tool_error",
				tool: r.toolName,
				message,
				args: call?.args,
				model: call?.model,
				chatId,
				unrecovered: n >= UNRECOVERED_STREAK,
			});
		}
	}
	return events;
}
