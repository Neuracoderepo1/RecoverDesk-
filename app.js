import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/+esm";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

/* =========================================================
   RecoverDesk — hardened application client
   ========================================================= */

const TIMEOUT_MS = 20_000;

/* ---------- network timeout ---------- */

function timedFetch(input, init = {}) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort(
      new DOMException("Request timed out", "TimeoutError")
    );
  }, TIMEOUT_MS);

  // Honour a caller-supplied signal as well as our own timeout.
  const outer = init.signal;

  if (outer) {
    if (outer.aborted) {
      controller.abort(outer.reason);
    } else {
      outer.addEventListener(
        "abort",
        () => controller.abort(outer.reason),
        { once: true }
      );
    }
  }

  const stop = () => clearTimeout(timer);

  return fetch(input, { ...init, signal: controller.signal }).then(
    res => {
      // Keep the timer running until the body has arrived, so a
      // stalled response body is covered as well as the headers.
      try {
        res.clone().arrayBuffer().then(stop, stop);
      } catch {
        stop();
      }

      return res;
    },
    error => {
      stop();
      throw error;
    }
  );
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  {
    global: {
      fetch: timedFetch
    }
  }
);

/* ---------- helpers ---------- */

const $ = s => document.querySelector(s);

const esc = v =>
  String(v ?? "").replace(
    /[&<>"']/g,
    c => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[c])
  );

const label = s =>
  String(s || "")
    .replaceAll("_", " ")
    .replace(/\s+/g, " ")
    .trim();

const fmt = d =>
  d ? new Date(d).toLocaleString() : "—";

const STATUSES = [
  "open",
  "in_progress",
  "resolved",
  "closed"
];

const PRIORITIES = [
  "low",
  "normal",
  "high",
  "urgent"
];

const NEXT = {
  open: "in_progress",
  in_progress: "resolved",
  resolved: "closed",
  closed: "open"
};

const NEXT_LABEL = {
  in_progress: "Start",
  resolved: "Resolve",
  closed: "Close",
  open: "Reopen"
};

const DONE = [
  "resolved",
  "closed"
];

/* =========================================================
   Application state
   ========================================================= */

const state = {
  user: null,
  cases: [],
  people: {},
  view: "cases",
  detailId: null,
  loadedFor: null,
  signUp: false,
  filters: {
    q: "",
    status: "all",
    priority: "all",
    scope: "all"
  }
};

/* =========================================================
   Error normalization
   ========================================================= */

function friendly(err) {
  const raw = String(
    err?.message ||
    err?.error_description ||
    err ||
    ""
  );

  const msg = raw.toLowerCase();
  const code = String(err?.code || err?.error_code || "").toLowerCase();
  const name = String(err?.name || "");
  const status = Number(err?.status);

  if (
    code === "over_email_send_rate_limit" ||
    msg.includes("over_email_send_rate_limit") ||
    msg.includes("email rate limit")
  ) {
    return "Too many emails were sent recently. Please wait a while before trying again.";
  }

  if (
    status === 429 ||
    msg.includes("rate limit") ||
    msg.includes("too many requests")
  ) {
    return "Too many requests. Please wait a moment and try again.";
  }

  if (
    code === "57014" ||
    msg.includes("statement timeout") ||
    msg.includes("canceling statement")
  ) {
    return "The server took too long to respond. Please try again.";
  }

  if (
    name === "AbortError" ||
    name === "TimeoutError" ||
    msg.includes("failed to fetch") ||
    msg.includes("networkerror") ||
    msg.includes("network request") ||
    msg.includes("network problem") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("aborterror") ||
    msg.includes("aborted") ||
    msg.includes("load failed") ||
    msg.includes("failed to load")
  ) {
    return "Network problem — check your connection and try again.";
  }

  if (
    code === "42501" ||
    msg.includes("row-level security") ||
    msg.includes("permission denied") ||
    msg.includes("not permitted") ||
    msg.includes("only the owner")
  ) {
    return "You don't have permission to do that.";
  }

  if (
    msg.includes("jwt expired") ||
    msg.includes("invalid jwt") ||
    msg.includes("refresh token")
  ) {
    return "Your session has expired. Please sign in again.";
  }

  if (
    msg.includes("email not confirmed") ||
    msg.includes("email_not_confirmed")
  ) {
    return "Please confirm your email first — check your inbox for the link.";
  }

  if (
    msg.includes("invalid login credentials") ||
    msg.includes("invalid_credentials")
  ) {
    return "Incorrect email or password.";
  }

  if (
    msg.includes("already registered") ||
    msg.includes("user already registered")
  ) {
    return "An account with this email already exists. Try signing in.";
  }

  // Auth errors carry user-facing text (for example, a weak password).
  if (name.startsWith("Auth") && raw) {
    return raw;
  }

  // Anything else may contain internals (SQL, policy names): log it,
  // but never show it.
  console.warn("Unmapped error:", err);

  return "Something went wrong. Please try again.";
}

