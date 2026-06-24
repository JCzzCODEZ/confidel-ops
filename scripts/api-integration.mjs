import { readFileSync } from "node:fs";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

loadEnvFile(".env.local");

const phase = process.argv[2] ?? "test";
const runId = requiredEnv("API_TEST_RUN_ID");
const password = process.env.API_TEST_PASSWORD || "ConfidelApiTest!2026";
const baseUrl = process.env.API_TEST_BASE_URL || "http://127.0.0.1:3000";
const supabaseUrl = requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
const publishableKey = requiredEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");

// Use the reserved, non-deliverable example.com domain so test signups can
// never send mail to a real inbox. Do not change to a real domain.
const emails = {
  owner: `confidel.api.owner.${runId}@example.com`,
  employee: `confidel.api.employee.${runId}@example.com`,
  otherEmployee: `confidel.api.other.${runId}@example.com`,
};

const anonSupabase = createSupabaseClient(supabaseUrl, publishableKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

if (phase === "signup") {
  await signupUsers();
} else if (phase === "test") {
  await runTests();
} else {
  throw new Error(`Unknown phase: ${phase}`);
}

async function signupUsers() {
  console.log(`API integration signup run=${runId}`);

  for (const [role, email] of Object.entries(emails)) {
    const { data, error } = await anonSupabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          confidel_api_test_run_id: runId,
          confidel_api_test_role: role,
        },
      },
    });

    if (error) {
      throw new Error(`${role} signup failed: ${error.message}`);
    }

    console.log(
      `SIGNUP ${role} email=${email} user_id=${data.user?.id ?? "missing"} session=${data.session ? "yes" : "no"}`,
    );
  }
}

