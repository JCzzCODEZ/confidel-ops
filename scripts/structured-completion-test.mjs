import { readFileSync } from "node:fs";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// ============================================================================
// Structured completion regression: services/add-ons/expenses are real rows the
// owner can read (not buried in notes), expenses are itemized, timing/hours are
// computed, and cross-employee isolation holds.
//
//   node scripts/structured-completion-test.mjs signup   # once per run id
//   node scripts/structured-completion-test.mjs test
//
// Requires db/fixes/2026-06-23_structured_completion.sql applied + dev server up.
// Env: STRUCTURED_TEST_RUN_ID (required), API_TEST_PASSWORD, API_TEST_BASE_URL,
//      NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.
// ============================================================================

loadEnvFile(".env.local");

const phase = process.argv[2] ?? "test";
const runId = requiredEnv("STRUCTURED_TEST_RUN_ID");
const password = process.env.API_TEST_PASSWORD || "ConfidelApiTest!2026";
const baseUrl = process.env.API_TEST_BASE_URL || "http://127.0.0.1:3000";
const supabaseUrl = requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
const publishableKey = requiredEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");

const emails = {
  owner: `confidel.struct.owner.${runId}@example.com`,
  employee: `confidel.struct.emp.${runId}@example.com`,
  other: `confidel.struct.other.${runId}@example.com`,
};

if (phase === "signup") {
  await signupUsers();
} else if (phase === "test") {
  await runTests();
} else {
  throw new Error(`Unknown phase: ${phase}`);
}

async function signupUsers() {
  console.log(`structured signup run=${runId}`);
  for (const [role, email] of Object.entries(emails)) {
    const client = freshAnonClient();
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: { data: { confidel_struct_run_id: runId, role } },
    });
    if (error) throw new Error(`${role} signup failed: ${error.message}`);
    console.log(`SIGNUP ${role} user_id=${data.user?.id ?? "missing"}`);
  }
}

async function runTests() {
  console.log(`structured test run=${runId}`);

  const owner = await signIn("owner", emails.owner);
  const employee = await signIn("employee", emails.employee);
  const other = await signIn("other", emails.other);

  const companyId = await seedCompany(owner, [
    { user: employee, role: "employee", active: true },
    { user: other, role: "employee", active: true },
  ]);

  const client = await api("POST", "/api/clients", owner.token, { companyId, name: `Struct ${runId} Client` });
  expectStatus(client, 201);
  const job = await api("POST", "/api/jobs", owner.token, {
    companyId,
    clientId: client.body.client.id,
    title: `Struct ${runId} Job`,
    priceCents: 20000,
  });
  expectStatus(job, 201);
  const jobId = job.body.job.id;
  expectStatus(await api("POST", "/api/jobs/assign", owner.token, { jobId, employeeUserId: employee.user.id }), 201);

  const completion = await api("POST", "/api/jobs/complete", employee.token, {
    jobId,
    notes: "Gate squeaks — follow up",
    photoUrls: [],
  });
  expectStatus(completion, 201);
  const completionId = completion.body.completion.id;

  await step("employee records structured details (services/add-ons/expenses/timing)", async () => {
    const res = await api("POST", `/api/completions/${completionId}/details`, employee.token, {
      arrival: "08:45",
      start: "09:00",
      end: "13:30",
      breakMinutes: 30,
      completionStatus: "Completed",
      services: ["Deep Cleaning", "Pet Care"],
      addons: ["Inside Oven"],
      expenses: [
        { type: "supplies", description: "Microfiber + solution", amountCents: 1500 },
        { type: "mileage", quantity: 12, unit: "miles", amountCents: 0 },
        { type: "parking", amountCents: 500 },
      ],
    });
    expectStatus(res, 201);
    return summarize(res, res.body);
  });

  await step("owner reads structured services/add-ons + computed hours", async () => {
    const res = await api("GET", `/api/completions/${completionId}/details`, owner.token);
    expectStatus(res, 200);
    assert(res.body.services?.includes("Deep Cleaning"), "missing service Deep Cleaning");
    assert(res.body.services?.includes("Pet Care"), "missing service Pet Care");
    assert(res.body.addons?.includes("Inside Oven"), "missing add-on Inside Oven");
    assert(res.body.completion?.completion_status === "Completed", "completion_status not stored");
    assert(Math.abs(Number(res.body.completion?.hours) - 4) < 0.01, `expected 4 hours, got ${res.body.completion?.hours}`);
    return summarize(res, {
      services: res.body.services,
      addons: res.body.addons,
      hours: res.body.completion?.hours,
    });
  });

  await step("expenses are itemized (not one rolled-up number)", async () => {
    const res = await api("GET", `/api/completions/${completionId}/details`, owner.token);
    expectStatus(res, 200);
    const expenses = res.body.expenses ?? [];
    assert(expenses.length === 3, `expected 3 itemized expenses, got ${expenses.length}`);
    const mileage = expenses.find((e) => e.expense_type === "mileage");
    assert(mileage && Number(mileage.quantity) === 12, "mileage row missing miles quantity");
    const supplies = expenses.find((e) => e.expense_type === "supplies");
    assert(supplies && Number(supplies.amount_cents) === 1500, "supplies amount not itemized");
    return summarize(res, { expenseTypes: expenses.map((e) => e.expense_type) });
  });

  await step("owner details payload exposes no pricing/financial fields", async () => {
    const res = await api("GET", `/api/completions/${completionId}/details`, owner.token);
    expectStatus(res, 200);
    for (const forbidden of ["price_cents", "revenue_cents", "profit_cents", "payroll_cents", "total"]) {
      assert(!(forbidden in (res.body.completion ?? {})), `details leaked pricing field '${forbidden}'`);
    }
    return summarize(res, { completionKeys: Object.keys(res.body.completion ?? {}).sort() });
  });

  await step("other employee cannot read this completion's structured details", async () => {
    const res = await api("GET", `/api/completions/${completionId}/details`, other.token);
    const blocked = res.status >= 400 || (res.body?.services?.length ?? 0) === 0;
    assert(blocked, `unassigned employee saw structured details: ${JSON.stringify(res.body)}`);
    return summarize(res, { status: res.status });
  });

  await step("anon cannot read structured details", async () => {
    const res = await api("GET", `/api/completions/${completionId}/details`);
    expectStatus(res, 401);
    return summarize(res, res.body);
  });

  console.log(`CLEANUP_LABEL run=${runId} company_id=${companyId} owner=${owner.user.id}`);
  console.log("structured completion tests completed: PASS");
}

async function seedCompany(owner, members) {
  const ownerDb = supabaseForToken(owner.token);
  const { data: company, error } = await ownerDb
    .from("companies")
    .insert({ owner_user_id: owner.user.id, name: `Struct Test ${runId} Company` })
    .select("id")
    .single();
  if (error) throw new Error(`seed company failed: ${error.message}`);
  for (const m of members) {
    const { error: mErr } = await ownerDb.from("company_memberships").insert({
      company_id: company.id,
      user_id: m.user.user.id,
      role: m.role,
      full_name: `Struct ${runId} ${m.role}`,
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
