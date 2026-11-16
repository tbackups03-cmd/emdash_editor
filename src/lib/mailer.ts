import { env } from "cloudflare:workers";

export async function sendPasswordResetEmail(options: {
	toEmail: string;
	displayName: string;
	resetUrl: string;
}): Promise<void> {
	const workerEnv = env as unknown as {
		GOOGLE_SCRIPT_URL?: string;
	};

	const scriptUrl = workerEnv.GOOGLE_SCRIPT_URL?.trim();

	if (!scriptUrl) {
		console.warn(`[DEV MAIL] ลิงก์รีเซ็ตสำหรับ ${options.toEmail}: ${options.resetUrl}`);
		return;
	}

	const response = await fetch(scriptUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			email: options.toEmail,
			name: options.displayName,
			resetUrl: options.resetUrl,
		}),
	});

	if (!response.ok) {
		const errText = await response.text();
		throw new Error(`ส่งอีเมลผ่าน Google Script ไม่สำเร็จ (${response.status}): ${errText}`);
	}

	const result = (await response.json()) as { status?: string; message?: string };
	if (result.status !== "success") {
		throw new Error(`Google Script Error: ${result.message || "Unknown error"}`);
	}
}