/* =========================================================
   Modal management
   ========================================================= */

const authModal = $("#authModal");
const caseModal = $("#caseModal");
const detailModal = $("#detailModal");

const returnFocus = new Map();

const modals = [authModal, caseModal, detailModal];

/*
  While any modal is open, the rest of the page is made inert so that
  keyboard focus and assistive technology cannot reach content behind it.
*/
function syncInert() {
  const anyOpen = modals.some(
    m => m && !m.classList.contains("hidden")
  );

  document
    .querySelectorAll("body > :not(.modal):not(script):not(#toast)")
    .forEach(el => {
      if (anyOpen) {
        el.setAttribute("inert", "");
      } else {
        el.removeAttribute("inert");
      }
    });
}

function focusSafely(el) {
  try {
    el.focus({ preventScroll: true });
  } catch {
    el.focus();
  }
}

function openModal(m) {
  if (!m) return;

  if (m.classList.contains("hidden")) {
    returnFocus.set(m, document.activeElement);
  }

  m.classList.remove("hidden");

  syncInert();

  const card = m.querySelector(".modal-card");

  if (card) {
    card.setAttribute("tabindex", "-1");
    focusSafely(card);
  }
}

function closeModal(m) {
  if (!m) return;

  m.classList.add("hidden");

  if (m === detailModal) {
    state.detailId = null;
    delete detailModal.dataset.caseId;
  }

  // Un-inert the page before restoring focus, or focus() is refused.
  syncInert();

  const back = returnFocus.get(m);

  returnFocus.delete(m);

  if (
    back &&
    back !== document.body &&
    back.isConnected &&
    typeof back.focus === "function"
  ) {
    focusSafely(back);
    return;
  }

  // The opener was re-rendered away: land on a stable control instead.
  const fallback = document.querySelector(
    ".side-btn.active, #openAuth"
  );

  if (fallback) {
    focusSafely(fallback);
  }
}

function notice(el, msg, err = false) {
  if (!el) return;

  el.textContent = msg;
  el.className = "notice" + (err ? " error" : "");
}

let toastTimer;

function toast(msg, ok = true) {
  const t = $("#toast");

  if (!t) return;

  t.textContent = msg;
  t.className = "toast" + (ok ? " ok" : "");

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    t.classList.add("hidden");
  }, 4000);
}

/* ---------- modal triggers ---------- */

["openAuth", "heroAuth", "ctaAuth"].forEach(id => {
  const button = $("#" + id);

  if (button) {
    button.addEventListener("click", () => {
      openModal(authModal);
    });
  }
});

document.querySelectorAll("[data-close]").forEach(button => {
  button.addEventListener("click", () => {
    closeModal($("#" + button.dataset.close));
  });
});

document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;

  for (const modal of [
    detailModal,
    caseModal,
    authModal
  ]) {
    if (modal && !modal.classList.contains("hidden")) {
      closeModal(modal);
      break;
    }
  }
});

/* =========================================================
   Authentication
   ========================================================= */

$("#toggleAuth").addEventListener("click", () => {
  state.signUp = !state.signUp;

  $("#authSubmit").textContent =
    state.signUp
      ? "Create account"
      : "Sign in";

  $("#toggleAuth").textContent =
    state.signUp
      ? "Already have an account? Sign in"
      : "Need an account? Create one";

  $("#authTitle").textContent =
    state.signUp
      ? "Create your RecoverDesk account"
      : "Enter RecoverDesk";

  $("#authPassword").autocomplete =
    state.signUp
      ? "new-password"
      : "current-password";
});

