import { readFileSync } from "node:fs";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// ============================================================================
// Owner pricing / invoice-draft / tax-record regression.
//   node scripts/pricing-invoice-test.mjs signup   # once per run id
//   node scripts/pricing-invoice-test.mjs test
//
// Requires db/fixes/2026-06-23_structured_completion.sql AND
//          db/fixes/2026-06-23_pricing_invoicing.sql applied + dev server up.
// Env: PRICING_TEST_RUN_ID (required), API_TEST_PASSWORD, API_TEST_BASE_URL,
//      NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.
// ============================================================================

loadEnvFile(".env.local");

const phase = process.argv[2] ?? "test";
const runId = requiredEnv("PRICING_TEST_RUN_ID");
const password = process.env.API_TEST_PASSWORD || "ConfidelApiTest!2026";
const baseUrl = process.env.API_TEST_BASE_URL || "http://127.0.0.1:3000";
const supabaseUrl = requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
const publishableKey = requiredEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");

const PRICING_FORBIDDEN = [
  "price_cents",
  "cost_cents",
  "profit_cents",
  "payroll_cents",
  "gross_revenue_cents",
  "net_profit_cents",
  "invoice_total_cents",
  "tax_cents",
  "revenue_cents",
];

const emails = {
  owner: `confidel.price.owner.${runId}@example.com`,
  employee: `confidel.price.emp.${runId}@example.com`,
};

if (phase === "signup") {
  await signupUsers();
} else if (phase === "test") {
  await runTests();
} else {
  throw new Error(`Unknown phase: ${phase}`);
}

async function signupUsers() {
  console.log(`pricing signup run=${runId}`);
  for (const [role, email] of Object.entries(emails)) {
    const client = freshAnonClient();
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: { data: { confidel_price_run_id: runId, role } },
    });
    if (error) throw new Error(`${role} signup failed: ${error.message}`);
    console.log(`SIGNUP ${role} user_id=${data.user?.id ?? "missing"}`);
  }
}

