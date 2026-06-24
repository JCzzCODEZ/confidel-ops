import type { NextRequest } from "next/server";
import { assertNoDbError, handleRouteError, json, requireUser } from "../../../_shared";

export const dynamic = "force-dynamic";

type DraftContext = {
  params: Promise<{ completionId: string }>;
};

// Owner/admin-only: generate (or refresh) an invoice draft from the structured
// completion. Authorization, pricing, and the financial summary are all handled
// inside the create_invoice_draft_from_completion SECURITY DEFINER RPC.
export async function POST(request: NextRequest, context: DraftContext) {
  try {
    const { completionId } = await context.params;
    const { supabase } = await requireUser(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const { data, error } = await supabase.rpc("create_invoice_draft_from_completion", {
      p_completion_id: completionId,
      p_tax_rate_bps: typeof body.taxRateBps === "number" ? body.taxRateBps : 0,
      p_discount_cents: typeof body.discountCents === "number" ? body.discountCents : 0,
      p_due_date: typeof body.dueDate === "string" ? body.dueDate : null,
    });
    assertNoDbError(error);

    return json({ draft: data ?? null }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
