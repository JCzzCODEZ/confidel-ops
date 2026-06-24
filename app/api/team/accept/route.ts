import type { NextRequest } from "next/server";
import { assertNoDbError, handleRouteError, json, requireUser } from "../../_shared";

export const dynamic = "force-dynamic";

// Any logged-in user: accept a pending invite that matches their auth email.
// Creates/activates their company_memberships row via accept_my_invite().
export async function POST(request: NextRequest) {
  try {
    const { supabase } = await requireUser(request);
    const { data, error } = await supabase.rpc("accept_my_invite");
    assertNoDbError(error);
    return json({ result: data ?? { accepted: false } });
  } catch (error) {
    return handleRouteError(error);
  }
}
