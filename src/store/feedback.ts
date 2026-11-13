import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_ROOT } from "../../config.ts";
import { screenshotExtension, type FeedbackKind, type ScreenshotInput, type ScreenshotType } from "../core/feedback.ts";

/**
 * THE USER-REPORT STORE (2026-11): server-wide like the error ledger —
 * <data>/feedback/reports.jsonl (one line per report) plus the screenshot
 * files under <data>/feedback/screens/. Reports are saved here first,
 * always; filing them to GitHub is a separate best-effort step whose
 * issue numbers land in <data>/feedback/issues.json.
 */

export interface ReportedError {
	at: string;
	kind: string;
	tool?: string;
	message: string;
	fp: string;
}

export interface FeedbackReport {
	id: string;
	at: string;
	kind: FeedbackKind;
	text: string;
	userId?: string;
	username?: string;
	chatId?: string;
	chatTitle?: string;
	messageId?: string;
	model?: string;
	version: string;
	/** Markdown excerpt of the conversation (only when the reporter opted in). */
	excerpt?: string;
	/** That chat's logged errors (only when the reporter opted in). */
	errors?: ReportedError[];
	/** Screenshot files, relative to the feedback directory. */
	screenshots: { file: string; type: ScreenshotType }[];
}

export interface FeedbackStore {
	readonly dir: string;
	newId(): string;
	/** Write the screenshots and append the report line. */
	save(report: Omit<FeedbackReport, "screenshots">, screenshots: readonly ScreenshotInput[]): FeedbackReport;
	list(): FeedbackReport[];
	readScreenshot(file: string): Buffer;
	issueFor(id: string): number | undefined;
	setIssue(id: string, number: number): void;
}

export function createFeedbackStore(dir: string): FeedbackStore {
	const reportsFile = path.join(dir, "reports.jsonl");
	const issuesFile = path.join(dir, "issues.json");
	const readIssues = (): Record<string, number> => {
		try {
			return JSON.parse(fs.readFileSync(issuesFile, "utf-8")) as Record<string, number>;
		} catch {
			return {};
		}
	};
	return {
		dir,
		newId() {
			const d = new Date();
			const stamp = d.toISOString().slice(0, 10).replace(/-/g, "");
			return `r${stamp}-${randomBytes(4).toString("hex")}`;
		},
		save(report, screenshots) {
			fs.mkdirSync(path.join(dir, "screens"), { recursive: true });
			const files = screenshots.map((s, i) => {
				const file = `screens/${report.id}-${i + 1}.${screenshotExtension(s.type)}`;
				fs.writeFileSync(path.join(dir, file), Buffer.from(s.data, "base64"));
				return { file, type: s.type };
			});
			const full: FeedbackReport = { ...report, screenshots: files };
			fs.appendFileSync(reportsFile, `${JSON.stringify(full)}\n`, "utf-8");
			return full;
		},
		list() {
			let raw: string;
			try {
				raw = fs.readFileSync(reportsFile, "utf-8");
			} catch {
				return [];
			}
			const out: FeedbackReport[] = [];
			for (const line of raw.split("\n")) {
				if (!line.trim()) continue;
				try {
					out.push(JSON.parse(line) as FeedbackReport);
				} catch {
					/* torn final line */
				}
			}
			return out;
		},
		readScreenshot(file) {
			if (!/^screens\/[\w-]+\.(png|jpg|webp)$/.test(file)) throw new Error("invalid screenshot path");
			return fs.readFileSync(path.join(dir, file));
		},
		issueFor(id) {
			return readIssues()[id];
		},
		setIssue(id, number) {
			const issues = readIssues();
			issues[id] = number;
			fs.mkdirSync(dir, { recursive: true });
			const tmp = `${issuesFile}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(issues, null, "\t"), "utf-8");
			fs.renameSync(tmp, issuesFile);
		},
	};
}

/** The app's one report store, under DATA_ROOT (server-wide). */
export const feedbackStore = createFeedbackStore(path.join(DATA_ROOT, "feedback"));
