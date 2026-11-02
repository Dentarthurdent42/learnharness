import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { ACCOUNTS_DIR } from "../../config.ts";
import type { Role } from "../../tenancy.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { DEFAULT_ALLOWANCE, type AllowanceConfig } from "../core/allowance.ts";

/**
 * THE ACCOUNT STORE (cloud mode, 2026-11): users, login sessions, and the
 * one-time invite / password-reset links — three small JSON files under
 * <DATA_ROOT>/accounts/, server-wide (never per user). Read-modify-write
 * like settings.json, written atomically (tmp + rename). Every mutation is
 * synchronous between its read and its write, so the single Node process
 * never interleaves two of them.
 *
 * SECRETS AT REST: passwords as scrypt hashes; session and link tokens as
 * SHA-256 digests — the raw token exists only in the cookie / the link the
 * admin hands out, so a leaked accounts dir logs nobody in.
 *
 * Owner-approved defaults (2026-11): sessions last 30 days, renewed on use;
 * invite links 7 days, reset links 24 hours, both single-use; usernames
 * 3–32 of [A-Za-z0-9._-], case-insensitive; passwords at least 10 chars.
 */

export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
/** Renew a session's expiry at most this often (one write per day per
 *  session, not one per request). */
const SESSION_RENEW_AFTER_MS = 24 * 60 * 60_000;
export const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
export const RESET_TTL_MS = 24 * 60 * 60_000;
export const MIN_PASSWORD_LENGTH = 10;
/** A password over this is refused before hashing (scrypt cost guard). */
export const MAX_PASSWORD_LENGTH = 1024;
const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;

export interface UserRecord {
	id: string;
	/** As typed at sign-up (display form). */
	username: string;
	/** Lowercased — the uniqueness and login key. */
	usernameKey: string;
	passwordHash: string;
	role: Role;
	disabled: boolean;
	createdAt: number;
	/** Allowance override, USD; absent = the server default. */
	limitUsd?: number;
}

export interface SessionRecord {
	/** SHA-256 of the cookie token (hex). */
	tokenHash: string;
	userId: string;
	createdAt: number;
	expiresAt: number;
}

export type LinkKind = "invite" | "reset";

export interface LinkRecord {
	/** SHA-256 of the link token (hex). */
	tokenHash: string;
	kind: LinkKind;
	/** reset: the account whose password the link sets. invite: absent. */
	userId?: string;
	createdBy: string;
	createdAt: number;
	expiresAt: number;
	usedAt?: number;
}

/** The safe projection for the admin list (no hash). */
export interface UserSummary {
	id: string;
	username: string;
	role: Role;
	disabled: boolean;
	createdAt: number;
	limitUsd?: number;
}

export class AccountError extends Error {
	constructor(
		readonly code:
			| "invalid_username"
			| "username_taken"
			| "weak_password"
			| "password_too_long"
			| "invalid_link"
			| "not_found"
			| "invalid_limit",
		message: string,
	) {
		super(message);
	}
}

// ─── files ───────────────────────────────────────────────────────────────────

const usersFile = () => path.join(ACCOUNTS_DIR, "users.json");
const sessionsFile = () => path.join(ACCOUNTS_DIR, "sessions.json");
const linksFile = () => path.join(ACCOUNTS_DIR, "links.json");

function readList<T>(file: string): T[] {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	const parsed = JSON.parse(raw) as unknown;
	return Array.isArray(parsed) ? (parsed as T[]) : [];
}

