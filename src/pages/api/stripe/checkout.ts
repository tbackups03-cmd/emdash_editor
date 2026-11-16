import type { APIRoute } from "astro";
import { cleanCheckoutParams, getCurrentMember, getDB } from "../../../lib/member-auth";
import type { BookProduct } from "../../../lib/member-access";
import { stripeRequest } from "../../../lib/stripe";

export const POST: APIRoute = async ({ request, cookies, url }) => {
	try {
		const member = await getCurrentMember(cookies);
		if (!member) {
			return Response.json({ error: "กรุณาเข้าสู่ระบบก่อนทำการสั่งซื้อ" }, { status: 401 });
		}

		const body = (await request.json()) as Record<string, unknown>;
		const checkoutMode = body.mode === "subscription" ? "subscription" : "onetime";
		const targetSlug = checkoutMode === "subscription" ? "__subscription__" : String(body.target_slug ?? "").trim();
		const returnPath = cleanCheckoutParams(String(body.return_path ?? "/"));

		if (!targetSlug) {
			return Response.json({ error: "ไม่พบข้อมูลหนังสือที่ต้องการสั่งซื้อ" }, { status: 400 });
		}

		const db = getDB();
		const product = await db
			.prepare(
				"SELECT category_slug, title, access_mode, price_thb, preview_paragraphs, stripe_price_id FROM app_book_products WHERE category_slug = ?",
			)
			.bind(targetSlug)
			.first<BookProduct>();

		if (!product) {
			return Response.json({ error: "ยังไม่ได้ตั้งค่าแพ็กเกจนี้ในระบบหลังบ้าน" }, { status: 404 });
		}

		if (!product.stripe_price_id && product.price_thb < 10) {
			return Response.json(
				{ error: "ยังไม่ได้ตั้งค่าราคาสำหรับแพ็กเกจนี้ (ขั้นต่ำ 10 บาท) กรุณาติดต่อผู้ดูแลระบบ" },
				{ status: 400 },
			);
		}

		const grantType = checkoutMode === "subscription" ? "all_access" : "book";
		const grantTarget = checkoutMode === "subscription" ? "*" : product.category_slug;

		const metadata = {
			member_id: member.id,
			grant_type: grantType,
			target_slug: grantTarget,
		};

		const lineItem = product.stripe_price_id
			? { price: product.stripe_price_id, quantity: 1 }
			: checkoutMode === "subscription"
				? {
						price_data: {
							currency: "thb",
							unit_amount: product.price_thb * 100,
							recurring: { interval: "month" },
							product_data: {
								name: product.title || "สมาชิกรายเดือนแบบเต็มรูปแบบ",
								description: "เข้าถึงหนังสือและบทความพิเศษทั้งหมดในเว็บไซต์ได้ไม่จำกัด",
							},
						},
						quantity: 1,
					}
				: {
						price_data: {
							currency: "thb",
							unit_amount: product.price_thb * 100,
							product_data: {
								name: product.title,
								description: "ซื้อขาดหนังสือรายเล่ม กลับมาอ่านได้ตลอดชีพ",
							},
						},
						quantity: 1,
					};

		const separator = returnPath.includes("?") ? "&" : "?";
		const successUrl = `${url.origin}${returnPath}${separator}checkout=success&session_id={CHECKOUT_SESSION_ID}`;
		const cancelUrl = `${url.origin}${returnPath}${separator}checkout=cancel`;

		const sessionPayload: Record<string, unknown> = {
			mode: checkoutMode === "subscription" ? "subscription" : "payment",
			line_items: [lineItem],
			success_url: successUrl,
			cancel_url: cancelUrl,
			client_reference_id: member.id,
			metadata,
		};

		if (member.stripe_customer_id) {
			sessionPayload.customer = member.stripe_customer_id;
		} else {
			sessionPayload.customer_email = member.email;
		}

		if (checkoutMode === "subscription") {
			sessionPayload.subscription_data = { metadata };
		}

		const session = await stripeRequest<{ url?: string }>("/checkout/sessions", {
			method: "POST",
			body: sessionPayload,
		});

		if (!session.url) {
			return Response.json({ error: "ไม่สามารถสร้างลิงก์ชำระเงินได้" }, { status: 500 });
		}

		return Response.json({ url: session.url });
	} catch (err) {
		console.error("Stripe checkout error:", err);
		const msg = err instanceof Error ? err.message : "เกิดข้อผิดพลาดในการสร้างรายการชำระเงิน";
		return Response.json({ error: msg }, { status: 500 });
	}
};