async function runTests() {
  console.log(`pricing test run=${runId}`);

  const owner = await signIn("owner", emails.owner);
  const employee = await signIn("employee", emails.employee);

  const companyId = await seedCompany(owner, [{ user: employee, role: "employee", active: true }]);

  await step("owner can create service + add-on prices", async () => {
    expectStatus(
      await api("POST", "/api/pricing/services", owner.token, {
        companyId,
        serviceName: "Deep Cleaning",
        priceCents: 20000,
        taxable: true,
      }),
      201,
    );
    expectStatus(
      await api("POST", "/api/pricing/services", owner.token, {
        companyId,
        serviceName: "Pet Care",
        priceCents: 5000,
        taxable: false,
      }),
      201,
    );
    expectStatus(
      await api("POST", "/api/pricing/addons", owner.token, {
        companyId,
        addonName: "Inside Oven",
        priceCents: 3000,
        taxable: true,
      }),
      201,
    );
    return summarize({ status: 201 }, { ok: true });
  });

  await step("employee cannot read pricing", async () => {
    expectFailure(await api("GET", `/api/pricing/services?companyId=${companyId}`, employee.token));
    expectFailure(await api("GET", `/api/pricing/addons?companyId=${companyId}`, employee.token));
    return summarize({ status: 403 }, { blocked: true });
  });

  // seed job + structured completion
  const client = await api("POST", "/api/clients", owner.token, { companyId, name: `Price ${runId} Client` });
  expectStatus(client, 201);
  const job = await api("POST", "/api/jobs", owner.token, {
    companyId,
    clientId: client.body.client.id,
    title: `Price ${runId} Job`,
    priceCents: 0,
    payrollCents: 8000,
  });
  expectStatus(job, 201);
  const jobId = job.body.job.id;
  expectStatus(await api("POST", "/api/jobs/assign", owner.token, { jobId, employeeUserId: employee.user.id }), 201);

  const completion = await api("POST", "/api/jobs/complete", employee.token, { jobId, notes: "done", photoUrls: [] });
  expectStatus(completion, 201);
  const completionId = completion.body.completion.id;

  expectStatus(
    await api("POST", `/api/completions/${completionId}/details`, employee.token, {
      start: "09:00",
      end: "13:00",
      breakMinutes: 0,
      completionStatus: "Completed",
      services: ["Deep Cleaning", "Pet Care"],
      addons: ["Inside Oven"],
      expenses: [
        { type: "supplies", description: "rags", amountCents: 1500 },
        { type: "mileage", quantity: 12, unit: "miles", amountCents: 0 },
        { type: "parking", amountCents: 500 },
      ],
    }),
    201,
  );

  await step("owner review queue shows the submitted completion", async () => {
    const res = await api("GET", `/api/completions?companyId=${companyId}`, owner.token);
    expectStatus(res, 200);
    const ids = (res.body.completions || []).map((c) => c.id);
    assert(ids.includes(completionId), `submitted completion not in review queue; queue=${JSON.stringify(ids)}`);
    return summarize(res, { queue: ids });
  });

  let invoiceId = null;

  await step("owner generates invoice draft with matching line items + tax", async () => {
    const res = await api("POST", `/api/completions/${completionId}/invoice-draft`, owner.token, {
      taxRateBps: 700,
    });
    expectStatus(res, 201);
    const d = res.body.draft;
    invoiceId = d.invoice_id;
    assert(d.subtotal_cents === 28000, `subtotal expected 28000, got ${d.subtotal_cents}`);
    assert(d.tax_cents === 1610, `tax expected 1610, got ${d.tax_cents}`); // 23000 * 7%
    assert(d.total_cents === 29610, `total expected 29610, got ${d.total_cents}`);
    assert(d.reimbursement_cents === 2000, `reimbursement expected 2000, got ${d.reimbursement_cents}`);
    assert(d.employee_pay_cents === 8000, `payroll expected 8000, got ${d.employee_pay_cents}`);
    assert(d.net_profit_cents === 18000, `net profit expected 18000, got ${d.net_profit_cents}`);
    const labels = (d.line_items || []).map((l) => `${l.line_type}:${l.label}:${l.amount_cents}`);
    assert(labels.includes("service:Deep Cleaning:20000"), `missing Deep Cleaning line: ${labels}`);
    assert(labels.includes("service:Pet Care:5000"), `missing Pet Care line: ${labels}`);
    assert(labels.includes("addon:Inside Oven:3000"), `missing Inside Oven line: ${labels}`);
    assert(labels.includes("tax:Sales tax:1610"), `missing tax line: ${labels}`);
    return summarize(res, { total: d.total_cents, lines: labels });
  });

  await step("payment updates amount paid + balance due", async () => {
    expectStatus(
      await api("POST", "/api/payments", owner.token, {
        invoiceId,
        amountCents: 10000,
        paidAt: new Date().toISOString(),
        method: "test",
        reference: `PRICE-${runId}`,
      }),
      201,
    );
    const res = await api("POST", `/api/completions/${completionId}/invoice-draft`, owner.token, { taxRateBps: 700 });
    expectStatus(res, 201);
    const d = res.body.draft;
    assert(d.amount_paid_cents === 10000, `amount paid expected 10000, got ${d.amount_paid_cents}`);
    assert(d.balance_due_cents === 19610, `balance expected 19610, got ${d.balance_due_cents}`);
    assert(d.payment_status === "partial", `status expected partial, got ${d.payment_status}`);
    return summarize(res, { paid: d.amount_paid_cents, balance: d.balance_due_cents, status: d.payment_status });
  });

  await step("employee API leaks no pricing/invoice/tax fields", async () => {
    const jobs = await api("GET", "/api/employee/jobs", employee.token);
    expectStatus(jobs, 200);
    ensureNoForbiddenKeys(jobs.body, PRICING_FORBIDDEN);
    const details = await api("GET", `/api/completions/${completionId}/details`, employee.token);
    if (details.status === 200) ensureNoForbiddenKeys(details.body, PRICING_FORBIDDEN);
    return summarize({ status: 200 }, { ok: true });
  });

  await step("owner tax report includes tax-ready fields", async () => {
    const res = await api("GET", `/api/reports/financials?companyId=${companyId}`, owner.token);
    expectStatus(res, 200);
    const row = (res.body.summaries || []).find((s) => s.completion_id === completionId);
    assert(row, "no financial summary for completion");
    for (const field of [
      "gross_revenue_cents",
      "tax_cents",
      "reimbursement_cents",
      "mileage_miles",
      "employee_pay_cents",
      "net_profit_cents",
      "payment_status",
      "amount_paid_cents",
      "balance_due_cents",
    ]) {
      assert(field in row, `tax report missing ${field}`);
    }
    assert(Number(row.gross_revenue_cents) === 28000, `revenue expected 28000, got ${row.gross_revenue_cents}`);
    assert(Number(row.amount_paid_cents) === 10000, `paid expected 10000, got ${row.amount_paid_cents}`);
    return summarize(res, { row });
  });

  console.log(`CLEANUP_LABEL run=${runId} company_id=${companyId} owner=${owner.user.id}`);
  console.log("pricing invoice tests completed: PASS");
}

