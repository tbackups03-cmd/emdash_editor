import type { APIRoute } from "astro";
import { getDB, hashPassword } from "../../../lib/member-auth";

export const POST: APIRoute = async ({ request, locals }) => {
	const adminUser = (locals as unknown as { user?: unknown }).user;
	if (!adminUser) {
		return Response.json({ error: "ไม่มีสิทธิ์เข้าถึง" }, { status: 403 });
	}

	try {
		const body = (await request.json()) as Record<string, unknown>;
		const memberId = String(body.member_id ?? "").trim();
		const newPassword = String(body.new_password ?? "");

		if (!memberId) {
			return Response.json({ error: "ไม่พบรหัสสมาชิก" }, { status: 400 });
		}
		if (newPassword.length < 6) {
			return Response.json({ error: "รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร" }, { status: 400 });
		}

		const db = getDB();
		const member = await db
			.prepare("SELECT id FROM app_members WHERE id = ?")
			.bind(memberId)
			.first<{ id: string }>();

		if (!member) {
			return Response.json({ error: "ไม่พบข้อมูลสมาชิกรายนี้" }, { status: 404 });
		}

		const { hash, salt } = await hashPassword(newPassword);
		const nowIso = new Date().toISOString();

		await db
			.prepare("UPDATE app_members SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?")
			.bind(hash, salt, nowIso, memberId)
			.run();

		// ล้างเซสชันเก่าทั้งหมดของสมาชิกคนนี้เพื่อบังคับล็อกอินใหม่ด้วยรหัสผ่านใหม่
		await db.prepare("DELETE FROM app_member_sessions WHERE member_id = ?").bind(memberId).run();

		return Response.json({ ok: true });
	} catch (err) {
		console.error("Admin reset password error:", err);
		return Response.json({ error: "เปลี่ยนรหัสผ่านไม่สำเร็จ กรุณาลองใหม่" }, { status: 500 });
	}
};