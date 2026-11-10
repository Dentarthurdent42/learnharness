import { NextResponse, type NextRequest } from "next/server";

/**
 * Cloud mode's page redirect (2026-11): a page load with no session
 * cookie goes to /login instead of rendering a shell whose every fetch
 * would 401. OPTIMISTIC ONLY — it checks the cookie's presence, not its
 * validity; the real gate is withUser / asPageUser at the data access
 * (src/server/auth.ts, lib/page-auth.ts), per Next's guidance that Proxy
 * is not an authorization layer. Desktop: a no-op.
 */
export function proxy(request: NextRequest) {
	if (process.env.LH_MODE !== "cloud") return NextResponse.next();
	if (request.cookies.has("lh_session")) return NextResponse.next();
	return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
	// Pages only: not the API (it answers 401 itself), not Next's assets,
	// not public files, not the sign-in surfaces.
	matcher: ["/((?!api/|_next/|login|invite/|reset/|favicon|fonts/|worklets/|.*\\..*).*)"],
};
