// Real-browser smoke test against the DEPLOYED site. Needs no credentials and creates no data:
// it only exercises signed-out UI and a deliberately wrong sign-in.
//   BASE_URL=https://neuracoderepo1.github.io/RecoverDesk- npx playwright test tests/e2e/live-smoke.spec.mjs
import { test, expect } from "@playwright/test";
const BASE = (process.env.BASE_URL || "http://localhost:8080").replace(/\/$/, "") + "/";

test.describe("signed-out, live", () => {
  test("landing renders and the browser console stays clean", async ({ page }) => {
    const problems = [];
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
    await page.goto(BASE);
    await expect(page).toHaveTitle(/RecoverDesk/);
    await expect(page.locator("header.site-header")).toBeVisible();
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator("footer")).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(problems).toEqual([]);
  });

  test("auth modal: inert background, keyboard, Escape, focus returns", async ({ page }) => {
    await page.goto(BASE);
    const opener = page.locator("#openAuth");
    await opener.focus();
    await opener.click();
    await expect(page.locator("#authModal")).toBeVisible();
    await expect(page.locator("main")).toHaveAttribute("inert", "");
    await expect(page.locator("header")).toHaveAttribute("inert", "");
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement.closest("#authModal"))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.locator("#authModal")).toBeHidden();
    await expect(page.locator("main")).not.toHaveAttribute("inert", "");
    await expect(opener).toBeFocused();
  });

  test("sign-up / sign-in / forgot-password controls switch modes", async ({ page }) => {
    await page.goto(BASE);
    await page.click("#openAuth");
    const submit = page.locator("#authSubmit");
    const before = await submit.textContent();
    await page.click("#toggleAuth");
    await expect(submit).not.toHaveText(before);
    await page.click("#toggleAuth");
    await expect(submit).toHaveText(before);
  });

  test("wrong credentials are rejected with a readable message and the UI recovers", async ({ page }) => {
    await page.goto(BASE);
    await page.click("#openAuth");
    await page.fill("#authEmail", "nobody-" + Date.now() + "@example.invalid");
    await page.fill("#authPassword", "definitely-wrong-password-123");
    await page.click("#authSubmit");
    await expect(page.locator("#authMessage")).not.toBeEmpty({ timeout: 15000 });
    await expect(page.locator("#authMessage")).not.toContainText(/undefined|\[object|stack/i);
    await expect(page.locator("#authSubmit")).toBeEnabled();      // not stuck in a busy state
    await expect(page.locator("#workspace, .in-app")).toHaveCount(0);
  });

  test("protected data is not readable anonymously (REST)", async ({ request }) => {
    const cfg = await (await request.get(BASE + "config.js")).text();
    const url = cfg.match(/https:\/\/[a-z0-9]+\.supabase\.co/)[0];
    const key = cfg.match(/(sb_publishable_[\w-]+|eyJ[\w.-]+)/)[1];
    for (const t of ["recovery_cases", "case_events", "profiles"]) {
      const r = await request.get(`${url}/rest/v1/${t}?select=*`, { headers: { apikey: key } });
      const body = await r.text();
      expect(r.status() === 200 ? JSON.parse(body) : [], t).toEqual([]);   // empty or denied, never rows
    }
  });
});
