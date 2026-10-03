import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/+esm";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const $ = s => document.querySelector(s);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
const label = s => String(s || "").replaceAll("_", " ");
const fmt = d => (d ? new Date(d).toLocaleString() : "—");

const STATUSES = ["open", "in_progress", "resolved", "closed"];
const PRIORITIES = ["low", "normal", "high", "urgent"];
const NEXT = { open: "in_progress", in_progress: "resolved", resolved: "closed", closed: "open" };
const NEXT_LABEL = { in_progress: "Start", resolved: "Resolve", closed: "Close", open: "Reopen" };
const DONE = ["resolved", "closed"];

const state = {
  user: null, cases: [], people: {}, view: "cases", detailId: null, loadedFor: null, signUp: false,
  filters: { q: "", status: "all", priority: "all", scope: "all" }
};

/* ---------- modals, notices, toasts ---------- */
const authModal = $("#authModal"), caseModal = $("#caseModal"), detailModal = $("#detailModal");
const openModal = m => m.classList.remove("hidden");
const closeModal = m => { m.classList.add("hidden"); if (m === detailModal) state.detailId = null; };
function notice(el, msg, err = false) { el.textContent = msg; el.className = "notice" + (err ? " error" : ""); }
let toastTimer;
function toast(msg, ok = true) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (ok ? " ok" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 4000);
}
["openAuth", "heroAuth", "ctaAuth"].forEach(id => $("#" + id).addEventListener("click", () => openModal(authModal)));
document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => closeModal($("#" + b.dataset.close))));
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  for (const m of [detailModal, caseModal, authModal]) if (!m.classList.contains("hidden")) { closeModal(m); break; }
});

/* ---------- auth ---------- */
$("#toggleAuth").addEventListener("click", () => {
  state.signUp = !state.signUp;
  $("#authSubmit").textContent = state.signUp ? "Create account" : "Sign in";
  $("#toggleAuth").textContent = state.signUp ? "Already have an account? Sign in" : "Need an account? Create one";
  $("#authTitle").textContent = state.signUp ? "Create your RecoverDesk account" : "Enter RecoverDesk";
  $("#authPassword").autocomplete = state.signUp ? "new-password" : "current-password";
});

$("#authForm").addEventListener("submit", async e => {
  e.preventDefault();
  const msg = $("#authMessage"), btn = $("#authSubmit");
  const email = $("#authEmail").value.trim(), password = $("#authPassword").value;
  btn.disabled = true;
  notice(msg, "Working…");
  const r = state.signUp
    ? await supabase.auth.signUp({ email, password })
    : await supabase.auth.signInWithPassword({ email, password });
  btn.disabled = false;
  if (r.error) return notice(msg, r.error.message, true);
  if (state.signUp && !r.data.session) return notice(msg, "Account created. Check your email to confirm access.");
  closeModal(authModal);
});

$("#forgotAuth").addEventListener("click", async () => {
  const msg = $("#authMessage"), email = $("#authEmail").value.trim();
  if (!email) return notice(msg, "Enter your email above, then choose Forgot password.", true);
  notice(msg, "Sending reset link…");
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  if (error) return notice(msg, error.message, true);
  notice(msg, "If an account exists for that email, a reset link is on its way.");
});

function showRecovery() {
  state.detailId = null;
  $("#detailEyebrow").textContent = "ACCOUNT";
  $("#detailTitle").textContent = "Set a new password";
  $("#detailBody").innerHTML =
    '<form id="recoveryForm"><input id="newPassword" type="password" minlength="10" autocomplete="new-password" placeholder="New password (10+ characters)" aria-label="New password" required>' +
    '<button class="btn btn-primary" type="submit">Update password</button></form><div class="notice" id="recoveryMessage" role="status"></div>';
  $("#recoveryForm").addEventListener("submit", async e => {
    e.preventDefault();
    const msg = $("#recoveryMessage");
    notice(msg, "Updating…");
    const { error } = await supabase.auth.updateUser({ password: $("#newPassword").value });
    if (error) return notice(msg, error.message, true);
    history.replaceState(null, "", location.pathname + location.search);
    closeModal(detailModal);
    toast("Password updated.");
  });
  openModal(detailModal);
}

// Never await Supabase calls inside this callback (auth-lock deadlock, fixed in 560b93c): defer with setTimeout.
supabase.auth.onAuthStateChange((event, session) => {
  state.user = session?.user || null;
  if (event === "PASSWORD_RECOVERY") setTimeout(() => { closeModal(authModal); showRecovery(); }, 0);
  if (event === "SIGNED_OUT") { state.loadedFor = null; return; }
  if (state.user && state.loadedFor !== state.user.id) {
    state.loadedFor = state.user.id;
    closeModal(authModal);
    setTimeout(() => { loadCases(); }, 0);
  }
});

