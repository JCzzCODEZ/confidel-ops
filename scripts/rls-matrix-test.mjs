import { readFileSync } from "node:fs";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// ============================================================================
// Phase B — RLS matrix regression: cross-company isolation + inactive employee.
// Complements scripts/api-integration.mjs (which covers anon, employee-vs-owner
// routes, and same-company employee isolation). This adds a SECOND company and
// an INACTIVE employee so we can prove tenant separation and deactivation.
//
// Phases:
//   node scripts/rls-matrix-test.mjs signup   # once per RLS_TEST_RUN_ID
//   node scripts/rls-matrix-test.mjs test     # seeds 2 companies + runs checks
//
// Env: RLS_TEST_RUN_ID (required, unique per run), API_TEST_PASSWORD (optional),
//      API_TEST_BASE_URL (optional, default http://127.0.0.1:3000),
//      NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.
// Uses the reserved @example.com domain — never a real inbox.
// ============================================================================

loadEnvFile(".env.local");

const phase = process.argv[2] ?? "test";
const runId = requiredEnv("RLS_TEST_RUN_ID");
const password = process.env.API_TEST_PASSWORD || "ConfidelApiTest!2026";
const baseUrl = process.env.API_TEST_BASE_URL || "http://127.0.0.1:3000";
const supabaseUrl = requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
const publishableKey = requiredEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");

const emails = {
  ownerA: `confidel.rls.ownera.${runId}@example.com`,
  empA: `confidel.rls.empa.${runId}@example.com`,
  empInactive: `confidel.rls.inactive.${runId}@example.com`,
  ownerB: `confidel.rls.ownerb.${runId}@example.com`,
  empB: `confidel.rls.empb.${runId}@example.com`,
};

if (phase === "signup") {
  await signupUsers();
} else if (phase === "test") {
  await runTests();
} else {
  throw new Error(`Unknown phase: ${phase}`);
}

async function signupUsers() {
  console.log(`RLS matrix signup run=${runId}`);
  for (const [role, email] of Object.entries(emails)) {
    const client = freshAnonClient();
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: { data: { confidel_rls_test_run_id: runId, confidel_rls_test_role: role } },
    });
    if (error) throw new Error(`${role} signup failed: ${error.message}`);
    console.log(`SIGNUP ${role} email=${email} user_id=${data.user?.id ?? "missing"}`);
  }
}

