import { env } from "cloudflare:workers";
import { getDB } from "./member-auth";

export function getStripeEnv(): { secretKey: string; webhookSecret: string } {
	const e = env as unknown as Record<string, string | undefined>;
	const secretKey = (e.STRIPE_SECRET_KEY ?? "").trim();
	const webhookSecret = (e.STRIPE_WEBHOOK_SECRET ?? "").trim();
	return { secretKey, webhookSecret };
}

function appendFormParams(params: URLSearchParams, prefix: string, value: unknown): void {
	if (value === undefined || value === null) return;
	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			appendFormParams(params, `${prefix}[${index}]`, item);
		});
	} else if (typeof value === "object") {
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			appendFormParams(params, `${prefix}[${k}]`, v);
		}
	} else {
		params.append(prefix, String(value));
	}
}

export async function stripeRequest<T = Record<string, unknown>>(
	path: string,
	options: {
		method?: "GET" | "POST";
		body?: Record<string, unknown>;
	} = {},
): Promise<T> {
	const { secretKey } = getStripeEnv();
	if (!secretKey) {
		throw new Error("ยังไม่ได้ตั้งค่า STRIPE_SECRET_KEY ในระบบ");
	}

	const method = options.method ?? "GET";
	const headers: Record<string, string> = {
		Authorization: `Bearer ${secretKey}`,
	};

	let bodyString: string | undefined;
	if (method === "POST" && options.body) {
		headers["Content-Type"] = "application/x-www-form-urlencoded";
		const params = new URLSearchParams();
		for (const [k, v] of Object.entries(options.body)) {
			appendFormParams(params, k, v);
		}
		bodyString = params.toString();
	}

	const res = await fetch(`https://api.stripe.com/v1${path}`, {
		method,
		headers,
		body: bodyString,
	});

	const data = (await res.json()) as Record<string, unknown>;
	if (!res.ok) {
		const errObj = data.error as { message?: string } | undefined;
		throw new Error(errObj?.message || `Stripe API error (${res.status})`);
	}

	return data as T;
}

export async function verifyStripeWebhookSignature(
	rawBody: string,
	signatureHeader: string | null,
	webhookSecret: string,
): Promise<boolean> {
	if (!signatureHeader || !webhookSecret) return false;

	const parts = signatureHeader.split(",");
	let timestamp = "";
	const v1Signatures: string[] = [];

	for (const part of parts) {
		const [key, val] = part.split("=");
		if (key === "t" && val) timestamp = val.trim();
		if (key === "v1" && val) v1Signatures.push(val.trim());
	}

	if (!timestamp || v1Signatures.length === 0) return false;

	const tsNum = Number(timestamp);
	if (isNaN(tsNum) || Math.abs(Math.floor(Date.now() / 1000) - tsNum) > 300) {
		return false;
	}

	const encoder = new TextEncoder();
	const signedPayload = `${timestamp}.${rawBody}`;
	const keyBytes = encoder.encode(webhookSecret);
	const keyBuffer = new ArrayBuffer(keyBytes.length);
	new Uint8Array(keyBuffer).set(keyBytes);

	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		keyBuffer,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);

	const payloadBytes = encoder.encode(signedPayload);
	const payloadBuffer = new ArrayBuffer(payloadBytes.length);
	new Uint8Array(payloadBuffer).set(payloadBytes);

	const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, payloadBuffer);
	const expectedHex = Array.from(new Uint8Array(signatureBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	return v1Signatures.some((sig) => {
		if (sig.length !== expectedHex.length) return false;
		let diff = 0;
		for (let i = 0; i < sig.length; i++) {
			diff |= sig.charCodeAt(i) ^ expectedHex.charCodeAt(i);
		}
		return diff === 0;
	});
}

// ตรวจสอบสถานะการชำระเงินจาก Stripe โดยตรงทันทีเมื่อลูกค้าเด้งกลับมาที่หน้าบทความ
export async function fulfillCheckoutSessionById(sessionId: string): Promise<boolean> {
	if (!sessionId || !sessionId.startsWith("cs_")) return false;

	try {
		const session = await stripeRequest<Record<string, unknown>>(
			`/checkout/sessions/${encodeURIComponent(sessionId)}`,
		);

		const paymentStatus = String(session.payment_status ?? "");
		const status = String(session.status ?? "");
		if (paymentStatus !== "paid" && status !== "complete") {
			return false;
		}

		const metadata = (session.metadata ?? {}) as Record<string, string>;
		const memberId = metadata.member_id || String(session.client_reference_id ?? "");
		const grantType = metadata.grant_type === "all_access" ? "all_access" : "book";
		const targetSlug = grantType === "all_access" ? "*" : metadata.target_slug || "";
		const customerId = typeof session.customer === "string" ? session.customer : null;

		if (!memberId || !targetSlug) return false;

		const db = getDB();
		const nowIso = new Date().toISOString();

		if (customerId) {
			await db
				.prepare("UPDATE app_members SET stripe_customer_id = ?, updated_at = ? WHERE id = ?")
				.bind(customerId, nowIso, memberId)
				.run();
		}

		if (grantType === "book") {
			const sid = String(session.id ?? sessionId);
			const existing = await db
				.prepare("SELECT id FROM app_member_grants WHERE stripe_ref_id = ?")
				.bind(sid)
				.first<{ id: string }>();

			if (!existing) {
				await db
					.prepare(
						`INSERT INTO app_member_grants
						 (id, member_id, grant_type, target_slug, source, stripe_ref_id, note, expires_at, created_at)
						 VALUES (?, ?, 'book', ?, 'stripe_onetime', ?, 'ชำระเงินผ่าน Stripe', NULL, ?)`,
					)
					.bind(crypto.randomUUID(), memberId, targetSlug, sid, nowIso)
					.run();
			}
			return true;
		}

		if (grantType === "all_access") {
			const subId =
				typeof session.subscription === "string" ? session.subscription : String(session.id ?? sessionId);
			let expiresAtIso = new Date(Date.now() + 32 * 24 * 60 * 60 * 1000).toISOString();

			if (typeof session.subscription === "string") {
				try {
					const sub = await stripeRequest<Record<string, unknown>>(
						`/subscriptions/${session.subscription}`,
					);
					let periodEndUnix = Number(sub.current_period_end ?? 0);
					if (!periodEndUnix) {
						const items = sub.items as { data?: Array<{ current_period_end?: number }> } | undefined;
						periodEndUnix = Number(items?.data?.[0]?.current_period_end ?? 0);
					}
					if (periodEndUnix > 0) {
						expiresAtIso = new Date((periodEndUnix + 86400) * 1000).toISOString();
					}
				} catch {
					// ใช้ค่าสำรอง 32 วัน
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
			return true;
		}

		return false;
	} catch (err) {
		console.error("Verify checkout session error:", err);
		return false;
	}
}