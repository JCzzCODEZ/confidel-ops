export type ApiOptions = {
  token?: string;
};

type JsonBody = Record<string, unknown>;

export type Role = "owner" | "admin" | "employee" | string;

export type Membership = {
  id: string;
  company_id: string;
  role: Role;
  full_name: string | null;
  email: string | null;
  is_active: boolean;
};

export type CompanyBranding = {
  id: string;
  name: string;
  logo_url: string | null;
};

export type SessionProfile = {
  user: {
    id: string;
    email: string | null;
  };
  memberships: Membership[];
  companies: CompanyBranding[];
};

export type ClientRecord = {
  id: string;
  company_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  billing_address: string | null;
  created_at: string;
  updated_at: string;
};

export type JobRecord = {
  id: string;
  company_id: string;
  client_id: string;
  title: string;
  description: string | null;
  status: string;
  scheduled_for: string | null;
  created_at?: string;
  updated_at?: string;
  assigned_at?: string;
  assignment_status?: string;
  client_name?: string;
};

export type AssignmentRecord = {
  id: string;
  company_id: string;
  job_id: string;
  employee_user_id: string;
  status: string;
  assigned_at: string;
};

export type CompletionRecord = {
  id: string;
  company_id?: string;
  job_id: string;
  employee_user_id?: string;
  status: string;
  submitted_at?: string;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  review_notes?: string | null;
};

export type EmployeeRecord = {
  id: string;
  name: string | null;
  email: string | null;
  role: Role;
  active: boolean;
};

export type OwnerCompletionRecord = {
  id: string;
  company_id: string;
  job_id: string;
  job_title: string | null;
  client_name: string | null;
  employee_user_id: string;
  employee_name: string | null;
  employee_email: string | null;
  status: string;
  submitted_at: string | null;
  notes: string | null;
};

