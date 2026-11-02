"use client";
/**
 * The admin page's allowance section (cloud mode, owner design 2026-11):
 * the default limit, how fast spending fades, and the economy preset users
 * can switch to. Per-user use and overrides live on the account rows
 * (admin-panel.tsx). The preset picker lists priced models only — an
 * unpriced preset would make economy turns count as $0.
 */

import { useEffect, useMemo, useState } from "react";
import { PRICES, type ModelCatalogEntry } from "@/src/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Settings {
	limitUsd: number;
	halfLifeHours: number;
	economy?: { model: { provider: string; id: string }; thinkingLevel?: string };
}

const field = "flex flex-col gap-1.5";
const label = "font-ui text-xs uppercase tracking-wider text-muted-foreground";

export function AdminAllowance() {
	const [saved, setSaved] = useState<Settings | null>(null);
	const [limit, setLimit] = useState("");
	const [halfLife, setHalfLife] = useState("");
	const [modelKey, setModelKey] = useState("");
	const [level, setLevel] = useState("");
	const [models, setModels] = useState<ModelCatalogEntry[]>([]);
	const [status, setStatus] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		void fetch("/api/admin/allowance")
			.then((r) => r.json())
			.then((s: Settings) => {
				setSaved(s);
				setLimit(String(s.limitUsd));
				setHalfLife(String(s.halfLifeHours));
				setModelKey(s.economy ? `${s.economy.model.provider}:${s.economy.model.id}` : "");
				setLevel(s.economy?.thinkingLevel ?? "");
			});
		void fetch("/api/models")
			.then((r) => r.json())
			.then((b: { models: ModelCatalogEntry[] }) => setModels(b.models.filter((m) => PRICES[`${m.provider}:${m.id}`])));
	}, []);

	const picked = useMemo(() => models.find((m) => `${m.provider}:${m.id}` === modelKey), [models, modelKey]);

	async function save() {
		setStatus(null);
		setError(null);
		const body: Record<string, unknown> = { limitUsd: Number(limit), halfLifeHours: Number(halfLife) };
		body.economy = picked ? { model: { provider: picked.provider, id: picked.id }, ...(level ? { thinkingLevel: level } : {}) } : null;
		const res = await fetch("/api/admin/allowance", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const data = (await res.json().catch(() => ({}))) as Settings & { error?: string };
		if (!res.ok) {
			setError(data.error ?? `Couldn't save (${res.status}).`);
			return;
		}
		setSaved(data);
		setStatus("Saved.");
	}

	if (!saved) return null;
	return (
		<section className="flex flex-col gap-4 rounded-lg border border-border p-4" data-testid="admin-allowance">
			<div>
				<h2 className="font-ui text-sm uppercase tracking-wider text-foreground">Allowance</h2>
				<p className="mt-1 text-xs text-muted-foreground">
					Each person&apos;s teaching turns count toward their limit, and older spending counts less over time. Turns pause at 100% until it fades.
				</p>
			</div>
			<div className="grid gap-4 sm:grid-cols-2">
				<label className={field}>
					<span className={label}>Default limit (USD)</span>
					<Input type="number" inputMode="decimal" min={0} step="0.5" value={limit} onChange={(e) => setLimit(e.target.value)} data-testid="allowance-limit" />
				</label>
				<label className={field}>
					<span className={label}>Spending counts half after (hours)</span>
					<Input type="number" inputMode="decimal" min={1} step="1" value={halfLife} onChange={(e) => setHalfLife(e.target.value)} data-testid="allowance-halflife" />
				</label>
				<label className={field}>
					<span className={label}>Economy model</span>
					<select
						value={modelKey}
						onChange={(e) => {
							setModelKey(e.target.value);
							setLevel("");
						}}
						className="h-9 rounded-md border border-input bg-transparent px-2 text-sm dark:bg-input/30"
						data-testid="economy-model"
					>
						<option value="">None (no economy switch)</option>
						{models.map((m) => (
							<option key={`${m.provider}:${m.id}`} value={`${m.provider}:${m.id}`}>
								{m.provider} · {m.name}
							</option>
						))}
					</select>
				</label>
				<label className={field}>
					<span className={label}>Economy thinking level</span>
					<select
						value={level}
						onChange={(e) => setLevel(e.target.value)}
						disabled={!picked || picked.supportedLevels.length === 0}
						className="h-9 rounded-md border border-input bg-transparent px-2 text-sm disabled:opacity-50 dark:bg-input/30"
					>
						<option value="">Model default</option>
						{picked?.supportedLevels.map((l) => (
							<option key={l} value={l}>
								{l}
							</option>
						))}
					</select>
				</label>
			</div>
			<div className="flex items-center gap-3">
				<Button size="sm" onClick={() => void save()} data-testid="allowance-save">
					Save
				</Button>
				{status && <span className="text-xs text-muted-foreground">{status}</span>}
				{error && (
					<span role="alert" className="text-xs text-red-500">
						{error}
					</span>
				)}
			</div>
		</section>
	);
}
