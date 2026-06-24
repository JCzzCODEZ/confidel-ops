import type { NextRequest } from "next/server";
import {
  assertNoDbError,
  handleRouteError,
  json,
  readJsonObject,
  requireCompanyAdmin,
  requiredString,
  requireUser,
} from "../../_shared";

export const dynamic = "force-dynamic";

// Owner/admin-only: change a member's role and/or active status. Authorization
// is re-checked inside set_company_membership() as well.
export async function POST(request: NextRequest) {
  try {
    const { supabase, user } = await requireUser(request);
    const body = await readJsonObject(request);
    const companyId = requiredString(body, "companyId");
    await requireCompanyAdmin(supabase, user, companyId);

    const { error } = await supabase.rpc("set_company_membership", {
      p_company_id: companyId,
      p_user_id: requiredString(body, "userId"),
      p_role: typeof body.role === "string" ? body.role : null,
      p_is_active: typeof body.isActive === "boolean" ? body.isActive : null,
    });
    assertNoDbError(error);

    return json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
