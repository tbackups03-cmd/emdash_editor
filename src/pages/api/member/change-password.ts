import type { APIRoute } from "astro";
import { getCurrentMember, getDB, hashPassword, verifyPassword } from "../../../lib/member-auth";

export const POST: APIRoute = async ({ request, cookies }) => {
	try {
		const member = await getCurrentMember(cookies);
		if (!member) {
			return Response.json({ error: "กรุณาเข้าสู่ระบบก่อนดำเนินการ" }, { status: 401 });
		}

		const body = (await request.json()) as Record<string, unknown>;
		const currentPassword = String(body.current_password ?? "");
		const newPassword = String(body.new_password ?? "");

		if (!currentPassword) {
			return Response.json({ error: "กรุณากรอกรหัสผ่านปัจจุบัน" }, { status: 400 });
		}
		if (newPassword.length < 6) {
			return Response.json({ error: "รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร" }, { status: 400 });
		}

		const db = getDB();
		const row = await db
			.prepare("SELECT password_hash, password_salt FROM app_members WHERE id = ?")
			.bind(member.id)
			.first<{ password_hash: string; password_salt: string }>();

		if (!row) {
			return Response.json({ error: "ไม่พบข้อมูลบัญชีสมาชิก" }, { status: 404 });
		}

		const isMatch = await verifyPassword(currentPassword, row.password_salt, row.password_hash);
		if (!isMatch) {
			return Response.json({ error: "รหัสผ่านปัจจุบันไม่ถูกต้อง" }, { status: 400 });
		}

		const { hash, salt } = await hashPassword(newPassword);
		const nowIso = new Date().toISOString();

		await db
			.prepare("UPDATE app_members SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?")
			.bind(hash, salt, nowIso, member.id)
			.run();

		return Response.json({ ok: true });
	} catch (err) {
		console.error("Change password error:", err);
		return Response.json({ error: "เกิดข้อผิดพลาดในการเปลี่ยนรหัสผ่าน" }, { status: 500 });
	}
};