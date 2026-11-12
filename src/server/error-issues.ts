import * as fs from "node:fs";
import * as path from "node:path";
import { DATA_ROOT } from "../../config.ts";
import { errorLedger, type ErrorGroup, type ErrorLedger, type ErrorLedgerEntry } from "../store/error-ledger.ts";
import { onAgentErrors } from "./error-reporting.ts";

/**
 * THE ERROR ISSUE FILER (2026-11, stacked on the error ledger): turns
 * error-ledger fingerprints into GitHub issues in a PRIVATE repo, where
 * the nightly triage agent picks them up.
 *
 * Owner decisions (2026-11-11):
 * - Issues go to a separate PRIVATE repo (LH_ERROR_ISSUES_REPO, e.g.
 *   Dentarthurdent42/learnharness-errors) — the app repo is public and
 *   entries hold learner content, so issues carry the FULL entry.
 * - File a fingerprint once it has occurred FILE_AT_COUNT times, or at
 *   once when any occurrence was unrecovered.
 *
 * After filing, repeats never open new issues: at most one "seen again"
 * comment per fingerprint per COMMENT_INTERVAL_MS. A CLOSED issue whose
 * error recurs is reopened with the `regression` label — but only when
 * this server process started AFTER the issue was closed (otherwise the
 * fix simply isn't deployed yet, and the recurrence is expected).
 *
 * Off unless both LH_ERROR_ISSUES_TOKEN (a fine-grained token with
 * Issues: read & write on that one repo) and LH_ERROR_ISSUES_REPO are
 * set. Never throws into the caller: GitHub being down costs a log line.
 */

export const FILE_AT_COUNT = 3;
export const COMMENT_INTERVAL_MS = 60 * 60_000;
/** Flood guard: new issues per rolling hour, across all fingerprints. */
export const MAX_NEW_ISSUES_PER_HOUR = 10;
export const ISSUE_LABEL = "agent-error";
export const REGRESSION_LABEL = "regression";

export interface IssueRecord {
	number: number;
	filedAt: string;
	/** Occurrence count included in the last issue body/comment. */
	reportedCount: number;
	lastCommentAt: string;
}

type IssueState = Record<string, IssueRecord>;

export interface FilerDeps {
	token: string;
	/** "owner/name" */
	repo: string;
	ledger: ErrorLedger;
	stateFile: string;
	fetch: typeof fetch;
	now: () => number;
	/** When this server process started (the regression rule). */
	startedAt: number;
}

function readState(file: string): IssueState {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as IssueState;
	} catch {
		return {};
	}
}

function writeState(file: string, state: IssueState): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(state, null, "\t"), "utf-8");
	fs.renameSync(tmp, file);
}

/** Should this group be filed now? (pure) */
export function shouldFile(group: Pick<ErrorGroup, "count" | "unrecoveredCount">): boolean {
	return group.unrecoveredCount > 0 || group.count >= FILE_AT_COUNT;
}

function fence(s: string): string {
	const ticks = s.includes("```") ? "````" : "```";
	return `${ticks}\n${s}\n${ticks}`;
}

/** The marker the triage agent (and humans) can grep for. */
export function fingerprintMarker(fp: string): string {
	return `<!-- lh-error-fp:${fp} -->`;
}

export function issueTitle(group: ErrorGroup): string {
	const what = group.tool ? `${group.kind} in ${group.tool}` : group.kind;
	const text = group.normalized.split("\n")[0]!.slice(0, 90);
	return `[${what}] ${text}`;
}

function occurrenceBlock(e: ErrorLedgerEntry): string {
	const lines = [
		`- **When:** ${e.at}`,
		`- **Version:** ${e.version}`,
		...(e.model ? [`- **Model:** ${e.model}`] : []),
		...(e.chatId ? [`- **Chat:** \`${e.chatId}\``] : []),
		...(e.userId ? [`- **User:** \`${e.userId}\``] : []),
		`- **Unrecovered:** ${e.unrecovered ? "yes" : "no"}`,
		"",
		"**Error text**",
		fence(e.message),
	];
	if (e.args) lines.push("", "**Tool arguments**", fence(e.args));
	if (e.detail) lines.push("", "**Detail**", fence(e.detail));
	return lines.join("\n");
}

export function issueBody(group: ErrorGroup): string {
	return [
		fingerprintMarker(group.fp),
		`Filed automatically by the learnharness error filer. See \`docs/agent-errors.md\` in the app repo.`,
		"",
		"| | |",
		"|---|---|",
		`| Kind | \`${group.kind}\` |`,
		...(group.tool ? [`| Tool | \`${group.tool}\` |`] : []),
		`| Fingerprint | \`${group.fp}\` |`,
		`| Occurrences | ${group.count} (${group.unrecoveredCount} unrecovered) in ${group.chats} chat(s) |`,
		`| First / last seen | ${group.firstAt} / ${group.lastAt} |`,
		"",
		"**Normalized text** (what the fingerprint hashes)",
		fence(group.normalized),
		"",
		"## Latest occurrence",
		"",
		occurrenceBlock(group.latest),
		"",
		`All occurrences: \`GET /api/admin/errors?fp=${group.fp}\``,
	].join("\n");
}

