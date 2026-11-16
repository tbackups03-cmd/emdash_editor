function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	const tag = target.tagName.toUpperCase();
	return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

export function initProtectedReader(): void {
	const container = document.querySelector<HTMLElement>("[data-protected-article]");
	if (!container) return;

	// 1. บล็อกการคลิกขวา ลากคลุมดำ และลากรูปภาพภายในบทความ (ยกเว้นช่องพิมพ์ความคิดเห็น)
	const blockSelectionAndMenu = (e: Event) => {
		if (isEditableTarget(e.target)) return;
		e.preventDefault();
	};

	container.addEventListener("contextmenu", blockSelectionAndMenu);
	container.addEventListener("selectstart", blockSelectionAndMenu);
	container.addEventListener("dragstart", blockSelectionAndMenu);

	// 2. บล็อกการคัดลอก/ตัดข้อความ และล้างคลิปบอร์ดหากมีการสั่งคัดลอก
	const blockCopy = (e: ClipboardEvent) => {
		if (isEditableTarget(e.target)) return;
		e.preventDefault();
		e.clipboardData?.setData("text/plain", "เนื้อหานี้สงวนสิทธิ์เฉพาะสมาชิก ไม่อนุญาตให้คัดลอกหรือเผยแพร่ซ้ำ");
	};

	container.addEventListener("copy", blockCopy);
	container.addEventListener("cut", blockCopy);

	container.querySelectorAll("img").forEach((img) => {
		img.setAttribute("draggable", "false");
	});

	// 3. บล็อกปุ่มลัดคัดลอก เลือกทั้งหมด บันทึกหน้าเว็บ และสั่งพิมพ์ (Ctrl+C, Ctrl+X, Ctrl+A, Ctrl+S, Ctrl+P, Ctrl+U)
	document.addEventListener("keydown", (e) => {
		const isModifier = e.ctrlKey || e.metaKey;
		if (!isModifier) return;

		const key = e.key.toLowerCase();
		if (isEditableTarget(e.target) && (key === "c" || key === "x" || key === "a")) {
			return;
		}

		if (key === "c" || key === "x" || key === "a" || key === "s" || key === "p" || key === "u") {
			e.preventDefault();
		}
	});
}