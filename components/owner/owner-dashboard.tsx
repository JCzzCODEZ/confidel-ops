"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  assignJob,
  ClientRecord,
  EmployeeRecord,
  createClient,
  createInvoice,
  createJob,
  getOwnerCompletions,
  getOwnerClients,
  getOwnerEmployees,
  getOwnerInvoices,
  getOwnerJobs,
  getCompletionDetails,
  getJobMediaSignedUrl,
  getServicePrices,
  getAddonPrices,
  getSessionProfile,
  AddonPrice,
  CompletionDetails,
  createInvoiceDraft,
  FinancialRecord,
  getFinancialSummaries,
  getTeamInvites,
  getTeamStats,
  inviteEmployee,
  InvoiceDraft,
  InvoiceRecord,
  setMembership,
  TeamInvite,
  TeamMemberStat,
  JobMedia,
  JobRecord,
  listJobMedia,
  OwnerCompletionRecord,
  recordPayment,
  reviewJob,
  ServicePrice,
  SessionProfile,
  upsertAddonPrice,
  upsertServicePrice,
} from "../../lib/confidel-api";
import {
  companyName,
  displayName,
  firstCompanyForRole,
  getApiOptions,
  hasEmployeeAccess,
  hasOwnerAccess,
  roleLabel,
  signOut,
} from "../../lib/auth";

type View = "clients" | "jobs" | "assign" | "review" | "billing" | "records" | "team";

const moneyToCents = (value: string) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
};

