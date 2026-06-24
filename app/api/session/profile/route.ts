import type { NextRequest } from "next/server";
import { assertNoDbError, handleRouteError, json, requireUser } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { supabase, user } = await requireUser(request);

    const { data: memberships, error: membershipsError } = await supabase
      .from("company_memberships")
      .select("id, company_id, role, full_name, email, is_active")
      .eq("user_id", user.id)
      .eq("is_active", true);

    assertNoDbError(membershipsError);

    const { data: companies, error: companiesError } = await supabase.rpc("company_branding");
    assertNoDbError(companiesError);

    return json({
      user: {
        id: user.id,
        email: user.email ?? null,
      },
      memberships: memberships ?? [],
      companies: companies ?? [],
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
