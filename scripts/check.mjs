// Dependency-free gate: syntax, asset references, CSP, config sanity and secret scan.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

let failed = 0;
const fail = (m) => { failed++; console.error("FAIL  " + m); };
const ok = (m) => console.log("ok    " + m);

// 1. JavaScript syntax
for (const f of ["app.js", "config.js", "scripts/check.mjs", "tests/e2e/workspace.spec.mjs"]) {
  if (!existsSync(f)) continue;
  try { execSync(`node --check ${f}`, { stdio: "pipe" }); ok("syntax " + f); } catch (e) { fail("syntax " + f + "\n" + e.stderr); }
}

// 2. index.html references exist and security headers present
const html = readFileSync("index.html", "utf8");
for (const m of html.matchAll(/(?:src|href)="\.\/([^"#?]+)"/g)) existsSync(m[1]) ? ok("asset " + m[1]) : fail("missing asset " + m[1]);
/Content-Security-Policy/.test(html) ? ok("CSP present") : fail("CSP missing");
/script-src [^;]*'unsafe-(inline|eval)'/.test(html) ? fail("CSP allows unsafe script") : ok("CSP has no unsafe-inline/eval for scripts");
/<script(?![^>]*\bsrc=)[^>]*>/.test(html) ? fail("inline <script> found") : ok("no inline scripts");

// 3. Config sanity: only the public publishable/anon key may appear
const cfg = readFileSync("config.js", "utf8");
/SUPABASE_URL\s*=\s*"https:\/\/[a-z0-9]+\.supabase\.co"/.test(cfg) ? ok("config URL") : fail("config URL malformed");
const jwt = cfg.match(/eyJ[\w-]+\.([\w-]+)\.[\w-]+/);
if (jwt) {
  const claims = JSON.parse(Buffer.from(jwt[1], "base64url").toString());
  claims.role === "anon" ? ok("config key role=anon") : fail("config key role is " + claims.role);
} else if (/sb_publishable_/.test(cfg)) ok("config publishable key"); else fail("no publishable key in config.js");

// 4. Secret scan over the working tree (and history when available)
const PATTERNS = [
  [/sb_secret_[\w-]{10,}/, "Supabase secret key"],
  [/-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/, "private key"],
  [/github_pat_[\w]{20,}|ghp_[\w]{30,}|gho_[\w]{30,}/, "GitHub token"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key"],
  [/xox[abprs]-[\w-]{10,}/, "Slack token"],
  [/postgres(?:ql)?:\/\/[^\s:@]+:[^\s@]+@/, "database URL with password"],
  [/smtp[_-]?pass(?:word)?\s*[:=]\s*["']?[^\s"']{4,}/i, "SMTP password"],
  [/sk-[A-Za-z0-9]{32,}/, "API secret"],
];
const walk = (d) => readdirSync(d).flatMap((n) => {
  if ([".git", "node_modules", "vendor"].includes(n)) return [];
  const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p];
});
for (const f of walk(".")) {
  if (f.endsWith("scripts/check.mjs") || f.endsWith("scripts\\check.mjs")) continue;
  const t = readFileSync(f, "utf8");
  for (const [re, label] of PATTERNS) if (re.test(t)) fail(`${label} in ${f}`);
  for (const m of t.matchAll(/eyJ[\w-]+\.([\w-]+)\.[\w-]+/g)) {
    try { if (JSON.parse(Buffer.from(m[1], "base64url").toString()).role === "service_role") fail("service_role JWT in " + f); } catch { /* not a JWT */ }
  }
}
for (const f of walk(".")) if (/(^|\/)\.env(\.|$)/.test(f)) fail(".env file committed: " + f);
ok("secret scan (working tree)");
try {
  const hist = execSync("git log -p --all --no-color", { maxBuffer: 256 * 1024 * 1024 }).toString();
  let bad = false;
  for (const [re, label] of PATTERNS) if (re.test(hist)) { fail(`${label} in git history`); bad = true; }
  for (const m of hist.matchAll(/eyJ[\w-]+\.([\w-]+)\.[\w-]+/g)) {
    try { if (JSON.parse(Buffer.from(m[1], "base64url").toString()).role === "service_role") { fail("service_role JWT in git history"); bad = true; } } catch { /* ignore */ }
  }
  if (!bad) ok("secret scan (git history)");
} catch { console.log("skip  git history scan (no git)"); }

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
