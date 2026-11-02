"use client";
/**
 * The account admin page (cloud mode, 2026-11 — owner plan): every account
 * with its role and status, a one-time invite link for a new person, a
 * one-time reset link per account (the admin sends links by hand — the
 * server sends no email), and disable / re-enable. Disabling signs the
 * account out everywhere; an admin can't disable themselves.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAccount } from "@/components/account";
import { AdminAllowance } from "@/components/admin-allowance";
import { SidebarToggle } from "@/components/sidebar";
import { Input } from "@/components/ui/input";

interface UserRow {
	id: string;
	username: string;
	role: "admin" | "user";
	disabled: boolean;
	createdAt: number;
	/** The account's own limit override; absent = the default. */
	limitUsd?: number;
	/** Current use: faded spend / effective limit (null = a $0 limit). */
	allowance: { fraction: number | null; limitUsd: number };
}

interface IssuedLink {
	kind: "invite" | "reset";
	username?: string;
	url: string;
	expiresAt: number;
}

function formatDate(ms: number): string {
	return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatDateTime(ms: number): string {
	return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function LinkCard({ link, onDismiss }: { link: IssuedLink; onDismiss: () => void }) {
	const [copied, setCopied] = useState(false);
	async function copy() {
		try {
			await navigator.clipboard.writeText(link.url);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			/* clipboard blocked — the URL stays selectable */
		}
	}
	return (
		<div className="rounded-lg border border-border bg-card p-4" data-testid="issued-link">
			<p className="text-sm text-foreground">
				{link.kind === "invite" ? "Invite link" : `Reset link for ${link.username}`}
				<span className="text-muted-foreground"> · single use, expires {formatDateTime(link.expiresAt)}</span>
			</p>
			<button
				type="button"
				onClick={copy}
				title="Click to copy"
				className="mt-2 block w-full break-all rounded-md border border-input px-3 py-2 text-left font-mono text-xs text-foreground hover:bg-accent"
			>
				{link.url}
			</button>
			<div className="mt-3 flex items-center gap-2">
				<Button size="sm" onClick={copy}>
					{copied ? "Copied" : "Copy link"}
				</Button>
				<Button size="sm" variant="ghost" onClick={onDismiss}>
					Done
				</Button>
				<span className="text-xs text-muted-foreground">Send it yourself — it won&apos;t be shown again.</span>
			</div>
		</div>
	);
}

function formatUsd(n: number): string {
	return `$${n.toFixed(n < 10 ? 2 : 0)}`;
}

/** One account's allowance: use, and the limit override editor. */
function LimitEditor({ user, onSaved }: { user: UserRow; onSaved: () => void }) {
	const [open, setOpen] = useState(false);
	const [value, setValue] = useState(user.limitUsd !== undefined ? String(user.limitUsd) : "");
	const [error, setError] = useState<string | null>(null);
	const pct = user.allowance.fraction === null ? "100%" : `${Math.round(user.allowance.fraction * 100)}%`;

	async function save(limitUsd: number | null) {
		setError(null);
		const res = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ limitUsd }),
		});
		const data = (await res.json().catch(() => ({}))) as { error?: string };
		if (!res.ok) {
			setError(data.error ?? `Couldn't save (${res.status}).`);
			return;
		}
		setOpen(false);
		onSaved();
	}

	return (
		<div className="flex flex-wrap items-center gap-2 font-ui text-xs text-muted-foreground" data-testid="limit-editor">
			<span>
				{pct} of {formatUsd(user.allowance.limitUsd)}
				{user.limitUsd === undefined ? " (default)" : ""}
			</span>
			{!open ? (
				<button type="button" className="underline-offset-2 hover:text-foreground hover:underline" onClick={() => setOpen(true)}>
					Change limit
				</button>
			) : (
				<>
					<Input
						type="number"
						inputMode="decimal"
						min={0}
						step="0.5"
						placeholder="USD"
						value={value}
						onChange={(e) => setValue(e.target.value)}
						className="h-7 w-24 text-xs"
						aria-label={`Limit for ${user.username}`}
					/>
					<Button size="xs" onClick={() => void save(value === "" ? null : Number(value))}>
						Save
					</Button>
					{user.limitUsd !== undefined && (
						<Button size="xs" variant="ghost" onClick={() => void save(null)}>
							Use default
						</Button>
					)}
					<Button size="xs" variant="ghost" onClick={() => setOpen(false)}>
						Cancel
					</Button>
				</>
			)}
			{error && <span className="text-red-500">{error}</span>}
		</div>
	);
}

