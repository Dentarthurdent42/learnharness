import * as path from "node:path";
import { currentUser } from "../../tenancy.ts";
import { conversationExcerpt, modelAt, type FeedbackInput } from "../core/feedback.ts";
import type { ChatStore } from "../core/ports.ts";
import { errorLedger, appVersion, type ErrorLedger } from "../store/error-ledger.ts";
import { feedbackStore, type FeedbackReport, type FeedbackStore } from "../store/feedback.ts";
import { configuredGitHubRepo, type GitHubRepoClient } from "./github.ts";
import { stores } from "./stores.ts";

/**
 * USER REPORTS — the server seam (2026-11, owner-approved plan).
 *
 * submitFeedback saves the report (always), then files it to the private
 * repo in the background when LH_ERROR_ISSUES_TOKEN/REPO are set:
 * screenshots are committed to screenshots/ in that repo (the token needs
 * Contents: read & write) and shown inline; the issue is labeled
 * user-report plus user-bug (the nightly triage takes these) or feedback
 * (waits for the owner). A screenshot upload failure never blocks the
 * issue — the body says so and the files stay on the server.
 */

export const REPORTS_PER_HOUR = 10;
const MAX_REPORTED_ERRORS = 10;

export class FeedbackRateLimitError extends Error {}

interface LhFeedbackGlobal {
	__lhFeedbackRate?: Map<string, number[]>;
}

function rateMap(): Map<string, number[]> {
	const g = globalThis as typeof globalThis & LhFeedbackGlobal;
	return (g.__lhFeedbackRate ??= new Map());
}

export interface FeedbackDeps {
	store: FeedbackStore;
	chatStore: Pick<ChatStore, "getChat">;
	ledger: Pick<ErrorLedger, "readEntries">;
	github?: GitHubRepoClient;
	now: () => number;
	version: string;
}

function defaultDeps(): FeedbackDeps {
	return {
		store: feedbackStore,
		chatStore: stores.chatStore,
		ledger: errorLedger,
		github: configuredGitHubRepo(),
		now: Date.now,
		version: appVersion(),
	};
}

/** Save a report (and file it in the background). Throws
 *  FeedbackRateLimitError past REPORTS_PER_HOUR for this user. */
export function submitFeedback(
	input: FeedbackInput,
	deps: FeedbackDeps = defaultDeps(),
): { report: FeedbackReport; filed: Promise<void> } {
	const user = currentUser();
	const rateKey = user?.userId ?? "local";
	const now = deps.now();
	const recent = (rateMap().get(rateKey) ?? []).filter((t) => t > now - 60 * 60_000);
	if (recent.length >= REPORTS_PER_HOUR) {
		throw new FeedbackRateLimitError("You've sent a lot of reports in the last hour. Please try again later.");
	}
	rateMap().set(rateKey, [...recent, now]);

	const chat = input.chatId ? deps.chatStore.getChat(input.chatId) : null;
	const report = deps.store.save(
		{
			id: deps.store.newId(),
			at: new Date(now).toISOString(),
			kind: input.kind,
			text: input.text,
			...(user ? { userId: user.userId, username: user.username } : {}),
			...(chat ? { chatId: chat.id, chatTitle: chat.title } : {}),
			...(chat && input.messageId ? { messageId: input.messageId } : {}),
			...(chat ? (() => {
				const model = modelAt(chat.messages, input.messageId);
				return model ? { model } : {};
			})() : {}),
			version: deps.version,
			...(chat && input.includeConversation
				? {
						excerpt: conversationExcerpt(chat.messages, input.messageId),
						errors: deps.ledger
							.readEntries()
							.filter((e) => e.chatId === chat.id)
							.slice(-MAX_REPORTED_ERRORS)
							.map((e) => ({ at: e.at, kind: e.kind, ...(e.tool ? { tool: e.tool } : {}), message: e.message, fp: e.fp })),
					}
				: {}),
		},
		input.screenshots,
	);
	const filed = deps.github
		? fileReport(deps.github, deps.store, report).then(
				() => undefined,
				(err: unknown) => console.error(`[feedback] filing ${report.id} failed:`, err),
			)
		: Promise.resolve();
	return { report, filed };
}

