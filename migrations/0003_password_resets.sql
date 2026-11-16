CREATE TABLE IF NOT EXISTS app_password_resets (
	token_hash TEXT PRIMARY KEY,
	member_id TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	FOREIGN KEY (member_id) REFERENCES app_members(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_app_password_resets_member ON app_password_resets(member_id);