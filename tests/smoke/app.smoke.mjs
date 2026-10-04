// RecoverDesk smoke tests — dependency-free (Node >= 20).
//
//   node --test tests/smoke/app.smoke.mjs
//
// Static checks always run against the files in the repo.
// Set BASE_URL to also verify the deployed site:
//
//   BASE_URL=https://neuracoderepo1.github.io/RecoverDesk- node --test tests/smoke/app.smoke.mjs
//
// These tests never sign in, never create accounts and never write data.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = f => readFileSync(join(ROOT, f), "utf8");
const sha256 = s => createHash("sha256").update(s).digest("hex");

const app = read("app.js");
const html = read("index.html");
const config = read("config.js");
const workflow = read(".github/workflows/deploy.yml");

const SHIPPED = ["index.html", "app.js", "config.js", "styles.css", "favicon.svg"];

/* ---------- static: source integrity ---------- */

test("app.js is syntactically valid ES module code", () => {
  const dir = mkdtempSync(join(tmpdir(), "rd-"));
  const file = join(dir, "app.check.mjs");
  try {
    writeFileSync(file, app);
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hardening features are present", () => {
  assert.match(app, /TIMEOUT_MS\s*=\s*20_?000/, "20s request timeout");
  assert.match(app, /global:\s*\{\s*fetch:\s*timedFetch/, "timedFetch wired into Supabase client");
  assert.match(app, /new AbortController\(\)/, "abort-based timeout");
  assert.match(app, /returnFocus/, "modal focus restore");
  assert.match(app, /addEventListener\(\s*"unhandledrejection"/, "unhandled rejection handler");
  assert.match(app, /function friendly\(/, "friendly error mapper");
  assert.match(app, /event === "SIGNED_OUT"/, "signed-out session recovery");
  assert.match(app, /placeholder="Assignee email"/, "short assignee placeholder");
});

test("friendly() maps network, auth and rate-limit errors", () => {
  // Extract the function and run it in isolation.
  const m = app.match(/function friendly\(err\) \{[\s\S]*?\n\}\n/);
  assert.ok(m, "friendly() found");
  const friendly = new Function(`${m[0]}; return friendly;`)();
  assert.match(friendly(new Error("Failed to fetch")), /Network problem/);
  assert.match(friendly({ name: "AbortError", message: "The operation was aborted" }), /Network problem/);
  assert.match(friendly(new Error("Invalid login credentials")), /Incorrect email or password/);
  assert.match(friendly({ message: "Email not confirmed" }), /confirm your email/i);
  assert.match(friendly({ message: "over_email_send_rate_limit" }), /Too many emails/);
  assert.match(friendly(new Error("User already registered")), /already exists/);
  assert.equal(friendly(""), "Something went wrong. Please try again.");
});

test("esc() neutralises HTML metacharacters", () => {
  const m = app.match(/const esc = v =>[\s\S]*?\n  \);\n/);
  assert.ok(m, "esc() found");
  const esc = new Function(`${m[0]}; return esc;`)();
  assert.equal(esc(`<img src=x onerror="a('b')">&`), "&lt;img src=x onerror=&quot;a(&#039;b&#039;)&quot;&gt;&amp;");
  assert.equal(esc(null), "");
});

test("auth-lock rule: onAuthStateChange callback never awaits or calls Supabase", () => {
  const start = app.indexOf("supabase.auth.onAuthStateChange(");
  assert.ok(start > -1, "onAuthStateChange registered");
  // Take everything up to the "Data" section banner as the callback region.
  const end = app.indexOf("Data\n   ====", start);
  const block = app.slice(start, end > -1 ? end : undefined);
  // Remove deferred work (setTimeout bodies), which is allowed to call Supabase.
  const sync = block.replace(/setTimeout\(\s*\(\)\s*=>\s*\{[\s\S]*?\}\s*,\s*0\s*\)/g, "setTimeout(DEFERRED)");
  assert.doesNotMatch(sync, /\bawait\b/, "no await in synchronous part of callback");
  assert.doesNotMatch(sync, /supabase\.(from|rpc|auth\.(getSession|updateUser|signOut))/, "no Supabase calls in synchronous part");
});

test("client never inserts case_events (triggers own them)", () => {
  assert.doesNotMatch(app, /from\(\s*"case_events"\s*\)\s*\.insert/);
});

test("no HTML sink is fed raw (unescaped) case fields", () => {
  for (const field of ["c.title", "c.description", "c.source", "p.owner_email", "p.assignee_email", "ev.message", "x.message"]) {
    // Every occurrence inside the app must appear within an esc( ... ) or textContent assignment.
    const re = new RegExp(`(?<!esc\\(\\s*)(?<!\\(\\s*)${field.replace(".", "\\.")}(?![\\w.])`, "g");
    for (const hit of app.matchAll(re)) {
      const ctx = app.slice(Math.max(0, hit.index - 120), hit.index + 80);
      const safe = /esc\(|textContent|\.toLowerCase\(\)|\|\|\s*""|filter|includes/.test(ctx);
      assert.ok(safe, `${field} may be unescaped near: ${ctx.replace(/\s+/g, " ")}`);
    }
  }
});

/* ---------- static: wiring between files ---------- */

test("every static #id used by app.js exists in index.html", () => {
  const used = new Set([...app.matchAll(/\$\("#([A-Za-z0-9_-]+)"\)/g)].map(m => m[1]));
  const staticIds = new Set([...html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map(m => m[1]));
  const dynamicIds = new Set([...app.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map(m => m[1]));
  const missing = [...used].filter(id => !staticIds.has(id) && !dynamicIds.has(id));
  assert.deepEqual(missing, [], `ids referenced but never defined: ${missing.join(", ")}`);
});

test("modal triggers and data-close targets exist", () => {
  for (const id of ["openAuth", "heroAuth", "ctaAuth"]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} trigger`);
  }
  const targets = [...html.matchAll(/data-close="([^"]+)"/g)].map(m => m[1]);
  assert.ok(targets.length > 0, "close buttons exist");
  for (const t of targets) assert.match(html, new RegExp(`id="${t}"`), `data-close target #${t}`);
});

test("modal cards carry the class that focus management expects", () => {
  for (const id of ["authModal", "caseModal", "detailModal"]) {
    const m = html.match(new RegExp(`id="${id}"[\\s\\S]*?class="modal-card[ "]`));
    assert.ok(m, `#${id} contains .modal-card`);
  }
});

test("index.html references only files that exist and ship", () => {
  const refs = [...html.matchAll(/(?:src|href)="\.\/([^"#?]+)"/g)].map(m => m[1]);
  for (const r of refs) {
    assert.ok(existsSync(join(ROOT, r)), `${r} exists`);
    assert.ok(SHIPPED.includes(r), `${r} is in the shipped asset list`);
  }
});

test("Pages workflow copies every shipped asset", () => {
  for (const f of SHIPPED) {
    assert.ok(existsSync(join(ROOT, f)), `${f} exists in repo`);
    assert.ok(workflow.includes(f), `deploy.yml copies ${f}`);
  }
});

test("CSP allows what app.js needs and nothing obviously unsafe", () => {
  const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i)?.[1];
  assert.ok(csp, "CSP meta tag present");
  const supabaseUrl = config.match(/SUPABASE_URL\s*=\s*"([^"]+)"/)?.[1];
  assert.ok(supabaseUrl, "SUPABASE_URL set");
  const connect = csp.match(/connect-src([^;]*)/)?.[1] || "";
  const script = csp.match(/script-src([^;]*)/)?.[1] || "";
  assert.ok(connect.includes(new URL(supabaseUrl).host) || connect.includes("https://*.supabase.co"), "connect-src allows Supabase");
  assert.ok(script.includes("cdn.jsdelivr.net"), "script-src allows jsDelivr (supabase-js ESM import)");
  assert.doesNotMatch(script, /unsafe-eval/, "no unsafe-eval");
});

test("app.js imports from a pinned supabase-js version", () => {
  assert.match(app, /@supabase\/supabase-js@\d+\.\d+\.\d+\/\+esm/);
});

/* ---------- static: secrets & hygiene ---------- */

test("no secrets in shipped files", () => {
  const patterns = [
    [/service_role/i, "service_role"],
    [/sb_secret_[A-Za-z0-9_-]+/, "Supabase secret key"],
    [/github_pat_[A-Za-z0-9_]{20,}/, "GitHub fine-grained token"],
    [/\bghp_[A-Za-z0-9]{20,}/, "GitHub classic token"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
    [/AKIA[0-9A-Z]{16}/, "AWS access key id"]
  ];
  for (const f of SHIPPED) {
    const body = read(f);
    for (const [re, name] of patterns) assert.doesNotMatch(body, re, `${f} contains ${name}`);
  }
  // A JWT-shaped key is only acceptable if its role claim is anon.
  for (const jwt of config.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) || []) {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
    assert.notEqual(payload.role, "service_role", "config.js must not contain a service_role JWT");
  }
});

test("config.js exposes only a publishable key", () => {
  assert.match(config, /SUPABASE_URL\s*=\s*"https:\/\/[a-z0-9]+\.supabase\.co"/);
  assert.match(config, /SUPABASE_PUBLISHABLE_KEY\s*=\s*"[^"]{20,}"/);
  assert.doesNotMatch(config, /secret/i);
});

test(".env files are gitignored", () => {
  const ignore = read(".gitignore");
  assert.match(ignore, /^\.env$/m);
});

/* ---------- runtime: timedFetch ---------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Like real fetch: reject immediately if already aborted, otherwise on abort.
const hangUntilAbort = (_u, init) =>
  new Promise((_res, rej) => {
    if (init.signal.aborted) return rej(init.signal.reason);
    init.signal.addEventListener("abort", () => rej(init.signal.reason));
  });

function makeTimedFetch(stubFetch, timeoutMs) {
  const m = app.match(/function timedFetch\(input, init = \{\}\) \{[\s\S]*?\n\}\n/);
  assert.ok(m, "timedFetch() found");
  return new Function("fetch", "TIMEOUT_MS", `${m[0]}; return timedFetch;`)(stubFetch, timeoutMs);
}

test("timedFetch: a hung request is aborted with a TimeoutError", async () => {
  const tf = makeTimedFetch(
    hangUntilAbort,
    40
  );
  await assert.rejects(tf("https://x.test"), e => e.name === "TimeoutError");
});

test("timedFetch: a caller-supplied signal still cancels (and is not ignored)", async () => {
  const tf = makeTimedFetch(
    hangUntilAbort,
    5_000
  );
  const ctl = new AbortController();
  const pending = tf("https://x.test", { signal: ctl.signal });
  ctl.abort(new Error("caller cancelled"));
  await assert.rejects(pending, /caller cancelled/);

  const pre = new AbortController();
  pre.abort(new Error("already aborted"));
  await assert.rejects(tf("https://x.test", { signal: pre.signal }), /already aborted/);
});

test("timedFetch: a stalled response BODY is also timed out", async () => {
  let sig;
  const tf = makeTimedFetch((_u, init) => {
    sig = init.signal;
    return Promise.resolve(
      new Response(new ReadableStream({ start(c) { init.signal.addEventListener("abort", () => c.error(init.signal.reason)); } }))
    );
  }, 40);
  await tf("https://x.test"); // headers arrive immediately
  assert.equal(sig.aborted, false, "not aborted yet");
  await sleep(150);
  assert.equal(sig.aborted, true, "body stall aborted by timer");
});

test("timedFetch: a healthy response is returned intact and never aborted", async () => {
  let sig;
  const tf = makeTimedFetch((_u, init) => { sig = init.signal; return Promise.resolve(new Response("ok")); }, 40);
  const res = await tf("https://x.test");
  assert.equal(await res.text(), "ok");
  await sleep(120);
  assert.equal(sig.aborted, false, "timer cleared after body completed");
});

/* ---------- runtime: friendly() mappings added in the hardening review ---------- */

test("friendly(): rate limits, DB timeouts, permissions, sessions, and no internals leaked", () => {
  const m = app.match(/function friendly\(err\) \{[\s\S]*?\n\}\n/);
  const friendly = new Function("console", `${m[0]}; return friendly;`)({ warn() {} });

  assert.match(friendly({ status: 429, message: "Request rate limit reached" }), /Too many requests/);
  assert.match(friendly({ code: "over_email_send_rate_limit", message: "x" }), /Too many emails/);
  assert.match(friendly({ code: "57014", message: "canceling statement due to statement timeout" }), /took too long/);
  assert.match(friendly({ name: "TimeoutError", message: "Request timed out" }), /Network problem/);
  assert.match(friendly({ message: "JWT expired" }), /session has expired/i);

  const rls = friendly({ code: "42501", message: 'new row violates row-level security policy for table "recovery_cases"' });
  assert.match(rls, /permission/i);
  assert.doesNotMatch(rls, /recovery_cases|row-level/);

  const unknown = friendly(new Error('relation "secret_table" does not exist'));
  assert.equal(unknown, "Something went wrong. Please try again.");

  assert.equal(
    friendly({ name: "AuthWeakPasswordError", message: "Password should be at least 10 characters." }),
    "Password should be at least 10 characters."
  );
});

/* ---------- static: review fixes ---------- */

test("modals: page is made inert while open, and un-inerted BEFORE focus is restored", () => {
  const open = app.slice(app.indexOf("function openModal("), app.indexOf("function closeModal("));
  const close = app.slice(app.indexOf("function closeModal("), app.indexOf("function notice("));
  assert.match(open, /syncInert\(\)/, "openModal makes the page inert");
  assert.ok(close.indexOf("syncInert()") > -1, "closeModal syncs inert");
  assert.ok(close.indexOf("syncInert()") < close.indexOf("focusSafely(back)"), "inert cleared before focus restore");
  assert.match(close, /\.side-btn\.active, #openAuth/, "stable fallback focus target");
});

test("detail modal re-render preserves focus, scroll and unsent input (per-case)", () => {
  assert.match(app, /detailModal\.dataset\.caseId === id/, "reuse only for the same open case");
  assert.match(app, /draftEl\.value !== draftEl\.defaultValue/, "draft detection");
  assert.match(app, /focusSafely\(el\)/, "focus restore");
});

test("loadCases ignores superseded responses", () => {
  assert.match(app, /const seq = \+\+loadSeq/);
  assert.equal((app.match(/if \(seq !== loadSeq\) return;/g) || []).length, 2, "checked after both awaits");
});

test("results re-render without rebuilding the toolbar or losing focus", () => {
  assert.match(app, /if \(\$\("#fQ"\) && \$\("#caseResults"\)\) \{\s*return renderCaseResults\(\);/);
  assert.match(app, /function paintCaseResults\(\)/);
});

test("in-flight guards and keyboard support", () => {
  assert.match(app, /aria-busy/);
  assert.match(app, /e\.key !== "Enter" && e\.key !== " "/);
  assert.match(app, /class="activity"[\s\S]{0,80}tabindex="0" role="button"/);
});

test("styles: workspace hides landing chrome; busy state styled", () => {
  const css = read("styles.css");
  assert.match(css, /\.in-app \.site-header,\.in-app \.footer\{display:none\}/);
  assert.match(css, /\[aria-busy="true"\]/);
});

/* ---------- static: migrations can rebuild the database ---------- */

test("migrations define every table, RLS enablement, and every policy (no schema only in the dashboard)", () => {
  const dir = join(ROOT, "supabase", "migrations");
  const files = readdirSync(dir).filter(f => f.endsWith(".sql")).sort();
  assert.ok(files.length >= 4, "baseline + hardening migrations present");
  assert.match(files[0], /baseline/i, "baseline sorts first");
  const sql = files.map(f => readFileSync(join(dir, f), "utf8")).join("\n");

  for (const t of ["profiles", "recovery_cases", "case_events"]) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${t}\\b`, "i"), `creates ${t}`);
    assert.match(sql, new RegExp(`alter table public\\.${t}\\s+enable row level security`, "i"), `enables RLS on ${t}`);
  }
  const policies = [...sql.matchAll(/create policy (\w+) on/gi)].map(m => m[1]).sort();
  assert.deepEqual(policies, [
    "cases_insert_owned", "cases_select_owned_or_assigned", "cases_update_owned_or_assigned",
    "events_select_case_access", "profiles_insert_own", "profiles_select_own", "profiles_update_own"
  ]);
  assert.match(sql, /create trigger on_auth_user_created after insert on auth\.users/i, "signup trigger");
  // Cases are a permanent record: nothing may (re)introduce client deletes or event writes.
  assert.doesNotMatch(sql.split(/revoke delete on public\.recovery_cases/i).pop(), /create policy \w+ on public\.recovery_cases\s+for delete/i);
});

/* ---------- live (opt-in) ---------- */

const BASE = (process.env.BASE_URL || "").replace(/\/$/, "");
const live = BASE ? test : test.skip;

live("live: all shipped assets resolve with 200", async () => {
  for (const f of ["", ...SHIPPED.filter(x => x !== "index.html")]) {
    const res = await fetch(`${BASE}/${f}`, { redirect: "follow" });
    assert.equal(res.status, 200, `${BASE}/${f} -> ${res.status}`);
  }
});

live("live: deployed app.js matches the committed file", async () => {
  const res = await fetch(`${BASE}/app.js`, { headers: { "cache-control": "no-cache" } });
  assert.equal(res.status, 200);
  const remote = await res.text();
  assert.equal(sha256(remote), sha256(app), "deployed app.js differs from repo (stale deploy or CDN cache?)");
});

live("live: landing page serves the expected shell", async () => {
  const body = await (await fetch(`${BASE}/`)).text();
  const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
  assert.ok(title && title.startsWith("RecoverDesk"), "repo index.html has a RecoverDesk title");
  assert.ok(body.includes(`<title>${title}</title>`), `live <title> matches repo: ${title}`);
  assert.match(body, /id="openAuth"/);
  assert.match(body, /\.\/app\.js/);
});
