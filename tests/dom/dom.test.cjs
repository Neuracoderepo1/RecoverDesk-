// OPTIONAL DOM-level behaviour tests (focus, inert, drafts, busy guards, keyboard).
// Runs the real index.html + app.js in jsdom against a fake Supabase client.
// No network, no real data. Needs jsdom, which is deliberately NOT a repo dependency:
//
//   npm i --no-save jsdom && node tests/dom/dom.test.cjs
//
const { JSDOM } = require("jsdom");
const fs = require("fs");
const assert = require("assert");

const REPO = process.env.REPO || require("path").join(__dirname, "..", "..");
const html = fs.readFileSync(`${REPO}/index.html`, "utf8");
let src = fs.readFileSync(`${REPO}/app.js`, "utf8");

// Replace the two imports with injected stubs and wrap for top-level await.
src = src
  .replace(/^import \{ createClient \}.*$/m, "const createClient = window.__createClient;")
  .replace(/^import \{ SUPABASE_URL.*$/m, 'const SUPABASE_URL = "http://x", SUPABASE_PUBLISHABLE_KEY = "k";');
const wrapped = `(async () => {\n${src}\n})().catch(e => { window.__bootError = e; });`;

const ME = "00000000-0000-0000-0000-00000000000a";
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

function makeFake({ failUpdates = false } = {}) {
  const db = {
    cases: [
      { id: "c1", owner_id: ME, assigned_to: null, title: "Case one", description: "d", status: "open", priority: "normal", source: null, due_at: null, created_at: "2026-10-01T10:00:00Z", updated_at: "2026-10-01T10:00:00Z", resolved_at: null },
      { id: "c2", owner_id: ME, assigned_to: null, title: "Case two", description: "d", status: "open", priority: "high", source: null, due_at: null, created_at: "2026-10-02T10:00:00Z", updated_at: "2026-10-02T10:00:00Z", resolved_at: null }
    ],
    events: [{ id: "e1", case_id: "c1", event_type: "case_created", message: "case_created", actor_id: ME, created_at: "2026-10-01T10:00:00Z", recovery_cases: { title: "Case one" } }]
  };
  const calls = { updates: 0, selects: 0 };
  const exec = b => {
    if (b.t === "recovery_cases") {
      if (b.op === "update") {
        calls.updates++;
        if (failUpdates) return { data: [], error: null };
        const row = db.cases.find(c => c.id === b.eq.id);
        Object.assign(row, b.patch);
        return { data: [{ id: row.id }], error: null };
      }
      calls.selects++;
      return { data: db.cases.map(c => ({ ...c })), error: null };
    }
    return { data: db.events, error: null };
  };
  const builder = t => {
    const b = { t, op: "select", eq: {}, patch: null };
    b.select = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.insert = () => { b.op = "insert"; return b; };
    b.update = patch => { b.op = "update"; b.patch = patch; return b; };
    b.eq = (k, v) => { b.eq[k] = v; return b; };
    b.then = (res, rej) => Promise.resolve(exec(b)).then(res, rej);
    return b;
  };
  const client = {
    auth: {
      onAuthStateChange(cb) { client._cb = cb; setTimeout(() => cb("INITIAL_SESSION", { user: { id: ME, email: "a@x.test" } }), 0); return { data: { subscription: {} } }; },
      getSession: async () => ({ data: { session: { user: { id: ME, email: "a@x.test" } } } }),
      signOut: async () => ({ error: null })
    },
    from: builder,
    rpc: async name => (name === "case_people" ? { data: [], error: null } : { data: true, error: null })
  };
  return { client, db, calls };
}

async function boot(opts) {
  const fake = makeFake(opts);
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, url: "http://localhost/" });
  const { window } = dom;
  window.__createClient = () => fake.client;
  window.eval(wrapped);
  await tick(60);
  assert.ok(!window.__bootError, "boot error: " + window.__bootError);
  return { window, document: window.document, fake };
}

