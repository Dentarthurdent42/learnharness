/**
 * User-report tests — input validation and the excerpt (core/feedback.ts),
 * the report store (store/feedback.ts), and submit + GitHub filing
 * (server/feedback.ts) against a fake GitHub and scratch directories.
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	conversationExcerpt,
	FeedbackInputError,
	MAX_SCREENSHOTS,
	modelAt,
	parseFeedbackInput,
	SCREENSHOT_MAX_BYTES,
} from "../src/core/feedback.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { ChatRecord } from "../src/core/contracts.ts";
import { createFeedbackStore } from "../src/store/feedback.ts";
import { createGitHubRepoClient } from "../src/server/github.ts";
import { REPORTS_PER_HOUR, FeedbackRateLimitError, resetFeedbackRateForTests, submitFeedback, type FeedbackDeps } from "../src/server/feedback.ts";
import type { ErrorLedgerEntry } from "../src/store/error-ledger.ts";

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function user(id: string, text: string): LhMessage {
	return { role: "user", id, content: [{ type: "text", text }], timestamp: 0 } as unknown as LhMessage;
}
function teacher(id: string, text: string, model = "glm-latest"): LhMessage {
	return { role: "assistant", id, provider: "zai", model, stopReason: "stop", content: [{ type: "text", text }] } as unknown as LhMessage;
}

test("parseFeedbackInput: validates kind, text, ids and screenshots", () => {
	const ok = parseFeedbackInput({ kind: "bug", text: "  it broke  ", chatId: "c_1", messageId: "m-2", screenshots: [{ type: "image/png", data: PNG_1PX }] });
	assert.equal(ok.text, "it broke");
	assert.equal(ok.includeConversation, true); // default on when a chat is given
	assert.equal(ok.screenshots.length, 1);
	assert.equal(parseFeedbackInput({ kind: "idea", text: "x" }).includeConversation, false); // no chat → nothing to include
	assert.equal(parseFeedbackInput({ kind: "bug", text: "x", chatId: "c", includeConversation: false }).includeConversation, false);

	const bad = (body: unknown) => assert.throws(() => parseFeedbackInput(body), FeedbackInputError);
	bad(null);
	bad({ kind: "praise", text: "x" });
	bad({ kind: "bug", text: "   " });
	bad({ kind: "bug", text: "x".repeat(5001) });
	bad({ kind: "bug", text: "x", chatId: "../etc" });
	bad({ kind: "bug", text: "x", screenshots: Array(MAX_SCREENSHOTS + 1).fill({ type: "image/png", data: PNG_1PX }) });
	bad({ kind: "bug", text: "x", screenshots: [{ type: "image/gif", data: PNG_1PX }] });
	bad({ kind: "bug", text: "x", screenshots: [{ type: "image/png", data: "not base64!" }] });
	bad({ kind: "bug", text: "x", screenshots: [{ type: "image/png", data: "A".repeat(Math.ceil((SCREENSHOT_MAX_BYTES + 10) * 4 / 3)) }] });
});

test("conversationExcerpt: 4 before, the message, 1 after; falls back to the tail", () => {
	const msgs = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? user(`m${i}`, `learner ${i}`) : teacher(`m${i}`, `teacher ${i}`)));
	const around = conversationExcerpt(msgs, "m6");
	for (const i of [2, 3, 4, 5, 6, 7]) assert.ok(around.includes(`${i % 2 === 0 ? "learner" : "teacher"} ${i}`), `has ${i}`);
	assert.ok(!around.includes("learner 8"));
	assert.ok(!around.includes("teacher 1"));
	const tail = conversationExcerpt(msgs, "missing");
	assert.ok(tail.includes("teacher 9") && tail.includes("teacher 5") && !tail.includes("learner 4"));
});

test("modelAt: the latest assistant model at or before the message", () => {
	const msgs = [teacher("a", "x", "m1"), user("b", "y"), teacher("c", "z", "m2")];
	assert.equal(modelAt(msgs, "b"), "zai:m1");
	assert.equal(modelAt(msgs), "zai:m2");
});

function setup(opts: { github?: boolean; failContents?: boolean } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-feedback-"));
	const store = createFeedbackStore(dir);
	const calls: { method: string; url: string; body?: Record<string, unknown> }[] = [];
	const fakeFetch = (async (url: string, init: RequestInit) => {
		const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
		const short = url.replace("https://api.github.com/repos/o/errs", "");
		calls.push({ method: init.method ?? "GET", url: short, ...(body ? { body } : {}) });
		if (opts.failContents && short.startsWith("/contents/")) return new Response("forbidden", { status: 403 });
		return new Response(JSON.stringify({ number: 42 }), { status: 201 });
	}) as unknown as typeof fetch;
	const chat: ChatRecord = {
		id: "chat1",
		title: "Abstract machines",
		createdAt: "",
		updatedAt: "",
		messages: [user("u1", "teach me"), teacher("t1", "here is a quiz"), user("u2", "the quiz broke")],
	} as unknown as ChatRecord;
	const errors: ErrorLedgerEntry[] = [
		{ at: "2026-11-12T00:00:00Z", kind: "tool_error", fp: "abc", tool: "quiz", message: "multiSelect needs options", normalized: "", version: "t", unrecovered: false, chatId: "chat1" },
		{ at: "2026-11-12T00:00:00Z", kind: "tool_error", fp: "zzz", message: "other chat", normalized: "", version: "t", unrecovered: false, chatId: "chat2" },
	];
	let clock = Date.parse("2026-11-13T00:00:00Z");
	const deps: FeedbackDeps = {
		store,
		chatStore: { getChat: (id) => (id === chat.id ? chat : null) },
		ledger: { readEntries: () => errors },
		...(opts.github ? { github: createGitHubRepoClient({ token: "t", repo: "o/errs", fetch: fakeFetch }) } : {}),
		now: () => clock,
		version: "0.3.4",
	};
	resetFeedbackRateForTests();
	return { dir, store, calls, deps, tick: (ms: number) => (clock += ms) };
}

test("submit: saves the report with excerpt, the chat's errors and screenshots; no GitHub when unconfigured", async () => {
	const { store, deps, calls, dir } = setup();
	const { report, filed } = submitFeedback(
		parseFeedbackInput({ kind: "bug", text: "quiz broke", chatId: "chat1", messageId: "t1", screenshots: [{ type: "image/png", data: PNG_1PX }] }),
		deps,
	);
	await filed;
	assert.equal(calls.length, 0);
	const [saved] = store.list();
	assert.equal(saved!.id, report.id);
	assert.equal(saved!.chatTitle, "Abstract machines");
	assert.equal(saved!.model, "zai:glm-latest");
	assert.ok(saved!.excerpt?.includes("here is a quiz"));
	assert.deepEqual(saved!.errors?.map((e) => e.fp), ["abc"]);
	assert.equal(saved!.screenshots.length, 1);
	assert.ok(fs.existsSync(path.join(dir, saved!.screenshots[0]!.file)));
});

test("submit: opting out of the conversation drops the excerpt and errors", async () => {
	const { store, deps } = setup();
	await submitFeedback(parseFeedbackInput({ kind: "bug", text: "x", chatId: "chat1", messageId: "t1", includeConversation: false }), deps).filed;
	const [saved] = store.list();
	assert.equal(saved!.excerpt, undefined);
	assert.equal(saved!.errors, undefined);
	assert.equal(saved!.chatId, "chat1");
});

test("filing: screenshots committed to the repo, issue labeled by kind, number recorded", async () => {
	const { store, deps, calls } = setup({ github: true });
	const { report, filed } = submitFeedback(
		parseFeedbackInput({ kind: "bug", text: "quiz broke\nmore detail", chatId: "chat1", messageId: "t1", screenshots: [{ type: "image/png", data: PNG_1PX }] }),
		deps,
	);
	await filed;
	assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [`PUT /contents/screenshots/${report.id}-1.png`, "POST /issues"]);
	assert.equal(calls[0]!.body!.content, PNG_1PX);
	const issue = calls[1]!.body!;
	assert.equal(issue.title, "[bug] quiz broke");
	assert.deepEqual(issue.labels, ["user-report", "user-bug"]);
	const body = issue.body as string;
	assert.ok(body.startsWith(`<!-- lh-report:${report.id} -->`));
	assert.ok(body.includes(`https://github.com/o/errs/blob/HEAD/screenshots/${report.id}-1.png?raw=true`));
	assert.ok(body.includes("multiSelect needs options"));
	assert.ok(body.includes("Conversation excerpt"));
	assert.equal(store.issueFor(report.id), 42);

	await submitFeedback(parseFeedbackInput({ kind: "idea", text: "dark mode" }), deps).filed;
	assert.deepEqual(calls.at(-1)!.body!.labels, ["user-report", "feedback"]);
});

test("filing: a screenshot upload failure still files the issue, with a note", async () => {
	const { deps, calls } = setup({ github: true, failContents: true });
	const origError = console.error;
	console.error = () => {};
	try {
		await submitFeedback(parseFeedbackInput({ kind: "bug", text: "x", screenshots: [{ type: "image/png", data: PNG_1PX }] }), deps).filed;
	} finally {
		console.error = origError;
	}
	const issue = calls.at(-1)!;
	assert.equal(issue.url, "/issues");
	assert.match(issue.body!.body as string, /couldn't be uploaded \(the token needs Contents: read & write\)/);
});

test("rate limit: REPORTS_PER_HOUR per user per rolling hour", () => {
	const { deps, tick } = setup();
	for (let i = 0; i < REPORTS_PER_HOUR; i++) submitFeedback(parseFeedbackInput({ kind: "idea", text: `idea ${i}` }), deps);
	assert.throws(() => submitFeedback(parseFeedbackInput({ kind: "idea", text: "one more" }), deps), FeedbackRateLimitError);
	tick(60 * 60_000 + 1);
	submitFeedback(parseFeedbackInput({ kind: "idea", text: "later" }), deps);
});
