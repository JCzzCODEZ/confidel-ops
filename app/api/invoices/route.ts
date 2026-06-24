import type { NextRequest } from "next/server";
import {
  assertNoDbError,
  firstRpcRow,
  handleRouteError,
  json,
  optionalDateString,
  optionalString,
  readJsonObject,
  requireCompanyAdmin,
  requiredInteger,
  requiredString,
  requireUser,
  selectFields,
  selectRows,
} from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { supabase, user } = await requireUser(request);
    const companyId = request.nextUrl.searchParams.get("companyId");

    if (!companyId) {
      return json({ error: "companyId is required" }, 400);
    }

    await requireCompanyAdmin(supabase, user, companyId);

    const { data, error } = await supabase
      .from("invoices")
      .select("id, company_id, client_id, job_id, amount_cents, status, due_date, paid_at, created_at, updated_at")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false });

    assertNoDbError(error);

    return json({
      invoices: selectRows(data, [
        "id",
        "company_id",
        "client_id",
        "job_id",
        "amount_cents",
        "status",
        "due_date",
        "paid_at",
        "created_at",
        "updated_at",
      ]),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { supabase } = await requireUser(request);
    const body = await readJsonObject(request);

    const { data, error } = await supabase.rpc("create_invoice", {
      p_company_id: requiredString(body, "companyId"),
      p_client_id: requiredString(body, "clientId"),
      p_job_id: optionalString(body, "jobId"),
      p_amount_cents: requiredInteger(body, "amountCents"),
      p_due_date: optionalDateString(body, "dueDate"),
      p_notes: optionalString(body, "notes"),
    });

    assertNoDbError(error);

    return json(
      {
        invoice: selectFields(firstRpcRow(data), [
          "id",
          "company_id",
          "client_id",
          "job_id",
          "amount_cents",
          "status",
          "due_date",
          "paid_at",
          "created_at",
          "updated_at",
        ]),
      },
      201,
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