export function seenAgainComment(group: ErrorGroup, previous: number): string {
	return [
		`Seen again: **${group.count}** occurrences now (was ${previous}), ${group.unrecoveredCount} unrecovered, in ${group.chats} chat(s). Last seen ${group.lastAt}.`,
		"",
		"<details><summary>Latest occurrence</summary>",
		"",
		occurrenceBlock(group.latest),
		"",
		"</details>",
	].join("\n");
}

export interface ErrorIssueFiler {
	/** Handle one recorded batch (what the onAgentErrors listener calls). */
	handle(entries: readonly ErrorLedgerEntry[]): Promise<void>;
}

export function createErrorIssueFiler(deps: FilerDeps): ErrorIssueFiler {
	const inFlight = new Set<string>();
	const createdAt: number[] = [];

	async function gh(method: string, url: string, body?: unknown): Promise<Record<string, unknown>> {
		const res = await deps.fetch(`https://api.github.com/repos/${deps.repo}${url}`, {
			method,
			headers: {
				Authorization: `Bearer ${deps.token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "learnharness-error-filer",
				...(body ? { "Content-Type": "application/json" } : {}),
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`GitHub ${method} ${url} → ${res.status}: ${text.slice(0, 300)}`);
		}
		return (await res.json()) as Record<string, unknown>;
	}

	async function fileOrUpdate(group: ErrorGroup): Promise<void> {
		const state = readState(deps.stateFile);
		const record = state[group.fp];
		const now = deps.now();

		if (!record) {
			if (!shouldFile(group)) return;
			while (createdAt.length && createdAt[0]! < now - 60 * 60_000) createdAt.shift();
			if (createdAt.length >= MAX_NEW_ISSUES_PER_HOUR) return; // retried on the next occurrence
			createdAt.push(now);
			const labels = [ISSUE_LABEL, ...(group.unrecoveredCount > 0 ? ["unrecovered"] : [])];
			const issue = await gh("POST", "/issues", { title: issueTitle(group), body: issueBody(group), labels });
			state[group.fp] = {
				number: issue.number as number,
				filedAt: new Date(now).toISOString(),
				reportedCount: group.count,
				lastCommentAt: new Date(now).toISOString(),
			};
			writeState(deps.stateFile, state);
			return;
		}

		if (group.count <= record.reportedCount) return;
		if (now - Date.parse(record.lastCommentAt) < COMMENT_INTERVAL_MS) return;

		const issue = await gh("GET", `/issues/${record.number}`);
		const closedAt = typeof issue.closed_at === "string" ? Date.parse(issue.closed_at) : undefined;
		const reopen = issue.state === "closed" && closedAt !== undefined && closedAt < deps.startedAt;
		if (issue.state === "closed" && !reopen) return; // fix merged but not deployed yet
		if (reopen) {
			await gh("PATCH", `/issues/${record.number}`, { state: "open" });
			await gh("POST", `/issues/${record.number}/labels`, { labels: [REGRESSION_LABEL] });
		}
		const prefix = reopen
			? `**Regression:** this came back after the issue was closed (the server was deployed after the close).\n\n`
			: "";
		await gh("POST", `/issues/${record.number}/comments`, { body: prefix + seenAgainComment(group, record.reportedCount) });
		state[group.fp] = { ...record, reportedCount: group.count, lastCommentAt: new Date(now).toISOString() };
		writeState(deps.stateFile, state);
	}

	return {
		async handle(entries) {
			const fps = [...new Set(entries.map((e) => e.fp))].filter((fp) => !inFlight.has(fp));
			if (fps.length === 0) return;
			for (const fp of fps) inFlight.add(fp);
			try {
				const groups = new Map(deps.ledger.readGroups().map((g) => [g.fp, g]));
				for (const fp of fps) {
					const group = groups.get(fp);
					if (!group) continue;
					try {
						await fileOrUpdate(group);
					} catch (err) {
						console.error(`[errors] issue filer failed for ${fp}:`, err);
					}
				}
			} finally {
				for (const fp of fps) inFlight.delete(fp);
			}
		},
	};
}

interface LhIssueFilerGlobal {
	__lhErrorIssueFiler?: boolean;
}

/** Start the filer once per process when configured (composition root). */
export function startErrorIssueFiler(): void {
	const g = globalThis as typeof globalThis & LhIssueFilerGlobal;
	if (g.__lhErrorIssueFiler) return;
	const token = process.env.LH_ERROR_ISSUES_TOKEN;
	const repo = process.env.LH_ERROR_ISSUES_REPO;
	if (!token || !repo || process.env.NODE_ENV === "test") return;
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
		console.error(`[errors] LH_ERROR_ISSUES_REPO must be "owner/name", got ${JSON.stringify(repo)}`);
		return;
	}
	g.__lhErrorIssueFiler = true;
	const filer = createErrorIssueFiler({
		token,
		repo,
		ledger: errorLedger,
		stateFile: path.join(DATA_ROOT, "errors", "issues.json"),
		fetch: globalThis.fetch.bind(globalThis),
		now: Date.now,
		startedAt: Date.now(),
	});
	onAgentErrors((entries) => void filer.handle(entries));
	console.info(`[errors] filing agent-error issues to ${repo}`);
}