/* ---------- data ---------- */
async function loadCases() {
  if (!state.user) return;
  const { data, error } = await supabase.from("recovery_cases").select("*").order("created_at", { ascending: false }).limit(500);
  if (error) { console.error(error); toast("Could not load cases.", false); return; }
  state.cases = data || [];
  state.people = {};
  if (state.cases.length) {
    const { data: ppl, error: pe } = await supabase.rpc("case_people", { p_cases: state.cases.map(c => c.id) });
    if (!pe) for (const p of ppl || []) state.people[p.case_id] = p;
  }
  renderWorkspace();
  if (state.detailId) renderDetail(state.detailId);
}

async function updateCase(id, patch, okMsg) {
  const { data, error } = await supabase.from("recovery_cases").update(patch).eq("id", id).select("id");
  if (error) { toast(error.message, false); return false; }
  if (!data || !data.length) { toast("That change isn't permitted.", false); return false; }
  if (okMsg) toast(okMsg);
  await loadCases();
  return true;
}

/* ---------- workspace ---------- */
function renderWorkspace() {
  document.body.classList.add("in-app");
  if (!$("#workspace")) {
    document.querySelector("main").innerHTML =
      '<section class="container app-shell" id="workspace"><aside class="sidebar"><div class="brand"><span class="brand-mark">R</span><span>RecoverDesk</span></div><div class="side-note">Recovery operations</div>' +
      '<button class="side-btn active" data-view="cases">Cases</button><button class="side-btn" data-view="activity">Activity</button>' +
      '<div class="side-bottom"><small>' + esc(state.user.email) + '</small><button class="text-btn" id="signOut">Sign out</button></div></aside>' +
      '<section class="app-main"><div class="app-top"><div><div class="eyebrow">WORKSPACE</div><h1>Recovery desk</h1></div><button class="btn btn-primary" id="newCase">New case</button></div><div id="view"></div></section></section>';
    bindWorkspace();
    state.view = "cases";
  }
  renderView(state.view);
}

function bindWorkspace() {
  $("#newCase").addEventListener("click", () => { notice($("#caseMessage"), ""); openModal(caseModal); });
  $("#signOut").addEventListener("click", async () => { await supabase.auth.signOut(); location.reload(); });
  document.querySelectorAll(".side-btn").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll(".side-btn").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    renderView(b.dataset.view);
  }));
}

function renderView(view) {
  state.view = view;
  if (view === "activity") return renderActivity();
  renderCasesView();
}

const opts = (list, sel, allLabel) =>
  (allLabel ? '<option value="all">' + allLabel + "</option>" : "") +
  list.map(x => '<option value="' + x + '"' + (x === sel ? " selected" : "") + ">" + esc(label(x)) + "</option>").join("");

function renderCasesView() {
  const f = state.filters;
  $("#view").innerHTML =
    '<div class="toolbar"><input id="fQ" type="search" placeholder="Search cases" aria-label="Search cases" value="' + esc(f.q) + '">' +
    '<select id="fStatus" aria-label="Filter by status">' + opts(STATUSES, f.status, "All statuses") + "</select>" +
    '<select id="fPriority" aria-label="Filter by priority">' + opts(PRIORITIES, f.priority, "All priorities") + "</select>" +
    '<select id="fScope" aria-label="Filter by ownership"><option value="all">All cases</option><option value="owned">Owned by me</option><option value="assigned">Assigned to me</option></select></div>' +
    '<div id="caseResults"></div>';
  $("#fStatus").value = f.status; $("#fPriority").value = f.priority; $("#fScope").value = f.scope;
  $("#fQ").addEventListener("input", e => { f.q = e.target.value; renderCaseResults(); });
  $("#fStatus").addEventListener("change", e => { f.status = e.target.value; renderCaseResults(); });
  $("#fPriority").addEventListener("change", e => { f.priority = e.target.value; renderCaseResults(); });
  $("#fScope").addEventListener("change", e => { f.scope = e.target.value; renderCaseResults(); });
  $("#caseResults").addEventListener("click", e => {
    const act = e.target.closest("[data-status]");
    if (act) return void updateCase(act.dataset.id, { status: act.dataset.status }, "Status updated");
    const card = e.target.closest("[data-open]");
    if (card) openDetail(card.dataset.open);
  });
  $("#caseResults").addEventListener("keydown", e => {
    if (e.key !== "Enter" || e.target.closest("button")) return;
    const card = e.target.closest("[data-open]");
    if (card) openDetail(card.dataset.open);
  });
  renderCaseResults();
}

