import type { NextRequest } from "next/server";
import {
  assertNoDbError,
  handleRouteError,
  json,
  optionalString,
  readJsonObject,
  requireUser,
} from "../../../_shared";

export const dynamic = "force-dynamic";

type AlarmCodeContext = {
  params: Promise<{ clientId: string }>;
};

// Owner/admin-only write of a client's alarm code. The value is encrypted at
// rest inside set_alarm_code() (SECURITY DEFINER) — it is never stored or
// returned in plaintext by any read API. Pass code: null/"" to clear it.
export async function PUT(request: NextRequest, context: AlarmCodeContext) {
  try {
    const { clientId } = await context.params;
    const { supabase } = await requireUser(request);
    const body = await readJsonObject(request);

    const { error } = await supabase.rpc("set_alarm_code", {
      p_client_id: clientId,
      p_code: optionalString(body, "code"),
    });

    assertNoDbError(error);

    return json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