$("#authForm").addEventListener("submit", async e => {
  e.preventDefault();

  const msg = $("#authMessage");
  const btn = $("#authSubmit");

  const email = $("#authEmail").value.trim();
  const password = $("#authPassword").value;

  btn.disabled = true;
  notice(msg, "Working…");

  try {
    const r = state.signUp
      ? await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo:
              location.origin + location.pathname
          }
        })
      : await supabase.auth.signInWithPassword({
          email,
          password
        });

    if (r.error) {
      return notice(
        msg,
        friendly(r.error),
        true
      );
    }

    if (
      state.signUp &&
      !r.data.session
    ) {
      return notice(
        msg,
        "Almost there — check your email for a confirmation link. Already registered? Just sign in."
      );
    }

    closeModal(authModal);
  } catch (error) {
    console.error(error);
    notice(msg, friendly(error), true);
  } finally {
    btn.disabled = false;
  }
});

$("#forgotAuth").addEventListener("click", async () => {
  const msg = $("#authMessage");
  const email = $("#authEmail").value.trim();

  if (!email) {
    return notice(
      msg,
      "Enter your email above, then choose Forgot password.",
      true
    );
  }

  notice(msg, "Sending reset link…");

  try {
    const { error } =
      await supabase.auth.resetPasswordForEmail(
        email,
        {
          redirectTo:
            location.origin + location.pathname
        }
      );

    if (error) {
      return notice(
        msg,
        friendly(error),
        true
      );
    }

    notice(
      msg,
      "If an account exists for that email, a reset link is on its way."
    );
  } catch (error) {
    console.error(error);

    notice(
      msg,
      friendly(error),
      true
    );
  }
});

/* =========================================================
   Password recovery
   ========================================================= */

function showRecovery() {
  state.detailId = null;

  $("#detailEyebrow").textContent = "ACCOUNT";
  $("#detailTitle").textContent = "Set a new password";

  $("#detailBody").innerHTML =
    '<form id="recoveryForm">' +
      '<input id="newPassword" type="password" minlength="10" autocomplete="new-password" placeholder="New password (10+ characters)" aria-label="New password" required>' +
      '<button class="btn btn-primary" type="submit">Update password</button>' +
    '</form>' +
    '<div class="notice" id="recoveryMessage" role="status"></div>';

  $("#recoveryForm").addEventListener(
    "submit",
    async e => {
      e.preventDefault();

      const msg = $("#recoveryMessage");

      notice(msg, "Updating…");

      try {
        const password =
          $("#newPassword").value;

        const { error } =
          await supabase.auth.updateUser({
            password
          });

        if (error) {
          return notice(
            msg,
            friendly(error),
            true
          );
        }

        history.replaceState(
          null,
          "",
          location.pathname + location.search
        );

        closeModal(detailModal);

        toast("Password updated.");
      } catch (error) {
        console.error(error);

        notice(
          msg,
          friendly(error),
          true
        );
      }
    }
  );

  openModal(detailModal);
}

/* =========================================================
   Auth state listener
   ========================================================= */

/*
  IMPORTANT:
  Never await Supabase calls inside onAuthStateChange.
  Supabase auth uses an internal lock. Awaiting another
  Supabase operation here can deadlock the application.

  This preserves the auth-lock fix from 560b93c.
*/

supabase.auth.onAuthStateChange(
  (event, session) => {
    state.user = session?.user || null;

    if (event === "PASSWORD_RECOVERY") {
      setTimeout(() => {
        closeModal(authModal);
        showRecovery();
      }, 0);

      return;
    }

    if (event === "SIGNED_OUT") {
      state.loadedFor = null;

      if (
        document.body.classList.contains(
          "in-app"
        )
      ) {
        setTimeout(() => {
          location.reload();
        }, 0);
      }

      return;
    }

    if (
      state.user &&
      state.loadedFor !== state.user.id
    ) {
      state.loadedFor = state.user.id;

      closeModal(authModal);

      setTimeout(() => {
        loadCases().catch(error => {
          console.error(error);
          toast(
            friendly(error),
            false
          );
        });
      }, 0);
    }
  }
);

/* =========================================================
   Data
   ========================================================= */

let loadSeq = 0;
let lastLoad = 0;

async function loadCases() {
  if (!state.user) return;

  // Only the most recent request may update the UI.
  const seq = ++loadSeq;
  lastLoad = Date.now();

  try {
    const {
      data,
      error
    } = await supabase
      .from("recovery_cases")
      .select("*")
      .order("created_at", {
        ascending: false
      })
      .limit(500);

    if (error) {
      throw error;
    }

    if (seq !== loadSeq) return;

    const rows = data || [];
    const people = {};

    if (rows.length) {
      const {
        data: ppl,
        error: pe
      } = await supabase.rpc(
        "case_people",
        {
          p_cases:
            rows.map(c => c.id)
        }
      );

      if (seq !== loadSeq) return;

      if (pe) {
        console.warn(
          "case_people failed:",
          pe
        );
      } else {
        for (const p of ppl || []) {
          people[p.case_id] = p;
        }
      }
    }

    state.cases = rows;
    state.people = people;

    renderWorkspace();

    if (state.detailId) {
      renderDetail(state.detailId);
    }
  } catch (error) {
    console.error(error);

    toast(
      friendly(error),
      false
    );
  }
}