function filteredCases() {
  const f = state.filters, q = f.q.trim().toLowerCase(), uid = state.user.id;
  return state.cases.filter(c =>
    (f.status === "all" || c.status === f.status) &&
    (f.priority === "all" || c.priority === f.priority) &&
    (f.scope === "all" || (f.scope === "owned" ? c.owner_id === uid : c.assigned_to === uid)) &&
    (!q || (c.title + " " + (c.description || "") + " " + (c.source || "")).toLowerCase().includes(q)));
}

const isOverdue = c => !!c.due_at && !DONE.includes(c.status) && new Date(c.due_at) < new Date();

function renderCaseResults() {
  const all = state.cases, list = filteredCases();
  const n = s => all.filter(c => c.status === s).length;
  const urgent = all.filter(c => c.priority === "urgent").length;
  $("#caseResults").innerHTML =
    '<div class="stats"><div><span>Open</span><strong>' + n("open") + "</strong></div><div><span>In progress</span><strong>" + n("in_progress") +
    "</strong></div><div><span>Urgent</span><strong>" + urgent + "</strong></div><div><span>Resolved</span><strong>" + (n("resolved") + n("closed")) + "</strong></div></div>" +
    '<div class="panel"><div class="panel-head"><h3>Cases</h3><span>' + list.length + (list.length === all.length ? " total" : " of " + all.length) + '</span></div><div class="case-list">' +
    (list.length ? list.map(caseCard).join("") : '<div class="empty">' + (all.length ? "No cases match these filters." : "No recovery cases yet. Create the first one.") + "</div>") +
    "</div></div>";
}

function caseCard(c) {
  const next = NEXT[c.status];
  const badges =
    (isOverdue(c) ? '<span class="badge overdue">Overdue</span>' : "") +
    (c.assigned_to === state.user.id ? '<span class="badge mine">Assigned to you</span>' : "");
  return '<article class="case" data-open="' + esc(c.id) + '" tabindex="0"><div class="case-main"><div class="case-meta"><span class="pill ' + esc(c.priority) + '">' + esc(c.priority) +
    "</span><span>" + esc(label(c.status)) + "</span>" + badges + "</div><h3>" + esc(c.title) + "</h3><p>" + esc(c.description || "No description") +
    "</p><small>" + esc(fmt(c.created_at)) + (c.source ? " · " + esc(c.source) : "") + "</small></div>" +
    '<button class="btn btn-small" data-id="' + esc(c.id) + '" data-status="' + next + '">' + NEXT_LABEL[next] + "</button></article>";
}

/* ---------- case creation ---------- */
$("#caseForm").addEventListener("submit", async e => {
  e.preventDefault();
  const msg = $("#caseMessage"), btn = $("#caseSubmit");
  btn.disabled = true;
  notice(msg, "Creating…");
  const payload = {
    owner_id: state.user.id,
    title: $("#caseTitle").value.trim(),
    description: $("#caseDescription").value.trim() || null,
    priority: $("#casePriority").value,
    source: $("#caseSource").value.trim() || null,
    due_at: $("#caseDue").value ? new Date($("#caseDue").value).toISOString() : null
  };
  // case_events rows are written by database triggers; the client never inserts them.
  const { error } = await supabase.from("recovery_cases").insert(payload);
  btn.disabled = false;
  if (error) return notice(msg, error.message, true);
  e.target.reset();
  closeModal(caseModal);
  toast("Case created.");
  await loadCases();
});

/* ---------- case detail ---------- */
function openDetail(id) { state.detailId = id; renderDetail(id); openModal(detailModal); }

