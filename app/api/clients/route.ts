import type { NextRequest } from "next/server";
import {
  assertNoDbError,
  firstRpcRow,
  handleRouteError,
  json,
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
      .from("clients")
      .select("id, company_id, name, email, phone, billing_address, created_at, updated_at")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false });

    assertNoDbError(error);

    return json({
      clients: selectRows(data, [
        "id",
        "company_id",
        "name",
        "email",
        "phone",
        "billing_address",
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

    const { data, error } = await supabase.rpc("create_client", {
      p_company_id: requiredString(body, "companyId"),
      p_name: requiredString(body, "name"),
      p_email: optionalString(body, "email"),
      p_phone: optionalString(body, "phone"),
      p_billing_address: optionalString(body, "billingAddress"),
      p_tax_id: optionalString(body, "taxId"),
      p_admin_notes: optionalString(body, "adminNotes"),
    });

    assertNoDbError(error);

    return json(
      {
        client: selectFields(firstRpcRow(data), [
          "id",
          "company_id",
          "name",
          "email",
          "phone",
          "billing_address",
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
