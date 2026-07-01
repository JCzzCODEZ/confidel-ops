// Guards the employee i18n dictionary: complete + consistent EN/ES, and the
// option "submitted values" stay canonical English (pricing/DB depend on them).
// Run: node --experimental-strip-types --test scripts/i18n-employee.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  en,
  es,
  dict,
  translate,
  normalizeLang,
  jobStatusLabel,
  roleChip,
  SERVICE_OPTIONS,
  ADDON_OPTIONS,
  COMPLETION_STATUS_OPTIONS,
} from "../lib/i18n/employee.ts";

test("es defines every en key", () => {
  for (const k of Object.keys(en)) {
    assert.ok(k in es, `Spanish is missing key: ${k}`);
  }
});

test("es has no keys beyond en", () => {
  const enKeys = new Set(Object.keys(en));
  for (const k of Object.keys(es)) {
    assert.ok(enKeys.has(k), `Spanish has an extra/typo key: ${k}`);
  }
});

test("no empty strings in either locale", () => {
  for (const lang of ["en", "es"] as const) {
    for (const [k, v] of Object.entries(dict[lang])) {
      assert.ok(String(v).trim().length > 0, `${lang}.${k} is empty`);
    }
  }
});

test("option submitted values are canonical English (no translation drift)", () => {
  for (const o of SERVICE_OPTIONS) assert.equal(o.value, en[o.labelKey], `service value drift: ${o.value}`);
  for (const o of ADDON_OPTIONS) assert.equal(o.value, en[o.labelKey], `addon value drift: ${o.value}`);
  for (const o of COMPLETION_STATUS_OPTIONS) assert.equal(o.value, en[o.labelKey], `status value drift: ${o.value}`);
});

test("completion-status values match the DB CHECK constraint enum", () => {
  const allowed = new Set(["Completed", "Partially Completed", "Needs Follow-Up"]);
  for (const o of COMPLETION_STATUS_OPTIONS) assert.ok(allowed.has(o.value), `bad status value: ${o.value}`);
});

test("interpolation replaces named vars", () => {
  assert.equal(translate("es", "jobs.visibleOther", { count: 3 }), "3 asignaciones visibles");
  assert.equal(translate("en", "jobs.visibleOther", { count: 3 }), "3 visible assignments");
});

test("normalizeLang", () => {
  assert.equal(normalizeLang("es"), "es");
  assert.equal(normalizeLang("en"), "en");
  assert.equal(normalizeLang("fr"), "en");
  assert.equal(normalizeLang(null), "en");
});

test("jobStatusLabel translates known + falls back to raw for unknown", () => {
  assert.equal(jobStatusLabel("es", "approved"), "aprobado");
  assert.equal(jobStatusLabel("en", "approved"), "approved");
  assert.equal(jobStatusLabel("es", "some_future_status"), "some_future_status");
  assert.equal(jobStatusLabel("es", null), "");
});

test("roleChip maps roles and defaults to team", () => {
  assert.equal(roleChip("es", "employee"), "EMPLEADO");
  assert.equal(roleChip("es", "owner"), "DUEÑO");
  assert.equal(roleChip("en", "owner"), "OWNER");
  assert.equal(roleChip("es", null), "EQUIPO");
});
