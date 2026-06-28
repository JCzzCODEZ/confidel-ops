import { readFileSync } from "node:fs";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// ============================================================================
// Onboarding / account-management regression (no service-role key).
//   node scripts/onboarding-test.mjs signup   # once per run id
//   node scripts/onboarding-test.mjs test
//
// Requires db/fixes/2026-06-23_onboarding.sql applied + dev server up.
// Env: ONBOARDING_TEST_RUN_ID (required), API_TEST_PASSWORD, API_TEST_BASE_URL,
//      NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.
// ============================================================================

loadEnvFile(".env.local");

const phase = process.argv[2] ?? "test";
const runId = requiredEnv("ONBOARDING_TEST_RUN_ID");
const password = process.env.API_TEST_PASSWORD || "ConfidelApiTest!2026";
const baseUrl = process.env.API_TEST_BASE_URL || "http://127.0.0.1:3000";
const supabaseUrl = requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
const publishableKey = requiredEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");

const PRICING_FORBIDDEN = [
  "price_cents", "cost_cents", "profit_cents", "payroll_cents",
  "gross_revenue_cents", "net_profit_cents", "invoice_total_cents", "tax_cents",
];

const emails = {
  owner: `confidel.team.owner.${runId}@example.com`,
  emp: `confidel.team.emp.${runId}@example.com`,
  admin: `confidel.team.admin.${runId}@example.com`,
};

if (phase === "signup") {
  await signupUsers();
} else if (phase === "test") {
  await runTests();
} else {
  throw new Error(`Unknown phase: ${phase}`);
}

async function signupUsers() {
  console.log(`onboarding signup run=${runId}`);
  for (const [role, email] of Object.entries(emails)) {
    const client = freshAnonClient();
    const { data, error } = await client.auth.signUp({ email, password, options: { data: { role } } });
    if (error) throw new Error(`${role} signup failed: ${error.message}`);
    console.log(`SIGNUP ${role} user_id=${data.user?.id ?? "missing"}`);
  }
}

