import { readFileSync } from "node:fs";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// ============================================================================
// Phase C — Storage media regression (private bucket + RLS).
// Proves: assigned employee can upload + record; owner/admin can list + sign;
// a non-assigned employee and anon cannot read; metadata API leaks no storage
// internals; URLs are signed (private), never public.
//
//   node scripts/storage-media-test.mjs signup   # once per STORAGE_TEST_RUN_ID
//   node scripts/storage-media-test.mjs test
//
// Requires db/fixes/2026-06-23_job_media_storage.sql applied + dev server up.
// Env: STORAGE_TEST_RUN_ID (required), API_TEST_PASSWORD, API_TEST_BASE_URL,
//      NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.
// ============================================================================

loadEnvFile(".env.local");

const phase = process.argv[2] ?? "test";
const runId = requiredEnv("STORAGE_TEST_RUN_ID");
const password = process.env.API_TEST_PASSWORD || "ConfidelApiTest!2026";
const baseUrl = process.env.API_TEST_BASE_URL || "http://127.0.0.1:3000";
const supabaseUrl = requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
const publishableKey = requiredEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
const BUCKET = "job-media";

const emails = {
  owner: `confidel.storage.owner.${runId}@example.com`,
  employee: `confidel.storage.emp.${runId}@example.com`,
  other: `confidel.storage.other.${runId}@example.com`,
};

if (phase === "signup") {
  await signupUsers();
} else if (phase === "test") {
  await runTests();
} else {
  throw new Error(`Unknown phase: ${phase}`);
}

async function signupUsers() {
  console.log(`storage signup run=${runId}`);
  for (const [role, email] of Object.entries(emails)) {
    const client = freshAnonClient();
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: { data: { confidel_storage_run_id: runId, role } },
    });
    if (error) throw new Error(`${role} signup failed: ${error.message}`);
    console.log(`SIGNUP ${role} user_id=${data.user?.id ?? "missing"}`);
  }
}

async function runTests() {
  console.log(`storage test run=${runId}`);

  const owner = await signIn("owner", emails.owner);
  const employee = await signIn("employee", emails.employee);
  const other = await signIn("other", emails.other);

  const companyId = await seedCompany(owner, [
    { user: employee, role: "employee", active: true },
    { user: other, role: "employee", active: true },
  ]);

  // client + job assigned to `employee` only; `other` is in the company but unassigned
  const client = await api("POST", "/api/clients", owner.token, { companyId, name: `Storage ${runId} Client` });
  expectStatus(client, 201);
  const job = await api("POST", "/api/jobs", owner.token, {
    companyId,
    clientId: client.body.client.id,
    title: `Storage ${runId} Job`,
    priceCents: 10000,
  });
  expectStatus(job, 201);
  const jobId = job.body.job.id;
  expectStatus(await api("POST", "/api/jobs/assign", owner.token, { jobId, employeeUserId: employee.user.id }), 201);

  const completion = await api("POST", "/api/jobs/complete", employee.token, {
    jobId,
    notes: `Storage ${runId} completion`,
    photoUrls: [],
  });
  expectStatus(completion, 201);
  const completionId = completion.body.completion.id;

  const path = `${companyId}/${jobId}/${completionId}/after_photo/${Date.now()}_test.txt`;
  const bytes = Buffer.from(`confidel storage test ${runId}`);

  let mediaId = null;

  await step("assigned employee can upload media + record metadata", async () => {
    const empStore = supabaseForToken(employee.token);
    const { error: upErr } = await empStore.storage.from(BUCKET).upload(path, bytes, {
      contentType: "text/plain",
      upsert: false,
    });
    assert(!upErr, `employee upload failed: ${upErr?.message}`);
    const rec = await api("POST", `/api/jobs/${jobId}/media`, employee.token, {
      completionId,
      mediaType: "after_photo",
      storagePath: path,
      mimeType: "text/plain",
      sizeBytes: bytes.length,
    });
    expectStatus(rec, 201);
    mediaId = rec.body.mediaId;
    assert(mediaId, "no mediaId returned");
    return summarize(rec, { mediaId });
  });

  await step("metadata API leaks no storage internals", async () => {
    const list = await api("GET", `/api/jobs/${jobId}/media`, owner.token);
    expectStatus(list, 200);
    const item = (list.body.media ?? [])[0];
    assert(item, "owner should see the media row");
    for (const forbidden of ["storage_path", "storage_bucket", "url", "signedUrl", "public_url"]) {
      assert(!(forbidden in item), `media metadata leaked '${forbidden}'`);
    }
    return summarize(list, { keys: Object.keys(item).sort() });
  });

  await step("owner/admin can get a signed (private) URL", async () => {
    const res = await api("POST", `/api/jobs/${jobId}/media/${mediaId}/signed-url`, owner.token);
    expectStatus(res, 200);
    const url = res.body.url ?? "";
    assert(url.includes("/sign/") && url.includes("token="), `expected a signed URL, got: ${url}`);
    return summarize(res, { signed: true });
  });

  await step("non-assigned employee cannot list this job's media", async () => {
    const res = await api("GET", `/api/jobs/${jobId}/media`, other.token);
    expectStatus(res, 200);
    assert((res.body.media?.length ?? 0) === 0, `unassigned employee saw ${res.body.media?.length} media rows`);
    return summarize(res, { rows: res.body.media?.length ?? 0 });
  });

  await step("non-assigned employee cannot sign this media", async () => {
    const res = await api("POST", `/api/jobs/${jobId}/media/${mediaId}/signed-url`, other.token);
    expectFailure(res);
    return summarize(res, res.body);
  });

  await step("non-assigned employee cannot upload to this job's path", async () => {
    const otherStore = supabaseForToken(other.token);
    const badPath = `${companyId}/${jobId}/${completionId}/other/${Date.now()}_intruder.txt`;
    const { error } = await otherStore.storage.from(BUCKET).upload(badPath, Buffer.from("nope"), {
      contentType: "text/plain",
    });
    assert(error, "storage RLS should have rejected unassigned upload");
    return summarize({ status: 403 }, { error: error.message });
  });

  await step("anon cannot access media API or download object", async () => {
    const apiRes = await api("GET", `/api/jobs/${jobId}/media`);
    expectStatus(apiRes, 401);
    const anonStore = freshAnonClient();
    const { data, error } = await anonStore.storage.from(BUCKET).download(path);
    assert(error || !data, "anon should not be able to download private object");
    return summarize({ status: 401 }, { anonDownloadBlocked: true });
  });

  console.log(`CLEANUP_LABEL run=${runId} company_id=${companyId} owner=${owner.user.id}`);
  console.log("storage media tests completed: PASS");
}

async function seedCompany(owner, members) {
  const ownerDb = supabaseForToken(owner.token);
  const { data: company, error } = await ownerDb
    .from("companies")
    .insert({ owner_user_id: owner.user.id, name: `Storage Test ${runId} Company` })
    .select("id")
    .single();
  if (error) throw new Error(`seed company failed: ${error.message}`);
  for (const m of members) {
    const { error: mErr } = await ownerDb.from("company_memberships").insert({
      company_id: company.id,
      user_id: m.user.user.id,
      role: m.role,
      full_name: `Storage ${runId} ${m.role}`,
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
