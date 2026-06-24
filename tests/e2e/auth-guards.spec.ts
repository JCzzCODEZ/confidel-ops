import { test, expect, type Page } from "@playwright/test";

/**
 * Phase 1.4 — browser regression for the auth guards and role routing.
 *
 * Items 1 & 2 of the Phase 1.4 plan:
 *   1. Logged-out guards: / shows login; /owner and /employee redirect to /;
 *      no infinite loading spinner.
 *   2. Role routing: owner/admin -> /owner, employee -> /employee, and each is
 *      bounced back from the other dashboard.
 *
 * The logged-out guard tests require no accounts and always run.
 * The role-routing tests need real Supabase test accounts; they are skipped
 * (clearly) unless the E2E_* env vars are set. See TESTING.md.
 */

const owner = {
  email: process.env.E2E_OWNER_EMAIL,
  password: process.env.E2E_OWNER_PASSWORD,
};
const employee = {
  email: process.env.E2E_EMPLOYEE_EMAIL,
  password: process.env.E2E_EMPLOYEE_PASSWORD,
};

async function login(page: Page, email: string, password: string) {
  await page.goto("/");
  await expect(page.getByTestId("login-screen")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
}

test.describe("logged-out auth guards", () => {
  test("/ shows the login screen and stops loading", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("login-screen")).toBeVisible({ timeout: 10_000 });
    // Spinner must clear (no infinite loading).
    await expect(page.getByTestId("auth-loading")).toHaveCount(0);
  });

  test("/owner redirects to / when logged out, no infinite loading", async ({ page }) => {
    await page.goto("/owner");
    // The redirect resolves to the login screen within the timeout; if the page
    // stayed on the spinner this assertion fails — that's the bug we guard.
    await expect(page.getByTestId("login-screen")).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("auth-loading")).toHaveCount(0);
  });

  test("/employee redirects to / when logged out, no infinite loading", async ({ page }) => {
    await page.goto("/employee");
    await expect(page.getByTestId("login-screen")).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("auth-loading")).toHaveCount(0);
  });
});

test.describe("role routing", () => {
  test.skip(
    !owner.email || !owner.password || !employee.email || !employee.password,
    "Set E2E_OWNER_EMAIL/PASSWORD and E2E_EMPLOYEE_EMAIL/PASSWORD to run role-routing tests (see TESTING.md).",
  );

  test("owner/admin lands on /owner", async ({ page }) => {
    await login(page, owner.email!, owner.password!);
    await expect(page).toHaveURL(/\/owner$/, { timeout: 15_000 });
    await expect(page.getByTestId("owner-dashboard")).toBeVisible();
  });

  test("employee lands on /employee", async ({ page }) => {
    await login(page, employee.email!, employee.password!);
    await expect(page).toHaveURL(/\/employee$/, { timeout: 15_000 });
    await expect(page.getByTestId("employee-dashboard")).toBeVisible();
  });

  test("employee visiting /owner is redirected to /employee", async ({ page }) => {
    await login(page, employee.email!, employee.password!);
    await expect(page.getByTestId("employee-dashboard")).toBeVisible({ timeout: 15_000 });
    await page.goto("/owner");
    await expect(page).toHaveURL(/\/employee$/, { timeout: 15_000 });
    await expect(page.getByTestId("employee-dashboard")).toBeVisible();
  });

  test("owner visiting /employee is redirected to /owner", async ({ page }) => {
    await login(page, owner.email!, owner.password!);
    await expect(page.getByTestId("owner-dashboard")).toBeVisible({ timeout: 15_000 });
    await page.goto("/employee");
    await expect(page).toHaveURL(/\/owner$/, { timeout: 15_000 });
    await expect(page.getByTestId("owner-dashboard")).toBeVisible();
  });
});
