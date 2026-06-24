import type { NextRequest } from "next/server";
import {
  assertNoDbError,
  handleRouteError,
  json,
  requireCompanyAdmin,
  requireUser,
} from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { supabase, user } = await requireUser(request);
    const companyId = request.nextUrl.searchParams.get("companyId");

    if (!companyId) {
      return json({ error: "companyId is required" }, 400);
    }

    await requireCompanyAdmin(supabase, user, companyId);

    const { data, error } = await supabase
      .from("company_memberships")
      .select("user_id, full_name, email, role, is_active")
      .eq("company_id", companyId)
      .eq("role", "employee")
      .order("full_name", { ascending: true, nullsFirst: false });

    assertNoDbError(error);

    return json({
      employees: (data ?? []).map((employee) => ({
        id: employee.user_id,
        name: employee.full_name,
        email: employee.email,
        role: employee.role,
        active: employee.is_active,
      })),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
