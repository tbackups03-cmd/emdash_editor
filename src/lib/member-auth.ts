import type { AstroCookies } from "astro";
import { env } from "cloudflare:workers";

export const MEMBER_COOKIE_NAME = "spt_member_session";
const SESSION_DAYS = 30;

export interface MemberUser {
	id: string;
	email: string;
	display_name: string;
	stripe_customer_id: string | null;
	status: string;
}

export function getDB(): D1Database {
	const db = (env as unknown as { DB?: D1Database }).DB;
	if (!db) {
		throw new Error("ไม่พบการเชื่อมต่อฐานข้อมูล D1 (DB binding)");
	}
	return db;
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
	const buffer = new ArrayBuffer(hex.length / 2);
	const bytes = new Uint8Array(buffer);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
	}
	return bytes;
}

export function generateRandomHex(byteLength = 32): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return bytesToHex(bytes);
}

export async function sha256Hex(input: string): Promise<string> {
	const data = new TextEncoder().encode(input);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	return bytesToHex(new Uint8Array(hashBuffer));
}

export async function hashPassword(password: string, saltHex?: string): Promise<{ hash: string; salt: string }> {
	const salt = saltHex ?? generateRandomHex(16);
	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		{ name: "PBKDF2" },
		false,
		["deriveBits"],
	);
	const derivedBits = await crypto.subtle.deriveBits(
		{
			name: "PBKDF2",
			salt: hexToBytes(salt),
			iterations: 100000,
			hash: "SHA-256",
		},
		keyMaterial,
		256,
	);
	return {
		hash: bytesToHex(new Uint8Array(derivedBits)),
		salt,
	};
}

export async function verifyPassword(password: string, saltHex: string, expectedHash: string): Promise<boolean> {
	const { hash } = await hashPassword(password, saltHex);
	if (hash.length !== expectedHash.length) return false;
	let diff = 0;
	for (let i = 0; i < hash.length; i++) {
		diff |= hash.charCodeAt(i) ^ expectedHash.charCodeAt(i);
	}
	return diff === 0;
}

export async function createMemberSession(cookies: AstroCookies, memberId: string): Promise<void> {
	const db = getDB();
	const rawToken = generateRandomHex(32);
	const tokenHash = await sha256Hex(rawToken);
	const now = new Date();
	const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);

	await db
		.prepare(
			"INSERT INTO app_member_sessions (token_hash, member_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
		)
		.bind(tokenHash, memberId, expiresAt.toISOString(), now.toISOString())
		.run();

	cookies.set(MEMBER_COOKIE_NAME, rawToken, {
		path: "/",
		httpOnly: true,
		sameSite: "lax",
		secure: import.meta.env.PROD,
		expires: expiresAt,
	});
}

export async function getCurrentMember(cookies: AstroCookies): Promise<MemberUser | null> {
	const rawToken = cookies.get(MEMBER_COOKIE_NAME)?.value;
	if (!rawToken) return null;

	try {
		const db = getDB();
		const tokenHash = await sha256Hex(rawToken);
		const nowIso = new Date().toISOString();

		const row = await db
			.prepare(
				`SELECT m.id, m.email, m.display_name, m.stripe_customer_id, m.status
				 FROM app_member_sessions s
				 JOIN app_members m ON m.id = s.member_id
				 WHERE s.token_hash = ? AND s.expires_at > ?`,
			)
			.bind(tokenHash, nowIso)
			.first<MemberUser>();

		if (!row || row.status !== "active") {
			cookies.delete(MEMBER_COOKIE_NAME, { path: "/" });
			return null;
		}

		return row;
	} catch {
		return null;
	}
}

export async function destroyMemberSession(cookies: AstroCookies): Promise<void> {
	const rawToken = cookies.get(MEMBER_COOKIE_NAME)?.value;
	if (rawToken) {
		try {
			const db = getDB();
			const tokenHash = await sha256Hex(rawToken);
			await db.prepare("DELETE FROM app_member_sessions WHERE token_hash = ?").bind(tokenHash).run();
		} catch {
			// ข้ามหากลบไม่สำเร็จ
		}
	}
	cookies.delete(MEMBER_COOKIE_NAME, { path: "/" });
}
// ป้องกันช่องโหว่ Open Redirect: อนุญาตเฉพาะ Path ภายในเว็บไซต์ที่ขึ้นต้นด้วย "/" ตัวเดียวเท่านั้น
export function sanitizeRedirectPath(raw: string | null | undefined, fallback = "/"): string {
	if (!raw) return fallback;
	const trimmed = raw.trim();
	if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.startsWith("/\\")) {
		return fallback;
	}
	try {
		const parsed = new URL(trimmed, "http://localhost");
		if (parsed.origin !== "http://localhost") return fallback;
		return `${parsed.pathname}${parsed.search}${parsed.hash}`;
	} catch {
		return fallback;
	}
}

// ล้างพารามิเตอร์ชั่วคราวของระบบชำระเงินออกจาก URL เพื่อป้องกันการวนลูป
export function cleanCheckoutParams(rawPath: string): string {
	const safePath = sanitizeRedirectPath(rawPath, "/");
	try {
		const parsed = new URL(safePath, "http://localhost");
		parsed.searchParams.delete("auto_checkout");
		parsed.searchParams.delete("target_slug");
		parsed.searchParams.delete("checkout");
		parsed.searchParams.delete("session_id");
		const qs = parsed.searchParams.toString();
		return `${parsed.pathname}${qs ? `?${qs}` : ""}`;
	} catch {
		return "/";
	}
}