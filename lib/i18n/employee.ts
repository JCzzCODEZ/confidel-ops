"use client";

// ============================================================================
// Employee-facing bilingual (English / Spanish) dictionary + hook.
//
// Design rules:
//  * `en` is the source of truth. `es` is typed as Record<EmployeeKey, string>,
//    so TypeScript FAILS TO COMPILE if any key is missing from Spanish.
//  * Only UI chrome / app-owned labels live here. Customer/DB content
//    (client names, notes, addresses, uploaded file names, service_name values
//    stored for pricing) is NEVER translated.
//  * Service / add-on / completion-status OPTIONS are display-translated but
//    SUBMIT their canonical English value — the owner side prices on those
//    English service_name/addon_name strings and the DB CHECK constraint on
//    completion_status only accepts the English enum. Translating the submitted
//    value would break pricing and violate the constraint.
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from "react";

export type Lang = "en" | "es";

export function normalizeLang(value: string | null | undefined): Lang {
  return value === "es" ? "es" : "en";
}

const STORAGE_KEY = "confidel.lang";

export function readStoredLang(): Lang | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "es" || v === "en" ? v : null;
  } catch {
    return null;
  }
}

function storeLang(lang: Lang) {
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* storage unavailable (private mode) — selection just won't persist */
  }
}

// Resolution order: explicit saved choice -> ?lang= -> invite/account preference
// -> browser Spanish -> English.
export function detectLang(opts?: { urlLang?: string | null; accountLang?: string | null }): Lang {
  const stored = readStoredLang();
  if (stored) return stored;
  if (opts?.urlLang === "es" || opts?.urlLang === "en") return opts.urlLang;
  if (opts?.accountLang === "es" || opts?.accountLang === "en") return opts.accountLang;
  try {
    if (typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("es")) {
      return "es";
    }
  } catch {
    /* ignore */
  }
  return "en";
}

