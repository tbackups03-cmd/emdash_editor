import type { APIRoute } from "astro";
import { generateRandomHex, getDB, sha256Hex } from "../../../lib/member-auth";
import { sendPasswordResetEmail } from "../../../lib/mailer";

export const POST: APIRoute = async ({ request, url }) => {
	try {
		const body = (await request.json()) as Record<string, unknown>;
		const email = String(body.email ?? "").trim().toLowerCase();

		if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
			return Response.json({ error: "กรุณากรอกรูปแบบอีเมลให้ถูกต้อง" }, { status: 400 });
		}

		const db = getDB();
		const member = await db
			.prepare("SELECT id, email, display_name, status FROM app_members WHERE email = ?")
			.bind(email)
			.first<{ id: string; email: string; display_name: string; status: string }>();

		// เพื่อความปลอดภัย ไม่เปิดเผยว่าอีเมลนี้มีในระบบหรือไม่ (ส่งอีเมลเฉพาะบัญชีที่ใช้งานปกติ)
		if (member && member.status === "active") {
			const rawToken = generateRandomHex(32);
			const tokenHash = await sha256Hex(rawToken);
			const now = new Date();
			const expiresAt = new Date(now.getTime() + 60 * 60 * 1000); // อายุ 1 ชั่วโมง

			await db.prepare("DELETE FROM app_password_resets WHERE member_id = ?").bind(member.id).run();
			await db
				.prepare(
					"INSERT INTO app_password_resets (token_hash, member_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
				)
				.bind(tokenHash, member.id, expiresAt.toISOString(), now.toISOString())
				.run();

			const resetUrl = `${url.origin}/reset-password?token=${encodeURIComponent(rawToken)}`;
			await sendPasswordResetEmail({
				toEmail: member.email,
				displayName: member.display_name,
				resetUrl,
			});
		}

		return Response.json({ ok: true });
	} catch (err) {
		console.error("Forgot password error:", err);
		const msg = err instanceof Error ? err.message : "ไม่สามารถส่งคำขอกู้คืนรหัสผ่านได้ในขณะนี้";
		return Response.json({ error: msg }, { status: 500 });
	}
};