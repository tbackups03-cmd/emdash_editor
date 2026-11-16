import type { APIRoute } from "astro";
import { getDB } from "../../../lib/member-auth";

export const POST: APIRoute = async ({ request, locals }) => {
	const adminUser = (locals as unknown as { user?: unknown }).user;
	if (!adminUser) {
		return Response.json({ error: "ไม่มีสิทธิ์เข้าถึง (เฉพาะผู้ดูแลระบบ)" }, { status: 401 });
	}

	try {
		const body = (await request.json()) as Record<string, unknown>;
		const memberId = String(body.member_id ?? "").trim();
		const status = body.status === "suspended" ? "suspended" : "active";

		if (!memberId) {
			return Response.json({ error: "ไม่พบรหัสสมาชิก" }, { status: 400 });
		}

		const db = getDB();
		const nowIso = new Date().toISOString();

		await db
			.prepare("UPDATE app_members SET status = ?, updated_at = ? WHERE id = ?")
			.bind(status, nowIso, memberId)
			.run();

		// หากสั่งระงับบัญชี ให้ลบ Session ที่ล็อกอินค้างอยู่ทันที
		if (status === "suspended") {
			await db.prepare("DELETE FROM app_member_sessions WHERE member_id = ?").bind(memberId).run();
		}

		return Response.json({ ok: true });
	} catch (err) {
		console.error("Update member status error:", err);
		return Response.json({ error: "เปลี่ยนสถานะสมาชิกไม่สำเร็จ" }, { status: 500 });
	}
};