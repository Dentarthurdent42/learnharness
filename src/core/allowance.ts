/**
 * THE FADING-SPEND ALLOWANCE (cloud mode, owner design 2026-11) — pure.
 *
 * Every teaching turn's cost counts toward the user's spend, and spend
 * FADES: a dollar spent `age` ago counts as 0.5^(age / halfLife). The
 * faded total against the user's limit is the allowance in use. Only
 * teaching turns count (owner ruling); background agents and graph
 * building never do.
 *
 * Levels (owner): a gentle notice from 50%, a stronger prompt from 85%,
 * and at 100% new user-started turns are refused until enough spend has
 * faded. Because every entry fades at the same rate, the faded total S
 * falls as S·0.5^(t/h), so the wait until it drops below the limit L is
 * exactly h·log2(S/L).
 *
 * Client-safe: plain numbers only (exposed via the core barrel for the
 * meter's rounding).
 */

export interface SpendEntry {
	/** Epoch ms of the turn. */
	at: number;
	/** The turn's inferred cost in USD (unpriced → 0). */
	usd: number;
}

export interface AllowanceConfig {
	/** The per-user default limit, USD of faded spend. */
	limitUsd: number;
	/** Hours for a dollar of spend to count half as much. */
	halfLifeHours: number;
}

/** Owner-approved starting values (editable on the admin page). */
export const DEFAULT_ALLOWANCE: AllowanceConfig = { limitUsd: 2, halfLifeHours: 24 };

export const NOTICE_AT = 0.5;
export const WARN_AT = 0.85;

export type AllowanceLevel = "ok" | "notice" | "warn" | "exhausted";

export interface AllowanceStatus {
	/** Faded spend, USD. */
	spentUsd: number;
	limitUsd: number;
	/** spent / limit (may exceed 1). */
	fraction: number;
	level: AllowanceLevel;
	/** exhausted only: epoch ms when new turns are allowed again. */
	resumesAt?: number;
}

/** The faded total of a spend log at `now`. Future-dated entries (clock
 *  skew) count at full weight, never more. */
export function fadedSpend(entries: readonly SpendEntry[], halfLifeHours: number, now: number): number {
	const halfLifeMs = halfLifeHours * 3_600_000;
	let total = 0;
	for (const e of entries) {
		if (!(e.usd > 0)) continue;
		const age = Math.max(0, now - e.at);
		total += e.usd * Math.pow(0.5, age / halfLifeMs);
	}
	return total;
}

export function allowanceLevel(fraction: number): AllowanceLevel {
	if (fraction >= 1) return "exhausted";
	if (fraction >= WARN_AT) return "warn";
	if (fraction >= NOTICE_AT) return "notice";
	return "ok";
}

export function allowanceStatus(
	entries: readonly SpendEntry[],
	config: AllowanceConfig,
	limitUsd: number,
	now: number,
): AllowanceStatus {
	const spentUsd = fadedSpend(entries, config.halfLifeHours, now);
	// A zero limit means "no turns at all": always exhausted, never resumes.
	if (!(limitUsd > 0)) return { spentUsd, limitUsd: 0, fraction: Infinity, level: "exhausted" };
	const fraction = spentUsd / limitUsd;
	const level = allowanceLevel(fraction);
	if (level !== "exhausted") return { spentUsd, limitUsd, fraction, level };
	// Wait until S·0.5^(t/h) < L: t = h·log2(S/L), plus a minute so the
	// retry lands just past the boundary rather than on it.
	const waitMs = config.halfLifeHours * 3_600_000 * Math.log2(spentUsd / limitUsd) + 60_000;
	return { spentUsd, limitUsd, fraction, level, resumesAt: now + Math.ceil(waitMs) };
}
