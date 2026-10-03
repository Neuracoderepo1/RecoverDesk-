// Browser QA against the live Supabase project.
// Prereq: Auth > Providers > Email > "Confirm email" OFF for the QA run (or use pre-confirmed users).
// Run: BASE_URL=http://localhost:8080 npx playwright test tests/e2e --reporter=list
import { test, expect } from "@playwright/test";
const BASE = process.env.BASE_URL || "http://localhost:8080";
const stamp = Date.now();
const users = { a: `qa-a-${stamp}@example.com`, b: `qa-b-${stamp}@example.com` };
const pw = "RecoverDesk-QA-1!";

async function signUp(page, email) {
  await page.goto(BASE);
  await page.click("#openAuth");
  await page.click("#toggleAuth");
  await page.fill("#authEmail", email);
  await page.fill("#authPassword", pw);
  await page.click("#authSubmit");
  await expect(page.locator("#workspace")).toBeVisible({ timeout: 15000 });
}

test("owner creates a case and advances its lifecycle", async ({ page }) => {
  await signUp(page, users.a);
  await page.click("#newCase");
  await page.fill("#caseTitle", "QA case A");
  await page.selectOption("#casePriority", "urgent");
  await page.click("#caseForm button[type=submit]");
  await expect(page.getByText("QA case A")).toBeVisible();
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByRole("button", { name: "Resolve" })).toBeVisible();
  await page.click('[data-view="activity"]');
  await expect(page.getByText("status changed")).toBeVisible();
});

test("a second user cannot see the first user's data", async ({ page }) => {
  await signUp(page, users.b);
  await expect(page.getByText("QA case A")).toHaveCount(0);
  await expect(page.getByText("No recovery cases yet")).toBeVisible();
  await page.click('[data-view="activity"]');
  await expect(page.getByText("No activity yet")).toBeVisible();
});
