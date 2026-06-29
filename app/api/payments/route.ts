import type { NextRequest } from "next/server";
import {
  assertNoDbError,
  handleRouteError,
  json,
  optionalDateString,
  optionalString,
  readJsonObject,
  requiredInteger,
  requiredString,
  requireUser,
  selectFields,
} from "../_shared";
import {
  PAYMENT_METHODS,
  canonicalPaymentMethod,
  canonicalPaymentReference,
  isAllowedPaymentMethod,
} from "../../../lib/confidel-api";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const { supabase } = await requireUser(request);
    const body = await readJsonObject(request);

    // Required dedicated transport key (NOT the business reference). Must be a uuid.
    const idempotencyKey = requiredString(body, "idempotencyKey");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
      return json({ error: "idempotencyKey must be a uuid" }, 400);
    }

    // Canonicalize method/reference HERE (single authority) and validate method
    // against the allowlist. The RPC stores + compares these canonical values, so
    // the idempotency fingerprint is exact — no JS-vs-Postgres trim drift.
    const method = canonicalPaymentMethod(optionalString(body, "method")) || "manual";
    if (!isAllowedPaymentMethod(method)) {
      return json({ error: `method must be one of: ${PAYMENT_METHODS.join(", ")}` }, 400);
    }
    const reference = canonicalPaymentReference(optionalString(body, "reference"));

    const { data, error } = await supabase.rpc("mark_payment", {
      p_invoice_id: requiredString(body, "invoiceId"),
      p_amount_cents: requiredInteger(body, "amountCents"),
      p_idempotency_key: idempotencyKey,
      p_paid_at: optionalDateString(body, "paidAt"),
      p_method: method,
      p_reference: reference,
    });

    assertNoDbError(error);

    // mark_payment returns an authoritative jsonb: the payment plus the recomputed
    // amount_paid / balance_due / payment_status. The client must trust THESE, not
    // local arithmetic.
    const result = (data ?? {}) as {
      payment?: Record<string, unknown> | null;
      amount_paid_cents?: number;
      balance_due_cents?: number;
      payment_status?: string;
      idempotent_replay?: boolean;
    };

    return json(
      {
        payment: result.payment
          ? selectFields(result.payment, [
              "id",
              "company_id",
              "invoice_id",
              "amount_cents",
              "paid_at",
              "method",
              "reference",
              "created_at",
            ])
          : null,
        amount_paid_cents: result.amount_paid_cents ?? null,
        balance_due_cents: result.balance_due_cents ?? null,
        payment_status: result.payment_status ?? null,
        idempotent_replay: result.idempotent_replay ?? false,
      },
      201,
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