async function updateCase(
  id,
  patch,
  okMsg
) {
  try {
    const {
      data,
      error
    } = await supabase
      .from("recovery_cases")
      .update(patch)
      .eq("id", id)
      .select("id");

    if (error) {
      throw error;
    }

    if (!data || !data.length) {
      toast(
        "That change isn't permitted.",
        false
      );

      return false;
    }

    if (okMsg) {
      toast(okMsg);
    }

    await loadCases();

    return true;
  } catch (error) {
    console.error(error);

    toast(
      friendly(error),
      false
    );

    return false;
  }
}

/* =========================================================
   Workspace
   ========================================================= */

function renderWorkspace() {
  document.body.classList.add("in-app");

  if (!$("#workspace")) {
    document.querySelector("main").innerHTML =
      '<section class="container app-shell" id="workspace">' +
        '<aside class="sidebar">' +
          '<div class="brand">' +
            '<span class="brand-mark">R</span>' +
            '<span>RecoverDesk</span>' +
          '</div>' +

          '<div class="side-note">Recovery operations</div>' +

          '<button class="side-btn active" data-view="cases">Cases</button>' +
          '<button class="side-btn" data-view="activity">Activity</button>' +

          '<div class="side-bottom">' +
            '<small>' +
              esc(state.user?.email || "") +
            '</small>' +
            '<button class="text-btn" id="signOut">Sign out</button>' +
          '</div>' +
        '</aside>' +

        '<section class="app-main">' +
          '<div class="app-top">' +
            '<div>' +
              '<div class="eyebrow">WORKSPACE</div>' +
              '<h1>Recovery desk</h1>' +
            '</div>' +
            '<button class="btn btn-primary" id="newCase">New case</button>' +
          '</div>' +

          '<div id="view"></div>' +
        '</section>' +
      '</section>';

    bindWorkspace();

    state.view = "cases";
  }

  renderView(state.view);
}

function bindWorkspace() {
  $("#newCase").addEventListener(
    "click",
    () => {
      notice(
        $("#caseMessage"),
        ""
      );

      openModal(caseModal);
    }
  );

  $("#signOut").addEventListener(
    "click",
    async () => {
      try {
        const { error } =
          await supabase.auth.signOut();

        if (error) {
          throw error;
        }
      } catch (error) {
        console.error(error);

        toast(
          friendly(error),
          false
        );
      }
    }
  );

  document
    .querySelectorAll(".side-btn")
    .forEach(button => {
      button.addEventListener(
        "click",
        () => {
          document
            .querySelectorAll(".side-btn")
            .forEach(x =>
              x.classList.remove("active")
            );

          button.classList.add("active");

          renderView(
            button.dataset.view
          );
        }
      );
    });
}

function renderView(view) {
  state.view = view;

  if (view === "activity") {
    return renderActivity();
  }

  renderCasesView();
}

/* =========================================================
   Filters
   ========================================================= */

const opts = (
  list,
  sel,
  allLabel
) =>
  (allLabel
    ? '<option value="all">' +
      allLabel +
      "</option>"
    : "") +
  list
    .map(
      x =>
        '<option value="' +
        esc(x) +
        '"' +
        (x === sel
          ? " selected"
          : "") +
        ">" +
        esc(label(x)) +
        "</option>"
    )
    .join("");

