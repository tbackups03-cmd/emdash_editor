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
		const grantType = body.grant_type === "all_access" ? "all_access" : "book";
		const targetSlug = grantType === "all_access" ? "*" : String(body.target_slug ?? "").trim();
		const expiresAtRaw = String(body.expires_at ?? "").trim();
		const note = String(body.note ?? "").trim() || null;

		if (!memberId) {
			return Response.json({ error: "กรุณาเลือกสมาชิก" }, { status: 400 });
		}
		if (grantType === "book" && !targetSlug) {
			return Response.json({ error: "กรุณาเลือกหนังสือหรือหมวดหมู่" }, { status: 400 });
		}

		let expiresAt: string | null = null;
		if (expiresAtRaw) {
			const parsed = new Date(expiresAtRaw);
			if (isNaN(parsed.getTime())) {
				return Response.json({ error: "รูปแบบวันหมดอายุไม่ถูกต้อง" }, { status: 400 });
			}
			expiresAt = parsed.toISOString();
		}

		const db = getDB();
		const grantId = crypto.randomUUID();
		const nowIso = new Date().toISOString();

		await db
			.prepare(
				`INSERT INTO app_member_grants (id, member_id, grant_type, target_slug, source, note, expires_at, created_at)
				 VALUES (?, ?, ?, ?, 'admin_custom', ?, ?, ?)`,
			)
			.bind(grantId, memberId, grantType, targetSlug, note, expiresAt, nowIso)
			.run();

		return Response.json({ ok: true });
	} catch (err) {
		console.error("Create grant error:", err);
		return Response.json({ error: "ไม่สามารถมอบสิทธิ์ได้" }, { status: 500 });
	}
};

export const DELETE: APIRoute = async ({ request, locals }) => {
	const adminUser = (locals as unknown as { user?: unknown }).user;
	if (!adminUser) {
		return Response.json({ error: "ไม่มีสิทธิ์เข้าถึง (เฉพาะผู้ดูแลระบบ)" }, { status: 401 });
	}

	try {
		const body = (await request.json()) as Record<string, unknown>;
		const grantId = String(body.grant_id ?? "").trim();
		if (!grantId) {
			return Response.json({ error: "ไม่พบรหัสสิทธิ์" }, { status: 400 });
		}

		const db = getDB();
		await db.prepare("DELETE FROM app_member_grants WHERE id = ?").bind(grantId).run();

		return Response.json({ ok: true });
	} catch (err) {
		console.error("Delete grant error:", err);
		return Response.json({ error: "ไม่สามารถยกเลิกสิทธิ์ได้" }, { status: 500 });
	}
};