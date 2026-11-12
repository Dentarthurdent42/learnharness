/**
 * Error issue filer tests (server/error-issues.ts) — a fake GitHub over a
 * scratch ledger: the filing threshold, no duplicate issues, the hourly
 * comment throttle, and the regression reopen rule.
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createErrorLedger, toLedgerEntry, type ErrorLedgerEntry } from "../src/store/error-ledger.ts";
import { COMMENT_INTERVAL_MS, createErrorIssueFiler, FILE_AT_COUNT, fingerprintMarker } from "../src/server/error-issues.ts";
import type { AgentErrorEvent } from "../src/core/agent-errors.ts";

interface Call {
	method: string;
	url: string;
	body?: Record<string, unknown>;
}

function setup(opts: { issueState?: () => { state: string; closed_at: string | null }; startedAt?: number } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-issues-"));
	const ledger = createErrorLedger(dir);
	const calls: Call[] = [];
	let clock = Date.parse("2026-11-11T00:00:00Z");
	const fakeFetch = (async (url: string, init: RequestInit) => {
		const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
		calls.push({ method: init.method ?? "GET", url: url.replace("https://api.github.com/repos/o/errs", ""), ...(body ? { body } : {}) });
		const payload = init.method === "GET" ? { number: 7, ...(opts.issueState?.() ?? { state: "open", closed_at: null }) } : { number: 7 };
		return new Response(JSON.stringify(payload), { status: 200 });
	}) as unknown as typeof fetch;
	const filer = createErrorIssueFiler({
		token: "t",
		repo: "o/errs",
		ledger,
		stateFile: path.join(dir, "issues.json"),
		fetch: fakeFetch,
		now: () => clock,
		startedAt: opts.startedAt ?? clock,
	});
	async function occur(event: Partial<AgentErrorEvent> = {}): Promise<ErrorLedgerEntry> {
		const e = toLedgerEntry(
			{ kind: "tool_error", tool: "quiz", message: "multiSelect needs options", unrecovered: false, chatId: "c1", ...event },
			{ version: "t", at: new Date(clock) },
		);
		ledger.append([e]);
		await filer.handle([e]);
		return e;
	}
	return { calls, occur, tick: (ms: number) => (clock += ms) };
}

test("files only once a fingerprint repeats FILE_AT_COUNT times; body carries the marker and full entry", async () => {
	const { calls, occur } = setup();
	for (let i = 1; i < FILE_AT_COUNT; i++) await occur();
	assert.equal(calls.length, 0);
	const e = await occur({ args: { multiSelect: true } });
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.method, "POST");
	assert.equal(calls[0]!.url, "/issues");
	const body = calls[0]!.body!;
	assert.deepEqual(body.labels, ["agent-error"]);
	assert.match(body.title as string, /^\[tool_error in quiz\] multiSelect needs options/);
	assert.ok((body.body as string).includes(fingerprintMarker(e.fp)));
	assert.ok((body.body as string).includes('{"multiSelect":true}'));
});

test("an unrecovered occurrence files immediately, labeled unrecovered", async () => {
	const { calls, occur } = setup();
	await occur({ kind: "turn_error", tool: undefined, message: "provider 500", unrecovered: true });
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0]!.body!.labels, ["agent-error", "unrecovered"]);
});

test("repeats after filing: no new issue; at most one comment per interval", async () => {
	const { calls, occur, tick } = setup();
	await occur({ unrecovered: true });
	await occur();
	await occur();
	assert.equal(calls.length, 1); // inside the interval: silent
	tick(COMMENT_INTERVAL_MS + 1);
	await occur();
	assert.deepEqual(
		calls.slice(1).map((c) => `${c.method} ${c.url}`),
		["GET /issues/7", "POST /issues/7/comments"],
	);
	assert.match(calls[2]!.body!.body as string, /\*\*4\*\* occurrences now \(was 1\)/);
});

test("a closed issue recurs: reopened as a regression only if the server started after the close", async () => {
	const closedAt = "2026-11-10T12:00:00Z";
	const deployedAfter = setup({ issueState: () => ({ state: "closed", closed_at: closedAt }), startedAt: Date.parse("2026-11-10T13:00:00Z") });
	await deployedAfter.occur({ unrecovered: true });
	deployedAfter.tick(COMMENT_INTERVAL_MS + 1);
	await deployedAfter.occur();
	assert.deepEqual(
		deployedAfter.calls.slice(1).map((c) => `${c.method} ${c.url}`),
		["GET /issues/7", "PATCH /issues/7", "POST /issues/7/labels", "POST /issues/7/comments"],
	);
	assert.match(deployedAfter.calls[4]!.body!.body as string, /^\*\*Regression:\*\*/);

	const notDeployed = setup({ issueState: () => ({ state: "closed", closed_at: closedAt }), startedAt: Date.parse("2026-11-10T11:00:00Z") });
	await notDeployed.occur({ unrecovered: true });
	notDeployed.tick(COMMENT_INTERVAL_MS + 1);
	await notDeployed.occur();
	assert.deepEqual(notDeployed.calls.slice(1).map((c) => `${c.method} ${c.url}`), ["GET /issues/7"]);
});

test("a GitHub failure is logged, not thrown, and the fingerprint is retried next time", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-issues-"));
	const ledger = createErrorLedger(dir);
	let fail = true;
	let posts = 0;
	const filer = createErrorIssueFiler({
		token: "t",
		repo: "o/errs",
		ledger,
		stateFile: path.join(dir, "issues.json"),
		fetch: (async () => {
			posts++;
			return fail ? new Response("nope", { status: 502 }) : new Response(JSON.stringify({ number: 1 }), { status: 201 });
		}) as unknown as typeof fetch,
		now: Date.now,
		startedAt: Date.now(),
	});
	const e = toLedgerEntry({ kind: "stream_error", message: "boom", unrecovered: true }, { version: "t" });
	ledger.append([e]);
	const origError = console.error;
	console.error = () => {};
	try {
		await filer.handle([e]);
	} finally {
		console.error = origError;
	}
	fail = false;
	await filer.handle([e]);
	assert.equal(posts, 2);
	assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "issues.json"), "utf-8"))[e.fp].number, 1);
});
