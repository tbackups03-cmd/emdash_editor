import type { APIRoute } from "astro";
import { getDB } from "../../../lib/member-auth";
import { getStripeEnv, stripeRequest, verifyStripeWebhookSignature } from "../../../lib/stripe";

function extractPeriodEndIso(sub: Record<string, unknown>): string {
	let periodEndUnix = Number(sub.current_period_end ?? 0);
	if (!periodEndUnix) {
		const items = sub.items as { data?: Array<{ current_period_end?: number }> } | undefined;
		periodEndUnix = Number(items?.data?.[0]?.current_period_end ?? 0);
	}
	// เผื่อเวลา 24 ชั่วโมงกันช่วงรอยต่อการตัดบิลรายเดือน
	if (periodEndUnix > 0) {
		return new Date((periodEndUnix + 86400) * 1000).toISOString();
	}
	return new Date(Date.now() + 32 * 24 * 60 * 60 * 1000).toISOString();
}

export const POST: APIRoute = async ({ request }) => {
	const rawBody = await request.text();
	const signature = request.headers.get("stripe-signature");
	const { webhookSecret } = getStripeEnv();

	const isValid = await verifyStripeWebhookSignature(rawBody, signature, webhookSecret);
	if (!isValid) {
		return new Response("Invalid Stripe signature", { status: 400 });
	}

	try {
		const event = JSON.parse(rawBody) as {
			type: string;
			data: { object: Record<string, unknown> };
		};
		const db = getDB();
		const nowIso = new Date().toISOString();

		// 1. เมื่อชำระเงินสำเร็จครั้งแรก (ทั้งแบบซื้อขาดและรายเดือน)
		if (event.type === "checkout.session.completed") {
			const session = event.data.object;
			const metadata = (session.metadata ?? {}) as Record<string, string>;
			const memberId = metadata.member_id || String(session.client_reference_id ?? "");
			const grantType = metadata.grant_type === "all_access" ? "all_access" : "book";
			const targetSlug = grantType === "all_access" ? "*" : metadata.target_slug || "";
			const customerId = typeof session.customer === "string" ? session.customer : null;

			if (memberId && customerId) {
				await db
					.prepare("UPDATE app_members SET stripe_customer_id = ?, updated_at = ? WHERE id = ?")
					.bind(customerId, nowIso, memberId)
					.run();
			}

			if (memberId && targetSlug) {
				if (grantType === "book") {
					const sessionId = String(session.id ?? "");
					const existing = await db
						.prepare("SELECT id FROM app_member_grants WHERE stripe_ref_id = ?")
						.bind(sessionId)
						.first<{ id: string }>();

					if (!existing) {
						await db
							.prepare(
								`INSERT INTO app_member_grants
								 (id, member_id, grant_type, target_slug, source, stripe_ref_id, note, expires_at, created_at)
								 VALUES (?, ?, 'book', ?, 'stripe_onetime', ?, 'ชำระเงินผ่าน Stripe', NULL, ?)`,
							)
							.bind(crypto.randomUUID(), memberId, targetSlug, sessionId, nowIso)
							.run();
					}
				} else if (grantType === "all_access") {
					const subId = typeof session.subscription === "string" ? session.subscription : String(session.id ?? "");
					let expiresAtIso = new Date(Date.now() + 32 * 24 * 60 * 60 * 1000).toISOString();

					if (typeof session.subscription === "string") {
						try {
							const sub = await stripeRequest<Record<string, unknown>>(
								`/subscriptions/${session.subscription}`,
							);
							expiresAtIso = extractPeriodEndIso(sub);
						} catch {
							// ใช้ค่าสำรอง 32 วันหากดึงข้อมูลรอบบิลไม่สำเร็จ
						}
					}

					const existing = await db
						.prepare("SELECT id FROM app_member_grants WHERE stripe_ref_id = ?")
						.bind(subId)
						.first<{ id: string }>();

					if (existing) {
						await db
							.prepare("UPDATE app_member_grants SET expires_at = ? WHERE id = ?")
							.bind(expiresAtIso, existing.id)
							.run();
					} else {
						await db
							.prepare(
								`INSERT INTO app_member_grants
								 (id, member_id, grant_type, target_slug, source, stripe_ref_id, note, expires_at, created_at)
								 VALUES (?, ?, 'all_access', '*', 'stripe_subscription', ?, 'สมาชิกรายเดือนอัตโนมัติ', ?, ?)`,
							)
							.bind(crypto.randomUUID(), memberId, subId, expiresAtIso, nowIso)
							.run();
					}
				}
			}
		}

		// 2. เมื่อตัดรอบบิลรายเดือนสำเร็จในเดือนถัดไป -> ต่ออายุวันหมดอายุอัตโนมัติ
		if (event.type === "invoice.paid") {
			const invoice = event.data.object;
			const subId = typeof invoice.subscription === "string" ? invoice.subscription : "";
			if (subId) {
				try {
					const sub = await stripeRequest<Record<string, unknown>>(`/subscriptions/${subId}`);
					const expiresAtIso = extractPeriodEndIso(sub);
					await db
						.prepare("UPDATE app_member_grants SET expires_at = ? WHERE stripe_ref_id = ?")
						.bind(expiresAtIso, subId)
						.run();
				} catch (err) {
					console.error("Failed to extend subscription on invoice.paid:", err);
				}
			}
		}

		// 3. เมื่อสมาชิกยกเลิกหรือสิ้นสุดแพ็กเกจรายเดือน
		if (event.type === "customer.subscription.deleted") {
			const sub = event.data.object;
			const subId = String(sub.id ?? "");
			if (subId) {
				await db
					.prepare("UPDATE app_member_grants SET expires_at = ? WHERE stripe_ref_id = ?")
					.bind(nowIso, subId)
					.run();
			}
		}

		return new Response("OK", { status: 200 });
	} catch (err) {
		console.error("Webhook processing error:", err);
		return new Response("Webhook error", { status: 500 });
	}
};