function renderCasesView() {
  // Keep the toolbar (and any text being typed) across data reloads.
  if ($("#fQ") && $("#caseResults")) {
    return renderCaseResults();
  }

  const f = state.filters;

  $("#view").innerHTML =
    '<div class="toolbar">' +

      '<input id="fQ" type="search" placeholder="Search cases" aria-label="Search cases" value="' +
        esc(f.q) +
      '">' +

      '<select id="fStatus" aria-label="Filter by status">' +
        opts(
          STATUSES,
          f.status,
          "All statuses"
        ) +
      "</select>" +

      '<select id="fPriority" aria-label="Filter by priority">' +
        opts(
          PRIORITIES,
          f.priority,
          "All priorities"
        ) +
      "</select>" +

      '<select id="fScope" aria-label="Filter by ownership">' +
        '<option value="all">All cases</option>' +
        '<option value="owned">Owned by me</option>' +
        '<option value="assigned">Assigned to me</option>' +
      "</select>" +

    "</div>" +

    '<div id="caseResults"></div>';

  $("#fStatus").value = f.status;
  $("#fPriority").value = f.priority;
  $("#fScope").value = f.scope;

  $("#fQ").addEventListener(
    "input",
    e => {
      f.q = e.target.value;
      renderCaseResults();
    }
  );

  $("#fStatus").addEventListener(
    "change",
    e => {
      f.status = e.target.value;
      renderCaseResults();
    }
  );

  $("#fPriority").addEventListener(
    "change",
    e => {
      f.priority = e.target.value;
      renderCaseResults();
    }
  );

  $("#fScope").addEventListener(
    "change",
    e => {
      f.scope = e.target.value;
      renderCaseResults();
    }
  );

  $("#caseResults").addEventListener(
    "click",
    e => {
      const act =
        e.target.closest(
          "[data-status]"
        );

      if (act) {
        if (act.getAttribute("aria-busy") === "true") return;

        act.setAttribute("aria-busy", "true");

        return void updateCase(
          act.dataset.id,
          {
            status:
              act.dataset.status
          },
          "Status updated"
        ).then(ok => {
          if (!ok && act.isConnected) {
            act.removeAttribute("aria-busy");
          }
        });
      }

      const card =
        e.target.closest(
          "[data-open]"
        );

      if (card) {
        openDetail(
          card.dataset.open
        );
      }
    }
  );

  $("#caseResults").addEventListener(
    "keydown",
    e => {
      if (
        (e.key !== "Enter" && e.key !== " ") ||
        e.target.closest("button")
      ) {
        return;
      }

      const card =
        e.target.closest(
          "[data-open]"
        );

      if (card) {
        e.preventDefault();

        openDetail(
          card.dataset.open
        );
      }
    }
  );

  renderCaseResults();
}

function filteredCases() {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  const uid = state.user.id;

  return state.cases.filter(c =>
    (f.status === "all" ||
      c.status === f.status) &&

    (f.priority === "all" ||
      c.priority === f.priority) &&

    (
      f.scope === "all" ||
      (
        f.scope === "owned"
          ? c.owner_id === uid
          : c.assigned_to === uid
      )
    ) &&

    (
      !q ||
      (
        c.title +
        " " +
        (c.description || "") +
        " " +
        (c.source || "")
      )
        .toLowerCase()
        .includes(q)
    )
  );
}

const isOverdue = c =>
  !!c.due_at &&
  !DONE.includes(c.status) &&
  new Date(c.due_at) <
    new Date();

function renderCaseResults() {
  const box = $("#caseResults");
  const active = document.activeElement;
  let refocus = "";

  if (box && active && box.contains(active)) {
    if (active.dataset.id) {
      refocus = 'button[data-id="' + active.dataset.id + '"]';
    } else if (active.dataset.open) {
      refocus = 'article[data-open="' + active.dataset.open + '"]';
    }
  }

  paintCaseResults();

  if (refocus) {
    const el = box.querySelector(refocus);

    if (el) {
      focusSafely(el);
    }
  }
}

function paintCaseResults() {
  const all = state.cases;
  const list = filteredCases();

  const n = status =>
    all.filter(
      c => c.status === status
    ).length;

  const urgent =
    all.filter(
      c => c.priority === "urgent"
    ).length;

  $("#caseResults").innerHTML =
    '<div class="stats">' +

      '<div><span>Open</span><strong>' +
        n("open") +
      "</strong></div>" +

      '<div><span>In progress</span><strong>' +
        n("in_progress") +
      "</strong></div>" +

      '<div><span>Urgent</span><strong>' +
        urgent +
      "</strong></div>" +

      '<div><span>Resolved</span><strong>' +
        (n("resolved") +
          n("closed")) +
      "</strong></div>" +

    "</div>" +

    '<div class="panel">' +

      '<div class="panel-head">' +
        "<h3>Cases</h3>" +
        "<span>" +
          list.length +
          (
            list.length === all.length
              ? " total"
              : " of " + all.length
          ) +
        "</span>" +
      "</div>" +

      '<div class="case-list">' +

        (
          list.length
            ? list
                .map(caseCard)
                .join("")
            : '<div class="empty">' +
                (
                  all.length
                    ? "No cases match these filters."
                    : "No recovery cases yet. Create the first one."
                ) +
              "</div>"
        ) +

      "</div>" +

    "</div>";
}

