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
import { appUrl } from "../../../../lib/supabase/admin";
import { sendInviteEmail } from "../../../../lib/invites";

export const dynamic = "force-dynamic";

const INVITE_FIELDS = "id, email, full_name, role, status, token, expires_at, created_at, preferred_language";

// Owner/admin-only. Creates or refreshes a pending invite, then sends a real
// Supabase Auth invitation email (server-side, service-role). The invite row is
// kept even if the email fails — `emailed` reflects whether delivery succeeded.
export async function POST(request: NextRequest) {
  try {
    const { supabase, user } = await requireUser(request);
    const body = await readJsonObject(request);
    const companyId = requiredString(body, "companyId");
    await requireCompanyAdmin(supabase, user, companyId);

    const email = requiredString(body, "email").trim().toLowerCase();
    const fullName = optionalString(body, "fullName");
    const role = body.role === "admin" ? "admin" : "employee";
    const language = typeof body.language === "string" ? body.language : "en";
    if (language !== "en" && language !== "es") {
      return json({ error: "language must be 'en' or 'es'" }, 400);
    }
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    // Create-or-refresh: reuse an existing pending invite for this email.
    const { data: existing, error: lookupError } = await supabase
      .from("company_invites")
      .select("id")
      .eq("company_id", companyId)
      .eq("email", email)
      .eq("status", "pending")
      .maybeSingle();
    assertNoDbError(lookupError);

    let invite;
    if (existing) {
      const { data, error } = await supabase
        .from("company_invites")
        .update({ full_name: fullName, role, expires_at: expiresAt, preferred_language: language })
        .eq("id", existing.id)
        .select(INVITE_FIELDS)
        .single();
      assertNoDbError(error);
      invite = data;
    } else {
      const { data, error } = await supabase
        .from("company_invites")
        .insert({
          company_id: companyId,
          email,
          full_name: fullName,
          role,
          invited_by: user.id,
          expires_at: expiresAt,
          preferred_language: language,
        })
        .select(INVITE_FIELDS)
        .single();
      assertNoDbError(error);
      invite = data;
    }

    const redirectTo = `${appUrl(request.nextUrl.origin)}/accept-invite?invite=${invite.token}&lang=${language}`;
    const send = await sendInviteEmail({ email, redirectTo, fullName, language });

    return json({ invite, emailed: send.emailed, inviteUrl: send.inviteUrl, note: send.note }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