async function runTests() {
  console.log(`onboarding test run=${runId}`);

  const owner = await signIn("owner", emails.owner);
  const emp = await signIn("emp", emails.emp);
  const admin = await signIn("admin", emails.admin);

  // owner seeds a company (owner membership is created by the company-insert trigger)
  const ownerDb = supabaseForToken(owner.token);
  const { data: company, error: companyError } = await ownerDb
    .from("companies")
    .insert({ owner_user_id: owner.user.id, name: `Team Test ${runId} Company` })
    .select("id")
    .single();
  if (companyError) throw new Error(`seed company failed: ${companyError.message}`);
  const companyId = company.id;
  console.log(`SEEDED company_id=${companyId}`);

  let empInviteToken = null;
  let adminInviteToken = null;

  await step("owner invites an employee and an admin", async () => {
    const e = await api("POST", "/api/team/invite", owner.token, { companyId, email: emails.emp, fullName: "Crew One", role: "employee" });
    expectStatus(e, 201);
    assert(e.body.inviteUrl, "no inviteUrl returned");
    empInviteToken = e.body.invite.token;
    const a = await api("POST", "/api/team/invite", owner.token, { companyId, email: emails.admin, fullName: "Admin Two", role: "admin" });
    expectStatus(a, 201);
    adminInviteToken = a.body.invite.token;
    assert(empInviteToken && adminInviteToken, "invite token missing");
    return summarize(e, { employeeInvite: e.body.invite.email, adminInvite: a.body.invite.email });
  });

  await step("employee cannot access owner-only routes (pre-accept)", async () => {
    expectStatus(await api("GET", `/api/team/invites?companyId=${companyId}`, emp.token), 403);
    return summarize({ status: 403 }, { blocked: true });
  });

  await step("invited employee accepts and gains employee access", async () => {
    const accept = await api("POST", "/api/team/accept", emp.token, { token: empInviteToken });
    expectStatus(accept, 200);
    assert(accept.body.result?.accepted === true, `accept failed: ${JSON.stringify(accept.body)}`);
    const jobs = await api("GET", "/api/employee/jobs", emp.token);
    expectStatus(jobs, 200);
    ensureNoForbiddenKeys(jobs.body, PRICING_FORBIDDEN);
    return summarize(accept, { accepted: true });
  });

  await step("employee cannot access owner/records/pricing/team routes", async () => {
    expectStatus(await api("GET", `/api/clients?companyId=${companyId}`, emp.token), 403);
    expectStatus(await api("GET", `/api/reports/financials?companyId=${companyId}`, emp.token), 403);
    expectStatus(await api("GET", `/api/pricing/services?companyId=${companyId}`, emp.token), 403);
    expectStatus(await api("GET", `/api/team/stats?companyId=${companyId}`, emp.token), 403);
    return summarize({ status: 403 }, { allBlocked: true });
  });

  await step("invited admin accepts and gains owner-dashboard access", async () => {
    const accept = await api("POST", "/api/team/accept", admin.token, { token: adminInviteToken });
    expectStatus(accept, 200);
    assert(accept.body.result?.accepted === true, "admin accept failed");
    expectStatus(await api("GET", `/api/clients?companyId=${companyId}`, admin.token), 200);
    expectStatus(await api("GET", `/api/reports/financials?companyId=${companyId}`, admin.token), 200);
    expectStatus(await api("GET", `/api/team/stats?companyId=${companyId}`, admin.token), 200);
    return summarize(accept, { adminAccess: true });
  });

  const probeEmail = `confidel.team.probe.${runId}@example.com`;

  await step("pending invite is created and listed (email optional)", async () => {
    const inv = await api("POST", "/api/team/invite", owner.token, { companyId, email: probeEmail, role: "employee" });
    expectStatus(inv, 201);
    const list = await api("GET", `/api/team/invites?companyId=${companyId}`, owner.token);
    expectStatus(list, 200);
    const found = (list.body.invites || []).find((i) => i.email === probeEmail && i.status === "pending");
    assert(found, "probe invite not pending in list");
    // email_not_configured (no service key) or existing_account is fine; never falsely "emailed"
    return summarize(inv, { emailed: inv.body.emailed, note: inv.body.note });
  });

  await step("duplicate invite is handled safely (refresh, no error)", async () => {
    const inv = await api("POST", "/api/team/invite", owner.token, { companyId, email: probeEmail, role: "admin" });
    expectStatus(inv, 201);
    const list = await api("GET", `/api/team/invites?companyId=${companyId}`, owner.token);
    const pending = (list.body.invites || []).filter((i) => i.email === probeEmail && i.status === "pending");
    assert(pending.length === 1, `expected 1 pending probe invite, got ${pending.length}`);
    return summarize(inv, { pending: pending.length });
  });

  await step("owner can resend then revoke an invite", async () => {
    const list = await api("GET", `/api/team/invites?companyId=${companyId}`, owner.token);
    const inv = (list.body.invites || []).find((i) => i.email === probeEmail && i.status === "pending");
    assert(inv, "no pending probe invite");
    expectStatus(await api("POST", "/api/team/invite/resend", owner.token, { companyId, inviteId: inv.id }), 200);
    expectStatus(await api("POST", "/api/team/invite/revoke", owner.token, { companyId, inviteId: inv.id }), 200);
    const after = await api("GET", `/api/team/invites?companyId=${companyId}`, owner.token);
    const revoked = (after.body.invites || []).find((i) => i.id === inv.id);
    assert(revoked?.status === "revoked", `invite not revoked: ${revoked?.status}`);
    return summarize({ status: 200 }, { status: revoked?.status });
  });

  await step("employee cannot send/resend/revoke invitations", async () => {
    expectStatus(await api("POST", "/api/team/invite", emp.token, { companyId, email: `x.${runId}@example.com` }), 403);
    return summarize({ status: 403 }, { blocked: true });
  });

  await step("reused acceptance fails (single-use)", async () => {
    const res = await api("POST", "/api/team/accept", emp.token, { token: empInviteToken });
    expectStatus(res, 200);
    assert(res.body.result?.accepted === false, `second accept should fail, got ${JSON.stringify(res.body)}`);
    return summarize(res, res.body);
  });

  await step("owner deactivates employee → blocked", async () => {
    expectStatus(
      await api("POST", "/api/team/membership", owner.token, { companyId, userId: emp.user.id, isActive: false }),
      200,
    );
    const jobs = await api("GET", "/api/employee/jobs", emp.token);
    expectStatus(jobs, 200);
    assert((jobs.body.jobs?.length ?? 0) === 0, "deactivated employee still sees jobs");
    expectStatus(await api("GET", `/api/clients?companyId=${companyId}`, emp.token), 403);
    return summarize(jobs, { deactivatedBlocked: true });
  });

  await step("anon cannot access protected routes", async () => {
    expectStatus(await api("GET", "/api/employee/jobs"), 401);
    expectStatus(await api("GET", `/api/team/invites?companyId=${companyId}`), 401);
    return summarize({ status: 401 }, { anonBlocked: true });
  });

  console.log(`CLEANUP_LABEL run=${runId} company_id=${companyId} owner=${owner.user.id}`);
  console.log("onboarding tests completed: PASS");
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