// ---------------------------------------------------------------------------
// Dictionary. `en` is the reference; keys are grouped by area for readability.
// ---------------------------------------------------------------------------
export const en = {
  // language selector (labels stay in their own language, per spec)
  "lang.english": "English",
  "lang.spanish": "Español",
  "lang.aria": "Language",

  // boot / loading
  "boot.opening": "Opening Confidel",
  "boot.loadingEmployee": "Loading employee dashboard",

  // brand / nav
  "brand.operations": "Operations",
  "nav.signOut": "Sign out",

  // role chips
  "role.owner": "OWNER",
  "role.admin": "ADMIN",
  "role.employee": "EMPLOYEE",
  "role.team": "TEAM",

  // login screen
  "login.eyebrow": "Private operations suite",
  "login.heroCopy": "A focused workspace for clients, jobs, employee completions, invoices, and payments.",
  "login.signIn": "Sign in",
  "login.subtitle": "Secure access for owners, admins, and field employees.",
  "login.email": "Email",
  "login.password": "Password",
  "login.signingIn": "Signing in",

  // employee dashboard headings
  "head.employeeDashboard": "Employee dashboard",
  "jobs.assigned": "Assigned jobs",
  "jobs.visibleOne": "1 visible assignment",
  "jobs.visibleOther": "{count} visible assignments",
  "jobs.client": "Client",
  "jobs.unscheduled": "Unscheduled",
  "jobs.none": "No assigned jobs.",
  "job.noDescription": "No description",
  "job.selectAssigned": "Select an assigned job.",
  "job.readonly": "This job is {status}{assignment} — read-only. No completion can be submitted.",
  "completion.idLabel": "Completion ID:",

  // completion form
  "form.jobTiming": "Job timing",
  "form.arrival": "Arrival",
  "form.startRequired": "Start (required)",
  "form.endRequired": "End (required)",
  "form.breakMin": "Break (min)",
  "form.jobStatus": "Job status",
  "form.servicesLegend": "Services completed (select all that apply)",
  "form.otherServiceNotes": "Other service notes",
  "form.addonsLegend": "Add-ons completed",
  "form.otherAddonNotes": "Other add-on notes",
  "form.expensesLegend": "Expenses / reimbursements (itemized, optional)",
  "form.suppliesDesc": "Supplies (description)",
  "form.suppliesCost": "Supplies cost ($)",
  "form.mileage": "Mileage (miles)",
  "form.parking": "Parking ($)",
  "form.tolls": "Tolls ($)",
  "form.otherDesc": "Other (description)",
  "form.otherCost": "Other cost ($)",
  "form.employeeNotes": "Employee Notes / Issues / Follow-Up Needed",
  "form.beforePhotos": "Before photos (required)",
  "form.afterPhotos": "After photos (required)",
  "form.signatureHint": "Signature (required) — sign below",
  "form.clearSignature": "Clear signature",
  "form.otherAttachments": "Other attachments / damage / insurance (optional)",
  "form.confirmText": "I confirm this report is accurate and complete.",
  "form.storageNote": "Photos and signature upload to private storage. Links are never public.",
  "form.submit": "Submit completion",
  "form.submitting": "Submitting…",

  // service option labels (VALUE submitted stays English — see file header)
  "service.standardCleaning": "Standard Cleaning",
  "service.deepCleaning": "Deep Cleaning",
  "service.moveInOut": "Move-In / Move-Out Cleaning",
  "service.airbnbTurnover": "Airbnb Turnover",
  "service.houseSitting": "House Sitting",
  "service.petCare": "Pet Care",
  "service.plantCare": "Plant Care",
  "service.laundry": "Laundry",
  "service.organization": "Organization",
  "service.mobileDetailing": "Mobile Detailing",
  "service.interiorDetailing": "Interior Detailing",
  "service.exteriorDetailing": "Exterior Detailing",
  "service.other": "Other",

  // add-on option labels
  "addon.insideFridge": "Inside Fridge",
  "addon.insideOven": "Inside Oven",
  "addon.interiorWindows": "Interior Windows",
  "addon.baseboards": "Baseboards",
  "addon.blinds": "Blinds",
  "addon.deepBathroom": "Deep Bathroom Detail",
  "addon.deepKitchen": "Deep Kitchen Detail",
  "addon.extraBedroom": "Extra Bedroom",
  "addon.extraBathroom": "Extra Bathroom",
  "addon.laundry": "Laundry",
  "addon.dishes": "Dishes",
  "addon.trashRemoval": "Trash Removal",
  "addon.garage": "Garage",
  "addon.patio": "Patio",
  "addon.petCleanup": "Pet Cleanup",
  "addon.otherAddon": "Other Add-On",

  // completion-status option labels (VALUE submitted stays English)
  "status.completed": "Completed",
  "status.partiallyCompleted": "Partially Completed",
  "status.needsFollowUp": "Needs Follow-Up",

  // job status chips (best-effort display; unknown values shown raw)
  "jobstatus.draft": "draft",
  "jobstatus.sent": "sent",
  "jobstatus.submitted": "submitted",
  "jobstatus.approved": "approved",
  "jobstatus.rejected": "rejected",
  "jobstatus.completed": "completed",
  "jobstatus.cancelled": "cancelled",
  "jobstatus.paid": "paid",
  "jobstatus.assigned": "assigned",

  // validation
  "val.selectJob": "Select a job before submitting.",
  "val.selectService": "Select at least one service completed.",
  "val.beforePhoto": "Add at least one before photo.",
  "val.afterPhoto": "Add at least one after photo.",
  "val.signature": "Please sign in the signature box before submitting.",
  "val.confirm": "Please check the confirmation box before submitting.",
  "val.startEnd": "Enter the start and end time for this job.",
  "val.signatureCapture": "Could not capture the signature. Please sign again.",

  // success / progress / warnings
  "msg.submittedReview": "Submitted for owner review.",
  "msg.uploadingAttachments": "Submitted for owner review. Uploading attachments…",
  "msg.submittedWithNote": "Submitted for owner review. Note: {notes}.",
  "msg.uploadProgressOne": "Submitted for owner review. Uploaded {done}/{total} file.",
  "msg.uploadProgressOther": "Submitted for owner review. Uploaded {done}/{total} files.",
  "warn.detailsNotSaved": "service/expense details didn’t save — the owner can still review, and you can resubmit",
  "warn.attachmentsNotUploaded": "some attachments didn’t upload — the owner can still review",
  "warn.attachmentsNotLinked": "attachments weren’t linked (missing company)",

  // errors
  "err.sessionTimeout": "Session check timed out. Please refresh or sign in again.",
  "err.loadDashboard": "Unable to load employee dashboard.",
  "err.noMembership": "No active membership yet. Ask your owner to invite this email, then sign in again.",
  "err.verifySession": "Couldn’t verify your session. Please sign in.",
  "err.unableSignIn": "Unable to sign in.",
  "err.unableLoadProfile": "Unable to load profile.",
  "err.alreadySubmitted": "This job has already been submitted or is not available for completion.",
  "err.completionFailed": "Completion failed.",
} as const;