function caseCard(c) {
  const next = NEXT[c.status];

  const badges =
    (
      isOverdue(c)
        ? '<span class="badge overdue">Overdue</span>'
        : ""
    ) +

    (
      c.assigned_to === state.user.id
        ? '<span class="badge mine">Assigned to you</span>'
        : ""
    );

  return (
    '<article class="case" data-open="' +
      esc(c.id) +
      '" tabindex="0">' +

      '<div class="case-main">' +

        '<div class="case-meta">' +

          '<span class="pill ' +
            esc(c.priority) +
          '">' +
            esc(c.priority) +
          "</span>" +

          "<span>" +
            esc(label(c.status)) +
          "</span>" +

          badges +

        "</div>" +

        "<h3>" +
          esc(c.title) +
        "</h3>" +

        "<p>" +
          esc(
            c.description ||
            "No description"
          ) +
        "</p>" +

        "<small>" +
          esc(fmt(c.created_at)) +
          (
            c.source
              ? " · " +
                esc(c.source)
              : ""
          ) +
        "</small>" +

      "</div>" +

      '<button class="btn btn-small" data-id="' +
        esc(c.id) +
        '" data-status="' +
        esc(next) +
      '">' +
        esc(NEXT_LABEL[next]) +
      "</button>" +

    "</article>"
  );
}

/* =========================================================
   Case creation
   ========================================================= */

$("#caseForm").addEventListener(
  "submit",
  async e => {
    e.preventDefault();

    const msg = $("#caseMessage");
    const btn = $("#caseSubmit");

    if (!state.user) {
      return notice(
        msg,
        "Your session has expired. Please sign in again.",
        true
      );
    }

    btn.disabled = true;

    notice(
      msg,
      "Creating…"
    );

    const payload = {
      owner_id: state.user.id,
      title:
        $("#caseTitle").value.trim(),
      description:
        $("#caseDescription").value.trim() ||
        null,
      priority:
        $("#casePriority").value,
      source:
        $("#caseSource").value.trim() ||
        null,
      due_at:
        $("#caseDue").value
          ? new Date(
              $("#caseDue").value
            ).toISOString()
          : null
    };

    try {
      /*
        case_events rows are written by
        database triggers. The client
        never inserts case_events directly.
      */

      const { error } =
        await supabase
          .from("recovery_cases")
          .insert(payload);

      if (error) {
        throw error;
      }

      e.target.reset();

      closeModal(caseModal);

      toast("Case created.");

      await loadCases();
    } catch (error) {
      console.error(error);

      notice(
        msg,
        friendly(error),
        true
      );
    } finally {
      btn.disabled = false;
    }
  }
);

/* =========================================================
   Case detail
   ========================================================= */

function openDetail(id) {
  state.detailId = id;

  renderDetail(id);

  openModal(detailModal);

  // Show the cached copy instantly, then refresh so another user's edits are never shown stale.
  void loadCases();
}

