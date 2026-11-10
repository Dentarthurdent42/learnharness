import { notFound } from "next/navigation";
import { CLOUD_MODE } from "@/tenancy";
import { ResetForm } from "@/components/auth-forms";

export const dynamic = "force-dynamic";

/** Redeem a password-reset link (cloud mode). */
export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
	if (!CLOUD_MODE) notFound();
	const { token } = await params;
	return <ResetForm token={token} />;
}
