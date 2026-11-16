import type { AstroCookies } from "astro";
import { getCurrentMember, getDB, type MemberUser } from "./member-auth";

export interface BookProduct {
	category_slug: string;
	title: string;
	access_mode: "free" | "paid";
	price_thb: number;
	preview_paragraphs: number;
	stripe_price_id: string | null;
}

export interface MemberGrant {
	id: string;
	member_id: string;
	grant_type: "all_access" | "book";
	target_slug: string;
	source: "stripe_subscription" | "stripe_onetime" | "admin_custom";
	stripe_ref_id: string | null;
	note: string | null;
	expires_at: string | null;
	created_at: string;
}

export interface PostAccessResult {
	hasAccess: boolean;
	isPaidContent: boolean;
	reason: "free" | "admin" | "granted" | "not_logged_in" | "no_grant";
	member: MemberUser | null;
	product: BookProduct | null;
	activeGrant: MemberGrant | null;
}

export async function checkPostAccess(params: {
	cookies: AstroCookies;
	categorySlugs: string[];
	postSlug: string;
	isAdminLoggedIn: boolean;
}): Promise<PostAccessResult> {
	const { cookies, categorySlugs, postSlug, isAdminLoggedIn } = params;
	const member = await getCurrentMember(cookies);

	// ตรวจสอบทั้งระดับหมวดหมู่ (หนังสือ) และระดับบทความเดี่ยว (เผื่อกรณีล็อกเฉพาะบทความ)
	const targetKeys = [...new Set([...categorySlugs, `post:${postSlug}`])].filter(Boolean);
	if (targetKeys.length === 0) {
		return {
			hasAccess: true,
			isPaidContent: false,
			reason: "free",
			member,
			product: null,
			activeGrant: null,
		};
	}

	try {
		const db = getDB();
		const placeholders = targetKeys.map(() => "?").join(", ");
		const paidProduct = await db
			.prepare(
				`SELECT category_slug, title, access_mode, price_thb, preview_paragraphs, stripe_price_id
				 FROM app_book_products
				 WHERE category_slug IN (${placeholders}) AND access_mode = 'paid'
				 LIMIT 1`,
			)
			.bind(...targetKeys)
			.first<BookProduct>();

		// หากไม่ได้ตั้งค่าเป็นเนื้อหาแบบเสียเงิน ให้ทุกคนอ่านฟรี
		if (!paidProduct) {
			return {
				hasAccess: true,
				isPaidContent: false,
				reason: "free",
				member,
				product: null,
				activeGrant: null,
			};
		}

		// หากเป็นผู้ดูแลระบบของ EmDash ให้เข้าถึงได้เสมอเพื่อตรวจสอบเนื้อหา
		if (isAdminLoggedIn) {
			return {
				hasAccess: true,
				isPaidContent: true,
				reason: "admin",
				member,
				product: paidProduct,
				activeGrant: null,
			};
		}

		// หากยังไม่ได้ล็อกอินในฐานะสมาชิก
		if (!member) {
			return {
				hasAccess: false,
				isPaidContent: true,
				reason: "not_logged_in",
				member: null,
				product: paidProduct,
				activeGrant: null,
			};
		}

		// ตรวจสอบสิทธิ์ในตาราง app_member_grants (ทั้งรายเดือน, ซื้อขาด และแอดมินกำหนดเอง)
		const nowIso = new Date().toISOString();
		const grantPlaceholders = targetKeys.map(() => "?").join(", ");
		const activeGrant = await db
			.prepare(
				`SELECT id, member_id, grant_type, target_slug, source, stripe_ref_id, note, expires_at, created_at
				 FROM app_member_grants
				 WHERE member_id = ?
				   AND (expires_at IS NULL OR expires_at > ?)
				   AND (
				     grant_type = 'all_access'
				     OR (grant_type = 'book' AND target_slug IN (${grantPlaceholders}))
				   )
				 ORDER BY expires_at IS NULL DESC, expires_at DESC
				 LIMIT 1`,
			)
			.bind(member.id, nowIso, ...targetKeys)
			.first<MemberGrant>();

		if (activeGrant) {
			return {
				hasAccess: true,
				isPaidContent: true,
				reason: "granted",
				member,
				product: paidProduct,
				activeGrant,
			};
		}

		return {
			hasAccess: false,
			isPaidContent: true,
			reason: "no_grant",
			member,
			product: paidProduct,
			activeGrant: null,
		};
	} catch (err) {
		console.error("Access check error:", err);
		return {
			hasAccess: true,
			isPaidContent: false,
			reason: "free",
			member,
			product: null,
			activeGrant: null,
		};
	}
}