async function runTests() {
  console.log(`API integration test run=${runId}`);
  console.log(`BASE_URL ${baseUrl}`);

  const owner = await signIn("owner", emails.owner);
  const employee = await signIn("employee", emails.employee);
  const otherEmployee = await signIn("otherEmployee", emails.otherEmployee);
  const ownerDb = supabaseForToken(owner.token);

  const seeded = await seedCompany(ownerDb, owner.user, employee.user, otherEmployee.user);
  const state = {
    companyId: seeded.company.id,
    clientId: null,
    jobId: null,
    hiddenJobId: null,
    completionId: null,
    rejectedJobId: null,
    rejectedCompletionId: null,
    invoiceId: null,
  };

  await step("owner can fetch session/profile", async () => {
    const response = await api("GET", "/api/session/profile", owner.token);
    expectStatus(response, 200);
    assert(response.body.user?.id === owner.user.id, "owner profile user id mismatch");
    assert(
      response.body.memberships?.some((membership) => membership.company_id === state.companyId),
      "owner profile missing company membership",
    );
    return summarize(response, {
      user: response.body.user,
      memberships: response.body.memberships?.length ?? 0,
      companies: response.body.companies?.map((company) => Object.keys(company).sort()) ?? [],
    });
  });

  await step("employee can fetch session/profile", async () => {
    const response = await api("GET", "/api/session/profile", employee.token);
    expectStatus(response, 200);
    assert(response.body.user?.id === employee.user.id, "employee profile user id mismatch");
    assert(
      response.body.memberships?.some((membership) => membership.company_id === state.companyId),
      "employee profile missing company membership",
    );
    return summarize(response, {
      user: response.body.user,
      memberships: response.body.memberships?.length ?? 0,
    });
  });

  await step("employee can fetch company branding", async () => {
    const response = await api("GET", "/api/company/branding", employee.token);
    expectStatus(response, 200);
    const company = response.body.companies?.find((row) => row.id === state.companyId);
    assert(company, "company branding missing test company");
    assertEqualKeys(company, ["id", "logo_url", "name"]);
    return summarize(response, { companies: response.body.companies });
  });

  await step("owner can create client", async () => {
    const response = await api("POST", "/api/clients", owner.token, {
      companyId: state.companyId,
      name: `API Test ${runId} Client`,
      email: `client.${runId}@example.com`,
      phone: "555-0100",
      billingAddress: "100 API Test Way",
      taxId: `API-TAX-${runId}`,
      adminNotes: `API TEST ${runId} client private note`,
    });
    expectStatus(response, 201);
    state.clientId = response.body.client?.id;
    assert(state.clientId, "client id missing");
    ensureNoForbiddenKeys(response.body, ["tax_id", "admin_notes"]);
    return summarize(response, response.body);
  });

  await step("owner can fetch clients", async () => {
    const response = await api("GET", `/api/clients?companyId=${state.companyId}`, owner.token);
    expectStatus(response, 200);
    assert(response.body.clients?.some((client) => client.id === state.clientId), "created client not returned");
    ensureNoForbiddenKeys(response.body, ["tax_id", "admin_notes"]);
    return summarize(response, { clientCount: response.body.clients?.length ?? 0 });
  });

  // ---- Phase 1.1 alarm-code encryption (gated: only runs after the Vault
  //      migration db/fixes/2026-06-23_alarm_code_vault.sql has been applied).
  //      Set ALARM_CODE_TESTS=1 to include these. Off by default so the
  //      Phase 1.4 suite stays green without the migration. ----
  if (process.env.ALARM_CODE_TESTS === "1") {
    const alarmCode = `ALARM-${runId}`;

    await step("owner/admin can set then reveal alarm code", async () => {
      const set = await api("PUT", `/api/clients/${state.clientId}/alarm-code`, owner.token, { code: alarmCode });
      expectStatus(set, 200);
      const reveal = await api("POST", `/api/clients/${state.clientId}/reveal-alarm-code`, owner.token);
      expectStatus(reveal, 200);
      assert(reveal.body.alarmCode === alarmCode, `expected revealed code to match, got ${reveal.body.alarmCode}`);
      return summarize(reveal, { matched: true });
    });

    await step("normal client APIs never include the alarm code", async () => {
      const list = await api("GET", `/api/clients?companyId=${state.companyId}`, owner.token);
      expectStatus(list, 200);
      ensureNoForbiddenKeys(list.body, ["alarm_code", "alarm_code_cipher", "alarmCode"]);
      return summarize(list, { ok: true });
    });

    await step("employee cannot reveal alarm code", async () => {
      const res = await api("POST", `/api/clients/${state.clientId}/reveal-alarm-code`, employee.token);
      expectFailure(res);
      return summarize(res, res.body);
    });

    await step("anon cannot reveal alarm code", async () => {
      const res = await api("POST", `/api/clients/${state.clientId}/reveal-alarm-code`);
      expectStatus(res, 401);
      return summarize(res, res.body);
    });

    await step("employee cannot set alarm code", async () => {
      const res = await api("PUT", `/api/clients/${state.clientId}/alarm-code`, employee.token, { code: "nope" });
      expectFailure(res);
      return summarize(res, res.body);
    });

    await step("reveal writes an audit row", async () => {
      const { data, error } = await ownerDb
        .from("alarm_code_audit")
        .select("id, revealed_by")
        .eq("client_id", state.clientId);
      assert(!error, `audit read error: ${error?.message}`);
      assert((data?.length ?? 0) >= 1, "expected at least one alarm_code_audit row after reveal");
      assert(data.every((row) => row.revealed_by === owner.user.id), "audit row revealed_by mismatch");
      return summarize({ status: 200 }, { auditRows: data?.length ?? 0 });
    });
  }

  await step("owner can create job", async () => {
    const response = await api("POST", "/api/jobs", owner.token, {
      companyId: state.companyId,
      clientId: state.clientId,
      title: `API Test ${runId} Assigned Job`,
      description: "Created by API integration harness",
      scheduledFor: new Date(Date.now() + 86400000).toISOString(),
      priceCents: 125000,
      costCents: 30000,
      payrollCents: 20000,
      adminNotes: `API TEST ${runId} job private note`,
    });
    expectStatus(response, 201);
    state.jobId = response.body.job?.id;
    assert(state.jobId, "job id missing");
    ensureNoForbiddenKeys(response.body, [
      "price_cents",
      "cost_cents",
      "payroll_cents",
      "profit_cents",
      "admin_notes",
      "invoice_id",
    ]);
    return summarize(response, response.body);
  });

  await step("owner can create hidden other-employee job", async () => {
    const response = await api("POST", "/api/jobs", owner.token, {
      companyId: state.companyId,
      clientId: state.clientId,
      title: `API Test ${runId} Other Employee Job`,
      priceCents: 88000,
      payrollCents: 12000,
      adminNotes: `API TEST ${runId} hidden job private note`,
    });
    expectStatus(response, 201);
    state.hiddenJobId = response.body.job?.id;
    assert(state.hiddenJobId, "hidden job id missing");
    return summarize(response, { hiddenJobId: state.hiddenJobId });
  });

  await step("owner can fetch jobs", async () => {
    const response = await api("GET", `/api/jobs?companyId=${state.companyId}`, owner.token);
    expectStatus(response, 200);
    assert(response.body.jobs?.some((job) => job.id === state.jobId), "created job not returned");
    ensureNoForbiddenKeys(response.body, [
      "price_cents",
      "cost_cents",
      "payroll_cents",
      "profit_cents",
      "admin_notes",
      "invoice_id",
    ]);
    return summarize(response, { jobCount: response.body.jobs?.length ?? 0 });
  });

  await step("owner can assign job", async () => {
    const response = await api("POST", "/api/jobs/assign", owner.token, {
      jobId: state.jobId,
      employeeUserId: employee.user.id,
    });
    expectStatus(response, 201);
    assert(response.body.assignment?.job_id === state.jobId, "assignment job mismatch");
    return summarize(response, response.body);
  });

  await step("owner can assign hidden job to other employee", async () => {
    const response = await api("POST", "/api/jobs/assign", owner.token, {
      jobId: state.hiddenJobId,
      employeeUserId: otherEmployee.user.id,
    });
    expectStatus(response, 201);
    assert(response.body.assignment?.employee_user_id === otherEmployee.user.id, "other employee assignment mismatch");
    return summarize(response, {
      job_id: response.body.assignment?.job_id,
      employee_user_id: response.body.assignment?.employee_user_id,
    });
  });

  await step("employee can see assigned job through the API only", async () => {
    const response = await api("GET", "/api/employee/jobs", employee.token);
    expectStatus(response, 200);
    const jobs = response.body.jobs ?? [];
    const visibleIds = jobs.map((job) => job.id ?? job.job_id);
    assert(visibleIds.includes(state.jobId), "assigned job missing from employee API response");
    assert(!visibleIds.includes(state.hiddenJobId), "employee can see another employee job");
    ensureNoForbiddenKeys(response.body, [
      "price_cents",
      "cost_cents",
      "payroll_cents",
      "profit_cents",
      "tax_id",
      "admin_notes",
      "invoice_id",
    ]);
    return summarize(response, { visibleJobIds: visibleIds, visibleKeys: jobs.map((job) => Object.keys(job).sort()) });
  });

  // ---- Phase 1.4 RLS direct-access proofs (bypass the API, hit PostgREST as the
  //      employee / anon to prove Row-Level Security, not just the API layer). ----
  await step("RLS: employee direct SELECT on jobs returns 0 rows", async () => {
    const empDb = supabaseForToken(employee.token);
    const { data, error } = await empDb.from("jobs").select("id");
    assert(!error, `unexpected error: ${error?.message}`);
    assert((data?.length ?? 0) === 0, `expected 0 rows for employee, got ${data?.length}`);
    return summarize({ status: 200 }, { rows: data?.length ?? 0 });
  });

  await step("RLS: employee direct SELECT on companies returns 0 rows", async () => {
    const empDb = supabaseForToken(employee.token);
    const { data, error } = await empDb.from("companies").select("id");
    assert(!error, `unexpected error: ${error?.message}`);
    assert((data?.length ?? 0) === 0, `expected 0 rows for employee, got ${data?.length}`);
    return summarize({ status: 200 }, { rows: data?.length ?? 0 });
  });

  await step("RLS: employee direct INSERT into jobs is rejected", async () => {
    const empDb = supabaseForToken(employee.token);
    const { data, error } = await empDb
      .from("jobs")
      .insert({
        company_id: state.companyId,
        client_id: state.clientId,
        title: `API TEST ${runId} illegal direct insert`,
      })
      .select("id");
    assert(error || (data?.length ?? 0) === 0, "expected RLS to reject employee direct job insert");
    return summarize({ status: 403 }, { error: error?.message ?? null, rows: data?.length ?? 0 });
  });

  await step("RLS: company_branding RPC returns only id/name/logo_url", async () => {
    const empDb = supabaseForToken(employee.token);
    const { data, error } = await empDb.rpc("company_branding");
    assert(!error, `unexpected error: ${error?.message}`);
    const row = (data ?? []).find((company) => company.id === state.companyId);
    assert(row, "company_branding did not return the test company");
    assertEqualKeys(row, ["id", "logo_url", "name"]);
    return summarize({ status: 200 }, { keys: Object.keys(row).sort() });
  });

  await step("RLS: anon cannot read jobs via my_jobs RPC (denied or empty)", async () => {
    // Use a FRESH, never-signed-in client so this is a genuine anonymous call.
    // (Do NOT reuse a client that has called signInWithPassword — it retains the
    // session in memory and would run this RPC as that user, not as anon.)
    // Depending on PostgREST behavior, a revoked-EXECUTE / RLS-blocked RPC may
    // either throw (permission denied) or return an empty result. Both are safe.
    // The only failure is anon actually getting rows back.
    const anon = freshAnonClient();
    const { data, error } = await anon.rpc("my_jobs");
    const rowCount = Array.isArray(data) ? data.length : data == null ? 0 : 1;
    assert(error || rowCount === 0, `anon my_jobs() exposed ${rowCount} row(s) — boundary leak`);
    return summarize(
      { status: error ? 403 : 200 },
      { denied: Boolean(error), error: error?.message ?? null, rows: rowCount },
    );
  });

  await step("employee can submit completion", async () => {
    const response = await api("POST", "/api/jobs/complete", employee.token, {
      jobId: state.jobId,
      notes: `API TEST ${runId} completed`,
      photoUrls: ["https://example.com/api-test-photo.jpg"],
    });
    expectStatus(response, 201);
    state.completionId = response.body.completion?.id;
    assert(state.completionId, "completion id missing");
    return summarize(response, response.body);
  });

  await step("bad duplicate submit attempt fails", async () => {
    const response = await api("POST", "/api/jobs/complete", employee.token, {
      jobId: state.jobId,
      notes: "duplicate should fail",
      photoUrls: [],
    });
    expectFailure(response);
    return summarize(response, response.body);
  });

  await step("bad cross-employee submit attempt fails", async () => {
    const response = await api("POST", "/api/jobs/complete", employee.token, {
      jobId: state.hiddenJobId,
      notes: "not my job",
      photoUrls: [],
    });
    expectFailure(response);
    return summarize(response, response.body);
  });

  await step("bad photo_urls submit attempt fails", async () => {
    const response = await api("POST", "/api/jobs/complete", employee.token, {
      jobId: state.hiddenJobId,
      notes: "bad photo urls",
      photoUrls: { bad: true },
    });
    expectStatus(response, 400);
    return summarize(response, response.body);
  });

  await step("owner can approve job completion", async () => {
    const response = await api("POST", `/api/jobs/${state.jobId}/review`, owner.token, {
      completionId: state.completionId,
      decision: "approve",
      reviewNotes: `API TEST ${runId} approved`,
    });
    expectStatus(response, 200);
    assert(response.body.completion?.status === "approved", "completion was not approved");
    return summarize(response, response.body);
  });

  await step("owner can reject job completion", async () => {
    const created = await api("POST", "/api/jobs", owner.token, {
      companyId: state.companyId,
      clientId: state.clientId,
      title: `API Test ${runId} Rejected Job`,
      priceCents: 44000,
      adminNotes: `API TEST ${runId} reject private note`,
    });
    expectStatus(created, 201);
    state.rejectedJobId = created.body.job?.id;

    const assigned = await api("POST", "/api/jobs/assign", owner.token, {
      jobId: state.rejectedJobId,
      employeeUserId: employee.user.id,
    });
    expectStatus(assigned, 201);

    const submitted = await api("POST", "/api/jobs/complete", employee.token, {
      jobId: state.rejectedJobId,
      notes: `API TEST ${runId} reject me`,
      photoUrls: [],
    });
    expectStatus(submitted, 201);
    state.rejectedCompletionId = submitted.body.completion?.id;

    const rejected = await api("POST", `/api/jobs/${state.rejectedJobId}/review`, owner.token, {
      completionId: state.rejectedCompletionId,
      decision: "reject",
      reviewNotes: `API TEST ${runId} rejected`,
    });
    expectStatus(rejected, 200);
    assert(rejected.body.completion?.status === "rejected", "completion was not rejected");
    return summarize(rejected, rejected.body);
  });

  await step("owner can create invoice", async () => {
    const response = await api("POST", "/api/invoices", owner.token, {
      companyId: state.companyId,
      clientId: state.clientId,
      jobId: state.jobId,
      amountCents: 125000,
      dueDate: new Date(Date.now() + 14 * 86400000).toISOString(),
      notes: `API TEST ${runId} invoice private note`,
    });
    expectStatus(response, 201);
    state.invoiceId = response.body.invoice?.id;
    assert(state.invoiceId, "invoice id missing");
    return summarize(response, response.body);
  });

  await step("owner can record payment", async () => {
    const response = await api("POST", "/api/payments", owner.token, {
      invoiceId: state.invoiceId,
      amountCents: 125000,
      paidAt: new Date().toISOString(),
      method: "test",
      reference: `API-TEST-${runId}`,
    });
    expectStatus(response, 201);
    assert(response.body.payment?.invoice_id === state.invoiceId, "payment invoice mismatch");
    return summarize(response, response.body);
  });

  await step("anon requests fail", async () => {
    const checks = [
      await api("GET", "/api/session/profile"),
      await api("GET", "/api/company/branding"),
      await api("POST", "/api/jobs/complete", null, { jobId: state.jobId, photoUrls: [] }),
    ];
    checks.forEach((response) => expectStatus(response, 401));
    return summarize(null, checks.map((response) => ({ status: response.status, body: response.body })));
  });

  await step("employee requests to owner-only routes fail", async () => {
    const checks = [
      await api("GET", `/api/clients?companyId=${state.companyId}`, employee.token),
      await api("GET", `/api/jobs?companyId=${state.companyId}`, employee.token),
      await api("POST", "/api/clients", employee.token, {
        companyId: state.companyId,
        name: `API Test ${runId} Forbidden Client`,
      }),
      await api("POST", "/api/jobs", employee.token, {
        companyId: state.companyId,
        clientId: state.clientId,
        title: `API Test ${runId} Forbidden Job`,
      }),
      await api("POST", "/api/jobs/assign", employee.token, {
        jobId: state.jobId,
        employeeUserId: employee.user.id,
      }),
      await api("POST", "/api/invoices", employee.token, {
        companyId: state.companyId,
        clientId: state.clientId,
        amountCents: 100,
      }),
      await api("POST", "/api/payments", employee.token, {
        invoiceId: state.invoiceId,
        amountCents: 100,
      }),
    ];
    checks.forEach((response) => expectFailure(response));
    return summarize(null, checks.map((response) => ({ status: response.status, body: response.body })));
  });

  console.log(
    `CLEANUP_LABEL run=${runId} company_id=${state.companyId} owner=${owner.user.id} employee=${employee.user.id} other_employee=${otherEmployee.user.id}`,
  );
  console.log("API integration tests completed: PASS");
}

