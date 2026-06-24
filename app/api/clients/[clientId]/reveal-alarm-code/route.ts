import type { NextRequest } from "next/server";
import { assertNoDbError, handleRouteError, json, requireUser } from "../../../_shared";

export const dynamic = "force-dynamic";

type RevealContext = {
  params: Promise<{ clientId: string }>;
};

// Owner/admin-only reveal of a client's alarm code. Authorization, decryption,
// and audit logging all happen inside the SECURITY DEFINER reveal_alarm_code()
// RPC — this route only forwards the request and the result.
export async function POST(request: NextRequest, context: RevealContext) {
  try {
    const { clientId } = await context.params;
    const { supabase } = await requireUser(request);

    const { data, error } = await supabase.rpc("reveal_alarm_code", {
      p_client_id: clientId,
    });

    assertNoDbError(error);

    return json({ alarmCode: data ?? null });
  } catch (error) {
    return handleRouteError(error);
  }
}
