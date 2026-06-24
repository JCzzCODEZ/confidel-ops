import type { NextRequest } from "next/server";
import { assertNoDbError, handleRouteError, json, requireUser } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { supabase } = await requireUser(request);
    const { data, error } = await supabase.rpc("my_jobs");

    assertNoDbError(error);

    return json({ jobs: data ?? [] });
  } catch (error) {
    return handleRouteError(error);
  }
}
