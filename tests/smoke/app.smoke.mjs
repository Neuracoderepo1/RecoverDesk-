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
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
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

const SHIPPED = ["index.html", "app.js", "config.js", "styles.css", "favicon.svg", "vendor/supabase.js"];

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
    const top = f.split("/")[0]; // directories are copied with `cp -r`, so match the top-level name
    assert.ok(workflow.includes(top), `deploy.yml copies ${top}`);
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
  assert.match(script, /^\s*'self'\s*$/, "script-src is 'self' only (supabase-js is vendored)");
  assert.doesNotMatch(script, /unsafe-eval/, "no unsafe-eval");
});

test("app.js imports the vendored supabase-js, not a CDN", () => {
  assert.match(app, /from\s+"\.\/vendor\/supabase\.js"/);
  assert.doesNotMatch(app, /from\s+"https?:/, "no remote module imports");
  assert.doesNotMatch(html, /<script[^>]+src="https?:/, "no remote <script> tags in index.html");
  assert.ok(read("vendor/supabase.js").includes("createClient"), "vendor bundle exports createClient");
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
