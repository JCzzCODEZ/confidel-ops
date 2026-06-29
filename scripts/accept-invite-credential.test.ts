// Unit tests for the pure /accept-invite credential logic.
// Run: node --experimental-strip-types --test scripts/accept-invite-credential.test.ts
// (No deps, no DOM, no Supabase — covers the credential-selection flow bugs.)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INVITE_STASH_KEY,
  captureInviteCredentials,
  cleanInviteHref,
  decideCredential,
  resolveInviteToken,
  type CredentialInput,
  type StorageLike,
} from "../lib/accept-invite-credential.ts";

const base: CredentialInput = {
  tokenHash: null,
  otpType: null,
  code: null,
  hashAccess: null,
  hashRefresh: null,
  hashError: null,
};

test("token_hash + valid type -> verify (single credential)", () => {
  const d = decideCredential({ ...base, tokenHash: "th", otpType: "invite" });
  assert.deepEqual(d, { kind: "verify", tokenHash: "th", otpType: "invite" });
});

test("token_hash with invalid type -> link_error/bad_type", () => {
  assert.deepEqual(decideCredential({ ...base, tokenHash: "th", otpType: "nope" }), {
    kind: "link_error",
    reason: "bad_type",
  });
});

test("token_hash with NO type -> link_error/bad_type", () => {
  assert.equal(decideCredential({ ...base, tokenHash: "th" }).kind, "link_error");
});

test("code only -> exchange", () => {
  assert.deepEqual(decideCredential({ ...base, code: "abc" }), { kind: "exchange", code: "abc" });
});

test("full implicit hash -> setSession receives BOTH tokens", () => {
  const d = decideCredential({ ...base, hashAccess: "AT", hashRefresh: "RT" });
  assert.deepEqual(d, { kind: "setSession", accessToken: "AT", refreshToken: "RT" });
});

test("partial hash (access only) -> link_error/partial_hash", () => {
  assert.deepEqual(decideCredential({ ...base, hashAccess: "AT" }), {
    kind: "link_error",
    reason: "partial_hash",
  });
});

test("partial hash (refresh only) -> link_error/partial_hash", () => {
  assert.deepEqual(decideCredential({ ...base, hashRefresh: "RT" }), {
    kind: "link_error",
    reason: "partial_hash",
  });
});

test("conflicting credentials (token_hash + code) -> link_error/conflict", () => {
  assert.deepEqual(decideCredential({ ...base, tokenHash: "th", otpType: "invite", code: "abc" }), {
    kind: "link_error",
    reason: "conflict",
  });
});

test("conflicting credentials (code + full hash) -> link_error/conflict", () => {
  assert.deepEqual(
    decideCredential({ ...base, code: "abc", hashAccess: "AT", hashRefresh: "RT" }),
    { kind: "link_error", reason: "conflict" },
  );
});

test("hash error fragment -> link_error/hash_error (even with another credential)", () => {
  assert.deepEqual(
    decideCredential({ ...base, tokenHash: "th", otpType: "invite", hashError: "access_denied" }),
    { kind: "link_error", reason: "hash_error" },
  );
});

test("no credential -> existing", () => {
  assert.deepEqual(decideCredential(base), { kind: "existing" });
});

test("captureInviteCredentials reads query + hash (incl. partial/error fragments)", () => {
  const u = new URL(
    "https://app.example.com/accept-invite?invite=TOK&lang=es&token_hash=TH&type=invite&code=C#access_token=AT&refresh_token=RT",
  );
  const c = captureInviteCredentials(u);
  assert.equal(c.lang, "es");
  assert.equal(c.inviteParam, "TOK");
  assert.equal(c.tokenHash, "TH");
  assert.equal(c.otpType, "invite");
  assert.equal(c.code, "C");
  assert.equal(c.hashAccess, "AT");
  assert.equal(c.hashRefresh, "RT");
  assert.equal(c.hashError, null);
  // error fragment captured too
  const e = captureInviteCredentials(new URL("https://app.example.com/accept-invite#error=access_denied"));
  assert.equal(e.hashError, "access_denied");
  // the captured object feeds decideCredential directly (it is a superset)
  assert.equal(decideCredential(captureInviteCredentials(new URL("https://app.example.com/x"))).kind, "existing");
});

test("cleanInviteHref strips invite/token_hash/code/type AND hash, keeps lang", () => {
  const dirty =
    "https://app.example.com/accept-invite?invite=TOK&lang=es&token_hash=TH&type=invite&code=C#access_token=AT&refresh_token=RT";
  const clean = cleanInviteHref(dirty);
  assert.equal(clean, "https://app.example.com/accept-invite?lang=es");
  for (const leak of ["invite=", "token_hash=", "code=", "type=", "access_token", "refresh_token", "#"]) {
    assert.ok(!clean.includes(leak), `leaked ${leak}`);
  }
});

test("resolveInviteToken stashes the URL token, then restores it when URL has none", () => {
  const mem = new Map<string, string>();
  const storage: StorageLike = {
    getItem: (k) => (mem.has(k) ? (mem.get(k) as string) : null),
    setItem: (k, v) => void mem.set(k, v),
    removeItem: (k) => void mem.delete(k),
  };
  assert.equal(resolveInviteToken("TOK", storage), "TOK");
  assert.equal(mem.get(INVITE_STASH_KEY), "TOK");
  // Later load without the URL param recovers the stashed token.
  assert.equal(resolveInviteToken(null, storage), "TOK");
});

test("resolveInviteToken tolerates throwing storage (falls back to URL value)", () => {
  const boom: StorageLike = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {},
  };
  assert.equal(resolveInviteToken("TOK", boom), "TOK");
  assert.equal(resolveInviteToken(null, null), null);
});