export type InvoiceRecord = {
  id: string;
  company_id: string;
  client_id: string;
  job_id: string | null;
  amount_cents: number;
  status: string;
  due_date: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PaymentRecord = {
  id: string;
  company_id: string;
  invoice_id: string;
  amount_cents: number;
  paid_at: string | null;
  method: string | null;
  reference: string | null;
  created_at: string;
};

export async function getSessionProfile(options: ApiOptions = {}) {
  return apiGet<SessionProfile>("/api/session/profile", options);
}

export async function getCompanyBranding(options: ApiOptions = {}) {
  return apiGet<{ companies: CompanyBranding[] }>("/api/company/branding", options);
}

export async function getOwnerClients(companyId: string, options: ApiOptions = {}) {
  return apiGet<{ clients: ClientRecord[] }>(
    `/api/clients?companyId=${encodeURIComponent(companyId)}`,
    options,
  );
}

export async function createClient(input: JsonBody, options: ApiOptions = {}) {
  return apiPost<{ client: ClientRecord }>("/api/clients", input, options);
}

// Owner/admin only. Stores the alarm code encrypted at rest (pass null to clear).
export async function setAlarmCode(clientId: string, code: string | null, options: ApiOptions = {}) {
  return apiFetch<{ ok: true }>(
    `/api/clients/${encodeURIComponent(clientId)}/alarm-code`,
    { method: "PUT", body: JSON.stringify({ code }) },
    options,
  );
}

// Owner/admin only. Decrypts and returns the alarm code on demand; the reveal is
// audited server-side. Returns null when no code is stored.
export async function revealAlarmCode(clientId: string, options: ApiOptions = {}) {
  return apiPost<{ alarmCode: string | null }>(
    `/api/clients/${encodeURIComponent(clientId)}/reveal-alarm-code`,
    {},
    options,
  );
}

// ---- Phase C: job-completion media (private storage) ----------------------
export const JOB_MEDIA_BUCKET = "job-media";

export type JobMediaType = "before_photo" | "after_photo" | "signature" | "other";

export type JobMedia = {
  id: string;
  company_id: string;
  job_id: string;
  completion_id: string;
  uploaded_by: string;
  media_type: JobMediaType;
  mime_type: string | null;
  size_bytes: number | null;
  created_at: string;
};

// Builds the private-bucket object path the storage RLS policies expect:
//   {companyId}/{jobId}/{completionId}/{mediaType}/{ts_filename}
export function jobMediaStoragePath(input: {
  companyId: string;
  jobId: string;
  completionId: string;
  mediaType: JobMediaType;
  filename: string;
}) {
  const safe = input.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${input.companyId}/${input.jobId}/${input.completionId}/${input.mediaType}/${Date.now()}_${safe}`;
}

// Lists safe media metadata for a job (no storage paths / public URLs).
export async function listJobMedia(jobId: string, options: ApiOptions = {}) {
  return apiGet<{ media: JobMedia[] }>(`/api/jobs/${encodeURIComponent(jobId)}/media`, options);
}

// Records metadata for an object already uploaded to the private bucket.
export async function recordJobMedia(
  jobId: string,
  input: {
    completionId: string;
    mediaType: JobMediaType;
    storagePath: string;
    mimeType?: string | null;
    sizeBytes?: number | null;
  },
  options: ApiOptions = {},
) {
  return apiPost<{ mediaId: string | null }>(
    `/api/jobs/${encodeURIComponent(jobId)}/media`,
    input,
    options,
  );
}

// Returns a short-lived signed URL for one media object (never a public URL).
export async function getJobMediaSignedUrl(jobId: string, mediaId: string, options: ApiOptions = {}) {
  return apiPost<{ url: string; expiresIn: number }>(
    `/api/jobs/${encodeURIComponent(jobId)}/media/${encodeURIComponent(mediaId)}/signed-url`,
    {},
    options,
  );
}

// ---- Structured completion data (services / add-ons / expenses + timing) ---
export type CompletionExpenseType = "supplies" | "mileage" | "parking" | "tolls" | "other";

export type CompletionExpenseInput = {
  type: CompletionExpenseType;
  description?: string | null;
  amountCents?: number;
  quantity?: number | null;
  unit?: string | null;
};

export type RecordCompletionDetailsInput = {
  arrival?: string | null; // "HH:MM"
  start: string; // required
  end: string; // required
  breakMinutes?: number | null;
  completionStatus: "Completed" | "Partially Completed" | "Needs Follow-Up";
  services: string[];
  addons: string[];
  expenses: CompletionExpenseInput[];
};

export type CompletionExpenseRow = {
  id: string;
  expense_type: string;
  description: string | null;
  amount_cents: number;
  quantity: number | null;
  unit: string | null;
};

export type CompletionDetails = {
  completion: {
    id: string;
    job_id: string;
    status: string;
    submitted_at: string | null;
    notes: string | null;
    arrival_time: string | null;
    start_time: string | null;
    end_time: string | null;
    break_minutes: number | null;
    hours: number | null;
    completion_status: string | null;
  };
  services: string[];
  addons: string[];
  expenses: CompletionExpenseRow[];
};

// Employee enriches their completion with timing + structured services/add-ons/expenses.
export async function recordCompletionDetails(
  completionId: string,
  input: RecordCompletionDetailsInput,
  options: ApiOptions = {},
) {
  return apiPost<{ ok: true }>(
    `/api/completions/${encodeURIComponent(completionId)}/details`,
    input,
    options,
  );
}

// Owner/admin (or the assigned employee) reads the structured details. No pricing here.
export async function getCompletionDetails(completionId: string, options: ApiOptions = {}) {
  return apiGet<CompletionDetails>(
    `/api/completions/${encodeURIComponent(completionId)}/details`,
    options,
  );
}

// ---- Owner pricing / invoicing / tax records (owner/admin only) -----------
export type ServicePrice = {
  id: string;
  service_name: string;
  price_cents: number;
  taxable: boolean;
  active: boolean;
};
export type AddonPrice = {
  id: string;
  addon_name: string;
  price_cents: number;
  taxable: boolean;
  active: boolean;
};

export type InvoiceLineItem = {
  line_type: string;
  label: string;
  quantity: number;
  unit_amount_cents: number;
  amount_cents: number;
  taxable: boolean;
};
export type InvoiceDraft = {
  invoice_id: string;
  subtotal_cents: number;
  discount_cents: number;
  // Always populated by the (post-migration) RPC for a freshly generated draft.
  taxable_subtotal_cents: number;
  taxable_discount_cents: number;
  tax_rate_bps: number;
  tax_cents: number;
  total_cents: number;
  reimbursement_cents: number;
  employee_pay_cents: number;
  net_profit_cents: number;
  amount_paid_cents: number;
  balance_due_cents: number;
  payment_status: string;
  line_items: InvoiceLineItem[];
};

export type FinancialSummary = {
  id: string;
  job_id: string;
  completion_id: string;
  invoice_id: string | null;
  gross_revenue_cents: number;
  taxable_subtotal_cents: number;
  // Persisted tax inputs. NULL for legacy rows created before the numeric-rate
  // migration (calculation_version distinguishes them: NULL = legacy, 2 = new).
  tax_rate_bps: number | null;
  taxable_discount_cents: number | null;
  calculation_version: number | null;
  tax_cents: number;
  discount_cents: number;
  invoice_total_cents: number;
  employee_pay_cents: number;
  reimbursement_cents: number;
  supplies_cents: number;
  mileage_miles: number;
  mileage_reimbursement_cents: number;
  parking_cents: number;
  tolls_cents: number;
  other_expenses_cents: number;
  net_profit_cents: number;
  payment_status: string;
  amount_paid_cents: number;
  balance_due_cents: number;
};

export async function getServicePrices(companyId: string, options: ApiOptions = {}) {
  return apiGet<{ prices: ServicePrice[] }>(
    `/api/pricing/services?companyId=${encodeURIComponent(companyId)}`,
    options,
  );
}
export async function upsertServicePrice(input: JsonBody, options: ApiOptions = {}) {
  return apiPost<{ price: ServicePrice }>("/api/pricing/services", input, options);
}
export async function getAddonPrices(companyId: string, options: ApiOptions = {}) {
  return apiGet<{ prices: AddonPrice[] }>(
    `/api/pricing/addons?companyId=${encodeURIComponent(companyId)}`,
    options,
  );
}
export async function upsertAddonPrice(input: JsonBody, options: ApiOptions = {}) {
  return apiPost<{ price: AddonPrice }>("/api/pricing/addons", input, options);
}

export async function createInvoiceDraft(
  completionId: string,
  // taxRateBps is REQUIRED (numeric basis points, e.g. 662.5 = 6.625%). The
  // caller must always supply an explicit rate — the server never defaults it.
  input: { taxRateBps: number; discountCents?: number; dueDate?: string | null },
  options: ApiOptions = {},
) {
  return apiPost<{ draft: InvoiceDraft }>(
    `/api/completions/${encodeURIComponent(completionId)}/invoice-draft`,
    input,
    options,
  );
}

// The report route enriches each summary with context for the Records ledger.
export type FinancialRecord = FinancialSummary & {
  date: string | null;
  job_title: string | null;
  client_name: string | null;
  employee_name: string | null;
  services: string[];
  addons: string[];
  payment_method: string | null;
};

export async function getFinancialSummaries(companyId: string, options: ApiOptions = {}) {
  return apiGet<{ summaries: FinancialRecord[] }>(
    `/api/reports/financials?companyId=${encodeURIComponent(companyId)}`,
    options,
  );
}

// ---- Team / onboarding ----------------------------------------------------
export type TeamInvite = {
  id: string;
  email: string;
  full_name: string | null;
  role: "employee" | "admin";
  status: string;
  token: string;
  created_at: string;
  expires_at?: string | null;
  preferred_language?: "en" | "es";
};
export type TeamMemberStat = {
  user_id: string;
  assigned_jobs: number;
  completed_jobs: number;
  hours: number;
  reimbursement_cents: number;
  payroll_cents: number;
};

export type InviteSendResponse = {
  invite: TeamInvite;
  emailed: boolean;
  inviteUrl: string;
  note: string | null;
};

export async function inviteEmployee(
  input: {
    companyId: string;
    email: string;
    fullName?: string | null;
    role?: "employee" | "admin";
    language?: "en" | "es";
  },
  options: ApiOptions = {},
) {
  return apiPost<InviteSendResponse>("/api/team/invite", input, options);
}
export async function resendInvite(companyId: string, inviteId: string, options: ApiOptions = {}) {
  return apiPost<InviteSendResponse>("/api/team/invite/resend", { companyId, inviteId }, options);
}
export async function revokeInvite(companyId: string, inviteId: string, options: ApiOptions = {}) {
  return apiPost<{ ok: boolean }>("/api/team/invite/revoke", { companyId, inviteId }, options);
}
export async function getTeamInvites(companyId: string, options: ApiOptions = {}) {
  return apiGet<{ invites: TeamInvite[] }>(
    `/api/team/invites?companyId=${encodeURIComponent(companyId)}`,
    options,
  );
}
export async function setMembership(
  input: { companyId: string; userId: string; role?: "employee" | "admin" | null; isActive?: boolean | null },
  options: ApiOptions = {},
) {
  return apiPost<{ ok: true }>("/api/team/membership", input, options);
}
export async function acceptInvite(options: ApiOptions = {}, inviteToken?: string) {
  return apiPost<{ result: { accepted: boolean; company_id?: string; role?: string; reason?: string } }>(
    "/api/team/accept",
    inviteToken ? { token: inviteToken } : {},
    options,
  );
}
export async function getTeamStats(companyId: string, options: ApiOptions = {}) {
  return apiGet<{ stats: TeamMemberStat[] }>(
    `/api/team/stats?companyId=${encodeURIComponent(companyId)}`,
    options,
  );
}

export async function getOwnerJobs(companyId: string, options: ApiOptions = {}) {
  return apiGet<{ jobs: JobRecord[] }>(
    `/api/jobs?companyId=${encodeURIComponent(companyId)}`,
    options,
  );
}

export async function getOwnerEmployees(companyId: string, options: ApiOptions = {}) {
  return apiGet<{ employees: EmployeeRecord[] }>(
    `/api/employees?companyId=${encodeURIComponent(companyId)}`,
    options,
  );
}

export async function getOwnerCompletions(companyId: string, options: ApiOptions = {}) {
  return apiGet<{ completions: OwnerCompletionRecord[] }>(
    `/api/completions?companyId=${encodeURIComponent(companyId)}`,
    options,
  );
}

export async function createJob(input: JsonBody, options: ApiOptions = {}) {
  return apiPost<{ job: JobRecord }>("/api/jobs", input, options);
}

export async function assignJob(input: JsonBody, options: ApiOptions = {}) {
  return apiPost<{ assignment: AssignmentRecord }>("/api/jobs/assign", input, options);
}

export async function getEmployeeJobs(options: ApiOptions = {}) {
  return apiGet<{ jobs: JobRecord[] }>("/api/employee/jobs", options);
}

export async function submitCompletion(input: JsonBody, options: ApiOptions = {}) {
  return apiPost<{ completion: CompletionRecord }>("/api/jobs/complete", input, options);
}

export async function reviewJob(jobId: string, input: JsonBody, options: ApiOptions = {}) {
  return apiPost<{ completion: CompletionRecord }>(
    `/api/jobs/${encodeURIComponent(jobId)}/review`,
    input,
    options,
  );
}

export async function createInvoice(input: JsonBody, options: ApiOptions = {}) {
  return apiPost<{ invoice: InvoiceRecord }>("/api/invoices", input, options);
}

export async function getOwnerInvoices(companyId: string, options: ApiOptions = {}) {
  return apiGet<{ invoices: InvoiceRecord[] }>(
    `/api/invoices?companyId=${encodeURIComponent(companyId)}`,
    options,
  );
}

// Canonicalization shared by the API route AND the client idempotency
// fingerprint, so both compute the SAME method/reference and the server's
// fingerprint comparison is exact equality on canonical values.
export const PAYMENT_METHODS = ["manual", "cash", "check", "card", "ach", "transfer", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export function canonicalPaymentMethod(m: string | null | undefined): string {
  return (m ?? "").trim().toLowerCase();
}
export function isAllowedPaymentMethod(m: string): m is PaymentMethod {
  return (PAYMENT_METHODS as readonly string[]).includes(m);
}
export function canonicalPaymentReference(r: string | null | undefined): string | null {
  const v = (r ?? "").trim();
  return v === "" ? null : v;
}

export type PaymentResult = {
  payment: PaymentRecord | null;
  amount_paid_cents: number | null;
  balance_due_cents: number | null;
  payment_status: string | null;
  idempotent_replay: boolean;
};
export async function recordPayment(input: JsonBody, options: ApiOptions = {}) {
  return apiPost<PaymentResult>("/api/payments", input, options);
}

// Single source of truth for an invoice's live payment state, derived from the
// authoritative invoice total + sum of payments. Used by the Records/CSV report
// so it never trusts the (draft-time, can-go-stale) job_financial_summaries
// payment columns once an invoice has payments.
export type PaymentStatus = "paid" | "partial" | "unpaid";
export type DerivedPaymentState = {
  amount_paid_cents: number;
  balance_due_cents: number;
  payment_status: PaymentStatus;
};
export function derivePaymentState(
  invoiceTotalCents: number | null | undefined,
  amountPaidCents: number | null | undefined,
): DerivedPaymentState {
  const total = Math.max(invoiceTotalCents ?? 0, 0);
  const paid = Math.max(amountPaidCents ?? 0, 0);
  return {
    amount_paid_cents: paid,
    balance_due_cents: Math.max(total - paid, 0),
    payment_status: total > 0 && paid >= total ? "paid" : paid > 0 ? "partial" : "unpaid",
  };
}

async function apiGet<T>(path: string, options: ApiOptions) {
  return apiFetch<T>(path, { method: "GET" }, options);
}

async function apiPost<T>(path: string, body: JsonBody, options: ApiOptions) {
  return apiFetch<T>(
    path,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    options,
  );
}

async function apiFetch<T>(path: string, init: RequestInit, options: ApiOptions): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");

  if (init.body) {
    headers.set("Content-Type", "application/json");
  }

  if (options.token) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "include",
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String(payload.error)
        : `Request failed with ${response.status}`;

    throw new Error(message);
  }

  return payload as T;
}