export function reportIssueTitle(report: FeedbackReport): string {
	const first = report.text.split("\n")[0]!.trim();
	return `[${report.kind}] ${first.length > 80 ? `${first.slice(0, 79)}…` : first}`;
}

function fence(s: string): string {
	const ticks = s.includes("```") ? "````" : "```";
	return `${ticks}\n${s}\n${ticks}`;
}

export function reportIssueBody(report: FeedbackReport, shotUrls: string[], uploadFailed: boolean): string {
	const quoted = report.text.split("\n").map((l) => `> ${l}`).join("\n");
	const lines = [
		`<!-- lh-report:${report.id} -->`,
		`**${report.kind === "bug" ? "Bug report" : "Idea / feedback"}** from ${report.username ? `\`${report.username}\`` : "the desktop app"}`,
		"",
		quoted,
		"",
		"| | |",
		"|---|---|",
		`| Report | \`${report.id}\` |`,
		`| When | ${report.at} |`,
		`| Version | ${report.version} |`,
		...(report.model ? [`| Model | ${report.model} |`] : []),
		...(report.chatId ? [`| Chat | \`${report.chatId}\`${report.chatTitle ? ` (${report.chatTitle.replace(/\|/g, "\\|")})` : ""} |`] : []),
		...(report.messageId ? [`| Message | \`${report.messageId}\` |`] : []),
		...(report.userId ? [`| User id | \`${report.userId}\` |`] : []),
	];
	if (shotUrls.length > 0) {
		lines.push("", "## Screenshots", "", ...shotUrls.map((u, i) => `![Screenshot ${i + 1}](${u})`));
	}
	if (uploadFailed) {
		lines.push(
			"",
			`_${report.screenshots.length} screenshot(s) couldn't be uploaded (the token needs Contents: read & write). They're on the server under \`/data/feedback/screens/\`._`,
		);
	}
	if (report.chatId && !report.excerpt) lines.push("", "_The reporter chose not to include the conversation._");
	if (report.errors && report.errors.length > 0) {
		lines.push(
			"",
			"## Logged errors in this chat",
			"",
			...report.errors.map((e) => `- ${e.at} \`${e.kind}\`${e.tool ? ` in \`${e.tool}\`` : ""} (fp \`${e.fp}\`): ${e.message.split("\n")[0]!.slice(0, 200)}`),
		);
	}
	if (report.excerpt) {
		lines.push("", "<details><summary>Conversation excerpt</summary>", "", fence(report.excerpt), "", "</details>");
	}
	return lines.join("\n");
}

/** Commit the screenshots to the private repo, then open the issue. */
export async function fileReport(github: GitHubRepoClient, store: FeedbackStore, report: FeedbackReport): Promise<number> {
	const existing = store.issueFor(report.id);
	if (existing) return existing;
	const shotUrls: string[] = [];
	let uploadFailed = false;
	for (const shot of report.screenshots) {
		const name = path.posix.basename(shot.file);
		try {
			await github.request("PUT", `/contents/screenshots/${name}`, {
				message: `Screenshot for user report ${report.id}`,
				content: store.readScreenshot(shot.file).toString("base64"),
			});
			shotUrls.push(`https://github.com/${github.repo}/blob/HEAD/screenshots/${name}?raw=true`);
		} catch (err) {
			uploadFailed = true;
			console.error(`[feedback] screenshot upload failed for ${report.id}:`, err);
		}
	}
	const issue = await github.request("POST", "/issues", {
		title: reportIssueTitle(report),
		body: reportIssueBody(report, shotUrls, uploadFailed),
		labels: ["user-report", report.kind === "bug" ? "user-bug" : "feedback"],
	});
	const number = issue.number as number;
	store.setIssue(report.id, number);
	return number;
}

/** Test seam: forget the per-user rate windows. */
export function resetFeedbackRateForTests(): void {
	rateMap().clear();
}
