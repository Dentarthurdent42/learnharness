"use client";
/**
 * The cloud sign-in surfaces (2026-11): sign in, accept an invite, set a
 * new password from a reset link. One quiet centered card in the app's
 * mono chrome — the pages in app/(auth) render these bare (no sidebar).
 * Every form posts JSON to its /api/auth route and, on success, lands on
 * home (a full navigation, so the server re-renders as the new user).
 */

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const MIN_PASSWORD = 10;

function Card({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
	return (
		<main className="flex min-h-dvh items-center justify-center px-4 py-10">
			<div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-xl">
				<h1 className="font-ui text-sm uppercase tracking-wider text-foreground">{title}</h1>
				{subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
				<div className="mt-5">{children}</div>
			</div>
		</main>
	);
}

function Field({
	label,
	...props
}: { label: string } & React.ComponentProps<typeof Input>) {
	return (
		<label className="flex flex-col gap-1.5">
			<span className="font-ui text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
			<Input {...props} />
		</label>
	);
}

function ErrorLine({ error }: { error: string | null }) {
	if (!error) return null;
	return (
		<p role="alert" className="rounded-sm border border-red-500/40 px-3 py-2 text-xs text-red-500">
			{error}
		</p>
	);
}

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const data = (await res.json().catch(() => ({}))) as { error?: string };
		return res.ok ? { ok: true } : { ok: false, error: data.error ?? `Something went wrong (${res.status}).` };
	} catch {
		return { ok: false, error: "Couldn't reach the server. Check your connection and try again." };
	}
}

/** Client-side mirror of the store's rules, so the common mistakes are
 *  caught before the round trip (the server stays the authority). */
function passwordProblem(password: string, confirm: string): string | null {
	if (password.length < MIN_PASSWORD) return `Passwords need at least ${MIN_PASSWORD} characters.`;
	if (password !== confirm) return "The two passwords don't match.";
	return null;
}

export function LoginForm() {
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function submit(e: FormEvent) {
		e.preventDefault();
		setBusy(true);
		setError(null);
		const result = await postJson("/api/auth/login", { username, password });
		if (result.ok) {
			window.location.assign("/");
			return;
		}
		setError(result.error ?? null);
		setBusy(false);
	}

	return (
		<Card title="Sign in" subtitle="LearnHarness">
			<form onSubmit={submit} className="flex flex-col gap-4" data-testid="login-form">
				<Field label="Username" name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required value={username} onChange={(e) => setUsername(e.target.value)} />
				<Field label="Password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
				<ErrorLine error={error} />
				<Button type="submit" disabled={busy || !username || !password}>
					{busy ? "Signing in…" : "Sign in"}
				</Button>
				<p className="text-xs text-muted-foreground">Forgot your password? Ask your admin for a reset link.</p>
			</form>
		</Card>
	);
}

/** Shared check for the link pages: is the token still usable? */
function useLinkCheck(kind: "invite" | "reset", token: string): { valid: boolean; username?: string } | null {
	const [state, setState] = useState<{ valid: boolean; username?: string } | null>(null);
	useEffect(() => {
		let live = true;
		fetch(`/api/auth/${kind}?token=${encodeURIComponent(token)}`)
			.then((res) => (res.ok ? res.json() : { valid: false }))
			.then((data: { valid: boolean; username?: string }) => live && setState(data))
			.catch(() => live && setState({ valid: false }));
		return () => {
			live = false;
		};
	}, [kind, token]);
	return state;
}

function DeadLink() {
	return (
		<Card title="Link not valid" subtitle="This link has expired or was already used.">
			<p className="text-sm text-muted-foreground">Ask your admin to send you a new one.</p>
		</Card>
	);
}

export function InviteForm({ token }: { token: string }) {
	const check = useLinkCheck("invite", token);
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	if (check === null) return <Card title="Create your account">{null}</Card>;
	if (!check.valid) return <DeadLink />;

	async function submit(e: FormEvent) {
		e.preventDefault();
		const problem = passwordProblem(password, confirm);
		if (problem) {
			setError(problem);
			return;
		}
		setBusy(true);
		setError(null);
		const result = await postJson("/api/auth/invite", { token, username, password });
		if (result.ok) {
			window.location.assign("/");
			return;
		}
		setError(result.error ?? null);
		setBusy(false);
	}

	return (
		<Card title="Create your account" subtitle="You've been invited to LearnHarness.">
			<form onSubmit={submit} className="flex flex-col gap-4" data-testid="invite-form">
				<Field label="Username" name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required minLength={3} maxLength={32} value={username} onChange={(e) => setUsername(e.target.value)} />
				<p className="-mt-2 text-xs text-muted-foreground">3–32 characters: letters, numbers, . _ -</p>
				<Field label="Password" name="password" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
				<Field label="Confirm password" name="confirm" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
				<p className="-mt-2 text-xs text-muted-foreground">At least {MIN_PASSWORD} characters.</p>
				<ErrorLine error={error} />
				<Button type="submit" disabled={busy || !username || !password || !confirm}>
					{busy ? "Creating…" : "Create account"}
				</Button>
			</form>
		</Card>
	);
}

export function ResetForm({ token }: { token: string }) {
	const check = useLinkCheck("reset", token);
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	if (check === null) return <Card title="Set a new password">{null}</Card>;
	if (!check.valid) return <DeadLink />;

	async function submit(e: FormEvent) {
		e.preventDefault();
		const problem = passwordProblem(password, confirm);
		if (problem) {
			setError(problem);
			return;
		}
		setBusy(true);
		setError(null);
		const result = await postJson("/api/auth/reset", { token, password });
		if (result.ok) {
			window.location.assign("/");
			return;
		}
		setError(result.error ?? null);
		setBusy(false);
	}

	return (
		<Card title="Set a new password" subtitle={<>For <span className="text-foreground">{check.username}</span>. You&apos;ll be signed out everywhere else.</>}>
			<form onSubmit={submit} className="flex flex-col gap-4" data-testid="reset-form">
				{/* Hidden username lets password managers file the new password correctly. */}
				<input type="text" name="username" autoComplete="username" value={check.username ?? ""} readOnly hidden />
				<Field label="New password" name="password" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
				<Field label="Confirm password" name="confirm" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
				<p className="-mt-2 text-xs text-muted-foreground">At least {MIN_PASSWORD} characters.</p>
				<ErrorLine error={error} />
				<Button type="submit" disabled={busy || !password || !confirm}>
					{busy ? "Saving…" : "Set password"}
				</Button>
			</form>
		</Card>
	);
}
