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
import { appUrl } from "../../../../../lib/supabase/admin";
import { sendInviteEmail } from "../../../../../lib/invites";

export const dynamic = "force-dynamic";

// Owner/admin-only: refresh expiry on a pending invite and re-send its email.
export async function POST(request: NextRequest) {
  try {
    const { supabase, user } = await requireUser(request);
    const body = await readJsonObject(request);
    const companyId = requiredString(body, "companyId");
    await requireCompanyAdmin(supabase, user, companyId);
    const inviteId = requiredString(body, "inviteId");

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: invite, error } = await supabase
      .from("company_invites")
      .update({ expires_at: expiresAt })
      .eq("id", inviteId)
      .eq("company_id", companyId)
      .eq("status", "pending")
      .select("id, email, full_name, role, status, token, expires_at")
      .maybeSingle();
    assertNoDbError(error);
    if (!invite) return json({ error: "invite not found or not pending" }, 404);

    const redirectTo = `${appUrl(request.nextUrl.origin)}/accept-invite?invite=${invite.token}`;
    const send = await sendInviteEmail({ email: invite.email, redirectTo, fullName: invite.full_name });

    return json({ invite, emailed: send.emailed, inviteUrl: send.inviteUrl, note: send.note });
  } catch (error) {
    return handleRouteError(error);
  }
}
