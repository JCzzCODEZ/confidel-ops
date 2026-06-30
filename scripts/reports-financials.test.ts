// Unit tests for the Records/CSV read-time payment derivation.
// Run: node --experimental-strip-types --test scripts/reports-financials.test.ts
// Covers the Phase 2 finding: a fully paid invoice must report paid / full
// amount / zero balance even though job_financial_summaries is a stale snapshot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { derivePaymentState } from "../lib/confidel-api.ts";

test("fully paid invoice (Phase 2 smoke values: total 106625, paid 106625)", () => {
  const d = derivePaymentState(106625, 106625);
  assert.equal(d.payment_status, "paid");
  assert.equal(d.amount_paid_cents, 106625);
  assert.equal(d.balance_due_cents, 0);
});

test("partial payment -> partial + correct balance", () => {
  const d = derivePaymentState(106625, 50000);
  assert.equal(d.payment_status, "partial");
  assert.equal(d.amount_paid_cents, 50000);
  assert.equal(d.balance_due_cents, 56625);
});

test("no payments -> unpaid, full balance", () => {
  const d = derivePaymentState(106625, 0);
  assert.equal(d.payment_status, "unpaid");
  assert.equal(d.amount_paid_cents, 0);
  assert.equal(d.balance_due_cents, 106625);
});

test("overpayment clamps balance to 0 and still reads paid", () => {
  const d = derivePaymentState(106625, 120000);
  assert.equal(d.payment_status, "paid");
  assert.equal(d.balance_due_cents, 0);
});

test("zero-total invoice with no payment is unpaid, not paid", () => {
  const d = derivePaymentState(0, 0);
  assert.equal(d.payment_status, "unpaid");
  assert.equal(d.balance_due_cents, 0);
});

test("null/undefined inputs are treated as 0 (no NaN)", () => {
  const d = derivePaymentState(null, undefined);
  assert.equal(d.amount_paid_cents, 0);
  assert.equal(d.balance_due_cents, 0);
  assert.equal(d.payment_status, "unpaid");
});
