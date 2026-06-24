import type { NextRequest } from "next/server";
import {
  assertNoDbError,
  firstRpcRow,
  handleRouteError,
  json,
  optionalDateString,
  optionalInteger,
  optionalString,
  readJsonObject,
  requireCompanyAdmin,
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
      .from("jobs")
      .select("id, company_id, client_id, title, description, status, scheduled_for, created_at, updated_at")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false });

    assertNoDbError(error);

    return json({
      jobs: selectRows(data, [
        "id",
        "company_id",
        "client_id",
        "title",
        "description",
        "status",
        "scheduled_for",
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

    const { data, error } = await supabase.rpc("create_job", {
      p_company_id: requiredString(body, "companyId"),
      p_client_id: requiredString(body, "clientId"),
      p_title: requiredString(body, "title"),
      p_description: optionalString(body, "description"),
      p_scheduled_for: optionalDateString(body, "scheduledFor"),
      p_price_cents: optionalInteger(body, "priceCents"),
      p_cost_cents: optionalInteger(body, "costCents"),
      p_payroll_cents: optionalInteger(body, "payrollCents"),
      p_admin_notes: optionalString(body, "adminNotes"),
    });

    assertNoDbError(error);

    return json(
      {
        job: selectFields(firstRpcRow(data), [
          "id",
          "company_id",
          "client_id",
          "title",
          "description",
          "status",
          "scheduled_for",
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
