import type { NextRequest } from "next/server";
import { assertNoDbError, handleRouteError, json, requireCompanyAdmin, requireUser } from "../../_shared";
import { derivePaymentState } from "../../../../lib/confidel-api";

export const dynamic = "force-dynamic";

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values.filter((v) => v != null)));
}

// Owner/admin-only tax-ready records: one row per completed job, enriched with
// date / client / job / employee / services / add-ons / payment method so the
// owner Records ledger can group by month and export CSV. No employee access.
export async function GET(request: NextRequest) {
  try {
    const { supabase, user } = await requireUser(request);
    const companyId = request.nextUrl.searchParams.get("companyId");
    if (!companyId) return json({ error: "companyId is required" }, 400);
    await requireCompanyAdmin(supabase, user, companyId);

    const { data: summaries, error } = await supabase
      .from("job_financial_summaries")
      .select("*")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false });
    assertNoDbError(error);

    const rows = summaries ?? [];
    const jobIds = unique(rows.map((r) => r.job_id));
    const completionIds = unique(rows.map((r) => r.completion_id));
    const invoiceIds = unique(rows.map((r) => r.invoice_id));

    const [jobs, clients0, completions, employees, services, addons, payments] = await Promise.all([
      jobIds.length
        ? supabase.from("jobs").select("id, title, client_id").in("id", jobIds)
        : Promise.resolve({ data: [], error: null }),
      Promise.resolve({ data: [], error: null }), // placeholder, clients fetched after jobs
      completionIds.length
        ? supabase.from("job_completions").select("id, submitted_at, employee_user_id").in("id", completionIds)
        : Promise.resolve({ data: [], error: null }),
      supabase.from("company_memberships").select("user_id, full_name, email").eq("company_id", companyId),
      completionIds.length
        ? supabase.from("job_completion_services").select("completion_id, service_name").in("completion_id", completionIds)
        : Promise.resolve({ data: [], error: null }),
      completionIds.length
        ? supabase.from("job_completion_addons").select("completion_id, addon_name").in("completion_id", completionIds)
        : Promise.resolve({ data: [], error: null }),
      invoiceIds.length
        ? supabase.from("payments").select("invoice_id, amount_cents, method, paid_at").in("invoice_id", invoiceIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    void clients0;
    assertNoDbError(jobs.error);
    assertNoDbError(completions.error);
    assertNoDbError(employees.error);
    assertNoDbError(services.error);
    assertNoDbError(addons.error);
    assertNoDbError(payments.error);

    const jobList = jobs.data ?? [];
    const clientIds = unique(jobList.map((j) => j.client_id));
    const clientsRes = clientIds.length
      ? await supabase.from("clients").select("id, name").in("id", clientIds)
      : { data: [], error: null };
    assertNoDbError(clientsRes.error);

    const jobById = new Map(jobList.map((j) => [j.id, j]));
    const clientById = new Map((clientsRes.data ?? []).map((c) => [c.id, c]));
    const completionById = new Map((completions.data ?? []).map((c) => [c.id, c]));
    const employeeById = new Map((employees.data ?? []).map((e) => [e.user_id, e]));

    const servicesByCompletion = new Map<string, string[]>();
    for (const s of services.data ?? []) {
      const list = servicesByCompletion.get(s.completion_id) ?? [];
      list.push(s.service_name);
      servicesByCompletion.set(s.completion_id, list);
    }
    const addonsByCompletion = new Map<string, string[]>();
    for (const a of addons.data ?? []) {
      const list = addonsByCompletion.get(a.completion_id) ?? [];
      list.push(a.addon_name);
      addonsByCompletion.set(a.completion_id, list);
    }
    // latest payment method per invoice
    const methodByInvoice = new Map<string, string | null>();
    for (const p of payments.data ?? []) {
      if (!methodByInvoice.has(p.invoice_id)) methodByInvoice.set(p.invoice_id, p.method ?? null);
    }

    // Authoritative payment state from invoices + payments (read-time). The
    // job_financial_summaries payment columns are draft-time snapshots and go
    // stale after a payment (the draft can't be regenerated once paid), so we
    // never trust them for live status/balance when an invoice exists.
    const invoicesRes = invoiceIds.length
      ? await supabase.from("invoices").select("id, amount_cents").in("id", invoiceIds)
      : { data: [], error: null };
    assertNoDbError(invoicesRes.error);
    const invoiceAmountById = new Map((invoicesRes.data ?? []).map((i) => [i.id, i.amount_cents ?? 0]));
    const paidByInvoice = new Map<string, number>();
    for (const p of payments.data ?? []) {
      paidByInvoice.set(p.invoice_id, (paidByInvoice.get(p.invoice_id) ?? 0) + (p.amount_cents ?? 0));
    }

    const summariesEnriched = rows.map((r) => {
      const job = jobById.get(r.job_id);
      const client = job ? clientById.get(job.client_id) : null;
      const completion = completionById.get(r.completion_id);
      const employee = completion ? employeeById.get(completion.employee_user_id) : null;

      // Derive live payment fields from the invoice + payments when an invoice
      // exists; otherwise fall back to the summary's own (pre-invoice) values.
      let amount_paid_cents = r.amount_paid_cents;
      let balance_due_cents = r.balance_due_cents;
      let payment_status = r.payment_status;
      if (r.invoice_id) {
        const invoiceTotal = invoiceAmountById.get(r.invoice_id) ?? r.invoice_total_cents ?? 0;
        const paid = paidByInvoice.get(r.invoice_id) ?? 0;
        ({ amount_paid_cents, balance_due_cents, payment_status } = derivePaymentState(invoiceTotal, paid));
      }

      return {
        ...r,
        amount_paid_cents,
        balance_due_cents,
        payment_status,
        date: completion?.submitted_at ?? r.created_at ?? null,
        job_title: job?.title ?? null,
        client_name: client?.name ?? null,
        employee_name: employee?.full_name ?? employee?.email ?? null,
        services: servicesByCompletion.get(r.completion_id) ?? [],
        addons: addonsByCompletion.get(r.completion_id) ?? [],
        payment_method: r.invoice_id ? methodByInvoice.get(r.invoice_id) ?? null : null,
      };
    });

    return json({ summaries: summariesEnriched });
  } catch (error) {
    return handleRouteError(error);
  }
}