export type EmployeeKey = keyof typeof en;

// Spanish — typed against EmployeeKey so a missing/renamed key won't compile.
export const es: Record<EmployeeKey, string> = {
  "lang.english": "English",
  "lang.spanish": "Español",
  "lang.aria": "Idioma",

  "boot.opening": "Abriendo Confidel",
  "boot.loadingEmployee": "Cargando el panel del empleado",

  "brand.operations": "Operaciones",
  "nav.signOut": "Cerrar sesión",

  "role.owner": "DUEÑO",
  "role.admin": "ADMIN",
  "role.employee": "EMPLEADO",
  "role.team": "EQUIPO",

  "login.eyebrow": "Suite de operaciones privada",
  "login.heroCopy": "Un espacio de trabajo enfocado para clientes, trabajos, finalizaciones de empleados, facturas y pagos.",
  "login.signIn": "Iniciar sesión",
  "login.subtitle": "Acceso seguro para dueños, administradores y empleados de campo.",
  "login.email": "Correo electrónico",
  "login.password": "Contraseña",
  "login.signingIn": "Iniciando sesión",

  "head.employeeDashboard": "Panel del empleado",
  "jobs.assigned": "Trabajos asignados",
  "jobs.visibleOne": "1 asignación visible",
  "jobs.visibleOther": "{count} asignaciones visibles",
  "jobs.client": "Cliente",
  "jobs.unscheduled": "Sin programar",
  "jobs.none": "No hay trabajos asignados.",
  "job.noDescription": "Sin descripción",
  "job.selectAssigned": "Selecciona un trabajo asignado.",
  "job.readonly": "Este trabajo está {status}{assignment} — solo lectura. No se puede enviar una finalización.",
  "completion.idLabel": "ID de finalización:",

  "form.jobTiming": "Horario del trabajo",
  "form.arrival": "Llegada",
  "form.startRequired": "Inicio (obligatorio)",
  "form.endRequired": "Fin (obligatorio)",
  "form.breakMin": "Descanso (min)",
  "form.jobStatus": "Estado del trabajo",
  "form.servicesLegend": "Servicios completados (selecciona todos los que apliquen)",
  "form.otherServiceNotes": "Notas de otros servicios",
  "form.addonsLegend": "Complementos completados",
  "form.otherAddonNotes": "Notas de otros complementos",
  "form.expensesLegend": "Gastos / reembolsos (detallados, opcional)",
  "form.suppliesDesc": "Materiales (descripción)",
  "form.suppliesCost": "Costo de materiales ($)",
  "form.mileage": "Kilometraje (millas)",
  "form.parking": "Estacionamiento ($)",
  "form.tolls": "Peajes ($)",
  "form.otherDesc": "Otro (descripción)",
  "form.otherCost": "Otro costo ($)",
  "form.employeeNotes": "Notas del empleado / Problemas / Seguimiento necesario",
  "form.beforePhotos": "Fotos de antes (obligatorio)",
  "form.afterPhotos": "Fotos de después (obligatorio)",
  "form.signatureHint": "Firma (obligatorio) — firma abajo",
  "form.clearSignature": "Borrar firma",
  "form.otherAttachments": "Otros archivos / daños / seguro (opcional)",
  "form.confirmText": "Confirmo que este reporte es preciso y está completo.",
  "form.storageNote": "Las fotos y la firma se suben a almacenamiento privado. Los enlaces nunca son públicos.",
  "form.submit": "Enviar finalización",
  "form.submitting": "Enviando…",

  "service.standardCleaning": "Limpieza estándar",
  "service.deepCleaning": "Limpieza profunda",
  "service.moveInOut": "Limpieza de mudanza (entrada/salida)",
  "service.airbnbTurnover": "Preparación de Airbnb",
  "service.houseSitting": "Cuidado de casa",
  "service.petCare": "Cuidado de mascotas",
  "service.plantCare": "Cuidado de plantas",
  "service.laundry": "Lavandería",
  "service.organization": "Organización",
  "service.mobileDetailing": "Detallado móvil",
  "service.interiorDetailing": "Detallado interior",
  "service.exteriorDetailing": "Detallado exterior",
  "service.other": "Otro",

  "addon.insideFridge": "Interior del refrigerador",
  "addon.insideOven": "Interior del horno",
  "addon.interiorWindows": "Ventanas interiores",
  "addon.baseboards": "Zócalos",
  "addon.blinds": "Persianas",
  "addon.deepBathroom": "Detalle profundo del baño",
  "addon.deepKitchen": "Detalle profundo de la cocina",
  "addon.extraBedroom": "Recámara adicional",
  "addon.extraBathroom": "Baño adicional",
  "addon.laundry": "Lavandería",
  "addon.dishes": "Platos",
  "addon.trashRemoval": "Retiro de basura",
  "addon.garage": "Garaje",
  "addon.patio": "Patio",
  "addon.petCleanup": "Limpieza de mascotas",
  "addon.otherAddon": "Otro complemento",

  "status.completed": "Completado",
  "status.partiallyCompleted": "Parcialmente completado",
  "status.needsFollowUp": "Requiere seguimiento",

  "jobstatus.draft": "borrador",
  "jobstatus.sent": "enviado",
  "jobstatus.submitted": "enviado",
  "jobstatus.approved": "aprobado",
  "jobstatus.rejected": "rechazado",
  "jobstatus.completed": "completado",
  "jobstatus.cancelled": "cancelado",
  "jobstatus.paid": "pagado",
  "jobstatus.assigned": "asignado",

  "val.selectJob": "Selecciona un trabajo antes de enviar.",
  "val.selectService": "Selecciona al menos un servicio completado.",
  "val.beforePhoto": "Agrega al menos una foto de antes.",
  "val.afterPhoto": "Agrega al menos una foto de después.",
  "val.signature": "Por favor firma en el recuadro antes de enviar.",
  "val.confirm": "Por favor marca la casilla de confirmación antes de enviar.",
  "val.startEnd": "Ingresa la hora de inicio y fin de este trabajo.",
  "val.signatureCapture": "No se pudo capturar la firma. Por favor firma de nuevo.",

  "msg.submittedReview": "Enviado para revisión del dueño.",
  "msg.uploadingAttachments": "Enviado para revisión del dueño. Subiendo archivos…",
  "msg.submittedWithNote": "Enviado para revisión del dueño. Nota: {notes}.",
  "msg.uploadProgressOne": "Enviado para revisión del dueño. Subido {done}/{total} archivo.",
  "msg.uploadProgressOther": "Enviado para revisión del dueño. Subidos {done}/{total} archivos.",
  "warn.detailsNotSaved": "los detalles de servicios/gastos no se guardaron — el dueño aún puede revisar y puedes reenviar",
  "warn.attachmentsNotUploaded": "algunos archivos no se subieron — el dueño aún puede revisar",
  "warn.attachmentsNotLinked": "los archivos no se vincularon (falta la empresa)",

  "err.sessionTimeout": "La verificación de sesión expiró. Actualiza o inicia sesión de nuevo.",
  "err.loadDashboard": "No se pudo cargar el panel del empleado.",
  "err.noMembership": "Aún no tienes una membresía activa. Pídele a tu dueño que invite este correo y luego inicia sesión de nuevo.",
  "err.verifySession": "No se pudo verificar tu sesión. Por favor inicia sesión.",
  "err.unableSignIn": "No se pudo iniciar sesión.",
  "err.unableLoadProfile": "No se pudo cargar el perfil.",
  "err.alreadySubmitted": "Este trabajo ya fue enviado o no está disponible para finalizar.",
  "err.completionFailed": "La finalización falló.",
};

