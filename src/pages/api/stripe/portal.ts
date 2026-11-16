import type { APIRoute } from "astro";
import { getCurrentMember, getDB } from "../../../lib/member-auth";
import { stripeRequest } from "../../../lib/stripe";

export const POST: APIRoute = async ({ cookies, url }) => {
	try {
		const member = await getCurrentMember(cookies);
		if (!member) {
			return new Response(JSON.stringify({ error: "กรุณาเข้าสู่ระบบก่อนดำเนินการ" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		}

		const db = getDB();
		const grantsResult = await db
			.prepare(
				`SELECT stripe_ref_id FROM app_member_grants
				 WHERE member_id = ? AND stripe_ref_id IS NOT NULL
				 ORDER BY created_at DESC LIMIT 10`,
			)
			.bind(member.id)
			.all<{ stripe_ref_id: string | null }>();

		let customerId: string | null = null;

		// 1. ค้นหารหัสลูกค้า (cus_...) จากรหัสอ้างอิงการชำระเงินทุกรูปแบบในฐานข้อมูล
		for (const row of grantsResult.results ?? []) {
			const refId = (row.stripe_ref_id ?? "").trim();
			if (!refId) continue;

			try {
				if (refId.startsWith("cus_")) {
					customerId = refId;
					break;
				} else if (refId.startsWith("sub_")) {
					const sub = await stripeRequest<Record<string, unknown>>(`/subscriptions/${refId}`);
					if (typeof sub.customer === "string") {
						customerId = sub.customer;
						break;
					}
				} else if (refId.startsWith("cs_")) {
					const sess = await stripeRequest<Record<string, unknown>>(`/checkout/sessions/${refId}`);
					if (typeof sess.customer === "string") {
						customerId = sess.customer;
						break;
					}
				} else if (refId.startsWith("pi_")) {
					const pi = await stripeRequest<Record<string, unknown>>(`/payment_intents/${refId}`);
					if (typeof pi.customer === "string") {
						customerId = pi.customer;
						break;
					}
				} else if (refId.startsWith("in_")) {
					const inv = await stripeRequest<Record<string, unknown>>(`/invoices/${refId}`);
					if (typeof inv.customer === "string") {
						customerId = inv.customer;
						break;
					}
				}
			} catch {
				// ข้ามรายการที่ค้นหาไม่พบแล้วลองตรวจสอบรายการถัดไป
			}
		}

		// 2. หากยังไม่พบ ให้ค้นหาบัญชีลูกค้าใน Stripe จากอีเมลของสมาชิกโดยตรง
		if (!customerId && member.email) {
			const customersRes = await stripeRequest<{ data?: Array<{ id?: string }> }>(
				`/customers?email=${encodeURIComponent(member.email)}&limit=1`,
			);
			const foundId = customersRes.data?.[0]?.id;
			if (typeof foundId === "string" && foundId) {
				customerId = foundId;
			}
		}

		if (!customerId) {
			return new Response(
				JSON.stringify({
					error: "ยังไม่พบประวัติลูกค้าในระบบ Stripe สำหรับอีเมลนี้ (หากเพิ่งเปิดสิทธิ์ผ่านแอดมินจะยังไม่มีบิลในระบบ)",
				}),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		const portalSession = await stripeRequest<{ url?: string }>("/billing_portal/sessions", {
			method: "POST",
			body: {
				customer: customerId,
				return_url: `${url.origin}/account`,
			},
		});

		if (!portalSession.url) {
			throw new Error("Stripe ไม่ได้ส่งลิงก์จัดการบัญชีกลับมา");
		}

		return new Response(JSON.stringify({ url: portalSession.url }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	} catch (err) {
		const message =
			err instanceof Error ? err.message : "ไม่สามารถเปิดหน้าจัดการการชำระเงินได้ในขณะนี้";
		return new Response(JSON.stringify({ error: message }), {
			status: 500,
			headers: { "Content-Type": "application/json" },
		});
	}
};