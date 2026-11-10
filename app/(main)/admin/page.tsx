import { notFound } from "next/navigation";
import { CLOUD_MODE } from "@/tenancy";
import { AdminPanel } from "@/components/admin-panel";
import { asPageUser } from "@/lib/page-auth";

export const dynamic = "force-dynamic";

/** The account admin page (cloud mode, admins only). */
export default function AdminPage() {
	if (!CLOUD_MODE) notFound();
	return asPageUser(() => <AdminPanel />, { admin: true });
}
