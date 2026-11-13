/**
 * A minimal GitHub REST client for ONE repository (2026-11) — shared by
 * the error issue filer and the user-report filer. Both write to the
 * private repo named by LH_ERROR_ISSUES_REPO with LH_ERROR_ISSUES_TOKEN.
 */

export interface GitHubRepoClient {
	/** `path` is relative to /repos/<owner>/<name> (e.g. "/issues"). */
	request(method: string, path: string, body?: unknown): Promise<Record<string, unknown>>;
	readonly repo: string;
}

export function createGitHubRepoClient(opts: { token: string; repo: string; fetch: typeof fetch }): GitHubRepoClient {
	return {
		repo: opts.repo,
		async request(method, path, body) {
			const res = await opts.fetch(`https://api.github.com/repos/${opts.repo}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${opts.token}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
					"User-Agent": "learnharness-error-filer",
					...(body ? { "Content-Type": "application/json" } : {}),
				},
				...(body ? { body: JSON.stringify(body) } : {}),
			});
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				throw new Error(`GitHub ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
			}
			return (await res.json()) as Record<string, unknown>;
		},
	};
}

/** The configured private repo client, or undefined when filing is off
 *  (either secret unset, a malformed repo name, or under tests). */
export function configuredGitHubRepo(): GitHubRepoClient | undefined {
	const token = process.env.LH_ERROR_ISSUES_TOKEN;
	const repo = process.env.LH_ERROR_ISSUES_REPO;
	if (!token || !repo || process.env.NODE_ENV === "test") return undefined;
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
		console.error(`[github] LH_ERROR_ISSUES_REPO must be "owner/name", got ${JSON.stringify(repo)}`);
		return undefined;
	}
	return createGitHubRepoClient({ token, repo, fetch: globalThis.fetch.bind(globalThis) });
}