function writeList<T>(file: string, list: T[]): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.tmp-${crypto.randomUUID().slice(0, 8)}`;
	fs.writeFileSync(tmp, JSON.stringify(list, null, "\t"), { encoding: "utf-8", mode: 0o600 });
	fs.renameSync(tmp, file);
}

// ─── primitives ──────────────────────────────────────────────────────────────

const scrypt = promisify(crypto.scrypt) as (
	password: string,
	salt: Buffer,
	keylen: number,
	options: crypto.ScryptOptions,
) => Promise<Buffer>;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEY_LEN = 32;

export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.randomBytes(16);
	const key = await scrypt(password, salt, KEY_LEN, SCRYPT);
	return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [scheme, n, r, p, salt, key] = stored.split("$");
	if (scheme !== "scrypt" || !n || !r || !p || !salt || !key) return false;
	const expected = Buffer.from(key, "base64url");
	const actual = await scrypt(password, Buffer.from(salt, "base64url"), expected.length, {
		N: Number(n),
		r: Number(r),
		p: Number(p),
		maxmem: SCRYPT.maxmem,
	});
	return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** A hash to verify against when the username doesn't exist — keeps the
 *  login's timing the same for unknown and known users. */
let dummyHash: Promise<string> | undefined;
export function dummyPasswordHash(): Promise<string> {
	return (dummyHash ??= hashPassword(crypto.randomBytes(16).toString("hex")));
}

export function newToken(): string {
	return crypto.randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
	return crypto.createHash("sha256").update(token).digest("hex");
}

function newUserId(): string {
	return `u_${crypto.randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9]/g, "")}`;
}

export function validateUsername(username: string): string {
	const trimmed = username.trim();
	if (!USERNAME_RE.test(trimmed)) {
		throw new AccountError("invalid_username", "Usernames are 3–32 characters: letters, numbers, dots, dashes and underscores.");
	}
	return trimmed;
}

export function validatePassword(password: string): void {
	if (password.length > MAX_PASSWORD_LENGTH) throw new AccountError("password_too_long", "That password is too long.");
	if (password.length < MIN_PASSWORD_LENGTH) {
		throw new AccountError("weak_password", `Passwords need at least ${MIN_PASSWORD_LENGTH} characters.`);
	}
}

export function summarize(user: UserRecord): UserSummary {
	return {
		id: user.id,
		username: user.username,
		role: user.role,
		disabled: user.disabled,
		createdAt: user.createdAt,
		...(user.limitUsd !== undefined ? { limitUsd: user.limitUsd } : {}),
	};
}

// ─── users ───────────────────────────────────────────────────────────────────

export function listUsers(): UserRecord[] {
	return readList<UserRecord>(usersFile());
}

export function getUser(id: string): UserRecord | undefined {
	return listUsers().find((u) => u.id === id);
}

export function findUserByUsername(username: string): UserRecord | undefined {
	const key = username.trim().toLowerCase();
	return listUsers().find((u) => u.usernameKey === key);
}

/** Create an account. The password is hashed BEFORE the read-modify-write
 *  (the await), and uniqueness is re-checked inside it. */
export async function createUser(input: { username: string; password: string; role: Role }): Promise<UserRecord> {
	const username = validateUsername(input.username);
	validatePassword(input.password);
	const passwordHash = await hashPassword(input.password);
	const users = listUsers();
	const usernameKey = username.toLowerCase();
	if (users.some((u) => u.usernameKey === usernameKey)) throw new AccountError("username_taken", "That username is taken.");
	const user: UserRecord = {
		id: newUserId(),
		username,
		usernameKey,
		passwordHash,
		role: input.role,
		disabled: false,
		createdAt: Date.now(),
	};
	writeList(usersFile(), [...users, user]);
	return user;
}

function updateUser(id: string, patch: Partial<Pick<UserRecord, "passwordHash" | "disabled" | "limitUsd">>): UserRecord {
	const users = listUsers();
	const i = users.findIndex((u) => u.id === id);
	const current = users[i];
	if (!current) throw new AccountError("not_found", "No such user.");
	const next = { ...current, ...patch };
	if (next.limitUsd === undefined) delete next.limitUsd;
	users[i] = next;
	writeList(usersFile(), users);
	return next;
}

/** Disable or re-enable an account. Disabling also ends its sessions. */
export function setUserDisabled(id: string, disabled: boolean): UserRecord {
	const user = updateUser(id, { disabled });
	if (disabled) deleteSessionsForUser(id);
	return user;
}

export async function setPassword(id: string, password: string): Promise<void> {
	validatePassword(password);
	const passwordHash = await hashPassword(password);
	updateUser(id, { passwordHash });
	deleteSessionsForUser(id);
}

// ─── sessions ────────────────────────────────────────────────────────────────

function liveSessions(now: number): SessionRecord[] {
	return readList<SessionRecord>(sessionsFile()).filter((s) => s.expiresAt > now);
}

/** Start a session; returns the raw cookie token (stored only hashed). */
export function createSession(userId: string, now = Date.now()): string {
	const token = newToken();
	const session: SessionRecord = { tokenHash: hashToken(token), userId, createdAt: now, expiresAt: now + SESSION_TTL_MS };
	// Expired sessions are pruned on every write.
	writeList(sessionsFile(), [...liveSessions(now), session]);
	return token;
}

/** The session for a cookie token, renewed when due; undefined when
 *  unknown or expired. */
export function resolveSession(token: string, now = Date.now()): SessionRecord | undefined {
	const tokenHash = hashToken(token);
	const all = readList<SessionRecord>(sessionsFile());
	const session = all.find((s) => s.tokenHash === tokenHash);
	if (!session || session.expiresAt <= now) return undefined;
	if (now + SESSION_TTL_MS - session.expiresAt >= SESSION_RENEW_AFTER_MS) {
		const renewed = { ...session, expiresAt: now + SESSION_TTL_MS };
		writeList(
			sessionsFile(),
			all.filter((s) => s.expiresAt > now).map((s) => (s.tokenHash === tokenHash ? renewed : s)),
		);
		return renewed;
	}
	return session;
}

export function deleteSession(token: string): void {
	const tokenHash = hashToken(token);
	const all = readList<SessionRecord>(sessionsFile());
	const kept = all.filter((s) => s.tokenHash !== tokenHash);
	if (kept.length !== all.length) writeList(sessionsFile(), kept);
}

function deleteSessionsForUser(userId: string): void {
	const all = readList<SessionRecord>(sessionsFile());
	const kept = all.filter((s) => s.userId !== userId);
	if (kept.length !== all.length) writeList(sessionsFile(), kept);
}

// ─── invite / reset links ────────────────────────────────────────────────────

/** Mint a one-time link token; returns the raw token for the URL. */
export function createLink(input: { kind: LinkKind; createdBy: string; userId?: string }, now = Date.now()): string {
	if (input.kind === "reset" && !input.userId) throw new AccountError("not_found", "A reset link needs a user.");
	if (input.userId && !getUser(input.userId)) throw new AccountError("not_found", "No such user.");
	const token = newToken();
	const link: LinkRecord = {
		tokenHash: hashToken(token),
		kind: input.kind,
		...(input.userId ? { userId: input.userId } : {}),
		createdBy: input.createdBy,
		createdAt: now,
		expiresAt: now + (input.kind === "invite" ? INVITE_TTL_MS : RESET_TTL_MS),
	};
	const links = readList<LinkRecord>(linksFile()).filter((l) => l.expiresAt > now && !l.usedAt);
	writeList(linksFile(), [...links, link]);
	return token;
}

/** A usable (unexpired, unused) link for a token, or undefined. */
export function peekLink(token: string, now = Date.now()): LinkRecord | undefined {
	const tokenHash = hashToken(token);
	const link = readList<LinkRecord>(linksFile()).find((l) => l.tokenHash === tokenHash);
	if (!link || link.usedAt || link.expiresAt <= now) return undefined;
	if (link.kind === "reset" && !(link.userId && getUser(link.userId))) return undefined;
	return link;
}

/** Spend a link: marks it used, or throws invalid_link if it no longer is
 *  usable. Synchronous between check and write — single-use holds. */
function consumeLink(token: string, kind: LinkKind, now: number): LinkRecord {
	const tokenHash = hashToken(token);
	const links = readList<LinkRecord>(linksFile());
	const i = links.findIndex((l) => l.tokenHash === tokenHash);
	const link = links[i];
	if (!link || link.kind !== kind || link.usedAt || link.expiresAt <= now) {
		throw new AccountError("invalid_link", "This link has expired or was already used. Ask your admin for a new one.");
	}
	links[i] = { ...link, usedAt: now };
	writeList(linksFile(), links);
	return link;
}

/** Redeem an invite: create the account (role user). The link is spent
 *  only after the account exists, so a taken username can be retried. */
export async function redeemInvite(token: string, username: string, password: string, now = Date.now()): Promise<UserRecord> {
	if (peekLink(token, now)?.kind !== "invite") {
		throw new AccountError("invalid_link", "This link has expired or was already used. Ask your admin for a new one.");
	}
	const user = await createUser({ username, password, role: "user" });
	try {
		consumeLink(token, "invite", Date.now());
	} catch (err) {
		// Lost a race for the same link: undo the account it would have made.
		writeList(usersFile(), listUsers().filter((u) => u.id !== user.id));
		throw err;
	}
	return user;
}

/** Redeem a reset link: set the account's password (ends its sessions). */
export async function redeemReset(token: string, password: string, now = Date.now()): Promise<UserRecord> {
	validatePassword(password);
	const passwordHash = await hashPassword(password);
	const link = consumeLink(token, "reset", now);
	const user = updateUser(link.userId!, { passwordHash });
	deleteSessionsForUser(user.id);
	return user;
}

// ─── allowance settings (admin page) ─────────────────────────────────────────

/** Set or clear (undefined) one account's allowance override. */
export function setUserLimit(id: string, limitUsd: number | undefined): UserRecord {
	if (limitUsd !== undefined && !(Number.isFinite(limitUsd) && limitUsd >= 0)) {
		throw new AccountError("invalid_limit", "The limit must be a dollar amount of 0 or more.");
	}
	return updateUser(id, { limitUsd });
}

/** The server-wide allowance settings: the default limit, the fade speed,
 *  and the admin's economy preset (one model + thinking level). */
export interface AllowanceSettings extends AllowanceConfig {
	economy?: { model: { provider: string; id: string }; thinkingLevel?: ThinkingLevel };
}

const allowanceFile = () => path.join(ACCOUNTS_DIR, "allowance.json");

export function readAllowanceSettings(): AllowanceSettings {
	try {
		const raw = JSON.parse(fs.readFileSync(allowanceFile(), "utf-8")) as Partial<AllowanceSettings>;
		return {
			limitUsd: typeof raw.limitUsd === "number" && raw.limitUsd >= 0 ? raw.limitUsd : DEFAULT_ALLOWANCE.limitUsd,
			halfLifeHours:
				typeof raw.halfLifeHours === "number" && raw.halfLifeHours > 0 ? raw.halfLifeHours : DEFAULT_ALLOWANCE.halfLifeHours,
			...(raw.economy?.model ? { economy: raw.economy } : {}),
		};
	} catch {
		return { ...DEFAULT_ALLOWANCE };
	}
}

export function writeAllowanceSettings(next: AllowanceSettings): AllowanceSettings {
	fs.mkdirSync(ACCOUNTS_DIR, { recursive: true, mode: 0o700 });
	const tmp = `${allowanceFile()}.tmp-${crypto.randomUUID().slice(0, 8)}`;
	fs.writeFileSync(tmp, JSON.stringify(next, null, "\t"), { encoding: "utf-8", mode: 0o600 });
	fs.renameSync(tmp, allowanceFile());
	return next;
}