async function seedCompany(owner, members) {
  const ownerDb = supabaseForToken(owner.token);
  const { data: company, error } = await ownerDb
    .from("companies")
    .insert({ owner_user_id: owner.user.id, name: `Price Test ${runId} Company` })
    .select("id")
    .single();
  if (error) throw new Error(`seed company failed: ${error.message}`);
  for (const m of members) {
    const { error: mErr } = await ownerDb.from("company_memberships").insert({
      company_id: company.id,
      user_id: m.user.user.id,
      role: m.role,
      full_name: `Price ${runId} ${m.role}`,
      email: m.user.user.email,
      is_active: m.active,
    });
    if (mErr) throw new Error(`seed membership failed: ${mErr.message}`);
  }
  console.log(`SEEDED company_id=${company.id}`);
  return company.id;
}

async function signIn(role, email) {
  const client = freshAnonClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session || !data.user) {
    throw new Error(`${role} sign-in failed: ${error?.message ?? "missing session"}`);
  }
  console.log(`SIGNED_IN ${role} user_id=${data.user.id}`);
  return { token: data.session.access_token, user: data.user };
}

function supabaseForToken(token) {
  return createSupabaseClient(supabaseUrl, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

function freshAnonClient() {
  return createSupabaseClient(supabaseUrl, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function step(name, fn) {
  try {
    const output = await fn();
    console.log(`PASS ${name}`);
    console.log(output);
  } catch (error) {
    console.log(`FAIL ${name}`);
    console.log(error.stack || error.message || String(error));
    throw error;
  }
}

async function api(method, path, token = null, body = undefined) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, body: payload };
}

function summarize(response, body) {
  return JSON.stringify({ status: response?.status ?? undefined, body }, null, 2);
}

function expectStatus(response, status) {
  assert(
    response.status === status,
    `expected status ${status}, got ${response.status}: ${JSON.stringify(response.body)}`,
  );
}

function expectFailure(response) {
  assert(response.status >= 400, `expected failure status, got ${response.status}: ${JSON.stringify(response.body)}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function ensureNoForbiddenKeys(value, forbiddenKeys) {
  const hits = [];
  walk(value, []);
  if (hits.length > 0) throw new Error(`forbidden fields leaked: ${hits.join(", ")}`);
  function walk(current, path) {
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) {
      current.forEach((item, index) => walk(item, [...path, String(index)]));
      return;
    }
    for (const [key, child] of Object.entries(current)) {
      const nextPath = [...path, key];
      if (forbiddenKeys.includes(key)) hits.push(nextPath.join("."));
      walk(child, nextPath);
    }
  }
}

function loadEnvFile(path) {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (!(key in process.env)) process.env[key] = rest.join("=");
  }
}

function requiredEnv(key) {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}