export const dict: Record<Lang, Record<EmployeeKey, string>> = { en, es };

// Simple {name} interpolation.
export function translate(lang: Lang, key: EmployeeKey, vars?: Record<string, string | number>): string {
  let out: string = dict[lang][key];
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.replaceAll(`{${k}}`, String(v));
    }
  }
  return out;
}

export type TFn = (key: EmployeeKey, vars?: Record<string, string | number>) => string;

// Canonical options: `value` is submitted (English, matches pricing/DB); `labelKey`
// is what the employee sees.
export const SERVICE_OPTIONS: { value: string; labelKey: EmployeeKey }[] = [
  { value: "Standard Cleaning", labelKey: "service.standardCleaning" },
  { value: "Deep Cleaning", labelKey: "service.deepCleaning" },
  { value: "Move-In / Move-Out Cleaning", labelKey: "service.moveInOut" },
  { value: "Airbnb Turnover", labelKey: "service.airbnbTurnover" },
  { value: "House Sitting", labelKey: "service.houseSitting" },
  { value: "Pet Care", labelKey: "service.petCare" },
  { value: "Plant Care", labelKey: "service.plantCare" },
  { value: "Laundry", labelKey: "service.laundry" },
  { value: "Organization", labelKey: "service.organization" },
  { value: "Mobile Detailing", labelKey: "service.mobileDetailing" },
  { value: "Interior Detailing", labelKey: "service.interiorDetailing" },
  { value: "Exterior Detailing", labelKey: "service.exteriorDetailing" },
  { value: "Other", labelKey: "service.other" },
];

