import { notFound } from "next/navigation";
import { CLOUD_MODE } from "@/tenancy";
import { InviteForm } from "@/components/auth-forms";

export const dynamic = "force-dynamic";

/** Accept an invite link (cloud mode): pick a username and password. */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
	if (!CLOUD_MODE) notFound();
	const { token } = await params;
	return <InviteForm token={token} />;
}
