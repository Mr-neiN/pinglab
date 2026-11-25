/* PingLab page — core.js */
const $ = (id) => document.getElementById(id);

const state = {
  version: null,
  benchPolicy: null,
  connection: null,
  tweak: null,
  pending: null,
  history: null,
  endpoints: [],
  catalog: null,
  protocols: null,
  target: null,
  adapterChoices: [],
  targetFallback: null,
  showVirtual: false,
  update: null,
  probe: null,
  bloat: null,
  dns: null,
  scan: null,
  alias: null,
  bench: { pending: null, latest: null, reverted: false },
  trend: null,
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const num = (v, d = 1) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "—");
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function timeOf(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

let toastTimer = null;
function toast(message, kind = "") {
  const el = $("toast");
  el.textContent = message;
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 5200);
}

// Written into the page by the server on every load. It is this run's only key to the API,
// and it is why another site cannot drive the app: it cannot read this page to get it.
const TOKEN = document.querySelector('meta[name="pinglab-token"]')?.content || "";

async function api(path, body) {
  try {
    const headers = { "X-PingLab-Token": TOKEN };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return await res.json();
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

function busy(btn, on, label) {
  if (!btn) return;
  if (on) {
    btn.dataset.idle = btn.textContent;
    btn.textContent = label || "Working…";
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.idle || btn.textContent;
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ verdict */

