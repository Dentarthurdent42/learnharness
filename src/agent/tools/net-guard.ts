import * as dns from "node:dns";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "puppeteer-core";
import { Agent, fetch as undiciFetch } from "undici";
import { CLOUD_MODE } from "../../../tenancy.ts";

/**
 * THE OUTBOUND URL GUARD (cloud mode, owner ruling 2026-11): agent-driven
 * fetches (web_fetch, web_fetch_pdf) refuse every non-public destination —
 * loopback, private, link-local (cloud metadata), CGNAT, Fly's 6PN
 * (fdaa::/16, inside fc00::/7), multicast and reserved ranges. On a shared
 * server the researcher must not become a window into the host's network.
 *
 * Checked at THREE points so no path slips past: the URL's literal host
 * (an IP literal never reaches DNS), the socket's DNS answer (every
 * resolved address must be public — closes DNS rebinding, because the
 * check runs on the very lookup the connection uses), and every redirect
 * hop (followed manually, each hop re-checked). Desktop: plain fetch,
 * behavior unchanged.
 */

const blocked = new net.BlockList();
for (const [addr, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const) {
	blocked.addSubnet(addr, prefix, "ipv4");
}
for (const [addr, prefix] of [
	["::", 128],
	["::1", 128],
	["64:ff9b::", 96], // NAT64
	["100::", 64],
	["2001:db8::", 32],
	["fc00::", 7], // unique local — Fly's private network is fdaa::/16
	["fe80::", 10],
	["ff00::", 8],
] as const) {
	blocked.addSubnet(addr, prefix, "ipv6");
}

/** Is this IP address a public, routable destination? */
export function isPublicAddress(ip: string): boolean {
	const family = net.isIP(ip);
	if (family === 4) return !blocked.check(ip, "ipv4");
	if (family === 6) {
		const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
		// IPv4-mapped (::ffff:a.b.c.d): judge the embedded v4. (No ::ffff:0:0/96
		// rule in the list — BlockList matches plain v4 against mapped v6
		// subnets, so that rule would block every IPv4 address.)
		if (mapped?.[1]) return !blocked.check(mapped[1], "ipv4");
		return !blocked.check(ip, "ipv6");
	}
	return false;
}

export class BlockedUrlError extends Error {}

/** Pre-flight check of a URL's scheme and literal host (DNS is checked at
 *  connect time by guardedLookup). */
export function assertFetchableUrl(raw: string): URL {
	const url = new URL(raw);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedUrlError("Only http(s) URLs are supported");
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (net.isIP(host) && !isPublicAddress(host)) throw new BlockedUrlError("Private or internal addresses are blocked on this server");
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
		throw new BlockedUrlError("Private or internal addresses are blocked on this server");
	}
	return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** The socket-level DNS check: resolve everything, refuse if ANY answer is
 *  non-public (a mixed answer is a rebinding tell), then answer in the
 *  shape the caller asked for. */
export function guardedLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
	dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
		if (err) return callback(err, []);
		const list = addresses as dns.LookupAddress[];
		if (list.length === 0 || list.some((a) => !isPublicAddress(a.address))) {
			const blockedErr: NodeJS.ErrnoException = new BlockedUrlError(
				"Private or internal addresses are blocked on this server",
			);
			blockedErr.code = "EBLOCKED";
			return callback(blockedErr, []);
		}
		if (options.all) return callback(null, list);
		const first = list[0]!;
		callback(null, first.address, first.family);
	});
}

let agent: Agent | undefined;
function guardedAgent(): Agent {
	return (agent ??= new Agent({ connect: { lookup: guardedLookup } }));
}

const MAX_REDIRECTS = 10;

/**
 * fetch() for agent-supplied URLs. Desktop: the global fetch, untouched.
 * Cloud: the guarded agent, redirects followed by hand (each hop checked).
 * Throws BlockedUrlError for a refused destination.
 */
export async function guardedFetch(raw: string, init: RequestInit = {}): Promise<Response> {
	if (!CLOUD_MODE) return fetch(raw, init);
	let url = assertFetchableUrl(raw);
	for (let hop = 0; ; hop++) {
		const resp = (await undiciFetch(url, {
			...(init as object),
			redirect: "manual",
			dispatcher: guardedAgent(),
		})) as unknown as Response;
		const location = resp.headers.get("location");
		if (resp.status >= 300 && resp.status < 400 && location) {
			if (hop >= MAX_REDIRECTS) throw new Error("Too many redirects");
			await resp.body?.cancel().catch(() => {});
			url = assertFetchableUrl(new URL(location, url).href);
			continue;
		}
		// Manual mode leaves resp.url as the hop's URL, matching the
		// redirect-followed resp.url callers print as their source line.
		return resp;
	}
}

/** Resolve a hostname and report whether EVERY answer is public. */
async function resolvesPublic(host: string): Promise<boolean> {
	if (net.isIP(host)) return isPublicAddress(host);
	try {
		const answers = await dns.promises.lookup(host, { all: true });
		return answers.length > 0 && answers.every((a) => isPublicAddress(a.address));
	} catch {
		return false;
	}
}

/** May a headless page (cloud mode) load this URL? Public http(s), the
 *  job's own files under fileRoot, and inline schemes only. */
export async function pageRequestAllowed(raw: string, fileRoot: string): Promise<boolean> {
	try {
		const url = new URL(raw);
		if (url.protocol === "data:" || url.protocol === "blob:" || url.href === "about:blank") return true;
		if (url.protocol === "file:") return path.resolve(fileURLToPath(url)).startsWith(path.resolve(fileRoot) + path.sep);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		const host = url.hostname.replace(/^\[|\]$/g, "");
		if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return false;
		return await resolvesPublic(host);
	} catch {
		return false;
	}
}

/**
 * The headless-page twin of guardedFetch (cloud mode): a demo or figure
 * page runs agent-written code, so every request it makes is checked by
 * pageRequestAllowed. A blocked request fails like any network error (the
 * demo verifier sees it in failedRequests). Chrome resolves DNS again
 * after this check, so this is narrower than guardedFetch's socket-level
 * check; it closes the plain "load an internal address" path.
 */
export async function guardPageRequests(page: Page, fileRoot: string): Promise<void> {
	await page.setRequestInterception(true);
	page.on("request", (request) => {
		if (request.isInterceptResolutionHandled()) return;
		void pageRequestAllowed(request.url(), fileRoot).then((allowed) =>
			(allowed ? request.continue() : request.abort("blockedbyclient")).catch(() => {}),
		);
	});
}
