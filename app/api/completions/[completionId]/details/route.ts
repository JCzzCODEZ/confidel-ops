import type { NextRequest } from "next/server";
import {
  assertNoDbError,
  handleRouteError,
  json,
  optionalString,
  readJsonObject,
  requiredString,
  requireUser,
} from "../../../_shared";

export const dynamic = "force-dynamic";

type DetailsContext = {
  params: Promise<{ completionId: string }>;
};

// Structured completion details — timing, services, add-ons, expenses. RLS on
// the child tables and job_completions restricts reads to owner/admin of the
// company or the assigned employee. NB: contains no pricing/financial fields.
export async function GET(request: NextRequest, context: DetailsContext) {
  try {
    const { completionId } = await context.params;
    const { supabase } = await requireUser(request);

    const { data: completion, error: completionError } = await supabase
      .from("job_completions")
      .select(
        "id, job_id, status, submitted_at, notes, arrival_time, start_time, end_time, break_minutes, hours, completion_status",
      )
      .eq("id", completionId)
      .single();
    assertNoDbError(completionError);

    const [services, addons, expenses] = await Promise.all([
      supabase.from("job_completion_services").select("service_name").eq("completion_id", completionId),
      supabase.from("job_completion_addons").select("addon_name").eq("completion_id", completionId),
      supabase
        .from("job_completion_expenses")
        .select("id, expense_type, description, amount_cents, quantity, unit")
        .eq("completion_id", completionId)
        .order("created_at", { ascending: true }),
    ]);
    assertNoDbError(services.error);
    assertNoDbError(addons.error);
    assertNoDbError(expenses.error);

    return json({
      completion,
      services: (services.data ?? []).map((row) => row.service_name),
      addons: (addons.data ?? []).map((row) => row.addon_name),
      expenses: expenses.data ?? [],
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

// Employee attaches structured details to their own completion (authorization
// enforced inside the record_completion_details SECURITY DEFINER RPC).
export async function POST(request: NextRequest, context: DetailsContext) {
  try {
    const { completionId } = await context.params;
    const { supabase } = await requireUser(request);
    const body = await readJsonObject(request);

    const services = Array.isArray(body.services) ? body.services.filter((s) => typeof s === "string") : [];
    const addons = Array.isArray(body.addons) ? body.addons.filter((a) => typeof a === "string") : [];
    const expenses = Array.isArray(body.expenses) ? body.expenses : [];

    const { error } = await supabase.rpc("record_completion_details", {
      p_completion_id: completionId,
      p_arrival: optionalString(body, "arrival"),
      p_start: requiredString(body, "start"),
      p_end: requiredString(body, "end"),
      p_break_minutes: typeof body.breakMinutes === "number" ? body.breakMinutes : null,
      p_completion_status: requiredString(body, "completionStatus"),
      p_services: services,
      p_addons: addons,
      p_expenses: expenses,
    });
    assertNoDbError(error);

    return json({ ok: true }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
