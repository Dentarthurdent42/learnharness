"use client";
/**
 * Who is signed in (cloud mode, 2026-11). The root layout (a server
 * component — it knows LH_MODE) provides the mode: desktop resolves to
 * { cloud: false } synchronously, SSR included, and never fetches — every
 * surface renders exactly as before. Cloud fetches GET /api/auth/me once
 * per page load, shared by every consumer.
 *
 * canManageKeys is the one gate the settings UI needs: desktop users own
 * their keys; in cloud mode the shared key store is admin-only (editing
 * /api/keys/:id refuses everyone else with 403; GET shows presence only).
 *
 * Also installs the signed-out watcher: any API call answering 401
 * unauthenticated (the session expired, or an admin disabled the
 * account) sends the window to /login instead of leaving a dead UI.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export interface Account {
	cloud: boolean;
	user?: { username: string; role: "admin" | "user" };
}

let pending: Promise<Account> | undefined;

function loadAccount(): Promise<Account> {
	return (pending ??= fetch("/api/auth/me")
		.then((res) => (res.ok ? (res.json() as Promise<Account>) : { cloud: true }))
		.catch(() => ({ cloud: true })));
}

const DESKTOP: Account = { cloud: false };

/** Absent provider (tests rendering a surface alone) = desktop. */
const CloudModeContext = createContext(false);

export function AccountModeProvider({ cloud, children }: { cloud: boolean; children: ReactNode }) {
	return <CloudModeContext.Provider value={cloud}>{children}</CloudModeContext.Provider>;
}

/** Desktop: { cloud: false } at once. Cloud: null while loading. */
export function useAccount(): Account | null {
	const cloud = useContext(CloudModeContext);
	const [account, setAccount] = useState<Account | null>(cloud ? null : DESKTOP);
	useEffect(() => {
		if (!cloud) return;
		let live = true;
		void loadAccount().then((a) => live && setAccount(a));
		return () => {
			live = false;
		};
	}, [cloud]);
	return account;
}

/** Keys are editable on desktop, and by the admin in cloud mode. While
 *  the account loads, nothing key-related renders (no flash of a section
 *  that would vanish). */
export function canManageKeys(account: Account | null): boolean {
	return account !== null && (!account.cloud || account.user?.role === "admin");
}

const AUTH_PAGES = ["/login", "/invite/", "/reset/"];

let watching = false;

/** Mount once (layout): wraps window.fetch to catch 401 unauthenticated
 *  from our own API. Desktop never answers that, so it never fires there. */
export function SignedOutWatcher() {
	useEffect(() => {
		if (watching) return;
		watching = true;
		const original = window.fetch.bind(window);
		window.fetch = async (...args: Parameters<typeof fetch>) => {
			const res = await original(...args);
			if (res.status === 401 && !AUTH_PAGES.some((p) => window.location.pathname.startsWith(p))) {
				const body = (await res.clone().json().catch(() => null)) as { code?: string } | null;
				if (body?.code === "unauthenticated") window.location.assign("/login");
			}
			return res;
		};
	}, []);
	return null;
}

export async function signOut(): Promise<void> {
	await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
	window.location.assign("/login");
}
