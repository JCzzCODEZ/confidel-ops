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
  signOut,
} from "../../lib/auth";
import { createSupabaseBrowserClient } from "../../lib/supabase/client";
import {
  ADDON_OPTIONS,
  COMPLETION_STATUS_OPTIONS,
  jobStatusLabel,
  roleChip,
  SERVICE_OPTIONS,
  useEmployeeLang,
  type Lang,
  type TFn,
} from "../../lib/i18n/employee";
import { LanguageSelector } from "../i18n/language-selector";

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
  const [accountLang, setAccountLang] = useState<string | null>(null);
  const { lang, setLang, t } = useEmployeeLang(accountLang);
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

  // Seed the language from the invite/account preference (user_metadata) when the
  // employee hasn't made an explicit in-app choice yet.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const supabase = createSupabaseBrowserClient();
        const { data } = await supabase.auth.getUser();
        const pref = (data.user?.user_metadata as Record<string, unknown> | undefined)?.preferred_language;
        if (active && (pref === "en" || pref === "es")) setAccountLang(pref);
      } catch {
        /* ignore — fall back to localStorage / browser / en */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const timeout = setTimeout(() => {
      if (active) {
        setError(t("err.sessionTimeout"));
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
      } catch {
        if (!active) return;
        setError(t("err.loadDashboard"));
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
    // t is stable per lang; we intentionally run this once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      setError(t("val.selectJob"));
      setBusy(false);
      return;
    }

    const beforeFiles = filesFromRef(beforeRef);
    const afterFiles = filesFromRef(afterRef);
    const otherFiles = filesFromRef(otherRef);

    // Clear, specific validation messages (not just a disabled button).
    if (!services.length) {
      setError(t("val.selectService"));
      setBusy(false);
      return;
    }
    if (!beforeFiles.length) {
      setError(t("val.beforePhoto"));
      setBusy(false);
      return;
    }
    if (!afterFiles.length) {
      setError(t("val.afterPhoto"));
      setBusy(false);
      return;
    }
    if (!hasSignature) {
      setError(t("val.signature"));
      setBusy(false);
      return;
    }
    if (!confirmed) {
      setError(t("val.confirm"));
      setBusy(false);
      return;
    }
    if (!startTime || !endTime) {
      setError(t("val.startEnd"));
      setBusy(false);
      return;
    }

    let signatureFile: File;
    try {
      signatureFile = await signatureToFile(canvasRef.current);
    } catch {
      setError(t("val.signatureCapture"));
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
            // Submit canonical English service/add-on names — the owner prices on
            // these and the DB stores them; only the on-screen label is localized.
            services: [...services, ...(otherServiceNotes.trim() ? [`Other: ${otherServiceNotes.trim()}`] : [])],
            addons: [...addOns, ...(otherAddonNotes.trim() ? [`Other: ${otherAddonNotes.trim()}`] : [])],
            expenses: buildExpenses(),
          },
          options,
        );
      } catch {
        warnings.push(t("warn.detailsNotSaved"));
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
            setMessage(t("msg.uploadingAttachments"));
            await uploadCompletionMedia({
              companyId: selectedJob.company_id,
              jobId: selectedJob.id,
              completionId: result.completion.id,
              groups,
              options,
              onProgress: (done, total) =>
                setMessage(t(total === 1 ? "msg.uploadProgressOne" : "msg.uploadProgressOther", { done, total })),
            });
          }
        } catch {
          warnings.push(t("warn.attachmentsNotUploaded"));
        }
      } else {
        warnings.push(t("warn.attachmentsNotLinked"));
      }

      setMessage(
        warnings.length ? t("msg.submittedWithNote", { notes: warnings.join("; ") }) : t("msg.submittedReview"),
      );
      resetForm();
      await refreshJobs();
    } catch (submitError) {
      // Only reached if the base completion submit itself failed.
      const raw = submitError instanceof Error ? submitError.message : t("err.completionFailed");
      setError(friendlyCompletionError(raw, t));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <main className="screen">
        <div className="shell loading" data-testid="auth-loading">
          {t("boot.loadingEmployee")}
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
            <LanguageSelector lang={lang} onChange={setLang} ariaLabel={t("lang.aria")} />
            <span className="status">{roleChip(lang, role?.role)}</span>
            <button className="btn secondary" data-testid="employee-sign-out" onClick={handleLogout} type="button">
              {t("nav.signOut")}
            </button>
          </div>
        </header>

        <section className="panel stack" data-testid="employee-dashboard">
          <div className="section-head">
            <div>
              <p className="eyebrow">{t("head.employeeDashboard")}</p>
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
              {t("completion.idLabel")} {completionId}
            </div>
          ) : null}

          <div className="dashboard-grid">
            <section className="stack">
              <div className="section-head">
                <div>
                  <h3>{t("jobs.assigned")}</h3>
                  <p>{jobs.length === 1 ? t("jobs.visibleOne") : t("jobs.visibleOther", { count: jobs.length })}</p>
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
                          <p className="muted small">{job.client_name || t("jobs.client")}</p>
                          <p className="muted small">
                            {job.scheduled_for ? formatDate(job.scheduled_for, lang) : t("jobs.unscheduled")}
                          </p>
                        </div>
                        <span className="status">{jobStatusLabel(lang, job.assignment_status ?? job.status)}</span>
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="empty">{t("jobs.none")}</div>
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
                        <p className="muted small">{selectedJob.description || t("job.noDescription")}</p>
                        <p className="muted small">{selectedJob.client_name || t("jobs.client")}</p>
                      </div>
                      <span className="status">{jobStatusLabel(lang, selectedJob.status)}</span>
                    </div>
                  </article>

                  {submittable ? (
                    <form className="form-grid" onSubmit={handleSubmit}>
                      <fieldset className="wide" style={{ border: 0, padding: 0, margin: 0 }}>
                        <legend>{t("form.jobTiming")}</legend>
                        <div style={checkGridStyle}>
                          <label>
                            {t("form.arrival")}
                            <input type="time" data-testid="completion-arrival" value={arrival} onChange={(e) => setArrival(e.target.value)} />
                          </label>
                          <label>
                            {t("form.startRequired")}
                            <input type="time" data-testid="completion-start" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
                          </label>
                          <label>
                            {t("form.endRequired")}
                            <input type="time" data-testid="completion-end" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
                          </label>
                          <label>
                            {t("form.breakMin")}
                            <input type="number" min="0" data-testid="completion-break" value={breakMinutes} onChange={(e) => setBreakMinutes(e.target.value)} />
                          </label>
                          <label>
                            {t("form.jobStatus")}
                            <select
                              data-testid="completion-status"
                              value={completionStatus}
                              onChange={(e) => setCompletionStatus(e.target.value as typeof completionStatus)}
                            >
                              {COMPLETION_STATUS_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {t(option.labelKey)}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                      </fieldset>

                      <fieldset className="wide" style={{ border: 0, padding: 0, margin: 0 }}>
                        <legend>{t("form.servicesLegend")}</legend>
                        <div data-testid="completion-services" style={checkGridStyle}>
                          {SERVICE_OPTIONS.map((option) => (
                            <label key={option.value} style={checkItemStyle}>
                              <input
                                type="checkbox"
                                data-testid={`service-${slug(option.value)}`}
                                checked={services.includes(option.value)}
                                onChange={() => setServices((current) => toggleItem(current, option.value))}
                              />
                              <span>{t(option.labelKey)}</span>
                            </label>
                          ))}
                        </div>
                        <input
                          className="wide"
                          data-testid="completion-other-services"
                          placeholder={t("form.otherServiceNotes")}
                          value={otherServiceNotes}
                          onChange={(event) => setOtherServiceNotes(event.target.value)}
                        />
                      </fieldset>

                      <fieldset className="wide" style={{ border: 0, padding: 0, margin: 0 }}>
                        <legend>{t("form.addonsLegend")}</legend>
                        <div data-testid="completion-addons" style={checkGridStyle}>
                          {ADDON_OPTIONS.map((option) => (
                            <label key={option.value} style={checkItemStyle}>
                              <input
                                type="checkbox"
                                data-testid={`addon-${slug(option.value)}`}
                                checked={addOns.includes(option.value)}
                                onChange={() => setAddOns((current) => toggleItem(current, option.value))}
                              />
                              <span>{t(option.labelKey)}</span>
                            </label>
                          ))}
                        </div>
                        <input
                          className="wide"
                          data-testid="completion-other-addons"
                          placeholder={t("form.otherAddonNotes")}
                          value={otherAddonNotes}
                          onChange={(event) => setOtherAddonNotes(event.target.value)}
                        />
                      </fieldset>

                      <fieldset className="wide" style={{ border: 0, padding: 0, margin: 0 }}>
                        <legend>{t("form.expensesLegend")}</legend>
                        <div style={checkGridStyle}>
                          <label>
                            {t("form.suppliesDesc")}
                            <input data-testid="expense-supplies-desc" value={suppliesDesc} onChange={(e) => setSuppliesDesc(e.target.value)} />
                          </label>
                          <label>
                            {t("form.suppliesCost")}
                            <input type="number" min="0" step="0.01" data-testid="expense-supplies-cost" value={suppliesCost} onChange={(e) => setSuppliesCost(e.target.value)} />
                          </label>
                          <label>
                            {t("form.mileage")}
                            <input type="number" min="0" step="0.1" data-testid="expense-mileage" value={mileage} onChange={(e) => setMileage(e.target.value)} />
                          </label>
                          <label>
                            {t("form.parking")}
                            <input type="number" min="0" step="0.01" data-testid="expense-parking" value={parking} onChange={(e) => setParking(e.target.value)} />
                          </label>
                          <label>
                            {t("form.tolls")}
                            <input type="number" min="0" step="0.01" data-testid="expense-tolls" value={tolls} onChange={(e) => setTolls(e.target.value)} />
                          </label>
                          <label>
                            {t("form.otherDesc")}
                            <input data-testid="expense-other-desc" value={otherExpenseDesc} onChange={(e) => setOtherExpenseDesc(e.target.value)} />
                          </label>
                          <label>
                            {t("form.otherCost")}
                            <input type="number" min="0" step="0.01" data-testid="expense-other-cost" value={otherExpenseCost} onChange={(e) => setOtherExpenseCost(e.target.value)} />
                          </label>
                        </div>
                      </fieldset>

                      <label className="wide">
                        {t("form.employeeNotes")}
                        <textarea
                          data-testid="completion-notes"
                          value={employeeNotes}
                          onChange={(event) => setEmployeeNotes(event.target.value)}
                        />
                      </label>

                      <label className="wide">
                        {t("form.beforePhotos")}
                        <input ref={beforeRef} data-testid="completion-before" type="file" accept="image/*" multiple />
                      </label>
                      <label className="wide">
                        {t("form.afterPhotos")}
                        <input ref={afterRef} data-testid="completion-after" type="file" accept="image/*" multiple />
                      </label>

                      <div className="wide">
                        <p className="muted small">{t("form.signatureHint")}</p>
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
                          {t("form.clearSignature")}
                        </button>
                      </div>

                      <label className="wide">
                        {t("form.otherAttachments")}
                        <input ref={otherRef} data-testid="completion-other" type="file" multiple />
                      </label>

                      <label className="wide" style={checkItemStyle}>
                        <input
                          type="checkbox"
                          data-testid="completion-confirm"
                          checked={confirmed}
                          onChange={(event) => setConfirmed(event.target.checked)}
                        />
                        <span>{t("form.confirmText")}</span>
                      </label>

                      <p className="muted small">{t("form.storageNote")}</p>

                      <button
                        className="btn gold wide"
                        data-testid="completion-submit"
                        disabled={busy}
                        type="submit"
                      >
                        {busy ? t("form.submitting") : t("form.submit")}
                      </button>
                    </form>
                  ) : (
                    <article className="card" data-testid="employee-job-readonly">
                      <p className="muted">
                        {t("job.readonly", {
                          status: jobStatusLabel(lang, selectedJob.status),
                          assignment: selectedJob.assignment_status
                            ? ` (${jobStatusLabel(lang, selectedJob.assignment_status)})`
                            : "",
                        })}
                      </p>
                    </article>
                  )}
                </>
              ) : (
                <div className="empty">{t("job.selectAssigned")}</div>
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
  onProgress?: (done: number, total: number) => void;
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
      params.onProgress?.(uploaded, total);
    }
  }

  return total;
}

function dollarsToCents(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) : 0;
}

function friendlyCompletionError(message: string, t: TFn) {
  if (message.includes("not assigned") || message.includes("not submittable")) {
    return t("err.alreadySubmitted");
  }
  return message;
}

function formatDate(value: string, lang: Lang) {
  return new Intl.DateTimeFormat(lang, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
