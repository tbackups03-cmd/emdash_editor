import type { APIRoute } from "astro";
import { createMemberSession, getDB, hashPassword, sha256Hex } from "../../../lib/member-auth";

export const POST: APIRoute = async ({ request, cookies }) => {
	try {
		const body = (await request.json()) as Record<string, unknown>;
		const rawToken = String(body.token ?? "").trim();
		const newPassword = String(body.new_password ?? "");

		if (!rawToken) {
			return Response.json({ error: "ลิงก์ตั้งรหัสผ่านใหม่ไม่ถูกต้อง" }, { status: 400 });
		}
		if (newPassword.length < 6) {
			return Response.json({ error: "รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร" }, { status: 400 });
		}

		const db = getDB();
		const tokenHash = await sha256Hex(rawToken);
		const nowIso = new Date().toISOString();

		const resetRow = await db
			.prepare("SELECT member_id, expires_at FROM app_password_resets WHERE token_hash = ?")
			.bind(tokenHash)
			.first<{ member_id: string; expires_at: string }>();

		if (!resetRow || resetRow.expires_at <= nowIso) {
			return Response.json(
				{ error: "ลิงก์นี้หมดอายุหรือถูกใช้งานไปแล้ว กรุณาขอลิงก์ใหม่อีกครั้ง" },
				{ status: 400 },
			);
		}

		const { hash, salt } = await hashPassword(newPassword);

		await db
			.prepare("UPDATE app_members SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?")
			.bind(hash, salt, nowIso, resetRow.member_id)
			.run();

		// ลบโทเค็นที่ใช้แล้ว และล้างเซสชันเก่าทั้งหมด
		await db.prepare("DELETE FROM app_password_resets WHERE member_id = ?").bind(resetRow.member_id).run();
		await db.prepare("DELETE FROM app_member_sessions WHERE member_id = ?").bind(resetRow.member_id).run();

		// ล็อกอินให้อัตโนมัติหลังตั้งรหัสผ่านใหม่สำเร็จ
		await createMemberSession(cookies, resetRow.member_id);

		return Response.json({ ok: true });
	} catch (err) {
		console.error("Reset password error:", err);
		return Response.json({ error: "ตั้งรหัสผ่านใหม่ไม่สำเร็จ กรุณาลองใหม่" }, { status: 500 });
	}
};