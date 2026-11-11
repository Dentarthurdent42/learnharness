import * as fs from "node:fs";
import * as path from "node:path";
import { DATA_ROOT, ROOT } from "../../config.ts";
import { errorFingerprint, normalizeErrorText, type AgentErrorEvent, type AgentErrorKind } from "../core/agent-errors.ts";

/**
 * THE ERROR LEDGER (2026-11): one append-only, SERVER-WIDE JSONL of every
 * agent failure (<data>/errors/errors.jsonl) — developer diagnostics like
 * PATHS.debug, never per user (the admin reads one picture across all
 * accounts; each entry carries the userId it happened to).
 *
 * Size-capped: once the live file passes maxBytes it rotates to
 * errors.1.jsonl (one generation kept, the older one is dropped), so a
 * runaway error loop can never fill the volume. Reads fold both files.
 *
 * Entries hold the RAW error text and the call's arguments, which can
 * contain learner content — this file is admin-only (GET /api/admin/errors)
 * and never leaves the server except through a deliberate filer.
 */

export interface ErrorLedgerEntry {
	at: string;
	kind: AgentErrorKind;
	fp: string;
	tool?: string;
	message: string;
	normalized: string;
	/** JSON of the failing call's arguments, truncated. */
	args?: string;
	detail?: string;
	model?: string;
	chatId?: string;
	userId?: string;
	version: string;
	unrecovered: boolean;
}

export interface ErrorGroup {
	fp: string;
	kind: AgentErrorKind;
	tool?: string;
	normalized: string;
	count: number;
	unrecoveredCount: number;
	firstAt: string;
	lastAt: string;
	/** Distinct chats the error appeared in. */
	chats: number;
	/** The most recent occurrence, in full. */
	latest: ErrorLedgerEntry;
}

const MESSAGE_CAP = 2_000;
const ARGS_CAP = 4_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** The running build: package version plus Fly's image ref when deployed. */
export function appVersion(): string {
	const pkg = process.env.npm_package_version ?? readPackageVersion();
	const image = process.env.FLY_IMAGE_REF;
	return image ? `${pkg} (${image.split(":").pop()})` : pkg;
}

let cachedVersion: string | undefined;
function readPackageVersion(): string {
	if (cachedVersion) return cachedVersion;
	try {
		const raw = fs.readFileSync(path.join(ROOT, "package.json"), "utf-8");
		cachedVersion = (JSON.parse(raw) as { version?: string }).version ?? "unknown";
	} catch {
		cachedVersion = "unknown";
	}
	return cachedVersion;
}

function truncate(s: string, cap: number): string {
	return s.length > cap ? `${s.slice(0, cap)}… [truncated ${s.length - cap} chars]` : s;
}

/** Build the stored entry for one event (pure apart from the clock). */
export function toLedgerEntry(
	event: AgentErrorEvent,
	extra: { userId?: string; version?: string; at?: Date } = {},
): ErrorLedgerEntry {
	let args: string | undefined;
	if (event.args !== undefined) {
		try {
			args = truncate(JSON.stringify(event.args), ARGS_CAP);
		} catch {
			args = "[unserializable]";
		}
	}
	return {
		at: (extra.at ?? new Date()).toISOString(),
		kind: event.kind,
		fp: errorFingerprint(event.kind, event.tool, event.message),
		...(event.tool ? { tool: event.tool } : {}),
		message: truncate(event.message, MESSAGE_CAP),
		normalized: normalizeErrorText(event.message),
		...(args !== undefined ? { args } : {}),
		...(event.detail ? { detail: truncate(event.detail, MESSAGE_CAP) } : {}),
		...(event.model ? { model: event.model } : {}),
		...(event.chatId ? { chatId: event.chatId } : {}),
		...(extra.userId ? { userId: extra.userId } : {}),
		version: extra.version ?? appVersion(),
		unrecovered: event.unrecovered,
	};
}

export interface ErrorLedger {
	append(entries: readonly ErrorLedgerEntry[]): void;
	readEntries(): ErrorLedgerEntry[];
	/** Entries grouped by fingerprint, most recently seen first. */
	readGroups(): ErrorGroup[];
}

export function createErrorLedger(dir: string, opts: { maxBytes?: number } = {}): ErrorLedger {
	const live = path.join(dir, "errors.jsonl");
	const rotated = path.join(dir, "errors.1.jsonl");
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

	function readFile(file: string): ErrorLedgerEntry[] {
		let raw: string;
		try {
			raw = fs.readFileSync(file, "utf-8");
		} catch {
			return [];
		}
		const out: ErrorLedgerEntry[] = [];
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				const e = JSON.parse(line) as ErrorLedgerEntry;
				if (typeof e.fp === "string" && typeof e.at === "string") out.push(e);
			} catch {
				/* a torn final line — skip */
			}
		}
		return out;
	}

	return {
		append(entries) {
			if (entries.length === 0) return;
			fs.mkdirSync(dir, { recursive: true });
			let size = 0;
			try {
				size = fs.statSync(live).size;
			} catch {
				/* no file yet */
			}
			if (size >= maxBytes) fs.renameSync(live, rotated);
			fs.appendFileSync(live, entries.map((e) => `${JSON.stringify(e)}\n`).join(""), "utf-8");
		},
		readEntries() {
			return [...readFile(rotated), ...readFile(live)];
		},
		readGroups() {
			const groups = new Map<string, ErrorGroup & { chatSet: Set<string> }>();
			for (const e of this.readEntries()) {
				const g = groups.get(e.fp);
				if (!g) {
					groups.set(e.fp, {
						fp: e.fp,
						kind: e.kind,
						...(e.tool ? { tool: e.tool } : {}),
						normalized: e.normalized,
						count: 1,
						unrecoveredCount: e.unrecovered ? 1 : 0,
						firstAt: e.at,
						lastAt: e.at,
						chats: 0,
						latest: e,
						chatSet: new Set(e.chatId ? [e.chatId] : []),
					});
					continue;
				}
				g.count++;
				if (e.unrecovered) g.unrecoveredCount++;
				if (e.at < g.firstAt) g.firstAt = e.at;
				if (e.at >= g.lastAt) {
					g.lastAt = e.at;
					g.latest = e;
				}
				if (e.chatId) g.chatSet.add(e.chatId);
			}
			return [...groups.values()]
				.map(({ chatSet, ...g }) => ({ ...g, chats: chatSet.size }))
				.sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
		},
	};
}

/** The app's one ledger, under DATA_ROOT (server-wide, never per user). */
export const errorLedger = createErrorLedger(path.join(DATA_ROOT, "errors"));
