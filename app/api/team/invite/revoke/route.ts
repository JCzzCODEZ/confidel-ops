import type { NextRequest } from "next/server";
import {
  assertNoDbError,
  handleRouteError,
  json,
  readJsonObject,
  requireCompanyAdmin,
  requiredString,
  requireUser,
} from "../../../_shared";

export const dynamic = "force-dynamic";

// Owner/admin-only: revoke a pending invite (cannot be accepted afterward).
export async function POST(request: NextRequest) {
  try {
    const { supabase, user } = await requireUser(request);
    const body = await readJsonObject(request);
    const companyId = requiredString(body, "companyId");
    await requireCompanyAdmin(supabase, user, companyId);
    const inviteId = requiredString(body, "inviteId");

    const { data, error } = await supabase
      .from("company_invites")
      .update({ status: "revoked" })
      .eq("id", inviteId)
      .eq("company_id", companyId)
      .eq("status", "pending")
      .select("id, status")
      .maybeSingle();
    assertNoDbError(error);

    return json({ ok: Boolean(data), invite: data ?? null });
  } catch (error) {
    return handleRouteError(error);
  }
}
