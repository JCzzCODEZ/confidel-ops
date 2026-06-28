import type { NextRequest } from "next/server";
import { assertNoDbError, handleRouteError, json, requireUser } from "../../_shared";

export const dynamic = "force-dynamic";

// Any logged-in user: accept a pending invite that matches their auth email
// (and the invite token, when supplied). accept_my_invite() does the atomic
// token + email + pending + expiry + single-use check.
export async function POST(request: NextRequest) {
  try {
    const { supabase } = await requireUser(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const token = typeof body.token === "string" ? body.token : null;
    const { data, error } = await supabase.rpc("accept_my_invite", { p_token: token });
    assertNoDbError(error);
    return json({ result: data ?? { accepted: false } });
  } catch (error) {
    return handleRouteError(error);
  }
}
