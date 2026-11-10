import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { CLOUD_MODE, runAsUser } from "@/tenancy";
import { ensureBootstrapAdmin, scopeOf, SESSION_COOKIE, userForToken } from "@/src/server";

/**
 * The page-side twin of withUser (src/server/auth.ts): server components
 * that read user data run inside the signed-in user's scope. Signed out →
 * /login. Desktop: render() runs directly.
 */
export async function asPageUser<T>(render: () => T | Promise<T>, opts: { admin?: boolean } = {}): Promise<T> {
	if (!CLOUD_MODE) return render();
	await ensureBootstrapAdmin();
	const user = userForToken((await cookies()).get(SESSION_COOKIE)?.value);
	if (!user) redirect("/login");
	if (opts.admin && user.role !== "admin") redirect("/");
	return runAsUser(scopeOf(user), render);
}
