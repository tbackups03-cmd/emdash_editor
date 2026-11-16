import type { APIRoute } from "astro";
import { getDB } from "../../../lib/member-auth";

export const POST: APIRoute = async ({ request, locals }) => {
	const adminUser = (locals as unknown as { user?: unknown }).user;
	if (!adminUser) {
		return Response.json({ error: "ไม่มีสิทธิ์เข้าถึง (เฉพาะผู้ดูแลระบบ)" }, { status: 401 });
	}

	try {
		const body = (await request.json()) as Record<string, unknown>;
		const categorySlug = String(body.category_slug ?? "").trim();
		const title = String(body.title ?? "").trim();
		const accessMode = body.access_mode === "paid" ? "paid" : "free";
		const priceThb = Math.max(0, Math.round(Number(body.price_thb ?? 0)));
		const previewParagraphs = Math.max(0, Math.round(Number(body.preview_paragraphs ?? 2)));
		const stripePriceId = String(body.stripe_price_id ?? "").trim() || null;

		if (!categorySlug || !title) {
			return Response.json({ error: "ข้อมูลหนังสือไม่ครบถ้วน" }, { status: 400 });
		}

		const db = getDB();
		const nowIso = new Date().toISOString();

		await db
			.prepare(
				`INSERT INTO app_book_products (category_slug, title, access_mode, price_thb, preview_paragraphs, stripe_price_id, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(category_slug) DO UPDATE SET
				   title = excluded.title,
				   access_mode = excluded.access_mode,
				   price_thb = excluded.price_thb,
				   preview_paragraphs = excluded.preview_paragraphs,
				   stripe_price_id = excluded.stripe_price_id,
				   updated_at = excluded.updated_at`,
			)
			.bind(categorySlug, title, accessMode, priceThb, previewParagraphs, stripePriceId, nowIso)
			.run();

		return Response.json({ ok: true });
	} catch (err) {
		console.error("Save book product error:", err);
		return Response.json({ error: "บันทึกข้อมูลหนังสือไม่สำเร็จ" }, { status: 500 });
	}
};