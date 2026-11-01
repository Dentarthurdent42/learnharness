import { AsyncLocalStorage } from "node:async_hooks";

/**
 * THE TENANCY SEAM (cloud mode, 2026-11): who the current request acts for.
 *
 * Desktop (LH_MODE unset) is single-user by construction — there is no
 * scope, every data path resolves exactly as before, and nothing here
 * changes behavior. Cloud (LH_MODE=cloud) is multi-user: each request is
 * run inside runAsUser(), and AsyncLocalStorage carries that user through
 * every await, timer and un-awaited background task the request starts
 * (turns, jobs, extraction runs) — so stores keep their plain path reads.
 *
 * FAIL CLOSED: in cloud mode a data path read OUTSIDE a user scope throws
 * (config.ts dataRoot) instead of falling back to a shared directory — a
 * missed propagation surfaces as an error, never as one user's data
 * landing in (or read from) another's.
 */

export type Role = "admin" | "user";

export interface UserScope {
	userId: string;
	username: string;
	role: Role;
}

export const CLOUD_MODE = process.env.LH_MODE === "cloud";

interface LhTenancyGlobal {
	__lhTenancy?: AsyncLocalStorage<UserScope>;
}

// globalThis-pinned like the other registries: Next can load this module
// more than once (route bundles), and every copy must share one store.
function storage(): AsyncLocalStorage<UserScope> {
	const g = globalThis as typeof globalThis & LhTenancyGlobal;
	return (g.__lhTenancy ??= new AsyncLocalStorage<UserScope>());
}

// Tag every core event with its emitting user (core/events.ts reads this
// hook; the core itself must stay free of node:async_hooks).
(globalThis as typeof globalThis & { __lhEventOwner?: () => string | undefined }).__lhEventOwner = () =>
	storage().getStore()?.userId;

/** Run fn as the given user (cloud mode's per-request entry). */
export function runAsUser<T>(scope: UserScope, fn: () => T): T {
	return storage().run(scope, fn);
}

/** The user the current async context acts for; undefined on desktop or
 *  outside any request. */
export function currentUser(): UserScope | undefined {
	return storage().getStore();
}

/** The current user, or throw — for code that must never run unscoped in
 *  cloud mode. Desktop callers never reach this (CLOUD_MODE gates it). */
export function requireUser(): UserScope {
	const scope = currentUser();
	if (!scope) throw new Error("tenancy: cloud-mode data access outside a user scope");
	return scope;
}

/**
 * Namespace an in-memory registry key by user (turn runs, liveness,
 * compaction, extraction runs): chat ids are random, but isolation must
 * not rest on randomness. Identity on desktop.
 */
export function scopedKey(key: string): string {
	return CLOUD_MODE ? `${requireUser().userId}:${key}` : key;
}

/** The inverse filter for registry listings: does this scoped key belong
 *  to the current user? Always true on desktop. */
export function ownsScopedKey(key: string): boolean {
	return CLOUD_MODE ? key.startsWith(`${requireUser().userId}:`) : true;
}

/** Strip the user prefix from a scoped key (listing payloads carry the
 *  plain chat/source id the client knows). Identity on desktop. */
export function unscopedKey(key: string): string {
	if (!CLOUD_MODE) return key;
	const i = key.indexOf(":");
	return i === -1 ? key : key.slice(i + 1);
}

/**
 * A per-user view over a process-wide registry Map: every key passes
 * through scopedKey, and iteration only yields the current user's entries
 * (keys unscoped). On desktop it is the Map itself, behavior unchanged.
 */
export class ScopedMap<V> {
	constructor(private readonly inner: Map<string, V>) {}
	get(key: string): V | undefined {
		return this.inner.get(scopedKey(key));
	}
	set(key: string, value: V): this {
		this.inner.set(scopedKey(key), value);
		return this;
	}
	has(key: string): boolean {
		return this.inner.has(scopedKey(key));
	}
	delete(key: string): boolean {
		return this.inner.delete(scopedKey(key));
	}
	*entries(): IterableIterator<[string, V]> {
		for (const [k, v] of this.inner) if (ownsScopedKey(k)) yield [unscopedKey(k), v];
	}
	*keys(): IterableIterator<string> {
		for (const [k] of this.entries()) yield k;
	}
	*values(): IterableIterator<V> {
		for (const [, v] of this.entries()) yield v;
	}
	[Symbol.iterator](): IterableIterator<[string, V]> {
		return this.entries();
	}
}

/** The Set counterpart of ScopedMap (single-flight guards). */
export class ScopedSet {
	constructor(private readonly inner: Set<string>) {}
	has(key: string): boolean {
		return this.inner.has(scopedKey(key));
	}
	add(key: string): this {
		this.inner.add(scopedKey(key));
		return this;
	}
	delete(key: string): boolean {
		return this.inner.delete(scopedKey(key));
	}
}