function renderDetail(id) {
  const c =
    state.cases.find(
      x => x.id === id
    );

  if (!c) {
    return closeModal(
      detailModal
    );
  }

  const uid = state.user.id;

  const isOwner =
    c.owner_id === uid;

  const p =
    state.people[id] || {};

  /*
    Re-rendering the open detail must not steal focus, reset scroll or
    discard unsent input. Only reuse state when this same case is
    already open (never carry a draft across cases).
  */
  const modalCard = detailModal.querySelector(".modal-card");

  const reuse =
    detailModal.dataset.caseId === id &&
    !detailModal.classList.contains("hidden");

  const prevScroll = reuse && modalCard ? modalCard.scrollTop : 0;

  const prevFocusId =
    reuse && detailModal.contains(document.activeElement)
      ? document.activeElement.id
      : "";

  const draftEl = reuse ? $("#dAssignee") : null;

  const draft =
    draftEl && draftEl.value !== draftEl.defaultValue
      ? draftEl.value
      : null;

  $("#detailEyebrow").textContent =
    "CASE · " +
    label(c.status).toUpperCase();

  $("#detailTitle").textContent =
    c.title;

  $("#detailBody").innerHTML =
    '<p class="kv"><b>Owner:</b> ' +
      esc(
        p.owner_email ||
        (
          isOwner
            ? "You"
            : "—"
        )
      ) +
    "</p>" +

    '<p class="kv"><b>Assignee:</b> ' +
      esc(
        p.assignee_email ||
        (
          c.assigned_to === uid
            ? "You"
            : "Unassigned"
        )
      ) +

      (
        c.assigned_to === uid
          ? ' <span class="badge mine">Assigned to you</span>'
          : ""
      ) +

    "</p>" +

    '<p class="kv"><b>Source:</b> ' +
      esc(c.source || "—") +
    "</p>" +

    '<p class="kv"><b>Due:</b> ' +
      esc(fmt(c.due_at)) +

      (
        isOverdue(c)
          ? ' <span class="badge overdue">Overdue</span>'
          : ""
      ) +

    "</p>" +

    '<p class="kv"><b>Created:</b> ' +
      esc(fmt(c.created_at)) +
      " · <b>Updated:</b> " +
      esc(fmt(c.updated_at)) +

      (
        c.resolved_at
          ? " · <b>Resolved:</b> " +
            esc(fmt(c.resolved_at))
          : ""
      ) +

    "</p>" +

    "<p>" +
      esc(
        c.description ||
        "No description"
      ) +
    "</p>" +

    '<div class="detail-row">' +

      '<select id="dStatus" aria-label="Status">' +
        opts(
          STATUSES,
          c.status
        ) +
      "</select>" +

      '<select id="dPriority" aria-label="Priority">' +
        opts(
          PRIORITIES,
          c.priority
        ) +
      "</select>" +

    "</div>" +

    (
      isOwner
        ? '<div class="detail-row">' +

            '<input id="dAssignee" type="email" placeholder="Assignee email" aria-label="Assignee email (leave blank to unassign)" value="' +
              esc(
                p.assignee_email ||
                ""
              ) +
            '">' +

            '<button class="btn btn-small" id="dAssign" type="button">Assign</button>' +

          "</div>"
        : ""
    ) +

    "<h3>Timeline</h3>" +

    '<ul class="timeline" id="timeline">' +
      "<li>Loading…</li>" +
    "</ul>";

  $("#dStatus").addEventListener(
    "change",
    async e => {
      const ok = await updateCase(
        id,
        {
          status:
            e.target.value
        },
        "Status updated"
      );

      // Revert the control if the change was refused.
      if (!ok && state.detailId === id) {
        renderDetail(id);
      }
    }
  );

  $("#dPriority").addEventListener(
    "change",
    async e => {
      const ok = await updateCase(
        id,
        {
          priority:
            e.target.value
        },
        "Priority updated"
      );

      if (!ok && state.detailId === id) {
        renderDetail(id);
      }
    }
  );

  if (isOwner) {
    $("#dAssign").addEventListener(
      "click",
      async e => {
        const btn =
          e.currentTarget;

        const email =
          $("#dAssignee")
            .value
            .trim();

        if (btn.getAttribute("aria-busy") === "true") return;

        btn.setAttribute("aria-busy", "true");

        try {
          const {
            data,
            error
          } =
            await supabase.rpc(
              "assign_case",
              {
                p_case: id,
                p_email: email
              }
            );

          if (error) {
            throw error;
          }

          if (data === false) {
            return toast(
              "No account found for that email.",
              false
            );
          }

          toast(
            email
              ? "Case assigned."
              : "Case unassigned."
          );

          await loadCases();
        } catch (error) {
          console.error(error);

          toast(
            friendly(error),
            false
          );
        } finally {
          btn.removeAttribute("aria-busy");
        }
      }
    );
  }

  detailModal.dataset.caseId = id;

  if (reuse) {
    const again = $("#dAssignee");

    if (draft !== null && again) {
      again.value = draft;
    }

    if (modalCard) {
      modalCard.scrollTop = prevScroll;
    }

    if (prevFocusId) {
      const el = document.getElementById(prevFocusId);

      if (el && detailModal.contains(el)) {
        focusSafely(el);
      }
    }
  }

  loadTimeline(
    id,
    c,
    p
  ).catch(error => {
    console.error(error);
  });
}

/* =========================================================
   Timeline
   ========================================================= */

