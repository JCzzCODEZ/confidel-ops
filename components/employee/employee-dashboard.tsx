"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useRouter } from "next/navigation";
import {
  ApiOptions,
  CompletionExpenseInput,
  getEmployeeJobs,
  getSessionProfile,
  JobMediaType,
  JOB_MEDIA_BUCKET,
  jobMediaStoragePath,
  JobRecord,
  recordCompletionDetails,
  recordJobMedia,
  SessionProfile,
  submitCompletion,
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
import { createSupabaseBrowserClient } from "../../lib/supabase/client";

const SERVICE_OPTIONS = [
  "Standard Cleaning",
  "Deep Cleaning",
  "Move-In / Move-Out Cleaning",
  "Airbnb Turnover",
  "House Sitting",
  "Pet Care",
  "Plant Care",
  "Laundry",
  "Organization",
  "Mobile Detailing",
  "Interior Detailing",
  "Exterior Detailing",
  "Other",
];

const ADDON_OPTIONS = [
  "Inside Fridge",
  "Inside Oven",
  "Interior Windows",
  "Baseboards",
  "Blinds",
  "Deep Bathroom Detail",
  "Deep Kitchen Detail",
  "Extra Bedroom",
  "Extra Bathroom",
  "Laundry",
  "Dishes",
  "Trash Removal",
  "Garage",
  "Patio",
  "Pet Cleanup",
  "Other Add-On",
];

// A job is only submittable while it's active work assigned to this employee.
const FINISHED_STATUSES = ["approved", "rejected", "completed", "cancelled", "paid", "submitted"];

const checkGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
  gap: "8px",
  margin: "8px 0",
};
const checkItemStyle: CSSProperties = { display: "flex", alignItems: "center", gap: "8px" };