export function OwnerDashboard() {
  const router = useRouter();
  const [profile, setProfile] = useState<SessionProfile | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [employees, setEmployees] = useState<EmployeeRecord[]>([]);
  const [completions, setCompletions] = useState<OwnerCompletionRecord[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRecord[]>([]);
  const [view, setView] = useState<View>("clients");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastInvoice, setLastInvoice] = useState<InvoiceRecord | null>(null);

  const role = profile?.memberships.find((membership) => membership.company_id === companyId);
  const company = companyName(profile, companyId);

  const metrics = useMemo(
    () => [
      ["Clients", clients.length],
      ["Jobs", jobs.length],
      ["Open", jobs.filter((job) => job.status !== "completed").length],
      ["Reviews", completions.length],
      ["Invoices", invoices.length],
    ],
    [clients, completions, invoices, jobs],
  );

  async function refreshData(nextCompanyId = companyId) {
    if (!nextCompanyId) {
      return;
    }

    const options = await getApiOptions();

    if (!options) {
      router.replace("/");
      return;
    }

    const [clientResult, jobResult, employeeResult, completionResult, invoiceResult] = await Promise.all([
      getOwnerClients(nextCompanyId, options),
      getOwnerJobs(nextCompanyId, options),
      getOwnerEmployees(nextCompanyId, options),
      getOwnerCompletions(nextCompanyId, options),
      getOwnerInvoices(nextCompanyId, options),
    ]);

    setClients(clientResult.clients);
    setJobs(jobResult.jobs);
    setEmployees(employeeResult.employees);
    setCompletions(completionResult.completions);
    setInvoices(invoiceResult.invoices);
  }

  useEffect(() => {
    let active = true;

    // Timeout protection: never let the dashboard spin forever.
    const timeout = setTimeout(() => {
      if (active) {
        setError("Session check timed out. Please refresh or sign in again.");
        setLoading(false);
      }
    }, 8000);

    async function load() {
      try {
        const options = await getApiOptions();

        if (!active) {
          return;
        }

        // No session: this is a guard page, send to the login/entry screen.
        if (!options) {
          router.replace("/");
          return;
        }

        const nextProfile = await getSessionProfile(options);

        if (!active) {
          return;
        }

        // Guard only: wrong role is bounced to the right place, never re-routed
        // to this same page.
        if (!hasOwnerAccess(nextProfile)) {
          router.replace(hasEmployeeAccess(nextProfile) ? "/employee" : "/");
          return;
        }

        const nextCompanyId = firstCompanyForRole(nextProfile, ["owner", "admin"]);

        if (!nextCompanyId) {
          setError("No owner or admin company is available.");
          return;
        }

        setProfile(nextProfile);
        setCompanyId(nextCompanyId);
        const [clientResult, jobResult, employeeResult, completionResult, invoiceResult] = await Promise.all([
          getOwnerClients(nextCompanyId, options),
          getOwnerJobs(nextCompanyId, options),
          getOwnerEmployees(nextCompanyId, options),
          getOwnerCompletions(nextCompanyId, options),
          getOwnerInvoices(nextCompanyId, options),
        ]);

        if (!active) {
          return;
        }

        setClients(clientResult.clients);
        setJobs(jobResult.jobs);
        setEmployees(employeeResult.employees);
        setCompletions(completionResult.completions);
        setInvoices(invoiceResult.invoices);
      } catch (loadError) {
        if (!active) {
          return;
        }

        setError(loadError instanceof Error ? loadError.message : "Unable to load owner dashboard.");
        router.replace("/");
      } finally {
        if (active) {
          clearTimeout(timeout);
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [router]);

  async function withAction(action: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      const nextMessage = await action();
      setMessage(nextMessage);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    await signOut();
    router.replace("/");
  }

  if (loading) {
    return (
      <main className="screen">
        <div className="shell loading" data-testid="auth-loading">
          Loading owner dashboard
        </div>
      </main>
    );
  }

  return (
    <main className="screen">
      <div className="shell">
        <header className="topbar">
          <div className="brand-mark">
            <div className="brand-seal">
              <img
                src="/confidel-logo.png"
                alt="Confidel"
                style={{ width: "100%", height: "100%", objectFit: "contain", borderRadius: "50%" }}
              />
            </div>
            <div>
              <p className="brand-title">Confidel</p>
              <p className="brand-subtitle">{company}</p>
            </div>
          </div>
          <div className="button-row">
            <span className="status">{roleLabel(role)}</span>
            <button className="btn secondary" data-testid="owner-sign-out" onClick={handleLogout} type="button">
              Sign out
            </button>
          </div>
        </header>

        <section className="panel stack" data-testid="owner-dashboard">
          <div className="section-head">
            <div>
              <p className="eyebrow">Owner dashboard</p>
              <h2>{displayName(profile)}</h2>
              <p>{profile?.user.email}</p>
            </div>
          </div>

          <div className="metrics">
            {metrics.map(([label, value]) => (
              <div className="metric" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>

          {message ? <div className="notice success">{message}</div> : null}
          {error ? (
            <div className="notice error" data-testid="auth-error">
              {error}
            </div>
          ) : null}

          <div className="tabs">
            {(["clients", "jobs", "assign", "review", "billing", "records", "team"] as View[]).map((item) => (
              <button
                className={`tab ${view === item ? "active" : ""}`}
                data-testid={`owner-tab-${item}`}
                key={item}
                onClick={() => setView(item)}
                type="button"
              >
                {item === "assign" ? "Assign" : item === "review" ? "Review" : item}
              </button>
            ))}
          </div>

          {view === "clients" ? (
            <ClientsPanel
              busy={busy}
              clients={clients}
              companyId={companyId}
              onCreate={(form) =>
                withAction(async () => {
                  const options = await requireOptions();
                  const result = await createClient(form, options);
                  await refreshData();
                  return `Client created: ${result.client.name}`;
                })
              }
            />
          ) : null}

          {view === "jobs" ? (
            <JobsPanel
              busy={busy}
              clients={clients}
              companyId={companyId}
              jobs={jobs}
              onCreate={(form) =>
                withAction(async () => {
                  const options = await requireOptions();
                  const result = await createJob(form, options);
                  await refreshData();
                  return `Job created: ${result.job.title}`;
                })
              }
            />
          ) : null}

          {view === "assign" ? (
            <AssignPanel
              busy={busy}
              employees={employees}
              jobs={jobs}
              onAssign={(form) =>
                withAction(async () => {
                  const options = await requireOptions();
                  const result = await assignJob(form, options);
                  await refreshData();
                  return `Assigned job ${result.assignment.job_id}`;
                })
              }
            />
          ) : null}

          {view === "review" ? (
            <ReviewPanel
              busy={busy}
              completions={completions}
              onReview={(jobId, form) =>
                withAction(async () => {
                  const options = await requireOptions();
                  const result = await reviewJob(jobId, form, options);
                  await refreshData();
                  return `Completion ${result.completion.status}`;
                })
              }
              onLoadMedia={loadJobMediaList}
              onPreviewMedia={openMediaPreview}
              onLoadDetails={loadCompletionDetails}
              onReload={async () => {
                await refreshData();
              }}
              companyId={companyId}
              onLoadPrices={loadCompanyPrices}
              onSavePrice={saveCompanyPrice}
              onGenerateDraft={generateInvoiceDraft}
              onRecordPayment={recordDraftPayment}
            />
          ) : null}

          {view === "billing" ? (
            <BillingPanel
              busy={busy}
              clients={clients}
              companyId={companyId}
              invoices={invoices}
              jobs={jobs}
              lastInvoice={lastInvoice}
              onInvoice={(form) =>
                withAction(async () => {
                  const options = await requireOptions();
                  const result = await createInvoice(form, options);
                  setLastInvoice(result.invoice);
                  setInvoices((current) => [
                    result.invoice,
                    ...current.filter((invoice) => invoice.id !== result.invoice.id),
                  ]);
                  return `Invoice created: ${result.invoice.id}`;
                })
              }
              onPayment={(form) =>
                withAction(async () => {
                  const options = await requireOptions();
                  const result = await recordPayment(form, options);
                  await refreshData();
                  return `Payment recorded: ${result.payment.id}`;
                })
              }
            />
          ) : null}

          {view === "records" ? (
            <RecordsPanel companyId={companyId} onLoadRecords={loadFinancialRecords} />
          ) : null}

          {view === "team" ? (
            <TeamPanel
              companyId={companyId}
              onLoadTeam={loadTeam}
              onInvite={sendTeamInvite}
              onUpdateMembership={updateTeamMembership}
            />
          ) : null}
        </section>
      </div>
    </main>
  );
}

async function requireOptions() {
  const options = await getApiOptions();

  if (!options) {
    throw new Error("Please sign in again.");
  }

  return options;
}

// Owner-side media helpers. Metadata only (no storage paths); previews open a
// short-lived signed URL, never a public one.
async function loadJobMediaList(jobId: string) {
  const options = await requireOptions();
  const result = await listJobMedia(jobId, options);
  return result.media;
}

async function openMediaPreview(jobId: string, mediaId: string) {
  const options = await requireOptions();
  const result = await getJobMediaSignedUrl(jobId, mediaId, options);
  if (result.url) {
    window.open(result.url, "_blank", "noopener,noreferrer");
  }
}

async function loadCompletionDetails(completionId: string) {
  const options = await requireOptions();
  return getCompletionDetails(completionId, options);
}

// ---- Owner pricing / invoice-draft helpers (owner/admin only) -------------
async function loadCompanyPrices(companyId: string) {
  const options = await requireOptions();
  const [services, addons] = await Promise.all([
    getServicePrices(companyId, options),
    getAddonPrices(companyId, options),
  ]);
  return { services: services.prices, addons: addons.prices };
}

async function saveCompanyPrice(
  kind: "service" | "addon",
  input: { companyId: string; name: string; priceCents: number; taxable: boolean },
) {
  const options = await requireOptions();
  if (kind === "service") {
    await upsertServicePrice(
      { companyId: input.companyId, serviceName: input.name, priceCents: input.priceCents, taxable: input.taxable },
      options,
    );
  } else {
    await upsertAddonPrice(
      { companyId: input.companyId, addonName: input.name, priceCents: input.priceCents, taxable: input.taxable },
      options,
    );
  }
}

async function generateInvoiceDraft(completionId: string, opts: { taxRateBps: number; discountCents: number }) {
  const options = await requireOptions();
  const result = await createInvoiceDraft(completionId, opts, options);
  return result.draft;
}

async function recordDraftPayment(invoiceId: string, amountCents: number) {
  const options = await requireOptions();
  await recordPayment(
    { invoiceId, amountCents, paidAt: new Date().toISOString(), method: "manual" },
    options,
  );
}

async function loadFinancialRecords(companyId: string) {
  const options = await requireOptions();
  const result = await getFinancialSummaries(companyId, options);
  return result.summaries;
}

// ---- Team / onboarding helpers (owner/admin only) -------------------------
async function loadTeam(companyId: string) {
  const options = await requireOptions();
  const [employees, invites, stats] = await Promise.all([
    getOwnerEmployees(companyId, options),
    getTeamInvites(companyId, options),
    getTeamStats(companyId, options),
  ]);
  return { employees: employees.employees, invites: invites.invites, stats: stats.stats };
}

async function sendTeamInvite(input: {
  companyId: string;
  email: string;
  fullName?: string | null;
  role?: "employee" | "admin";
}) {
  const options = await requireOptions();
  return inviteEmployee(input, options);
}

async function updateTeamMembership(input: {
  companyId: string;
  userId: string;
  role?: "employee" | "admin" | null;
  isActive?: boolean | null;
}) {
  const options = await requireOptions();
  await setMembership(input, options);
}

function ClientsPanel({
  busy,
  clients,
  companyId,
  onCreate,
}: {
  busy: boolean;
  clients: ClientRecord[];
  companyId: string | null;
  onCreate: (form: Record<string, unknown>) => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);

    onCreate({
      companyId,
      name: String(data.get("name") ?? ""),
      email: stringOrNull(data.get("email")),
      phone: stringOrNull(data.get("phone")),
      billingAddress: stringOrNull(data.get("billingAddress")),
      taxId: stringOrNull(data.get("taxId")),
      adminNotes: stringOrNull(data.get("adminNotes")),
    });
    form.reset();
  }

  return (
    <div className="dashboard-grid">
      <section className="stack">
        <div className="section-head">
          <div>
            <h3>Client list</h3>
            <p>{clients.length} active record{clients.length === 1 ? "" : "s"}</p>
          </div>
        </div>
        <div className="list" data-testid="owner-client-list">
          {clients.length ? (
            clients.map((client) => (
              <article className="card" key={client.id}>
                <div className="card-row">
                  <div>
                    <h3>{client.name}</h3>
                    <p className="muted small">{client.email || "No email"} · {client.phone || "No phone"}</p>
                    <p className="muted small">{client.billing_address || "No billing address"}</p>
                  </div>
                  <span className="status">Client</span>
                </div>
              </article>
            ))
          ) : (
            <div className="empty">No clients yet.</div>
          )}
        </div>
      </section>

      <section>
        <div className="section-head">
          <div>
            <h3>Create client</h3>
            <p>Owner/admin record</p>
          </div>
        </div>
        <form className="form-grid" onSubmit={submit}>
          <label className="wide">
            Name
            <input data-testid="client-name" name="name" required />
          </label>
          <label>
            Email
            <input data-testid="client-email" name="email" type="email" />
          </label>
          <label>
            Phone
            <input name="phone" />
          </label>
          <label className="wide">
            Billing address
            <input name="billingAddress" />
          </label>
          <label>
            Tax ID
            <input name="taxId" />
          </label>
          <label>
            Admin notes
            <input name="adminNotes" />
          </label>
          <button className="btn gold wide" data-testid="create-client" disabled={busy} type="submit">
            Create client
          </button>
        </form>
      </section>
    </div>
  );
}

function JobsPanel({
  busy,
  clients,
  companyId,
  jobs,
  onCreate,
}: {
  busy: boolean;
  clients: ClientRecord[];
  companyId: string | null;
  jobs: JobRecord[];
  onCreate: (form: Record<string, unknown>) => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const priceCents = moneyToCents(String(data.get("price") ?? ""));
    const payrollCents = moneyToCents(String(data.get("payroll") ?? ""));

    onCreate({
      companyId,
      clientId: String(data.get("clientId") ?? ""),
      title: String(data.get("title") ?? ""),
      description: stringOrNull(data.get("description")),
      scheduledFor: stringOrNull(data.get("scheduledFor")),
      priceCents,
      payrollCents,
      adminNotes: stringOrNull(data.get("adminNotes")),
    });
    form.reset();
  }

  return (
    <div className="dashboard-grid">
      <section className="stack">
        <div className="section-head">
          <div>
            <h3>Job list</h3>
            <p>{jobs.length} job{jobs.length === 1 ? "" : "s"}</p>
          </div>
        </div>
        <div className="list" data-testid="owner-job-list">
          {jobs.length ? (
            jobs.map((job) => (
              <article className="card" key={job.id}>
                <div className="card-row">
                  <div>
                    <h3>{job.title}</h3>
                    <p className="muted small">{job.description || "No description"}</p>
                    <p className="muted small">{job.scheduled_for ? formatDate(job.scheduled_for) : "Unscheduled"}</p>
                  </div>
                  <span className="status">{job.status}</span>
                </div>
              </article>
            ))
          ) : (
            <div className="empty">No jobs yet.</div>
          )}
        </div>
      </section>

      <section>
        <div className="section-head">
          <div>
            <h3>Create job</h3>
            <p>Pricing stays in owner workflow</p>
          </div>
        </div>
        <form className="form-grid" onSubmit={submit}>
          <label className="wide">
            Client
            <select data-testid="job-client" name="clientId" required>
              <option value="">Select client</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </label>
          <label className="wide">
            Title
            <input data-testid="job-title" name="title" required />
          </label>
          <label className="wide">
            Description
            <textarea name="description" />
          </label>
          <label>
            Scheduled
            <input name="scheduledFor" type="datetime-local" />
          </label>
          <label>
            Price
            <input data-testid="job-price" min="0" name="price" step="0.01" type="number" />
          </label>
          <label>
            Payroll
            <input min="0" name="payroll" step="0.01" type="number" />
          </label>
          <label>
            Admin notes
            <input name="adminNotes" />
          </label>
          <button className="btn gold wide" data-testid="create-job" disabled={busy} type="submit">
            Create job
          </button>
        </form>
      </section>
    </div>
  );
}

function AssignPanel({
  busy,
  employees,
  jobs,
  onAssign,
}: {
  busy: boolean;
  employees: EmployeeRecord[];
  jobs: JobRecord[];
  onAssign: (form: Record<string, unknown>) => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onAssign({
      jobId: String(data.get("jobId") ?? ""),
      employeeUserId: String(data.get("employeeUserId") ?? ""),
    });
  }

  return (
    <section className="stack">
      <div className="section-head">
        <div>
          <h3>Assign job</h3>
          <p>{employees.length} employee{employees.length === 1 ? "" : "s"} available</p>
        </div>
      </div>
      <form className="form-grid" onSubmit={submit}>
        <label className="wide">
          Job
          <select data-testid="assign-job" name="jobId" required>
            <option value="">Select job</option>
            {jobs.map((job) => (
              <option key={job.id} value={job.id}>
                {job.title}
              </option>
            ))}
          </select>
        </label>
        <label className="wide">
          Employee
          <select data-testid="assign-employee" name="employeeUserId" required>
            <option value="">Select employee</option>
            {employees.map((employee) => (
              <option disabled={!employee.active} key={employee.id} value={employee.id}>
                {employee.name || employee.email || employee.id}
                {employee.active ? "" : " (inactive)"}
              </option>
            ))}
          </select>
        </label>
        <button className="btn gold wide" data-testid="assign-submit" disabled={busy} type="submit">
          Assign job
        </button>
      </form>
      {!employees.length ? <div className="empty">No employees found for this company.</div> : null}
    </section>
  );
}

function ReviewPanel({
  busy,
  completions,
  onReview,
  onLoadMedia,
  onPreviewMedia,
  onLoadDetails,
  onReload,
  companyId,
  onLoadPrices,
  onSavePrice,
  onGenerateDraft,
  onRecordPayment,
}: {
  busy: boolean;
  completions: OwnerCompletionRecord[];
  onReview: (jobId: string, form: Record<string, unknown>) => void;
  onLoadMedia: (jobId: string) => Promise<JobMedia[]>;
  onPreviewMedia: (jobId: string, mediaId: string) => Promise<void>;
  onLoadDetails: (completionId: string) => Promise<CompletionDetails>;
  onReload: () => Promise<void>;
  companyId: string | null;
  onLoadPrices: (companyId: string) => Promise<{ services: ServicePrice[]; addons: AddonPrice[] }>;
  onSavePrice: (
    kind: "service" | "addon",
    input: { companyId: string; name: string; priceCents: number; taxable: boolean },
  ) => Promise<void>;
  onGenerateDraft: (completionId: string, opts: { taxRateBps: number; discountCents: number }) => Promise<InvoiceDraft>;
  onRecordPayment: (invoiceId: string, amountCents: number) => Promise<void>;
}) {
  const [mediaByCompletion, setMediaByCompletion] = useState<Record<string, JobMedia[]>>({});
  const [mediaBusy, setMediaBusy] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [detailsByCompletion, setDetailsByCompletion] = useState<Record<string, CompletionDetails>>({});
  const [detailsBusy, setDetailsBusy] = useState<string | null>(null);
  const [selectedCompletionId, setSelectedCompletionId] = useState("");
  const [reloadBusy, setReloadBusy] = useState(false);

  async function loadDetails(completionId: string) {
    setDetailsBusy(completionId);
    setMediaError(null);
    try {
      const details = await onLoadDetails(completionId);
      setDetailsByCompletion((current) => ({ ...current, [completionId]: details }));
    } catch (error) {
      setMediaError(error instanceof Error ? error.message : "Unable to load completion details.");
    } finally {
      setDetailsBusy(null);
    }
  }

  async function loadMedia(completionId: string, jobId: string) {
    setMediaBusy(completionId);
    setMediaError(null);
    try {
      const items = await onLoadMedia(jobId);
      setMediaByCompletion((current) => ({ ...current, [completionId]: items }));
    } catch (error) {
      setMediaError(error instanceof Error ? error.message : "Unable to load attachments.");
    } finally {
      setMediaBusy(null);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const completionId = String(data.get("completionId") ?? "");
    const completion = completions.find((item) => item.id === completionId);

    if (!completion) {
      return;
    }

    onReview(completion.job_id, {
      completionId,
      decision: String(data.get("decision") ?? ""),
      reviewNotes: stringOrNull(data.get("reviewNotes")),
    });
  }

  return (
    <section className="stack">
      <div className="section-head">
        <div>
          <h3>Review queue</h3>
          <p>{completions.length} submitted completion{completions.length === 1 ? "" : "s"} waiting</p>
        </div>
        <div className="button-row">
          <button
            className="btn secondary"
            type="button"
            data-testid="review-reload"
            disabled={reloadBusy}
            onClick={async () => {
              setReloadBusy(true);
              try {
                await onReload();
              } finally {
                setReloadBusy(false);
              }
            }}
          >
            {reloadBusy ? "Reloading…" : "Reload review queue"}
          </button>
        </div>
      </div>
      <PricingEditor companyId={companyId} onLoadPrices={onLoadPrices} onSavePrice={onSavePrice} />
      {mediaError ? <div className="notice error">{mediaError}</div> : null}
      <div className="list" data-testid="completion-queue">
        {completions.length ? (
          completions.map((completion) => {
            const media = mediaByCompletion[completion.id];
            return (
              <article className="card" key={completion.id}>
                <div className="card-row">
                  <div>
                    <h3>{completion.job_title || completion.job_id}</h3>
                    <p className="muted small">
                      {completion.client_name || "No client"} · {completion.employee_name || "Employee"}
                    </p>
                    <p className="muted small">
                      {completion.submitted_at ? formatDate(completion.submitted_at) : "Submitted"} ·{" "}
                      {completion.notes || "No notes"}
                    </p>
                  </div>
                  <span className="status">{completion.status}</span>
                </div>
                <div className="button-row">
                  <button
                    className="btn secondary"
                    data-testid={`review-load-details-${completion.id}`}
                    disabled={detailsBusy === completion.id}
                    onClick={() => loadDetails(completion.id)}
                    type="button"
                  >
                    {detailsBusy === completion.id ? "Loading…" : "View details"}
                  </button>
                  <button
                    className="btn secondary"
                    data-testid={`review-load-media-${completion.id}`}
                    disabled={mediaBusy === completion.id}
                    onClick={() => loadMedia(completion.id, completion.job_id)}
                    type="button"
                  >
                    {mediaBusy === completion.id ? "Loading…" : "View attachments"}
                  </button>
                </div>
                {detailsByCompletion[completion.id] ? (
                  <div className="stack" data-testid={`review-details-${completion.id}`} style={{ marginTop: "8px" }}>
                    {(() => {
                      const d = detailsByCompletion[completion.id];
                      return (
                        <>
                          <p className="muted small">
                            Status: {d.completion.completion_status || "—"} · Hours: {d.completion.hours ?? "—"} ·{" "}
                            {d.completion.start_time || "—"}–{d.completion.end_time || "—"}
                            {d.completion.break_minutes ? ` · break ${d.completion.break_minutes}m` : ""}
                          </p>
                          <p className="muted small">
                            <strong>Services:</strong> {d.services.length ? d.services.join(", ") : "None"}
                          </p>
                          <p className="muted small">
                            <strong>Add-ons:</strong> {d.addons.length ? d.addons.join(", ") : "None"}
                          </p>
                          <p className="muted small">
                            <strong>Expenses:</strong>{" "}
                            {d.expenses.length
                              ? d.expenses
                                  .map((e) =>
                                    e.expense_type === "mileage"
                                      ? `mileage ${e.quantity ?? 0} ${e.unit || "miles"}`
                                      : `${e.expense_type} $${(e.amount_cents / 100).toFixed(2)}${e.description ? ` (${e.description})` : ""}`,
                                  )
                                  .join("; ")
                              : "None"}
                          </p>
                        </>
                      );
                    })()}
                  </div>
                ) : null}
                {media ? (
                  <div className="list" data-testid={`review-media-${completion.id}`}>
                    {media.length ? (
                      media.map((item) => (
                        <div className="card-row" key={item.id}>
                          <p className="muted small">
                            {item.media_type} · {item.mime_type || "file"}
                            {item.size_bytes ? ` · ${Math.round(item.size_bytes / 1024)} KB` : ""}
                          </p>
                          <button
                            className="btn secondary"
                            data-testid={`review-preview-${item.id}`}
                            onClick={() => onPreviewMedia(completion.job_id, item.id)}
                            type="button"
                          >
                            Preview
                          </button>
                        </div>
                      ))
                    ) : (
                      <div className="empty">No attachments.</div>
                    )}
                  </div>
                ) : null}
                <CompletionPricing
                  completion={completion}
                  onGenerateDraft={onGenerateDraft}
                  onRecordPayment={onRecordPayment}
                />
              </article>
            );
          })
        ) : (
          <div className="empty">No submitted completions are waiting for review.</div>
        )}
      </div>
      {completions.length ? (
        <form className="form-grid" onSubmit={submit}>
          <label className="wide">
            Completion
            <select
              data-testid="review-completion"
              name="completionId"
              required
              value={selectedCompletionId}
              onChange={(event) => setSelectedCompletionId(event.target.value)}
            >
              <option value="">Select submitted completion</option>
              {completions.map((completion) => (
                <option key={completion.id} value={completion.id}>
                  {(completion.job_title || completion.job_id) + " · " + (completion.employee_name || "Employee")}
                </option>
              ))}
            </select>
          </label>
          <label>
            Decision
            <select data-testid="review-decision" name="decision" required>
              <option value="approve">Approve</option>
              <option value="reject">Reject</option>
            </select>
          </label>
          <label>
            Review notes
            <input name="reviewNotes" />
          </label>
          <button
            className="btn gold wide"
            data-testid="review-submit"
            disabled={busy || !selectedCompletionId}
            type="submit"
          >
            Save review
          </button>
        </form>
      ) : (
        <div className="empty" data-testid="review-empty">
          No submitted completions are waiting for review. Submitted jobs from employees appear here.
        </div>
      )}
    </section>
  );
}

function usd(cents: number | null | undefined) {
  return `$${((cents ?? 0) / 100).toFixed(2)}`;
}

// Company-level service / add-on price editor (owner/admin only).
function PricingEditor({
  companyId,
  onLoadPrices,
  onSavePrice,
}: {
  companyId: string | null;
  onLoadPrices: (companyId: string) => Promise<{ services: ServicePrice[]; addons: AddonPrice[] }>;
  onSavePrice: (
    kind: "service" | "addon",
    input: { companyId: string; name: string; priceCents: number; taxable: boolean },
  ) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [services, setServices] = useState<ServicePrice[]>([]);
  const [addons, setAddons] = useState<AddonPrice[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    if (!companyId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onLoadPrices(companyId);
      setServices(result.services);
      setAddons(result.addons);
      setOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load prices.");
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!companyId) return;
    // Capture the form before any await — currentTarget can be null afterward.
    const form = event.currentTarget;
    const data = new FormData(form);
    const kind = String(data.get("kind") ?? "service") === "addon" ? "addon" : "service";
    const name = String(data.get("name") ?? "").trim();
    const priceCents = moneyToCents(String(data.get("price") ?? "")) ?? 0;
    if (!name) {
      setError("Enter a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSavePrice(kind, { companyId, name, priceCents, taxable: data.get("taxable") === "on" });
      form.reset();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save price.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="stack" data-testid="pricing-editor">
      <div className="button-row">
        <button className="btn secondary" type="button" disabled={busy} onClick={reload}>
          {open ? "Reload prices" : "Manage prices"}
        </button>
      </div>
      {error ? <div className="notice error">{error}</div> : null}
      {open ? (
        <>
          <div className="list">
            {[...services.map((s) => ({ name: s.service_name, price: s.price_cents, taxable: s.taxable, k: "service" }))]
              .concat(addons.map((a) => ({ name: a.addon_name, price: a.price_cents, taxable: a.taxable, k: "addon" })))
              .map((row) => (
                <p className="muted small" key={`${row.k}-${row.name}`}>
                  {row.k}: {row.name} — {usd(row.price)} {row.taxable ? "(taxable)" : "(no tax)"}
                </p>
              ))}
          </div>
          <form className="form-grid" onSubmit={save}>
            <label>
              Type
              <select name="kind" data-testid="price-kind">
                <option value="service">Service</option>
                <option value="addon">Add-on</option>
              </select>
            </label>
            <label>
              Name
              <input name="name" data-testid="price-name" placeholder="e.g. Deep Cleaning" />
            </label>
            <label>
              Price ($)
              <input name="price" data-testid="price-amount" type="number" min="0" step="0.01" />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <input name="taxable" type="checkbox" defaultChecked data-testid="price-taxable" />
              Taxable
            </label>
            <button className="btn gold" type="submit" data-testid="price-save" disabled={busy}>
              Save price
            </button>
          </form>
        </>
      ) : null}
    </section>
  );
}

// Per-completion pricing: generate an invoice draft, view line items + totals,
// record a payment. All owner/admin only.
function CompletionPricing({
  completion,
  onGenerateDraft,
  onRecordPayment,
}: {
  completion: OwnerCompletionRecord;
  onGenerateDraft: (completionId: string, opts: { taxRateBps: number; discountCents: number }) => Promise<InvoiceDraft>;
  onRecordPayment: (invoiceId: string, amountCents: number) => Promise<void>;
}) {
  const [taxPct, setTaxPct] = useState("0");
  const [discount, setDiscount] = useState("0");
  const [payment, setPayment] = useState("");
  const [draft, setDraft] = useState<InvoiceDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function opts() {
    return {
      taxRateBps: Math.round((Number(taxPct) || 0) * 100),
      discountCents: Math.round((Number(discount) || 0) * 100),
    };
  }

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      setDraft(await onGenerateDraft(completion.id, opts()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to generate draft.");
    } finally {
      setBusy(false);
    }
  }

  async function pay() {
    if (!draft) return;
    const cents = Math.round((Number(payment) || 0) * 100);
    if (cents <= 0) {
      setError("Enter a payment amount.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onRecordPayment(draft.invoice_id, cents);
      setDraft(await onGenerateDraft(completion.id, opts())); // refresh paid/balance
      setPayment("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to record payment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" data-testid={`review-pricing-${completion.id}`} style={{ marginTop: "8px" }}>
      <div className="form-grid">
        <label>
          Tax rate (%)
          <input type="number" min="0" step="0.001" value={taxPct} onChange={(e) => setTaxPct(e.target.value)} data-testid={`pricing-tax-${completion.id}`} />
        </label>
        <label>
          Discount ($)
          <input type="number" min="0" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} data-testid={`pricing-discount-${completion.id}`} />
        </label>
        <button className="btn gold" type="button" disabled={busy} onClick={generate} data-testid={`pricing-generate-${completion.id}`}>
          {busy ? "Working…" : "Generate invoice draft"}
        </button>
      </div>
      {error ? <div className="notice error">{error}</div> : null}
      {draft ? (
        <div className="stack" data-testid={`pricing-draft-${completion.id}`}>
          <div className="list">
            {draft.line_items.map((line, index) => (
              <p className="muted small" key={index}>
                {line.line_type}: {line.label} — {usd(line.amount_cents)}
                {line.taxable ? " (taxable)" : ""}
              </p>
            ))}
          </div>
          <div className="metrics">
            {(
              [
                ["Subtotal", draft.subtotal_cents],
                ["Discount", -draft.discount_cents],
                ["Tax", draft.tax_cents],
                ["Total", draft.total_cents],
                ["Reimbursements", draft.reimbursement_cents],
                ["Employee pay", draft.employee_pay_cents],
                ["Net profit", draft.net_profit_cents],
                ["Amount paid", draft.amount_paid_cents],
                ["Balance due", draft.balance_due_cents],
              ] as [string, number][]
            ).map(([label, value]) => (
              <div className="metric" key={label}>
                <span>{label}</span>
                <strong>{usd(value)}</strong>
              </div>
            ))}
          </div>
          <p className="muted small">Payment status: {draft.payment_status}</p>
          <div className="form-grid">
            <label>
              Record payment ($)
              <input type="number" min="0" step="0.01" value={payment} onChange={(e) => setPayment(e.target.value)} data-testid={`pricing-payment-${completion.id}`} />
            </label>
            <button className="btn secondary" type="button" disabled={busy} onClick={pay} data-testid={`pricing-pay-${completion.id}`}>
              Record payment
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---- Records / monthly tax ledger (owner/admin only) ----------------------
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const RECORD_SUM_FIELDS = [
  ["gross_revenue_cents", "Gross revenue"],
  ["tax_cents", "Sales tax collected"],
  ["invoice_total_cents", "Invoice totals"],
  ["amount_paid_cents", "Amount paid"],
  ["balance_due_cents", "Outstanding balance"],
  ["employee_pay_cents", "Employee payroll"],
  ["reimbursement_cents", "Reimbursements"],
  ["supplies_cents", "Supplies"],
  ["mileage_reimbursement_cents", "Mileage reimbursement"],
  ["parking_cents", "Parking"],
  ["tolls_cents", "Tolls"],
  ["other_expenses_cents", "Other expenses"],
  ["net_profit_cents", "Net profit"],
] as const;

function recordYear(record: FinancialRecord): number | null {
  if (!record.date) return null;
  const parsed = new Date(record.date);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getFullYear();
}
function recordMonth(record: FinancialRecord): number | null {
  if (!record.date) return null;
  const parsed = new Date(record.date);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getMonth();
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function RecordsPanel({
  companyId,
  onLoadRecords,
}: {
  companyId: string | null;
  onLoadRecords: (companyId: string) => Promise<FinancialRecord[]>;
}) {
  const [records, setRecords] = useState<FinancialRecord[]>([]);
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [month, setMonth] = useState<number | "all">("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  async function load() {
    if (!companyId) return;
    setBusy(true);
    setError(null);
    try {
      setRecords(await onLoadRecords(companyId));
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load records.");
    } finally {
      setBusy(false);
    }
  }

  const years = useMemo(() => {
    const set = new Set<number>();
    records.forEach((r) => {
      const y = recordYear(r);
      if (y != null) set.add(y);
    });
    set.add(new Date().getFullYear());
    return Array.from(set).sort((a, b) => b - a);
  }, [records]);

  const filtered = useMemo(
    () =>
      records.filter((r) => recordYear(r) === year && (month === "all" || recordMonth(r) === month)),
    [records, year, month],
  );

  const totals = useMemo(() => {
    const acc: Record<string, number> = {};
    for (const [field] of RECORD_SUM_FIELDS) acc[field] = 0;
    let miles = 0;
    let paidInvoices = 0;
    let openInvoices = 0;
    for (const r of filtered) {
      for (const [field] of RECORD_SUM_FIELDS) acc[field] += Number((r as Record<string, unknown>)[field] ?? 0);
      miles += Number(r.mileage_miles ?? 0);
      if (r.payment_status === "paid") paidInvoices += 1;
      else openInvoices += 1;
    }
    return { acc, miles, paidInvoices, openInvoices, jobs: filtered.length };
  }, [filtered]);

  function exportCsv() {
    const header = [
      "job_date", "client", "job_title", "invoice_id", "invoice_total", "amount_paid", "balance_due",
      "payment_status", "payment_method", "sales_tax", "services", "add_ons", "supplies",
      "mileage_miles", "mileage_reimbursement", "parking", "tolls", "other_expenses", "payroll",
      "reimbursements", "net_profit",
    ];
    const lines = filtered.map((r) =>
      [
        r.date ? new Date(r.date).toISOString().slice(0, 10) : "",
        r.client_name ?? "",
        r.job_title ?? "",
        r.invoice_id ?? "",
        (r.invoice_total_cents / 100).toFixed(2),
        (r.amount_paid_cents / 100).toFixed(2),
        (r.balance_due_cents / 100).toFixed(2),
        r.payment_status,
        r.payment_method ?? "",
        (r.tax_cents / 100).toFixed(2),
        r.services.join(" | "),
        r.addons.join(" | "),
        (r.supplies_cents / 100).toFixed(2),
        r.mileage_miles,
        (r.mileage_reimbursement_cents / 100).toFixed(2),
        (r.parking_cents / 100).toFixed(2),
        (r.tolls_cents / 100).toFixed(2),
        (r.other_expenses_cents / 100).toFixed(2),
        (r.employee_pay_cents / 100).toFixed(2),
        (r.reimbursement_cents / 100).toFixed(2),
        (r.net_profit_cents / 100).toFixed(2),
      ]
        .map(csvCell)
        .join(","),
    );
    const csv = [header.join(","), ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `confidel-records-${year}${month === "all" ? "" : `-${String(month + 1).padStart(2, "0")}`}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="stack" data-testid="records-panel">
      <div className="section-head">
        <div>
          <h3>Records</h3>
          <p>Monthly tax ledger — completed / invoiced jobs</p>
        </div>
        <div className="button-row">
          <button className="btn secondary" type="button" disabled={busy} onClick={load} data-testid="records-load">
            {busy ? "Loading…" : loaded ? "Reload" : "Load records"}
          </button>
        </div>
      </div>

      {error ? <div className="notice error">{error}</div> : null}

      {loaded ? (
        <>
          <div className="form-grid">
            <label>
              Year
              <select value={year} onChange={(e) => setYear(Number(e.target.value))} data-testid="records-year">
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Month
              <select
                value={month === "all" ? "all" : String(month)}
                onChange={(e) => setMonth(e.target.value === "all" ? "all" : Number(e.target.value))}
                data-testid="records-month"
              >
                <option value="all">All months</option>
                {MONTH_NAMES.map((name, index) => (
                  <option key={name} value={index}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn gold" type="button" onClick={exportCsv} data-testid="records-export" disabled={!filtered.length}>
              Export CSV
            </button>
          </div>

          <div className="metrics" data-testid="records-totals">
            {RECORD_SUM_FIELDS.map(([field, label]) => (
              <div className="metric" key={field}>
                <span>{label}</span>
                <strong>{usd(totals.acc[field])}</strong>
              </div>
            ))}
            <div className="metric">
              <span>Mileage miles</span>
              <strong>{totals.miles}</strong>
            </div>
            <div className="metric">
              <span>Jobs</span>
              <strong>{totals.jobs}</strong>
            </div>
            <div className="metric">
              <span>Paid invoices</span>
              <strong>{totals.paidInvoices}</strong>
            </div>
            <div className="metric">
              <span>Unpaid / partial</span>
              <strong>{totals.openInvoices}</strong>
            </div>
          </div>

          <div className="list" data-testid="records-rows" style={{ overflowX: "auto" }}>
            {filtered.length ? (
              filtered.map((r) => (
                <article className="card" key={r.id}>
                  <div className="card-row">
                    <div>
                      <h3>{r.job_title || r.job_id}</h3>
                      <p className="muted small">
                        {r.date ? new Date(r.date).toLocaleDateString() : "—"} · {r.client_name || "No client"} ·{" "}
                        {r.employee_name || "Employee"}
                      </p>
                      <p className="muted small">
                        Services: {r.services.length ? r.services.join(", ") : "None"} · Add-ons:{" "}
                        {r.addons.length ? r.addons.join(", ") : "None"}
                      </p>
                      <p className="muted small">
                        Total {usd(r.invoice_total_cents)} · Paid {usd(r.amount_paid_cents)} · Balance{" "}
                        {usd(r.balance_due_cents)} · Tax {usd(r.tax_cents)} · Payroll {usd(r.employee_pay_cents)} ·
                        Reimb {usd(r.reimbursement_cents)} · Net {usd(r.net_profit_cents)}
                        {r.payment_method ? ` · ${r.payment_method}` : ""}
                      </p>
                    </div>
                    <span className="status">{r.payment_status}</span>
                  </div>
                </article>
              ))
            ) : (
              <div className="empty">
                {records.length === 0
                  ? "No records yet. Generate an invoice draft from a reviewed completion first (Review tab → a submitted completion → Generate invoice draft)."
                  : "No records for this period."}
              </div>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}

// ---- Team / employee onboarding + management (owner/admin only) -----------
function TeamPanel({
  companyId,
  onLoadTeam,
  onInvite,
  onUpdateMembership,
}: {
  companyId: string | null;
  onLoadTeam: (
    companyId: string,
  ) => Promise<{ employees: EmployeeRecord[]; invites: TeamInvite[]; stats: TeamMemberStat[] }>;
  onInvite: (input: {
    companyId: string;
    email: string;
    fullName?: string | null;
    role?: "employee" | "admin";
  }) => Promise<{ invite: TeamInvite; inviteUrl: string }>;
  onUpdateMembership: (input: {
    companyId: string;
    userId: string;
    role?: "employee" | "admin" | null;
    isActive?: boolean | null;
  }) => Promise<void>;
}) {
  const [employees, setEmployees] = useState<EmployeeRecord[]>([]);
  const [invites, setInvites] = useState<TeamInvite[]>([]);
  const [stats, setStats] = useState<Record<string, TeamMemberStat>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  async function load() {
    if (!companyId) return;
    setBusy(true);
    setError(null);
    try {
      const team = await onLoadTeam(companyId);
      setEmployees(team.employees);
      setInvites(team.invites);
      setStats(Object.fromEntries(team.stats.map((s) => [s.user_id, s])));
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load team.");
    } finally {
      setBusy(false);
    }
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!companyId) return;
    // Capture the form before any await — currentTarget can be null afterward.
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();
    if (!email) {
      setError("Enter an email address.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await onInvite({
        companyId,
        email,
        fullName: String(data.get("fullName") ?? "").trim() || null,
        role: data.get("role") === "admin" ? "admin" : "employee",
      });
      setInviteUrl(result.inviteUrl);
      setMessage(`Invite created for ${email}. They sign up with this email, then log in.`);
      form.reset();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create invite.");
    } finally {
      setBusy(false);
    }
  }

  async function update(userId: string, patch: { role?: "employee" | "admin"; isActive?: boolean }) {
    if (!companyId) return;
    setBusy(true);
    setError(null);
    try {
      await onUpdateMembership({ companyId, userId, ...patch });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update member.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="stack" data-testid="team-panel">
      <div className="section-head">
        <div>
          <h3>Team</h3>
          <p>Invite, activate, and manage employees & admins</p>
        </div>
        <div className="button-row">
          <button className="btn secondary" type="button" disabled={busy} onClick={load} data-testid="team-load">
            {busy ? "Loading…" : loaded ? "Reload" : "Load team"}
          </button>
        </div>
      </div>

      {error ? <div className="notice error">{error}</div> : null}
      {message ? <div className="notice success">{message}</div> : null}
      {inviteUrl ? (
        <div className="notice" data-testid="team-invite-url">
          Invite link (share with the employee): {inviteUrl}
        </div>
      ) : null}

      <form className="form-grid" onSubmit={invite}>
        <label>
          Email
          <input name="email" type="email" data-testid="team-invite-email" required />
        </label>
        <label>
          Full name
          <input name="fullName" data-testid="team-invite-name" />
        </label>
        <label>
          Role
          <select name="role" data-testid="team-invite-role">
            <option value="employee">Employee</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <button className="btn gold" type="submit" data-testid="team-invite-submit" disabled={busy}>
          Invite
        </button>
      </form>

      {loaded ? (
        <>
          <div className="list" data-testid="team-list">
            {employees.length ? (
              employees.map((emp) => {
                const stat = stats[emp.id];
                return (
                  <article className="card" key={emp.id}>
                    <div className="card-row">
                      <div>
                        <h3>{emp.name || emp.email || "Member"}</h3>
                        <p className="muted small">
                          {emp.email || "no email"} · {String(emp.role)} ·{" "}
                          {emp.active ? "active" : "inactive"}
                        </p>
                        {stat ? (
                          <p className="muted small">
                            Assigned {stat.assigned_jobs} · Completed {stat.completed_jobs} · Hours{" "}
                            {stat.hours ?? 0} · Reimb {usd(stat.reimbursement_cents)} · Payroll{" "}
                            {usd(stat.payroll_cents)}
                          </p>
                        ) : null}
                      </div>
                      <span className="status">{emp.active ? "Active" : "Inactive"}</span>
                    </div>
                    <div className="button-row">
                      {emp.active ? (
                        <button
                          className="btn secondary"
                          type="button"
                          disabled={busy}
                          data-testid={`team-deactivate-${emp.id}`}
                          onClick={() => update(emp.id, { isActive: false })}
                        >
                          Deactivate
                        </button>
                      ) : (
                        <button
                          className="btn secondary"
                          type="button"
                          disabled={busy}
                          data-testid={`team-reactivate-${emp.id}`}
                          onClick={() => update(emp.id, { isActive: true })}
                        >
                          Reactivate
                        </button>
                      )}
                      {String(emp.role) === "admin" ? (
                        <button
                          className="btn secondary"
                          type="button"
                          disabled={busy}
                          data-testid={`team-demote-${emp.id}`}
                          onClick={() => update(emp.id, { role: "employee" })}
                        >
                          Make employee
                        </button>
                      ) : (
                        <button
                          className="btn secondary"
                          type="button"
                          disabled={busy}
                          data-testid={`team-promote-${emp.id}`}
                          onClick={() => update(emp.id, { role: "admin" })}
                        >
                          Make admin
                        </button>
                      )}
                    </div>
                  </article>
                );
              })
            ) : (
              <div className="empty">No team members yet.</div>
            )}
          </div>

          {invites.length ? (
            <div className="stack" data-testid="team-invites">
              <h3>Pending invites</h3>
              {invites.map((inv) => (
                <p className="muted small" key={inv.id}>
                  {inv.email} · {inv.role} · {inv.status}
                </p>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function BillingPanel({
  busy,
  clients,
  companyId,
  invoices,
  jobs,
  lastInvoice,
  onInvoice,
  onPayment,
}: {
  busy: boolean;
  clients: ClientRecord[];
  companyId: string | null;
  invoices: InvoiceRecord[];
  jobs: JobRecord[];
  lastInvoice: InvoiceRecord | null;
  onInvoice: (form: Record<string, unknown>) => void;
  onPayment: (form: Record<string, unknown>) => void;
}) {
  const invoiceOptions = lastInvoice
    ? [lastInvoice, ...invoices.filter((invoice) => invoice.id !== lastInvoice.id)]
    : invoices;

  function submitInvoice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const amountCents = moneyToCents(String(data.get("amount") ?? ""));

    onInvoice({
      companyId,
      clientId: String(data.get("clientId") ?? ""),
      jobId: stringOrNull(data.get("jobId")),
      amountCents,
      dueDate: stringOrNull(data.get("dueDate")),
      notes: stringOrNull(data.get("notes")),
    });
  }

  function submitPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const amountCents = moneyToCents(String(data.get("amount") ?? ""));

    onPayment({
      invoiceId: String(data.get("invoiceId") ?? ""),
      amountCents,
      paidAt: stringOrNull(data.get("paidAt")) ?? new Date().toISOString(),
      method: stringOrNull(data.get("method")),
      reference: stringOrNull(data.get("reference")),
    });
  }

  return (
    <div className="dashboard-grid">
      <section>
        <div className="section-head">
          <div>
            <h3>Create invoice</h3>
            <p>{lastInvoice ? `Last invoice ${lastInvoice.id}` : "No invoice created this session"}</p>
          </div>
        </div>
        <form className="form-grid" onSubmit={submitInvoice}>
          <label>
            Client
            <select data-testid="invoice-client" name="clientId" required>
              <option value="">Select client</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Job
            <select name="jobId">
              <option value="">No job</option>
              {jobs.map((job) => (
                <option key={job.id} value={job.id}>
                  {job.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Amount
            <input data-testid="invoice-amount" min="0" name="amount" required step="0.01" type="number" />
          </label>
          <label>
            Due date
            <input name="dueDate" type="date" />
          </label>
          <label className="wide">
            Notes
            <input name="notes" />
          </label>
          <button className="btn gold wide" data-testid="invoice-submit" disabled={busy} type="submit">
            Create invoice
          </button>
        </form>
      </section>

      <section>
        <div className="section-head">
          <div>
            <h3>Record payment</h3>
            <p>{invoiceOptions.length} invoice{invoiceOptions.length === 1 ? "" : "s"} available</p>
          </div>
        </div>
        <form className="form-grid" onSubmit={submitPayment}>
          <label className="wide">
            Invoice
            <select
              data-testid="payment-invoice"
              defaultValue={lastInvoice?.id ?? ""}
              key={lastInvoice?.id ?? "empty-invoice"}
              name="invoiceId"
              required
            >
              <option value="">Select invoice</option>
              {invoiceOptions.map((invoice) => (
                <option key={invoice.id} value={invoice.id}>
                  {formatMoney(invoice.amount_cents)} · {invoice.status} ·{" "}
                  {invoice.job_id ? jobTitle(jobs, invoice.job_id) : clientName(clients, invoice.client_id)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Amount
            <input data-testid="payment-amount" min="0" name="amount" required step="0.01" type="number" />
          </label>
          <label>
            Paid at
            <input name="paidAt" type="datetime-local" />
          </label>
          <label>
            Method
            <input name="method" />
          </label>
          <label>
            Reference
            <input name="reference" />
          </label>
          <button className="btn gold wide" data-testid="payment-submit" disabled={busy} type="submit">
            Record payment
          </button>
        </form>
      </section>
    </div>
  );
}

function stringOrNull(value: FormDataEntryValue | null) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length ? text : null;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatMoney(cents: number) {
  return new Intl.NumberFormat("en", {
    currency: "USD",
    style: "currency",
  }).format(cents / 100);
}

function clientName(clients: ClientRecord[], clientId: string) {
  return clients.find((client) => client.id === clientId)?.name ?? "Client";
}

function jobTitle(jobs: JobRecord[], jobId: string) {
  return jobs.find((job) => job.id === jobId)?.title ?? "Job";
}
