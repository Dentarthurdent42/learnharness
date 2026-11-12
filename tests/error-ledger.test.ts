/**
 * Error ledger tests — the pure turn scan + fingerprinting
 * (core/agent-errors.ts), the size-capped JSONL ledger
 * (store/error-ledger.ts), and the reporting seam's fan-out
 * (server/error-reporting.ts). Each test uses its own scratch directory.
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { errorFingerprint, normalizeErrorText, turnErrorEvents, UNRECOVERED_STREAK } from "../src/core/agent-errors.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { createErrorLedger, toLedgerEntry } from "../src/store/error-ledger.ts";
import { onAgentErrors, reportAgentError, reportTurnErrors, setErrorLedgerForTests } from "../src/server/error-reporting.ts";

function scratch(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "lh-errors-"));
}

function assistantCall(id: string, name: string, args: unknown, extra: Record<string, unknown> = {}): LhMessage {
	return {
		role: "assistant",
		id: `m_${id}`,
		model: "glm-latest",
		stopReason: "toolUse",
		content: [{ type: "toolCall", id, name, arguments: args }],
		...extra,
	} as unknown as LhMessage;
}

function toolResult(id: string, name: string, text: string, isError: boolean): LhMessage {
	return {
		role: "toolResult",
		id: `r_${id}`,
		toolCallId: id,
		toolName: name,
		isError,
		content: [{ type: "text", text }],
	} as unknown as LhMessage;
}

test("normalizeErrorText: strips quoted values, ids and numbers so repeats group", () => {
	const a = normalizeErrorText('Invalid tool input for tool "quiz":\n- options[2] must have 4 items (got "abc")');
	const b = normalizeErrorText('Invalid tool input for tool "quiz":\n- options[7] must have 9 items (got "xyz")');
	assert.equal(a, b);
	assert.equal(normalizeErrorText("chat 3f2a9c1e-1111-2222-3333-444455556666 failed"), "chat <id> failed");
});

test("errorFingerprint: stable per kind+tool+normalized text, distinct across tools", () => {
	const one = errorFingerprint("tool_error", "quiz", 'bad "x" at 3');
	assert.equal(one, errorFingerprint("tool_error", "quiz", 'bad "y" at 9'));
	assert.notEqual(one, errorFingerprint("tool_error", "ask_user_question", 'bad "x" at 3'));
	assert.notEqual(one, errorFingerprint("turn_error", "quiz", 'bad "x" at 3'));
	assert.match(one, /^[0-9a-f]{12}$/);
});

test("turnErrorEvents: tool errors carry args and model; aborts and successes are skipped", () => {
	const msgs = [
		assistantCall("c1", "quiz", { multiSelect: true }),
		toolResult("c1", "quiz", "multiSelect needs options", true),
		assistantCall("c2", "read", { path: "x" }),
		toolResult("c2", "read", "Operation aborted", true),
		assistantCall("c3", "read", { path: "y" }),
		toolResult("c3", "read", "ok", false),
	];
	const events = turnErrorEvents(msgs, "chat1");
	assert.equal(events.length, 1);
	assert.deepEqual(events[0]!, {
		kind: "tool_error",
		tool: "quiz",
		message: "multiSelect needs options",
		args: { multiSelect: true },
		model: "glm-latest",
		chatId: "chat1",
		unrecovered: false,
	});
});

test("turnErrorEvents: the same tool failing UNRECOVERED_STREAK times in a row is unrecovered; a success resets", () => {
	const msgs: LhMessage[] = [];
	for (let i = 0; i < UNRECOVERED_STREAK; i++) {
		msgs.push(assistantCall(`q${i}`, "quiz", {}), toolResult(`q${i}`, "quiz", "bad", true));
	}
	msgs.push(assistantCall("ok", "quiz", {}), toolResult("ok", "quiz", "fine", false));
	msgs.push(assistantCall("after", "quiz", {}), toolResult("after", "quiz", "bad", true));
	const flags = turnErrorEvents(msgs).map((e) => e.unrecovered);
	assert.deepEqual(flags, [...Array(UNRECOVERED_STREAK - 1).fill(false), true, false]);
});

test("turnErrorEvents: an assistant message that ended in error is an unrecovered turn_error", () => {
	const msgs = [
		{ role: "assistant", id: "m1", model: "m", stopReason: "error", errorMessage: "provider 500", content: [] } as unknown as LhMessage,
	];
	const e = turnErrorEvents(msgs, "c")[0]!;
	assert.equal(e.kind, "turn_error");
	assert.equal(e.message, "provider 500");
	assert.equal(e.unrecovered, true);
});

test("ledger: append, read, group by fingerprint with counts and distinct chats", () => {
	const ledger = createErrorLedger(scratch());
	const base = { kind: "tool_error" as const, tool: "quiz", unrecovered: false };
	ledger.append([
		toLedgerEntry({ ...base, message: 'bad "a"', chatId: "c1" }, { version: "t", at: new Date("2026-11-01T00:00:00Z") }),
		toLedgerEntry({ ...base, message: 'bad "b"', chatId: "c2", unrecovered: true }, { version: "t", at: new Date("2026-11-02T00:00:00Z") }),
		toLedgerEntry({ ...base, message: 'bad "c"', chatId: "c1" }, { version: "t", at: new Date("2026-11-03T00:00:00Z") }),
		toLedgerEntry({ kind: "stream_error", message: "boom", unrecovered: true }, { version: "t", at: new Date("2026-11-02T12:00:00Z") }),
	]);
	const groups = ledger.readGroups();
	assert.equal(groups.length, 2);
	const quiz = groups[0]!;
	const stream = groups[1]!;
	assert.equal(quiz.tool, "quiz");
	assert.equal(quiz.count, 3);
	assert.equal(quiz.unrecoveredCount, 1);
	assert.equal(quiz.chats, 2);
	assert.equal(quiz.firstAt, "2026-11-01T00:00:00.000Z");
	assert.equal(quiz.latest.message, 'bad "c"');
	assert.equal(stream.count, 1);
});

test("ledger: rotates past maxBytes, keeps one generation, reads both", () => {
	const dir = scratch();
	const ledger = createErrorLedger(dir, { maxBytes: 200 });
	const entry = (i: number) => toLedgerEntry({ kind: "stream_error", message: `boom ${"x".repeat(150)} ${i}`, unrecovered: true }, { version: "t" });
	ledger.append([entry(1)]);
	ledger.append([entry(2)]); // live ≥ 200 bytes → rotates before this append
	ledger.append([entry(3)]); // rotates again: entry 1's generation is dropped
	assert.ok(fs.existsSync(path.join(dir, "errors.1.jsonl")));
	assert.equal(ledger.readEntries().length, 2);
});

test("toLedgerEntry: truncates huge args and messages", () => {
	const e = toLedgerEntry({ kind: "tool_error", tool: "t", message: "m".repeat(5000), args: { big: "a".repeat(10_000) }, unrecovered: false }, { version: "t" });
	assert.ok(e.message.length < 2100);
	assert.ok((e.args ?? "").length < 4100);
	assert.match(e.args ?? "", /truncated/);
});

test("reporting: records turn errors and fans out to listeners; never throws on a bad listener", () => {
	const ledger = createErrorLedger(scratch());
	setErrorLedgerForTests(ledger);
	const seen: string[] = [];
	const offBad = onAgentErrors(() => {
		throw new Error("listener bug");
	});
	const off = onAgentErrors((entries) => seen.push(...entries.map((e) => e.kind)));
	const origError = console.error;
	console.error = () => {};
	try {
		reportTurnErrors("chatX", [assistantCall("a", "quiz", {}), toolResult("a", "quiz", "bad", true)]);
		reportAgentError("turn_start_failed", new Error("nope"), { chatId: "chatX" });
	} finally {
		console.error = origError;
		off();
		offBad();
		setErrorLedgerForTests(undefined);
	}
	assert.deepEqual(seen, ["tool_error", "turn_start_failed"]);
	const entries = ledger.readEntries();
	assert.equal(entries.length, 2);
	assert.equal(entries[1]!.message, "nope");
	assert.match(entries[1]!.detail ?? "", /Error: nope/);
});
