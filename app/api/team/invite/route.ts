import type { NextRequest } from "next/server";
import {
  assertNoDbError,
  handleRouteError,
  json,
  optionalString,
  readJsonObject,
  requireCompanyAdmin,
  requiredString,
  requireUser,
} from "../../_shared";

export const dynamic = "force-dynamic";

// Owner/admin-only: create a pending invite. No service-role key — the invited
// person signs up themselves and accepts via accept_my_invite(). The returned
// inviteUrl is for the owner to share (dev convenience); acceptance is by the
// invited email, not the token.
export async function POST(request: NextRequest) {
  try {
    const { supabase, user } = await requireUser(request);
    const body = await readJsonObject(request);
    const companyId = requiredString(body, "companyId");
    await requireCompanyAdmin(supabase, user, companyId);

    const role = body.role === "admin" ? "admin" : "employee";
    const { data, error } = await supabase
      .from("company_invites")
      .insert({
        company_id: companyId,
        email: requiredString(body, "email").toLowerCase(),
        full_name: optionalString(body, "fullName"),
        role,
        invited_by: user.id,
      })
      .select("id, email, full_name, role, status, token, created_at")
      .single();
    assertNoDbError(error);

    return json({ invite: data, inviteUrl: `${request.nextUrl.origin}/?invite=${data.token}` }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
