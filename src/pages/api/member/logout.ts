import type { APIRoute } from "astro";
import { destroyMemberSession } from "../../../lib/member-auth";

export const POST: APIRoute = async ({ cookies, redirect }) => {
	await destroyMemberSession(cookies);
	return redirect("/", 302);
};