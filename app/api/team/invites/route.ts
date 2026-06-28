import type { NextRequest } from "next/server";
import { assertNoDbError, handleRouteError, json, requireCompanyAdmin, requireUser } from "../../_shared";

export const dynamic = "force-dynamic";

// Owner/admin-only: list pending invites for the company.
export async function GET(request: NextRequest) {
  try {
    const { supabase, user } = await requireUser(request);
    const companyId = request.nextUrl.searchParams.get("companyId");
    if (!companyId) return json({ error: "companyId is required" }, 400);
    await requireCompanyAdmin(supabase, user, companyId);

    // All recent invites (pending/accepted/revoked) so the UI can show state.
    const { data, error } = await supabase
      .from("company_invites")
      .select("id, email, full_name, role, status, token, created_at, expires_at, preferred_language")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(50);
    assertNoDbError(error);

    return json({ invites: data ?? [] });
  } catch (error) {
    return handleRouteError(error);
  }
}