export function AdminPanel() {
	const account = useAccount();
	const [users, setUsers] = useState<UserRow[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [link, setLink] = useState<IssuedLink | null>(null);
	const [busy, setBusy] = useState<string | null>(null);

	const load = useCallback(async () => {
		const res = await fetch("/api/admin/users");
		if (!res.ok) {
			setError(`Couldn't load accounts (${res.status}).`);
			return;
		}
		setUsers(((await res.json()) as { users: UserRow[] }).users);
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	async function issue(kind: "invite" | "reset", user?: UserRow) {
		setBusy(kind === "invite" ? "invite" : `reset:${user!.id}`);
		setError(null);
		const res = await fetch("/api/admin/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ kind, userId: user?.id }),
		});
		const data = (await res.json().catch(() => ({}))) as { url?: string; expiresAt?: number; error?: string };
		if (res.ok && data.url && data.expiresAt) {
			setLink({ kind, username: user?.username, url: data.url, expiresAt: data.expiresAt });
		} else {
			setError(data.error ?? `Couldn't create the link (${res.status}).`);
		}
		setBusy(null);
	}

	async function toggle(user: UserRow) {
		setBusy(`toggle:${user.id}`);
		setError(null);
		const res = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ disabled: !user.disabled }),
		});
		const data = (await res.json().catch(() => ({}))) as { error?: string };
		if (!res.ok) setError(data.error ?? `Couldn't update ${user.username} (${res.status}).`);
		await load();
		setBusy(null);
	}

	const self = account?.user?.username;

	return (
		<div className="h-full overflow-y-auto">
			<div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
				<header className="flex flex-wrap items-center justify-between gap-3">
					<div className="flex items-center gap-3">
						{/* The way back to the sessions (the phone drawer, or a closed sidebar). */}
						<SidebarToggle />
						<h1 className="font-ui text-sm uppercase tracking-wider text-foreground">Accounts</h1>
					</div>
					<Button size="sm" onClick={() => issue("invite")} disabled={busy !== null} data-testid="create-invite">
						{busy === "invite" ? "Creating…" : "Create invite link"}
					</Button>
				</header>

				{link && <LinkCard link={link} onDismiss={() => setLink(null)} />}

				{error && (
					<p role="alert" className="rounded-sm border border-red-500/40 px-3 py-2 text-xs text-red-500">
						{error}
					</p>
				)}

				<AdminAllowance />

				{users === null ? (
					<p className="text-sm text-muted-foreground">Loading…</p>
				) : (
					<ul className="flex flex-col divide-y divide-border rounded-lg border border-border" data-testid="account-list">
						{users.map((u) => (
							<li key={u.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
								<div className="min-w-0 flex-1">
									<p className={`truncate text-sm ${u.disabled ? "text-muted-foreground line-through" : "text-foreground"}`}>
										{u.username}
										{u.username === self && <span className="text-muted-foreground"> (you)</span>}
									</p>
									<p className="font-ui text-xs text-muted-foreground">
										{u.role === "admin" ? "Admin" : "User"} · joined {formatDate(u.createdAt)}
										{u.disabled && " · disabled"}
									</p>
									<LimitEditor user={u} onSaved={() => void load()} />
								</div>
								<div className="flex items-center gap-2">
									<Button size="sm" variant="outline" onClick={() => issue("reset", u)} disabled={busy !== null}>
										{busy === `reset:${u.id}` ? "Creating…" : "Reset link"}
									</Button>
									{u.username !== self && (
										<Button size="sm" variant={u.disabled ? "outline" : "ghost"} onClick={() => toggle(u)} disabled={busy !== null}>
											{busy === `toggle:${u.id}` ? "Saving…" : u.disabled ? "Enable" : "Disable"}
										</Button>
									)}
								</div>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}
