import type { NextRequest } from "next/server";
import {
  assertNoDbError,
  firstRpcRow,
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

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const { supabase } = await requireUser(request);
    const body = await readJsonObject(request);

    const { data, error } = await supabase.rpc("mark_payment", {
      p_invoice_id: requiredString(body, "invoiceId"),
      p_amount_cents: requiredInteger(body, "amountCents"),
      p_paid_at: optionalDateString(body, "paidAt"),
      p_method: optionalString(body, "method"),
      p_reference: optionalString(body, "reference"),
    });

    assertNoDbError(error);

    return json(
      {
        payment: selectFields(firstRpcRow(data), [
          "id",
          "company_id",
          "invoice_id",
          "amount_cents",
          "paid_at",
          "method",
          "reference",
          "created_at",
        ]),
      },
      201,
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