async function seedCompany(ownerDb, ownerUser, employeeUser, otherEmployeeUser) {
  const { data: company, error: companyError } = await ownerDb
    .from("companies")
    .insert({
      owner_user_id: ownerUser.id,
      name: `API Test ${runId} Company`,
      logo_url: "https://example.com/api-test-logo.png",
      tax_id: `API-TAX-${runId}`,
      admin_notes: `API TEST ${runId} company private note`,
    })
    .select("id, name, logo_url")
    .single();

  if (companyError) {
    throw new Error(`seed company failed: ${companyError.message}`);
  }

  for (const member of [
    {
      user_id: employeeUser.id,
      role: "employee",
      full_name: `API Test ${runId} Employee`,
      email: emails.employee,
    },
    {
      user_id: otherEmployeeUser.id,
      role: "employee",
      full_name: `API Test ${runId} Other Employee`,
      email: emails.otherEmployee,
    },
  ]) {
    const { error } = await ownerDb.from("company_memberships").insert({
      company_id: company.id,
      ...member,
    });

    if (error) {
      throw new Error(`seed membership failed for ${member.email}: ${error.message}`);
    }
  }

  console.log(`SEEDED company_id=${company.id} name="${company.name}"`);
  return { company };
}

async function signIn(role, email) {
  // Dedicated client per sign-in so the shared `anonSupabase` is never
  // contaminated with a user session. This keeps anonymous RLS checks honest.
  const client = freshAnonClient();
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password,
  });

  if (error || !data.session || !data.user) {
    throw new Error(`${role} sign-in failed: ${error?.message ?? "missing session"}`);
  }

  console.log(`SIGNED_IN ${role} email=${email} user_id=${data.user.id}`);
  return {
    token: data.session.access_token,
    user: data.user,
  };
}

