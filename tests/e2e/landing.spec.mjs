// Backend-free smoke test: runs on every push/PR without touching Supabase data.
import { test, expect } from "@playwright/test";

test("landing page loads with CSP and no page errors", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", e => pageErrors.push(String(e)));
  await page.goto("/");
  await expect(page.locator("#openAuth")).toBeVisible();
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute("content");
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(pageErrors).toEqual([]);
});

test("auth modal opens, toggles to sign-up, and enforces password length", async ({ page }) => {
  await page.goto("/");
  await page.click("#openAuth");
  await expect(page.locator("#authEmail")).toBeVisible();
  await expect(page.locator("#authSubmit")).toHaveText(/sign in/i);
  await page.click("#toggleAuth");
  await expect(page.locator("#authSubmit")).not.toHaveText(/^sign in$/i);
  await expect(page.locator("#authPassword")).toHaveAttribute("minlength", "10");
});

test("Escape closes the auth modal", async ({ page }) => {
  await page.goto("/");
  await page.click("#openAuth");
  await expect(page.locator("#authEmail")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#authEmail")).toBeHidden();
});