function renderDetail(id) {
  const c = state.cases.find(x => x.id === id);
  if (!c) return closeModal(detailModal);
  const uid = state.user.id, isOwner = c.owner_id === uid, p = state.people[id] || {};
  $("#detailEyebrow").textContent = "CASE · " + label(c.status).toUpperCase();
  $("#detailTitle").textContent = c.title;
  $("#detailBody").innerHTML =
    '<p class="kv"><b>Owner:</b> ' + esc(p.owner_email || (isOwner ? "You" : "—")) + "</p>" +
    '<p class="kv"><b>Assignee:</b> ' + esc(p.assignee_email || (c.assigned_to === uid ? "You" : "Unassigned")) + (c.assigned_to === uid ? ' <span class="badge mine">Assigned to you</span>' : "") + "</p>" +
    '<p class="kv"><b>Source:</b> ' + esc(c.source || "—") + "</p>" +
    '<p class="kv"><b>Due:</b> ' + esc(fmt(c.due_at)) + (isOverdue(c) ? ' <span class="badge overdue">Overdue</span>' : "") + "</p>" +
    '<p class="kv"><b>Created:</b> ' + esc(fmt(c.created_at)) + " · <b>Updated:</b> " + esc(fmt(c.updated_at)) + (c.resolved_at ? " · <b>Resolved:</b> " + esc(fmt(c.resolved_at)) : "") + "</p>" +
    "<p>" + esc(c.description || "No description") + "</p>" +
    '<div class="detail-row"><select id="dStatus" aria-label="Status">' + opts(STATUSES, c.status) + '</select><select id="dPriority" aria-label="Priority">' + opts(PRIORITIES, c.priority) + "</select></div>" +
    (isOwner
      ? '<div class="detail-row"><input id="dAssignee" type="email" placeholder="Assignee email (blank to unassign)" aria-label="Assignee email" value="' + esc(p.assignee_email || "") + '"><button class="btn btn-small" id="dAssign" type="button">Assign</button></div>'
      : "") +
    '<h3>Timeline</h3><ul class="timeline" id="timeline"><li>Loading…</li></ul>';

  $("#dStatus").addEventListener("change", e => updateCase(id, { status: e.target.value }, "Status updated"));
  $("#dPriority").addEventListener("change", e => updateCase(id, { priority: e.target.value }, "Priority updated"));
  if (isOwner) {
    $("#dAssign").addEventListener("click", async e => {
      const btn = e.currentTarget, email = $("#dAssignee").value.trim();
      btn.disabled = true;
      const { data, error } = await supabase.rpc("assign_case", { p_case: id, p_email: email });
      btn.disabled = false;
      if (error) return toast(error.message, false);
      if (data === false) return toast("No account found for that email.", false);
      toast(email ? "Case assigned." : "Case unassigned.");
      await loadCases();
    });
  }
  loadTimeline(id, c, p);
}

async function loadTimeline(id, c, p) {
  const { data, error } = await supabase.from("case_events").select("id,event_type,message,actor_id,created_at").eq("case_id", id).order("created_at", { ascending: false });
  if (state.detailId !== id) return;
  const ul = $("#timeline");
  if (!ul) return;
  if (error) { ul.innerHTML = "<li>Could not load timeline.</li>"; return; }
  const who = a => (a === state.user.id ? "You" : a === c.owner_id ? (p.owner_email || "Owner") : a === c.assigned_to ? (p.assignee_email || "Assignee") : "Someone");
  ul.innerHTML = (data || []).length
    ? data.map(ev => "<li><b>" + esc(ev.message || label(ev.event_type)) + "</b><small>" + esc(who(ev.actor_id)) + " · " + esc(fmt(ev.created_at)) + "</small></li>").join("")
    : "<li>No events yet.</li>";
}

/* ---------- activity ---------- */
async function renderActivity() {
  $("#view").innerHTML = '<div class="panel"><h3>Recent activity</h3><div id="activityList">Loading…</div></div>';
  const { data, error } = await supabase.from("case_events").select("id,event_type,message,case_id,created_at,recovery_cases(title)").order("created_at", { ascending: false }).limit(50);
  const box = $("#activityList");
  if (!box || state.view !== "activity") return;
  box.innerHTML = error ? '<div class="empty">Could not load activity.</div>'
    : (data || []).length
      ? data.map(x => '<div class="activity" data-open="' + esc(x.case_id) + '"><b>' + esc(label(x.event_type)) + "</b><span>" + esc(x.recovery_cases?.title || "") + "</span><small>" + esc(x.message || "") + " · " + esc(fmt(x.created_at)) + "</small></div>").join("")
      : '<div class="empty">No activity yet.</div>';
  box.addEventListener("click", e => {
    const row = e.target.closest("[data-open]");
    if (row && state.cases.some(c => c.id === row.dataset.open)) openDetail(row.dataset.open);
  });
}

/* ---------- init ---------- */
const { data: { session } } = await supabase.auth.getSession();
if (session && state.loadedFor !== session.user.id) {
  state.user = session.user;
  state.loadedFor = session.user.id;
  await loadCases();
}
