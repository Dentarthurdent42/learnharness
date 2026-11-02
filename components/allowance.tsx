"use client";
/**
 * The allowance surfaces (cloud mode, owner design 2026-11): the sidebar
 * meter ("Allowance 34%") and the notice above the message box — gentle
 * from 50%, stronger from 85% with "Switch to economy", and the refusal
 * line at 100% with roughly when turns come back. Desktop renders nothing
 * (useAccount says so synchronously; no fetch ever happens).
 *
 * Truth: GET /api/allowance, re-read when a turn settles (the only thing
 * that adds spend) and on the server-events resync.
 */

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { NOTICE_AT, WARN_AT, type AllowanceLevel } from "@/src/core";
import { useAccount } from "@/components/account";
import { useServerEvent, useServerResync } from "@/components/server-events";

export interface AllowanceView {
	fraction: number | null;
	level: AllowanceLevel;
	resumesAt?: number;
	economy: { available: boolean; active: boolean };
}

interface AllowanceContextValue {
	allowance: AllowanceView | null;
	refresh: () => void;
}

const AllowanceContext = createContext<AllowanceContextValue>({ allowance: null, refresh: () => {} });

/** Mounted once around the app chrome; inert on desktop. */
export function AllowanceProvider({ children }: { children: ReactNode }) {
	const account = useAccount();
	const cloud = Boolean(account?.cloud && account.user);
	const [allowance, setAllowance] = useState<AllowanceView | null>(null);
	const refresh = useCallback(() => {
		if (!cloud) return;
		fetch("/api/allowance")
			.then((r) => (r.ok ? r.json() : null))
			.then((body: AllowanceView | null) => body && setAllowance(body))
			.catch(() => {});
	}, [cloud]);
	useEffect(() => {
		refresh();
	}, [refresh]);
	useServerEvent("turn-settled", refresh);
	useServerResync(refresh);
	// The refusal's resume time passes on its own — re-read then.
	useEffect(() => {
		if (!allowance?.resumesAt) return;
		const wait = Math.max(1000, allowance.resumesAt - Date.now());
		const timer = setTimeout(refresh, Math.min(wait, 2 ** 31 - 1));
		return () => clearTimeout(timer);
	}, [allowance?.resumesAt, refresh]);
	return <AllowanceContext.Provider value={{ allowance: cloud ? allowance : null, refresh }}>{children}</AllowanceContext.Provider>;
}

export function useAllowance(): AllowanceContextValue {
	return useContext(AllowanceContext);
}

function percent(fraction: number | null): string {
	if (fraction === null || !Number.isFinite(fraction)) return "100%";
	return `${Math.min(999, Math.round(fraction * 100))}%`;
}

/** "in about 3 hours" — coarse on purpose (the fade is continuous). */
export function resumeText(resumesAt: number | undefined, now = Date.now()): string {
	if (!resumesAt) return "once your admin raises your limit";
	const minutes = Math.max(1, Math.round((resumesAt - now) / 60_000));
	if (minutes < 60) return `in about ${minutes} minute${minutes === 1 ? "" : "s"}`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `in about ${hours} hour${hours === 1 ? "" : "s"}`;
	const days = Math.round(hours / 24);
	return `in about ${days} days`;
}

/** The sidebar footer's always-on line. */
export function AllowanceMeter() {
	const { allowance } = useAllowance();
	if (!allowance) return null;
	const tone =
		allowance.level === "exhausted" ? "text-red-500" : allowance.level === "warn" ? "text-amber-500" : "text-muted-foreground";
	return (
		<div
			className={`flex items-center gap-1.5 px-2 py-1.5 text-xs uppercase tracking-wider ${tone}`}
			data-testid="allowance-meter"
			title="Your recent spending fades over time; turns pause at 100%."
		>
			Allowance {percent(allowance.fraction)}
			{allowance.economy.active && <span className="normal-case tracking-normal text-muted-foreground">· economy</span>}
		</div>
	);
}

/** The notice above the message box. `chatId` is the open session (the
 *  economy switch moves it along with the default). */
export function AllowanceNotice({ chatId }: { chatId: string }) {
	const { allowance, refresh } = useAllowance();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (!allowance || allowance.level === "ok") return null;

	async function toggleEconomy(on: boolean) {
		setBusy(true);
		setError(null);
		const res = await fetch("/api/allowance/economy", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(on ? { on, chatId } : { on }),
		}).catch(() => null);
		if (!res?.ok) setError("Couldn't switch. Try again.");
		refresh();
		setBusy(false);
	}

	const strong = allowance.level === "warn" || allowance.level === "exhausted";
	const message =
		allowance.level === "exhausted"
			? `You've used your allowance for now. You can continue ${resumeText(allowance.resumesAt)}.`
			: allowance.level === "warn"
				? `You've used ${percent(allowance.fraction)} of your allowance.`
				: `${percent(allowance.fraction)} of your allowance is in use. It recovers as recent spending fades.`;
	const offerEconomy = allowance.economy.available && !allowance.economy.active && (allowance.fraction ?? 1) >= NOTICE_AT;

	return (
		<div className="pointer-events-auto mb-2 flex justify-center px-2" data-testid="allowance-notice" data-level={allowance.level}>
			<div
				className={`flex max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-1.5 rounded-sm border px-3 py-1.5 text-xs ${
					strong ? "border-amber-500/50 bg-amber-500/10 text-foreground" : "border-border bg-card text-muted-foreground"
				}`}
			>
				<span>{message}</span>
				{offerEconomy && (
					<button
						type="button"
						disabled={busy}
						onClick={() => void toggleEconomy(true)}
						data-testid="economy-on"
						className={`rounded-sm px-2 py-0.5 font-ui transition-colors disabled:opacity-50 ${
							(allowance.fraction ?? 1) >= WARN_AT
								? "bg-primary text-primary-foreground hover:bg-primary/90"
								: "border border-border text-foreground hover:bg-accent"
						}`}
					>
						Switch to economy
					</button>
				)}
				{allowance.economy.active && (
					<button
						type="button"
						disabled={busy}
						onClick={() => void toggleEconomy(false)}
						data-testid="economy-off"
						className="rounded-sm border border-border px-2 py-0.5 font-ui text-foreground transition-colors hover:bg-accent disabled:opacity-50"
					>
						Switch back
					</button>
				)}
				{error && <span className="text-red-500">{error}</span>}
			</div>
		</div>
	);
}