const open = (m) => !m.classList.contains("hidden");
const key = (window, el, k) => el.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("  ok   -", name); }
  catch (e) { fail++; console.log("  FAIL -", name, "\n        ", e.message.split("\n")[0]); }
}

(async () => {
  console.log("DOM behaviour (real app.js + index.html, fake Supabase)");

  await t("boots into the workspace and tags body .in-app", async () => {
    const { document } = await boot();
    assert.ok(document.querySelector("#workspace"));
    assert.ok(document.body.classList.contains("in-app"));
    assert.equal(document.querySelectorAll("article.case").length, 2);
  });

  await t("opening the detail modal makes header/main/footer inert; closing clears it", async () => {
    const { window, document } = await boot();
    const card = document.querySelector('article.case[data-open="c1"]');
    card.focus();
    card.click();
    await tick(40);
    assert.ok(open(document.querySelector("#detailModal")));
    for (const sel of ["header.site-header", "main", "footer"]) {
      assert.ok(document.querySelector(sel).hasAttribute("inert"), sel + " should be inert");
    }
    assert.ok(!document.querySelector("#detailModal").hasAttribute("inert"), "modal itself not inert");
    key(window, document, "Escape");
    assert.ok(!open(document.querySelector("#detailModal")));
    for (const sel of ["header.site-header", "main", "footer"]) {
      assert.ok(!document.querySelector(sel).hasAttribute("inert"), sel + " inert cleared");
    }
  });

  await t("changing priority in the detail modal keeps focus on the control", async () => {
    const { window, document } = await boot();
    document.querySelector('article.case[data-open="c1"]').click();
    await tick(40);
    const sel = document.querySelector("#dPriority");
    sel.focus();
    sel.value = "urgent";
    sel.dispatchEvent(new window.Event("change", { bubbles: true }));
    await tick(80);
    assert.equal(document.activeElement && document.activeElement.id, "dPriority", "focus stayed on #dPriority");
    assert.equal(document.querySelector("#dPriority").value, "urgent", "new value shown after reload");
  });

  await t("unsent assignee text survives a re-render of the SAME case", async () => {
    const { window, document } = await boot();
    document.querySelector('article.case[data-open="c1"]').click();
    await tick(40);
    document.querySelector("#dAssignee").value = "someone@example.com";
    const sel = document.querySelector("#dStatus");
    sel.value = "in_progress";
    sel.dispatchEvent(new window.Event("change", { bubbles: true }));
    await tick(80);
    assert.equal(document.querySelector("#dAssignee").value, "someone@example.com");
  });

  await t("a draft does NOT leak into a different case", async () => {
    const { window, document } = await boot();
    document.querySelector('article.case[data-open="c1"]').click();
    await tick(40);
    document.querySelector("#dAssignee").value = "leak@example.com";
    key(window, document, "Escape");
    document.querySelector('article.case[data-open="c2"]').click();
    await tick(40);
    assert.equal(document.querySelector("#dAssignee").value, "", "c2 starts clean");
  });

  await t("Escape returns focus to a live control even when the opener was re-rendered", async () => {
    const { window, document } = await boot();
    const opener = document.querySelector('article.case[data-open="c1"]');
    opener.focus(); // like a real mouse/keyboard open: the card is focused
    opener.click();
    await tick(40);
    const sel = document.querySelector("#dStatus");
    sel.value = "in_progress";
    sel.dispatchEvent(new window.Event("change", { bubbles: true })); // reload replaces the opener card
    await tick(80);
    key(window, document, "Escape");
    const a = document.activeElement;
    assert.ok(a && a.isConnected && a !== document.body, "focus landed on a connected element");
    assert.ok(a.matches(".side-btn.active, article.case, #openAuth"), "landed on " + (a && (a.className || a.id)));
  });

  await t("Escape also lands on a live control when the modal was opened with no focused opener", async () => {
    const { window, document } = await boot();
    document.body.focus();
    document.querySelector('article.case[data-open="c1"]').click();
    await tick(40);
    key(window, document, "Escape");
    const a = document.activeElement;
    assert.ok(a && a !== document.body && a.isConnected, "focus landed on a connected control, got " + (a && (a.className || a.tagName)));
  });

  await t("a refused status change reverts the select instead of showing a wrong value", async () => {
    const { window, document } = await boot({ failUpdates: true });
    document.querySelector('article.case[data-open="c1"]').click();
    await tick(40);
    const sel = document.querySelector("#dStatus");
    sel.value = "closed";
    sel.dispatchEvent(new window.Event("change", { bubbles: true }));
    await tick(80);
    assert.equal(document.querySelector("#dStatus").value, "open", "reverted to server value");
  });

  await t("double-clicking Start sends ONE update (aria-busy guard)", async () => {
    const { document, fake } = await boot();
    const btn = document.querySelector('article.case[data-open="c1"] button[data-status]');
    btn.click();
    btn.click();
    await tick(80);
    assert.equal(fake.calls.updates, 1, "updates sent: " + fake.calls.updates);
  });

  await t("toolbar text is preserved across a data reload (toolbar not rebuilt)", async () => {
    const { window, document, fake } = await boot();
    const q = document.querySelector("#fQ");
    q.value = "two";
    q.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(document.querySelectorAll("article.case").length, 1, "filtered to one");
    const before = fake.calls.selects;
    document.querySelector('article.case[data-open="c2"] button[data-status]').click(); // update -> reload
    await tick(80);
    assert.ok(fake.calls.selects > before, "a reload really happened");
    assert.strictEqual(document.querySelector("#fQ"), q, "same input element (not rebuilt)");
    assert.equal(document.querySelector("#fQ").value, "two");
    assert.equal(document.querySelectorAll("article.case").length, 1);
  });

  await t("Space and Enter open a case card; Space does not scroll the page", async () => {
    const { window, document } = await boot();
    const card = document.querySelector('article.case[data-open="c2"]');
    const ev = new window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    card.dispatchEvent(ev);
    await tick(30);
    assert.ok(open(document.querySelector("#detailModal")), "opened with Space");
    assert.equal(ev.defaultPrevented, true, "default (scroll) prevented");
  });

  await t("activity rows are keyboard-operable", async () => {
    const { window, document } = await boot();
    document.querySelector('.side-btn[data-view="activity"]').click();
    await tick(60);
    const row = document.querySelector(".activity");
    assert.ok(row, "row rendered");
    assert.equal(row.getAttribute("tabindex"), "0");
    assert.equal(row.getAttribute("role"), "button");
    key(window, row, "Enter");
    await tick(30);
    assert.ok(open(document.querySelector("#detailModal")), "Enter opened the case");
  });

  await t("opening the detail modal refreshes stale case data (another user changed it)", async () => {
    const { document, fake } = await boot();
    fake.db.cases[0].priority = "urgent"; // changed elsewhere after our list loaded
    document.querySelector('article.case[data-open="c1"]').click();
    await tick(80);
    assert.equal(document.querySelector("#dPriority").value, "urgent", "modal shows fresh priority");
  });

  await t("returning to the foreground refreshes the list, but not more than once per 10s", async () => {
    const { window, document, fake } = await boot();
    const fire = () => document.dispatchEvent(new window.Event("visibilitychange"));
    fake.db.cases[0].priority = "urgent";
    const before = fake.calls.selects;
    fire(); await tick(40);
    assert.equal(fake.calls.selects, before, "no refetch within 10s of the last load");
    const real = window.Date.now;
    window.Date.now = () => real() + 20000;
    fire(); await tick(60);
    window.Date.now = real;
    assert.equal(fake.calls.selects, before + 1, "one refetch after 10s");
    assert.ok(/urgent/i.test(document.querySelector('article.case[data-open="c1"] .pill').textContent), "list shows fresh priority");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