function supabaseForToken(token) {
  return createSupabaseClient(supabaseUrl, publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
}

function freshAnonClient() {
  // A Supabase client that has never signed in — guaranteed to carry no user
  // session, so RPC/REST calls run as the anonymous role.
  return createSupabaseClient(supabaseUrl, publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
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
  const headers = {
    Accept: "application/json",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const payload = await response.json().catch(() => null);

  return {
    status: response.status,
    body: payload,
  };
}

function summarize(response, body) {
  return JSON.stringify(
    {
      status: response?.status ?? undefined,
      body,
    },
    null,
    2,
  );
}

function expectStatus(response, status) {
  assert(response.status === status, `expected status ${status}, got ${response.status}: ${JSON.stringify(response.body)}`);
}

function expectFailure(response) {
  assert(response.status >= 400, `expected failure status, got ${response.status}: ${JSON.stringify(response.body)}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqualKeys(row, expectedKeys) {
  const actual = Object.keys(row).sort();
  const expected = [...expectedKeys].sort();
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected keys ${expected.join(",")}, got ${actual.join(",")}`,
  );
}

function ensureNoForbiddenKeys(value, forbiddenKeys) {
  const hits = [];
  walk(value, []);

  if (hits.length > 0) {
    throw new Error(`forbidden fields leaked: ${hits.join(", ")}`);
  }

  function walk(current, path) {
    if (!current || typeof current !== "object") {
      return;
    }

    if (Array.isArray(current)) {
      current.forEach((item, index) => walk(item, [...path, String(index)]));
      return;
    }

    for (const [key, child] of Object.entries(current)) {
      const nextPath = [...path, key];

      if (forbiddenKeys.includes(key)) {
        hits.push(nextPath.join("."));
      }

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

    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }

    const [key, ...rest] = trimmed.split("=");
    const value = rest.join("=");

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function requiredEnv(key) {
  const value = process.env[key];

  if (!value) {
    throw new Error(`${key} is required`);
  }

  return value;
}
