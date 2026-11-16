import type { APIRoute } from "astro";
import { createMemberSession, getDB, verifyPassword } from "../../../lib/member-auth";

export const POST: APIRoute = async ({ request, cookies }) => {
	try {
		const body = (await request.json()) as Record<string, unknown>;
		const email = String(body.email ?? "").trim().toLowerCase();
		const password = String(body.password ?? "");

		if (!email || !password) {
			return Response.json({ error: "กรุณากรอกอีเมลและรหัสผ่าน" }, { status: 400 });
		}

		const db = getDB();
		const member = await db
			.prepare("SELECT id, password_hash, password_salt, status FROM app_members WHERE email = ?")
			.bind(email)
			.first<{ id: string; password_hash: string; password_salt: string; status: string }>();

		if (!member) {
			return Response.json({ error: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" }, { status: 401 });
		}

		if (member.status !== "active") {
			return Response.json({ error: "บัญชีของคุณถูกระงับการใช้งานชั่วคราว กรุณาติดต่อผู้ดูแล" }, { status: 403 });
		}

		const isValid = await verifyPassword(password, member.password_salt, member.password_hash);
		if (!isValid) {
			return Response.json({ error: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" }, { status: 401 });
		}

		await createMemberSession(cookies, member.id);

		return Response.json({ ok: true });
	} catch (err) {
		console.error("Login error:", err);
		return Response.json({ error: "เกิดข้อผิดพลาดในการเข้าสู่ระบบ กรุณาลองใหม่" }, { status: 500 });
	}
};