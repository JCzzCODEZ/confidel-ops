import type { NextRequest } from "next/server";
import { assertNoDbError, handleRouteError, json, requireUser } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { supabase } = await requireUser(request);
    const { data, error } = await supabase.rpc("company_branding");

    assertNoDbError(error);

    return json({ companies: data ?? [] });
  } catch (error) {
    return handleRouteError(error);
  }
}