async function loadTimeline(
  id,
  c,
  p
) {
  const {
    data,
    error
  } =
    await supabase
      .from("case_events")
      .select(
        "id,event_type,message,actor_id,created_at"
      )
      .eq(
        "case_id",
        id
      )
      .order(
        "created_at",
        {
          ascending: false
        }
      );

  if (
    state.detailId !== id
  ) {
    return;
  }

  const ul =
    $("#timeline");

  if (!ul) return;

  if (error) {
    ul.innerHTML =
      "<li>Could not load timeline.</li>";

    return;
  }

  const who = actor =>
    actor === state.user.id
      ? "You"
      : actor === c.owner_id
        ? (
            p.owner_email ||
            "Owner"
          )
        : actor === c.assigned_to
          ? (
              p.assignee_email ||
              "Assignee"
            )
          : "Someone";

  ul.innerHTML =
    (data || []).length

      ? data
          .map(
            ev =>
              "<li>" +

                "<b>" +
                  esc(
                    label(
                      ev.message ||
                      ev.event_type
                    )
                  ) +
                "</b>" +

                "<small>" +
                  esc(
                    who(
                      ev.actor_id
                    )
                  ) +
                  " · " +
                  esc(
                    fmt(
                      ev.created_at
                    )
                  ) +
                "</small>" +

              "</li>"
          )
          .join("")

      : "<li>No events yet.</li>";
}

/* =========================================================
   Activity
   ========================================================= */

async function renderActivity() {
  $("#view").innerHTML =
    '<div class="panel">' +
      "<h3>Recent activity</h3>" +
      '<div id="activityList">Loading…</div>' +
    "</div>";

  try {
    const {
      data,
      error
    } =
      await supabase
        .from("case_events")
        .select(
          "id,event_type,message,case_id,created_at,recovery_cases(title)"
        )
        .order(
          "created_at",
          {
            ascending: false
          }
        )
        .limit(50);

    if (error) {
      throw error;
    }

    const box =
      $("#activityList");

    if (
      !box ||
      state.view !== "activity"
    ) {
      return;
    }

    box.innerHTML =
      (data || []).length

        ? data
            .map(
              x =>
                '<div class="activity" data-open="' +
                  esc(x.case_id) +
                '" tabindex="0" role="button">' +

                  "<b>" +
                    esc(
                      label(
                        x.event_type
                      )
                    ) +
                  "</b>" +

                  "<span>" +
                    esc(
                      x.recovery_cases?.title ||
                      ""
                    ) +
                  "</span>" +

                  "<small>" +
                    esc(
                      label(
                        x.message ||
                        ""
                      )
                    ) +
                    " · " +
                    esc(
                      fmt(
                        x.created_at
                      )
                    ) +
                  "</small>" +

                "</div>"
            )
            .join("")

        : '<div class="empty">No activity yet.</div>';

    box.addEventListener(
      "click",
      e => {
        const row =
          e.target.closest(
            "[data-open]"
          );

        if (
          row &&
          state.cases.some(
            c =>
              c.id ===
              row.dataset.open
          )
        ) {
          openDetail(
            row.dataset.open
          );
        }
      }
    );

    box.addEventListener(
      "keydown",
      e => {
        if (e.key !== "Enter" && e.key !== " ") return;

        const row =
          e.target.closest(
            "[data-open]"
          );

        if (
          row &&
          state.cases.some(
            c =>
              c.id ===
              row.dataset.open
          )
        ) {
          e.preventDefault();

          openDetail(
            row.dataset.open
          );
        }
      }
    );
  } catch (error) {
    console.error(error);

    const box =
      $("#activityList");

    if (box) {
      box.innerHTML =
        '<div class="empty">' +
          esc(
            friendly(error)
          ) +
        "</div>";
    }
  }
}

/* =========================================================
   Global async safety
   ========================================================= */

window.addEventListener(
  "unhandledrejection",
  event => {
    console.error(
      event.reason
    );

    toast(
      friendly(
        event.reason
      ),
      false
    );
  }
);

/* Refresh when the tab/app returns to the foreground (another user may have changed a case). */
document.addEventListener("visibilitychange", () => {
  if (
    document.visibilityState === "visible" &&
    state.user &&
    Date.now() - lastLoad > 10_000
  ) {
    void loadCases();
  }
});

/* =========================================================
   Initial boot
   ========================================================= */

try {
  const {
    data: {
      session
    }
  } =
    await supabase.auth.getSession();

  if (
    session &&
    state.loadedFor !==
      session.user.id
  ) {
    state.user =
      session.user;

    state.loadedFor =
      session.user.id;

    await loadCases();
  }
} catch (error) {
  console.error(error);

  toast(
    friendly(error),
    false
  );
}
