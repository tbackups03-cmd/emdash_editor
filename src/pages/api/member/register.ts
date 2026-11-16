import type { APIRoute } from "astro";
import { createMemberSession, getDB, hashPassword } from "../../../lib/member-auth";

export const POST: APIRoute = async ({ request, cookies }) => {
	try {
		const body = (await request.json()) as Record<string, unknown>;
		const displayName = String(body.display_name ?? "").trim();
		const email = String(body.email ?? "").trim().toLowerCase();
		const password = String(body.password ?? "");

		if (!displayName || displayName.length < 2) {
			return Response.json({ error: "กรุณากรอกชื่อที่แสดงอย่างน้อย 2 ตัวอักษร" }, { status: 400 });
		}
		if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
			return Response.json({ error: "รูปแบบอีเมลไม่ถูกต้อง" }, { status: 400 });
		}
		if (password.length < 6) {
			return Response.json({ error: "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร" }, { status: 400 });
		}

		const db = getDB();
		const existing = await db
			.prepare("SELECT id FROM app_members WHERE email = ?")
			.bind(email)
			.first<{ id: string }>();

		if (existing) {
			return Response.json({ error: "อีเมลนี้ถูกใช้งานแล้ว กรุณาเข้าสู่ระบบ" }, { status: 409 });
		}

		const memberId = crypto.randomUUID();
		const { hash, salt } = await hashPassword(password);
		const nowIso = new Date().toISOString();

		await db
			.prepare(
				`INSERT INTO app_members (id, email, password_hash, password_salt, display_name, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
			)
			.bind(memberId, email, hash, salt, displayName, nowIso, nowIso)
			.run();

		await createMemberSession(cookies, memberId);

		return Response.json({ ok: true });
	} catch (err) {
		console.error("Register error:", err);
		return Response.json({ error: "เกิดข้อผิดพลาดในการสมัครสมาชิก กรุณาลองใหม่" }, { status: 500 });
	}
};