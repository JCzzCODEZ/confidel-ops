import type { NextRequest } from "next/server";
import { assertNoDbError, handleRouteError, json, requireCompanyAdmin, requireUser } from "../../_shared";

export const dynamic = "force-dynamic";

// Owner/admin-only: per-employee rollups (assigned/completed jobs, hours,
// reimbursement, payroll). Owner-only financial data.
export async function GET(request: NextRequest) {
  try {
    const { supabase, user } = await requireUser(request);
    const companyId = request.nextUrl.searchParams.get("companyId");
    if (!companyId) return json({ error: "companyId is required" }, 400);
    await requireCompanyAdmin(supabase, user, companyId);

    const { data, error } = await supabase.rpc("team_member_stats", { p_company_id: companyId });
    assertNoDbError(error);

    return json({ stats: data ?? [] });
  } catch (error) {
    return handleRouteError(error);
  }
}
