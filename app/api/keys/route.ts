/**
 * GET /api/keys — the auth page's key list (auth-keys wave, 2026-09-19;
 * providers added by the provider-keys interlude same wave).
 *
 * Every curated key (present or not) plus unknown file vars surfaced as
 * generic rows — ABSENT provider keys deliberately do NOT spam status
 * rows; the provider dropdown is the discovery surface. `providers`
 * carries it: {id, envVar, label} for every pi-ai plain-key provider,
 * derived from pi-ai's own provider→env-var table (no-drift pin in
 * tests/auth-provider-keys.test.ts) — the settings UI reads it optionally
 * with a graceful fallback.
 *
 * Masked only — last 4 + length; PLAINTEXT NEVER LEAVES THE STORE THROUGH
 * THIS API (owner decision). `source` tells the page whether the live
 * value comes from the environment (dev .env.local / launch env) or the
 * file, and `shadowedByEnv` explains why a saved key is not the live one
 * (env always wins).
 */
import { CLOUD_MODE, currentUser } from "@/tenancy";
import { keyStatuses, providerKeyList, withUser } from "@/src/server";

export const dynamic = "force-dynamic";

async function handleGET() {
	// Cloud mode: everyone may see WHICH keys exist (the setup prompt and
	// the search-engine picker depend on it) — only the admin sees even the
	// masked tails. Editing stays admin-only ([id]/route.ts).
	const admin = !CLOUD_MODE || currentUser()?.role === "admin";
	const keys = admin ? keyStatuses() : keyStatuses().map((k) => ({ ...k, masked: null }));
	return Response.json({ keys, providers: providerKeyList() });
}

// Cloud mode: signed-in users only (presence only for non-admins, above).
export const GET = withUser(handleGET);
