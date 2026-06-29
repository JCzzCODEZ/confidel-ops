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

    // Malformed JSON must be a hard 400 — never silently treated as an empty body
    // (which previously let a broken request produce a 0%-tax invoice).
    let body: Record<string, unknown>;
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return json({ error: "request body must be a JSON object" }, 400);
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }

    // Tax rate is REQUIRED, numeric basis points (e.g. 662.5 = 6.625%). Missing /
    // non-finite / out-of-range -> 400. The server never defaults the rate to 0.
    const taxRateBps = body.taxRateBps;
    if (typeof taxRateBps !== "number" || !Number.isFinite(taxRateBps) || taxRateBps < 0 || taxRateBps > 10000) {
      return json({ error: "taxRateBps is required and must be a finite number between 0 and 10000" }, 400);
    }

    // Discount is optional but, when present, must be a safe non-negative integer
    // number of cents (int4 RPC parameter).
    let discountCents = 0;
    if (body.discountCents !== undefined && body.discountCents !== null) {
      const d = body.discountCents;
      if (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 2_147_483_647) {
        return json({ error: "discountCents must be a non-negative integer (cents) within range" }, 400);
      }
      discountCents = d;
    }

    const dueDate = typeof body.dueDate === "string" ? body.dueDate : null;

    const { data, error } = await supabase.rpc("create_invoice_draft_from_completion", {
      p_completion_id: completionId,
      p_tax_rate_bps: taxRateBps,
      p_discount_cents: discountCents,
      p_due_date: dueDate,
    });
    assertNoDbError(error);

    return json({ draft: data ?? null }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