async function runTests() {
  console.log(`RLS matrix test run=${runId}`);
  console.log(`BASE_URL ${baseUrl}`);

  const ownerA = await signIn("ownerA", emails.ownerA);
  const empA = await signIn("empA", emails.empA);
  const empInactive = await signIn("empInactive", emails.empInactive);
  const ownerB = await signIn("ownerB", emails.ownerB);
  const empB = await signIn("empB", emails.empB);

  const companyA = await seedCompany(ownerA, "A", [
    { user: empA, role: "employee", active: true },
    { user: empInactive, role: "employee", active: false },
  ]);
  const companyB = await seedCompany(ownerB, "B", [{ user: empB, role: "employee", active: true }]);

  // Seed a client + assigned job in each company (via the API, as that company's owner).
  const jobA = await seedClientAndJob(ownerA, companyA, empA, "A");
  const jobB = await seedClientAndJob(ownerB, companyB, empB, "B");

  // ---- Cross-company isolation -------------------------------------------
  await step("cross-company: ownerA cannot read company B clients via API", async () => {
    const res = await api("GET", `/api/clients?companyId=${companyB}`, ownerA.token);
    expectFailure(res);
    return summarize(res, res.body);
  });

  await step("cross-company: ownerA direct SELECT on company B clients = 0 rows", async () => {
    const db = supabaseForToken(ownerA.token);
    const { data, error } = await db.from("clients").select("id").eq("company_id", companyB);
    assert(!error, `unexpected error: ${error?.message}`);
    assert((data?.length ?? 0) === 0, `expected 0 cross-company rows, got ${data?.length}`);
    return summarize({ status: 200 }, { rows: data?.length ?? 0 });
  });

  await step("cross-company: employeeA my_jobs excludes company B jobs", async () => {
    const res = await api("GET", "/api/employee/jobs", empA.token);
    expectStatus(res, 200);
    const jobs = res.body.jobs ?? [];
    const ids = jobs.map((j) => j.id ?? j.job_id);
    assert(ids.includes(jobA), "employeeA should see their own company A job");
    assert(!ids.includes(jobB), "employeeA must NOT see company B job");
    assert(jobs.every((j) => j.company_id === undefined || j.company_id === companyA),
      "employeeA my_jobs leaked a non-company-A job");
    return summarize(res, { visible: ids });
  });

  await step("cross-company: employeeA cannot read company B via owner route", async () => {
    const res = await api("GET", `/api/clients?companyId=${companyB}`, empA.token);
    expectFailure(res);
    return summarize(res, res.body);
  });

  // ---- Inactive employee --------------------------------------------------
  await step("inactive employee: my_jobs returns 0 rows", async () => {
    const res = await api("GET", "/api/employee/jobs", empInactive.token);
    expectStatus(res, 200);
    assert((res.body.jobs?.length ?? 0) === 0, `inactive employee saw ${res.body.jobs?.length} jobs`);
    return summarize(res, { jobs: res.body.jobs?.length ?? 0 });
  });

  await step("inactive employee: denied on owner-only route", async () => {
    const res = await api("GET", `/api/clients?companyId=${companyA}`, empInactive.token);
    expectFailure(res);
    return summarize(res, res.body);
  });

  await step("inactive employee: direct SELECT on jobs = 0 rows", async () => {
    const db = supabaseForToken(empInactive.token);
    const { data, error } = await db.from("jobs").select("id");
    assert(!error, `unexpected error: ${error?.message}`);
    assert((data?.length ?? 0) === 0, `expected 0 rows, got ${data?.length}`);
    return summarize({ status: 200 }, { rows: data?.length ?? 0 });
  });

  // ---- Anon -------------------------------------------------------------
  await step("anon: employee jobs route denied", async () => {
    const res = await api("GET", "/api/employee/jobs");
    expectStatus(res, 401);
    return summarize(res, res.body);
  });

  console.log(
    `CLEANUP_LABEL run=${runId} companyA=${companyA} companyB=${companyB} ` +
      `ownerA=${ownerA.user.id} ownerB=${ownerB.user.id}`,
  );
  console.log("RLS matrix tests completed: PASS");
}

async function seedCompany(owner, label, members) {
  const ownerDb = supabaseForToken(owner.token);
  const { data: company, error } = await ownerDb
    .from("companies")
    .insert({
      owner_user_id: owner.user.id,
      name: `RLS Test ${runId} Company ${label}`,
      logo_url: "https://example.com/rls-test-logo.png",
    })
    .select("id")
    .single();
  if (error) throw new Error(`seed company ${label} failed: ${error.message}`);

  for (const m of members) {
    const { error: mErr } = await ownerDb.from("company_memberships").insert({
      company_id: company.id,
      user_id: m.user.user.id,
      role: m.role,
      full_name: `RLS ${runId} ${m.role}`,
      email: m.user.user.email,
      is_active: m.active,
    });
    if (mErr) throw new Error(`seed membership (${label}) failed: ${mErr.message}`);
  }
  console.log(`SEEDED company ${label} id=${company.id}`);
  return company.id;
}

async function seedClientAndJob(owner, companyId, employee, label) {
  const client = await api("POST", "/api/clients", owner.token, {
    companyId,
    name: `RLS ${runId} Client ${label}`,
  });
  expectStatus(client, 201);
  const job = await api("POST", "/api/jobs", owner.token, {
    companyId,
    clientId: client.body.client.id,
    title: `RLS ${runId} Job ${label}`,
    priceCents: 10000,
  });
  expectStatus(job, 201);
  const assign = await api("POST", "/api/jobs/assign", owner.token, {
    jobId: job.body.job.id,
    employeeUserId: employee.user.id,
  });
  expectStatus(assign, 201);
  return job.body.job.id;
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