export function EmployeeDashboard() {
  const router = useRouter();
  const [profile, setProfile] = useState<SessionProfile | null>(null);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [completionId, setCompletionId] = useState<string | null>(null);

  // Completion form state
  const [services, setServices] = useState<string[]>([]);
  const [addOns, setAddOns] = useState<string[]>([]);
  const [otherServiceNotes, setOtherServiceNotes] = useState("");
  const [otherAddonNotes, setOtherAddonNotes] = useState("");
  const [employeeNotes, setEmployeeNotes] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);

  // Timing + status
  const [arrival, setArrival] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [breakMinutes, setBreakMinutes] = useState("");
  const [completionStatus, setCompletionStatus] = useState<
    "Completed" | "Partially Completed" | "Needs Follow-Up"
  >("Completed");

  // Itemized expenses / reimbursements
  const [suppliesDesc, setSuppliesDesc] = useState("");
  const [suppliesCost, setSuppliesCost] = useState("");
  const [mileage, setMileage] = useState("");
  const [parking, setParking] = useState("");
  const [tolls, setTolls] = useState("");
  const [otherExpenseDesc, setOtherExpenseDesc] = useState("");
  const [otherExpenseCost, setOtherExpenseCost] = useState("");

  const beforeRef = useRef<HTMLInputElement | null>(null);
  const afterRef = useRef<HTMLInputElement | null>(null);
  const otherRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);

  const companyId = profile ? firstCompanyForRole(profile, ["employee"]) : null;
  const company = companyName(profile, companyId);
  const role = profile?.memberships.find((membership) => membership.company_id === companyId);
  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedJobId) ?? jobs[0] ?? null,
    [jobs, selectedJobId],
  );

  const submittable =
    Boolean(selectedJob) &&
    !FINISHED_STATUSES.includes(String(selectedJob?.status ?? "")) &&
    selectedJob?.assignment_status !== "cancelled";

  useEffect(() => {
    let active = true;
    const timeout = setTimeout(() => {
      if (active) {
        setError("Session check timed out. Please refresh or sign in again.");
        setLoading(false);
      }
    }, 8000);

    async function load() {
      try {
        const options = await getApiOptions();
        if (!active) return;
        if (!options) {
          router.replace("/");
          return;
        }

        const nextProfile = await getSessionProfile(options);
        if (!active) return;

        if (hasOwnerAccess(nextProfile)) {
          router.replace("/owner");
          return;
        }
        if (!hasEmployeeAccess(nextProfile)) {
          router.replace("/");
          return;
        }

        const jobResult = await getEmployeeJobs(options);
        if (!active) return;

        setProfile(nextProfile);
        setJobs(jobResult.jobs);
        setSelectedJobId(jobResult.jobs[0]?.id ?? null);
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Unable to load employee dashboard.");
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

  async function refreshJobs() {
    const options = await getApiOptions();
    if (!options) {
      router.replace("/");
      return;
    }
    const result = await getEmployeeJobs(options);
    setJobs(result.jobs);
    setSelectedJobId((current) => current ?? result.jobs[0]?.id ?? null);
  }

  async function handleLogout() {
    await signOut();
    router.replace("/");
  }

  // ---- signature pad ----
  function signaturePoint(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
  }
  function onSignDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(event.pointerId);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawingRef.current = true;
    const point = signaturePoint(event);
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
  }
  function onSignMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const point = signaturePoint(event);
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#111111";
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
    if (!hasSignature) setHasSignature(true);
  }
  function onSignUp() {
    drawingRef.current = false;
  }
  function clearSignature() {
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
    setHasSignature(false);
  }

  function resetForm() {
    setServices([]);
    setAddOns([]);
    setOtherServiceNotes("");
    setOtherAddonNotes("");
    setEmployeeNotes("");
    setConfirmed(false);
    clearSignature();
    setArrival("");
    setStartTime("");
    setEndTime("");
    setBreakMinutes("");
    setCompletionStatus("Completed");
    setSuppliesDesc("");
    setSuppliesCost("");
    setMileage("");
    setParking("");
    setTolls("");
    setOtherExpenseDesc("");
    setOtherExpenseCost("");
    [beforeRef, afterRef, otherRef].forEach((ref) => {
      if (ref.current) ref.current.value = "";
    });
  }

  function buildExpenses(): CompletionExpenseInput[] {
    const items: CompletionExpenseInput[] = [];
    const supplies = dollarsToCents(suppliesCost);
    if (supplies > 0 || suppliesDesc.trim()) {
      items.push({ type: "supplies", description: suppliesDesc.trim() || null, amountCents: supplies });
    }
    const miles = Number(mileage);
    if (mileage && Number.isFinite(miles) && miles > 0) {
      items.push({ type: "mileage", quantity: miles, unit: "miles", amountCents: 0 });
    }
    const park = dollarsToCents(parking);
    if (park > 0) {
      items.push({ type: "parking", amountCents: park });
    }
    const toll = dollarsToCents(tolls);
    if (toll > 0) {
      items.push({ type: "tolls", amountCents: toll });
    }
    const otherCost = dollarsToCents(otherExpenseCost);
    if (otherCost > 0 || otherExpenseDesc.trim()) {
      items.push({ type: "other", description: otherExpenseDesc.trim() || null, amountCents: otherCost });
    }
    return items;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setError(null);
    setCompletionId(null);

    if (!selectedJob) {
      setError("Select a job before submitting.");
      setBusy(false);
      return;
    }

    const beforeFiles = filesFromRef(beforeRef);
    const afterFiles = filesFromRef(afterRef);
    const otherFiles = filesFromRef(otherRef);

    // Clear, specific validation messages (not just a disabled button).
    if (!services.length) {
      setError("Select at least one service completed.");
      setBusy(false);
      return;
    }
    if (!beforeFiles.length) {
      setError("Add at least one before photo.");
      setBusy(false);
      return;
    }
    if (!afterFiles.length) {
      setError("Add at least one after photo.");
      setBusy(false);
      return;
    }
    if (!hasSignature) {
      setError("Please sign in the signature box before submitting.");
      setBusy(false);
      return;
    }
    if (!confirmed) {
      setError("Please check the confirmation box before submitting.");
      setBusy(false);
      return;
    }
    if (!startTime || !endTime) {
      setError("Enter the start and end time for this job.");
      setBusy(false);
      return;
    }

    let signatureFile: File;
    try {
      signatureFile = await signatureToFile(canvasRef.current);
    } catch {
      setError("Could not capture the signature. Please sign again.");
      setBusy(false);
      return;
    }

    try {
      const options = await getApiOptions();
      if (!options) {
        router.replace("/");
        return;
      }

      const result = await submitCompletion(
        {
          jobId: selectedJob.id,
          notes: employeeNotes.trim(), // employee notes only — never service/pricing data
          photoUrls: [],
        },
        options,
      );
      // The base completion row now exists and is in the owner's review queue.
      // Everything below is best-effort enrichment — a failure here must NOT hide
      // the submission; it becomes a warning instead.
      setCompletionId(result.completion.id);
      const warnings: string[] = [];

      try {
        await recordCompletionDetails(
          result.completion.id,
          {
            arrival: arrival || null,
            start: startTime,
            end: endTime,
            breakMinutes: breakMinutes ? Number(breakMinutes) : null,
            completionStatus,
            services: [...services, ...(otherServiceNotes.trim() ? [`Other: ${otherServiceNotes.trim()}`] : [])],
            addons: [...addOns, ...(otherAddonNotes.trim() ? [`Other: ${otherAddonNotes.trim()}`] : [])],
            expenses: buildExpenses(),
          },
          options,
        );
      } catch {
        warnings.push("service/expense details didn't save — the owner can still review, and you can resubmit");
      }

      if (selectedJob.company_id) {
        try {
          const groups = (
            [
              { mediaType: "before_photo", files: beforeFiles },
              { mediaType: "after_photo", files: afterFiles },
              { mediaType: "signature", files: [signatureFile] },
              { mediaType: "other", files: otherFiles },
            ] as { mediaType: JobMediaType; files: File[] }[]
          ).filter((group) => group.files.length > 0);
          if (groups.length) {
            setMessage("Submitted for owner review. Uploading attachments…");
            await uploadCompletionMedia({
              companyId: selectedJob.company_id,
              jobId: selectedJob.id,
              completionId: result.completion.id,
              groups,
              options,
              onProgress: (msg) => setMessage(`Submitted for owner review. ${msg}`),
            });
          }
        } catch {
          warnings.push("some attachments didn't upload — the owner can still review");
        }
      } else {
        warnings.push("attachments weren't linked (missing company)");
      }

      setMessage(
        warnings.length
          ? `Submitted for owner review. Note: ${warnings.join("; ")}.`
          : "Submitted for owner review.",
      );
      resetForm();
      await refreshJobs();
    } catch (submitError) {
      // Only reached if the base completion submit itself failed.
      const raw = submitError instanceof Error ? submitError.message : "Completion failed.";
      setError(friendlyCompletionError(raw));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <main className="screen">
        <div className="shell loading" data-testid="auth-loading">
          Loading employee dashboard
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
            <button className="btn secondary" data-testid="employee-sign-out" onClick={handleLogout} type="button">
              Sign out
            </button>
          </div>
        </header>

        <section className="panel stack" data-testid="employee-dashboard">
          <div className="section-head">
            <div>
              <p className="eyebrow">Employee dashboard</p>
              <h2>{displayName(profile)}</h2>
              <p>{profile?.user.email}</p>
            </div>
          </div>

          {message ? <div className="notice success">{message}</div> : null}
          {error ? (
            <div className="notice error" data-testid="auth-error">
              {error}
            </div>
          ) : null}
          {completionId ? (
            <div className="notice" data-testid="completion-confirmation">
              Completion ID: {completionId}
            </div>
          ) : null}

          <div className="dashboard-grid">
            <section className="stack">
              <div className="section-head">
                <div>
                  <h3>Assigned jobs</h3>
                  <p>{jobs.length} visible assignment{jobs.length === 1 ? "" : "s"}</p>
                </div>
              </div>
              <div className="list" data-testid="employee-job-list">
                {jobs.length ? (
                  jobs.map((job) => (
                    <button
                      className={`card ${selectedJob?.id === job.id ? "selected" : ""}`}
                      data-testid={`employee-job-${job.id}`}
                      key={job.id}
                      onClick={() => setSelectedJobId(job.id)}
                      type="button"
                    >
                      <div className="card-row">
                        <div>
                          <h3>{job.title}</h3>
                          <p className="muted small">{job.client_name || "Client"}</p>
                          <p className="muted small">
                            {job.scheduled_for ? formatDate(job.scheduled_for) : "Unscheduled"}
                          </p>
                        </div>
                        <span className="status">{job.assignment_status ?? job.status}</span>
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="empty">No assigned jobs.</div>
                )}
              </div>
            </section>

            <section className="job-detail">
              {selectedJob ? (
                <>
                  <article className="card" data-testid="employee-job-detail">
                    <div className="card-row">
                      <div>
                        <h3>{selectedJob.title}</h3>
                        <p className="muted small">{selectedJob.description || "No description"}</p>
                        <p className="muted small">{selectedJob.client_name || "Client"}</p>
                      </div>
                      <span className="status">{selectedJob.status}</span>
                    </div>
                  </article>

                  {submittable ? (
                    <form className="form-grid" onSubmit={handleSubmit}>
                      <fieldset className="wide" style={{ border: 0, padding: 0, margin: 0 }}>
                        <legend>Job timing</legend>
                        <div style={checkGridStyle}>
                          <label>
                            Arrival
                            <input type="time" data-testid="completion-arrival" value={arrival} onChange={(e) => setArrival(e.target.value)} />
                          </label>
                          <label>
                            Start (required)
                            <input type="time" data-testid="completion-start" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
                          </label>
                          <label>
                            End (required)
                            <input type="time" data-testid="completion-end" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
                          </label>
                          <label>
                            Break (min)
                            <input type="number" min="0" data-testid="completion-break" value={breakMinutes} onChange={(e) => setBreakMinutes(e.target.value)} />
                          </label>
                          <label>
                            Job status
                            <select
                              data-testid="completion-status"
                              value={completionStatus}
                              onChange={(e) => setCompletionStatus(e.target.value as typeof completionStatus)}
                            >
                              <option>Completed</option>
                              <option>Partially Completed</option>
                              <option>Needs Follow-Up</option>
                            </select>
                          </label>
                        </div>
                      </fieldset>

                      <fieldset className="wide" style={{ border: 0, padding: 0, margin: 0 }}>
                        <legend>Services completed (select all that apply)</legend>
                        <div data-testid="completion-services" style={checkGridStyle}>
                          {SERVICE_OPTIONS.map((option) => (
                            <label key={option} style={checkItemStyle}>
                              <input
                                type="checkbox"
                                data-testid={`service-${slug(option)}`}
                                checked={services.includes(option)}
                                onChange={() => setServices((current) => toggleItem(current, option))}
                              />
                              <span>{option}</span>
                            </label>
                          ))}
                        </div>
                        <input
                          className="wide"
                          data-testid="completion-other-services"
                          placeholder="Other service notes"
                          value={otherServiceNotes}
                          onChange={(event) => setOtherServiceNotes(event.target.value)}
                        />
                      </fieldset>

                      <fieldset className="wide" style={{ border: 0, padding: 0, margin: 0 }}>
                        <legend>Add-ons completed</legend>
                        <div data-testid="completion-addons" style={checkGridStyle}>
                          {ADDON_OPTIONS.map((option) => (
                            <label key={option} style={checkItemStyle}>
                              <input
                                type="checkbox"
                                data-testid={`addon-${slug(option)}`}
                                checked={addOns.includes(option)}
                                onChange={() => setAddOns((current) => toggleItem(current, option))}
                              />
                              <span>{option}</span>
                            </label>
                          ))}
                        </div>
                        <input
                          className="wide"
                          data-testid="completion-other-addons"
                          placeholder="Other add-on notes"
                          value={otherAddonNotes}
                          onChange={(event) => setOtherAddonNotes(event.target.value)}
                        />
                      </fieldset>

                      <fieldset className="wide" style={{ border: 0, padding: 0, margin: 0 }}>
                        <legend>Expenses / reimbursements (itemized, optional)</legend>
                        <div style={checkGridStyle}>
                          <label>
                            Supplies (description)
                            <input data-testid="expense-supplies-desc" value={suppliesDesc} onChange={(e) => setSuppliesDesc(e.target.value)} />
                          </label>
                          <label>
                            Supplies cost ($)
                            <input type="number" min="0" step="0.01" data-testid="expense-supplies-cost" value={suppliesCost} onChange={(e) => setSuppliesCost(e.target.value)} />
                          </label>
                          <label>
                            Mileage (miles)
                            <input type="number" min="0" step="0.1" data-testid="expense-mileage" value={mileage} onChange={(e) => setMileage(e.target.value)} />
                          </label>
                          <label>
                            Parking ($)
                            <input type="number" min="0" step="0.01" data-testid="expense-parking" value={parking} onChange={(e) => setParking(e.target.value)} />
                          </label>
                          <label>
                            Tolls ($)
                            <input type="number" min="0" step="0.01" data-testid="expense-tolls" value={tolls} onChange={(e) => setTolls(e.target.value)} />
                          </label>
                          <label>
                            Other (description)
                            <input data-testid="expense-other-desc" value={otherExpenseDesc} onChange={(e) => setOtherExpenseDesc(e.target.value)} />
                          </label>
                          <label>
                            Other cost ($)
                            <input type="number" min="0" step="0.01" data-testid="expense-other-cost" value={otherExpenseCost} onChange={(e) => setOtherExpenseCost(e.target.value)} />
                          </label>
                        </div>
                      </fieldset>

                      <label className="wide">
                        Employee Notes / Issues / Follow-Up Needed
                        <textarea
                          data-testid="completion-notes"
                          value={employeeNotes}
                          onChange={(event) => setEmployeeNotes(event.target.value)}
                        />
                      </label>

                      <label className="wide">
                        Before photos (required)
                        <input ref={beforeRef} data-testid="completion-before" type="file" accept="image/*" multiple />
                      </label>
                      <label className="wide">
                        After photos (required)
                        <input ref={afterRef} data-testid="completion-after" type="file" accept="image/*" multiple />
                      </label>

                      <div className="wide">
                        <p className="muted small">Signature (required) — sign below</p>
                        <canvas
                          ref={canvasRef}
                          width={600}
                          height={180}
                          data-testid="completion-signature-pad"
                          style={{
                            width: "100%",
                            maxWidth: "100%",
                            height: "180px",
                            border: "1px solid #d4af37",
                            borderRadius: "8px",
                            background: "#ffffff",
                            touchAction: "none",
                            display: "block",
                          }}
                          onPointerDown={onSignDown}
                          onPointerMove={onSignMove}
                          onPointerUp={onSignUp}
                          onPointerLeave={onSignUp}
                        />
                        <button
                          type="button"
                          className="btn secondary"
                          data-testid="completion-signature-clear"
                          onClick={clearSignature}
                          style={{ marginTop: "8px" }}
                        >
                          Clear signature
                        </button>
                      </div>

                      <label className="wide">
                        Other attachments / damage / insurance (optional)
                        <input ref={otherRef} data-testid="completion-other" type="file" multiple />
                      </label>

                      <label className="wide" style={checkItemStyle}>
                        <input
                          type="checkbox"
                          data-testid="completion-confirm"
                          checked={confirmed}
                          onChange={(event) => setConfirmed(event.target.checked)}
                        />
                        <span>I confirm this report is accurate and complete.</span>
                      </label>

                      <p className="muted small">
                        Photos and signature upload to private storage. Links are never public.
                      </p>

                      <button
                        className="btn gold wide"
                        data-testid="completion-submit"
                        disabled={busy}
                        type="submit"
                      >
                        {busy ? "Submitting…" : "Submit completion"}
                      </button>
                    </form>
                  ) : (
                    <article className="card" data-testid="employee-job-readonly">
                      <p className="muted">
                        This job is <strong>{selectedJob.status}</strong>
                        {selectedJob.assignment_status ? ` (${selectedJob.assignment_status})` : ""} — read-only.
                        No completion can be submitted.
                      </p>
                    </article>
                  )}
                </>
              ) : (
                <div className="empty">Select an assigned job.</div>
              )}
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}

function toggleItem(list: string[], value: string) {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function filesFromRef(ref: { current: HTMLInputElement | null }): File[] {
  return Array.from(ref.current?.files ?? []).filter((file) => file.size > 0);
}

async function signatureToFile(canvas: HTMLCanvasElement | null): Promise<File> {
  if (!canvas) {
    throw new Error("no signature canvas");
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((value) => resolve(value), "image/png"));
  if (!blob) {
    throw new Error("could not export signature");
  }
  return new File([blob], `signature-${Date.now()}.png`, { type: "image/png" });
}

// Uploads each file to the PRIVATE job-media bucket (storage RLS enforces that
// the caller is the assigned employee), then records its metadata. Storage
// paths and bucket internals never surface in the UI.
async function uploadCompletionMedia(params: {
  companyId: string;
  jobId: string;
  completionId: string;
  groups: { mediaType: JobMediaType; files: File[] }[];
  options: ApiOptions;
  onProgress?: (message: string) => void;
}) {
  const supabase = createSupabaseBrowserClient();
  const total = params.groups.reduce((sum, group) => sum + group.files.length, 0);
  let uploaded = 0;

  for (const group of params.groups) {
    for (const file of group.files) {
      const storagePath = jobMediaStoragePath({
        companyId: params.companyId,
        jobId: params.jobId,
        completionId: params.completionId,
        mediaType: group.mediaType,
        filename: file.name,
      });

      const { error: uploadError } = await supabase.storage
        .from(JOB_MEDIA_BUCKET)
        .upload(storagePath, file, { contentType: file.type || undefined, upsert: false });
      if (uploadError) {
        throw new Error(`Upload failed for ${file.name}: ${uploadError.message}`);
      }

      await recordJobMedia(
        params.jobId,
        {
          completionId: params.completionId,
          mediaType: group.mediaType,
          storagePath,
          mimeType: file.type || null,
          sizeBytes: file.size,
        },
        params.options,
      );

      uploaded += 1;
      params.onProgress?.(`Uploaded ${uploaded}/${total} file${total === 1 ? "" : "s"}.`);
    }
  }

  return total;
}

function dollarsToCents(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) : 0;
}

function friendlyCompletionError(message: string) {
  if (message.includes("not assigned") || message.includes("not submittable")) {
    return "This job has already been submitted or is not available for completion.";
  }
  return message;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
