import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { CLOUD_MODE } from "@/tenancy";
import { LoginForm } from "@/components/auth-forms";
import { SESSION_COOKIE, userForToken } from "@/src/server";

export const dynamic = "force-dynamic";

/** Cloud sign-in. Desktop has no accounts (→ home); a live session skips
 *  the form. */
export default async function LoginPage() {
	if (!CLOUD_MODE) redirect("/");
	if (userForToken((await cookies()).get(SESSION_COOKIE)?.value)) redirect("/");
	return <LoginForm />;
}
