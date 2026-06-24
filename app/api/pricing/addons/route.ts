import type { NextRequest } from "next/server";
import {
  assertNoDbError,
  handleRouteError,
  json,
  readJsonObject,
  requireCompanyAdmin,
  requiredInteger,
  requiredString,
  requireUser,
} from "../../_shared";

export const dynamic = "force-dynamic";

const FIELDS = "id, addon_name, price_cents, taxable, active";

export async function GET(request: NextRequest) {
  try {
    const { supabase, user } = await requireUser(request);
    const companyId = request.nextUrl.searchParams.get("companyId");
    if (!companyId) return json({ error: "companyId is required" }, 400);
    await requireCompanyAdmin(supabase, user, companyId);

    const { data, error } = await supabase
      .from("addon_prices")
      .select(FIELDS)
      .eq("company_id", companyId)
      .order("addon_name", { ascending: true });
    assertNoDbError(error);
    return json({ prices: data ?? [] });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { supabase, user } = await requireUser(request);
    const body = await readJsonObject(request);
    const companyId = requiredString(body, "companyId");
    await requireCompanyAdmin(supabase, user, companyId);

    const { data, error } = await supabase
      .from("addon_prices")
      .upsert(
        {
          company_id: companyId,
          addon_name: requiredString(body, "addonName"),
          price_cents: requiredInteger(body, "priceCents"),
          taxable: body.taxable !== false,
          active: body.active !== false,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "company_id,addon_name" },
      )
      .select(FIELDS)
      .single();
    assertNoDbError(error);
    return json({ price: data }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