export const ADDON_OPTIONS: { value: string; labelKey: EmployeeKey }[] = [
  { value: "Inside Fridge", labelKey: "addon.insideFridge" },
  { value: "Inside Oven", labelKey: "addon.insideOven" },
  { value: "Interior Windows", labelKey: "addon.interiorWindows" },
  { value: "Baseboards", labelKey: "addon.baseboards" },
  { value: "Blinds", labelKey: "addon.blinds" },
  { value: "Deep Bathroom Detail", labelKey: "addon.deepBathroom" },
  { value: "Deep Kitchen Detail", labelKey: "addon.deepKitchen" },
  { value: "Extra Bedroom", labelKey: "addon.extraBedroom" },
  { value: "Extra Bathroom", labelKey: "addon.extraBathroom" },
  { value: "Laundry", labelKey: "addon.laundry" },
  { value: "Dishes", labelKey: "addon.dishes" },
  { value: "Trash Removal", labelKey: "addon.trashRemoval" },
  { value: "Garage", labelKey: "addon.garage" },
  { value: "Patio", labelKey: "addon.patio" },
  { value: "Pet Cleanup", labelKey: "addon.petCleanup" },
  { value: "Other Add-On", labelKey: "addon.otherAddon" },
];

export const COMPLETION_STATUS_OPTIONS: {
  value: "Completed" | "Partially Completed" | "Needs Follow-Up";
  labelKey: EmployeeKey;
}[] = [
  { value: "Completed", labelKey: "status.completed" },
  { value: "Partially Completed", labelKey: "status.partiallyCompleted" },
  { value: "Needs Follow-Up", labelKey: "status.needsFollowUp" },
];

// Best-effort translation of a raw job/assignment status; unknown values are
// shown as-is so nothing breaks if the backend adds a new status.
export function jobStatusLabel(lang: Lang, raw: string | null | undefined): string {
  if (!raw) return "";
  const key = `jobstatus.${raw}` as EmployeeKey;
  return key in dict[lang] ? dict[lang][key] : raw;
}

export function roleChip(lang: Lang, role: string | null | undefined): string {
  switch (role) {
    case "owner":
      return dict[lang]["role.owner"];
    case "admin":
      return dict[lang]["role.admin"];
    case "employee":
      return dict[lang]["role.employee"];
    default:
      return dict[lang]["role.team"];
  }
}

// React hook: resolves language on mount (SSR-safe: starts "en", client effect
// refines), exposes { lang, setLang, t }. `accountLang` is the invite/account
// preference used only when there's no explicit saved choice yet.
export function useEmployeeLang(accountLang?: string | null): {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: TFn;
} {
  const [lang, setLangState] = useState<Lang>("en");

  useEffect(() => {
    let urlLang: string | null = null;
    try {
      urlLang = new URLSearchParams(window.location.search).get("lang");
    } catch {
      /* ignore */
    }
    setLangState(detectLang({ urlLang, accountLang }));
  }, [accountLang]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    storeLang(next);
  }, []);

  const t = useMemo<TFn>(() => (key, vars) => translate(lang, key, vars), [lang]);

  return { lang, setLang, t };
}
