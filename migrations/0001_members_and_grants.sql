-- 1. ตารางเก็บข้อมูลสมาชิกผู้อ่าน
CREATE TABLE IF NOT EXISTS app_members (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	password_salt TEXT NOT NULL,
	display_name TEXT NOT NULL,
	stripe_customer_id TEXT,
	status TEXT NOT NULL DEFAULT 'active',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

-- 2. ตารางเก็บสถานะการล็อกอิน (แยกจากระบบหลังบ้านของ EmDash)
CREATE TABLE IF NOT EXISTS app_member_sessions (
	token_hash TEXT PRIMARY KEY,
	member_id TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	FOREIGN KEY (member_id) REFERENCES app_members(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_app_member_sessions_member ON app_member_sessions(member_id);

-- 3. ตารางตั้งค่าราคาและสถานะหนังสือแต่ละเล่ม (ผูกกับ slug ของหมวดหมู่)
CREATE TABLE IF NOT EXISTS app_book_products (
	category_slug TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	access_mode TEXT NOT NULL DEFAULT 'free',
	price_thb INTEGER NOT NULL DEFAULT 0,
	stripe_price_id TEXT,
	updated_at TEXT NOT NULL
);

-- 4. ตารางเก็บสิทธิ์การเข้าถึง (รองรับทั้งรายเดือน, ซื้อขาดรายเล่ม และแอดมินกำหนดเอง)
CREATE TABLE IF NOT EXISTS app_member_grants (
	id TEXT PRIMARY KEY,
	member_id TEXT NOT NULL,
	grant_type TEXT NOT NULL,
	target_slug TEXT NOT NULL,
	source TEXT NOT NULL,
	stripe_ref_id TEXT,
	note TEXT,
	expires_at TEXT,
	created_at TEXT NOT NULL,
	FOREIGN KEY (member_id) REFERENCES app_members(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_app_member_grants_member ON app_member_grants(member_id);
CREATE INDEX IF NOT EXISTS idx_app_member_grants_target ON app_member_grants(grant_type, target_slug);