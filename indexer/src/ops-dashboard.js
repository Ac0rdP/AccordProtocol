/**
 * The webhook delivery dashboard: one self-contained page (no external
 * requests, strict CSP via per-response nonce) that reads the indexer's
 * existing JSON endpoints.
 *
 * Every value from the API is written with `textContent`, never as HTML, so a
 * hostile payload or receiver error message cannot inject markup.
 */

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--panel:#fff;--text:#14181f;--muted:#5b6573;--line:#dde1e7;--accent:#2457d6;
--ok:#0f7b4a;--warn:#9a6700;--bad:#b42318;--okbg:#e3f5ec;--warnbg:#fff3d1;--badbg:#fde8e6}
@media(prefers-color-scheme:dark){:root{--bg:#0f1318;--panel:#171c23;--text:#e6e9ee;--muted:#98a2b0;--line:#2a313b;--accent:#7aa2ff;
--ok:#4cc38a;--warn:#e3b341;--bad:#ff7b72;--okbg:#10291f;--warnbg:#2e2610;--badbg:#321615}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,sans-serif}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
h1{font-size:17px;margin:0}h2{font-size:14px;margin:0 0 8px}main{padding:16px;display:grid;gap:16px;max-width:1280px;margin:0 auto}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px;overflow-x:auto}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.card{border:1px solid var(--line);border-radius:8px;padding:10px}.card b{display:block;font-size:22px}
.card span{color:var(--muted);font-size:12px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--muted);font-weight:600;font-size:12px}tbody tr.row{cursor:pointer}tbody tr.row:hover,tbody tr.sel{background:color-mix(in srgb,var(--accent) 10%,transparent)}
td.wrap{white-space:normal;word-break:break-word;max-width:360px}
.badge{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;font-weight:600}
.delivered{background:var(--okbg);color:var(--ok)}.pending,.retry{background:var(--warnbg);color:var(--warn)}.dead{background:var(--badbg);color:var(--bad)}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
input,select,button{font:inherit;padding:5px 8px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--text)}
button{cursor:pointer}button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button:disabled{opacity:.5;cursor:not-allowed}pre{margin:0;padding:10px;background:var(--bg);border:1px solid var(--line);border-radius:6px;overflow:auto;max-height:320px;font:12px/1.5 ui-monospace,monospace}
.tight{margin:0}.gap{margin-top:12px}.muted{color:var(--muted)}.err{color:var(--bad)}.ok{color:var(--ok)}#detail[hidden]{display:none}
.split{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
`;

const SCRIPT = `
"use strict";
const CONFIG = JSON.parse(document.getElementById("config").textContent);
const $ = (id) => document.getElementById(id);
const state = { offset: 0, selected: null, timer: null };

function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) node.append(child instanceof Node ? child : document.createTextNode(String(child ?? "")));
  return node;
}
const badge = (status) => h("span", { class: "badge " + status }, status);
const when = (iso) => (iso ? new Date(iso).toLocaleString() : "—");
const token = () => { try { return sessionStorage.getItem("opsToken") || ""; } catch { return ""; } };

async function api(path, options = {}) {
  const headers = { accept: "application/json" };
  if (options.method === "POST") headers.authorization = "Bearer " + token();
  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "request failed (HTTP " + response.status + ")");
  return body;
}

function flash(message, ok) {
  const node = $("flash");
  node.textContent = message;
  node.className = ok ? "ok" : "err";
}

async function loadSummary() {
  const data = await api("/webhooks/deliveries/summary");
  const cards = $("cards");
  cards.replaceChildren(...["pending", "delivered", "dead"].map((status) =>
    h("div", { class: "card" }, h("b", {}, data.totals[status] ?? 0), h("span", {}, status))));
  $("subs").replaceChildren(...data.subscriptions.map((row) => h("tr", {},
    h("td", {}, row.subscriptionId, row.configured ? "" : " (removed)"),
    h("td", {}, row.pending), h("td", {}, row.delivered), h("td", {}, row.dead), h("td", {}, row.replays),
    h("td", {}, when(row.oldestPendingAt)),
    h("td", {}, CONFIG.controlsEnabled && row.dead > 0
      ? h("button", { onclick: () => retryDead(row.subscriptionId) }, "Retry dead") : ""))));
}

function filters() {
  const params = new URLSearchParams({ order: "desc", limit: String(CONFIG.pageSize), offset: String(state.offset) });
  for (const [key, id] of [["status", "f-status"], ["subscription", "f-sub"], ["event", "f-event"]]) {
    const value = $(id).value.trim();
    if (value) params.set(key, value);
  }
  return params;
}

async function loadList() {
  const { deliveries } = await api("/webhooks/deliveries?" + filters());
  $("rows").replaceChildren(...deliveries.map((d) => {
    const row = h("tr", { class: "row" + (d.id === state.selected ? " sel" : ""), onclick: () => select(d.id) },
      h("td", {}, d.id), h("td", {}, d.subscriptionId), h("td", {}, d.eventId), h("td", {}, badge(d.status)),
      h("td", {}, d.attempts), h("td", {}, d.lastStatusCode ?? "—"), h("td", {}, when(d.nextAttemptAt)),
      h("td", {}, d.replayCount || 0));
    return row;
  }));
  $("empty").hidden = deliveries.length > 0;
  $("prev").disabled = state.offset === 0;
  $("next").disabled = deliveries.length < CONFIG.pageSize;
  $("page").textContent = "rows " + (deliveries.length ? state.offset + 1 : 0) + "–" + (state.offset + deliveries.length);
}

async function select(id) {
  state.selected = id;
  const { delivery, attempts, subscription } = await api("/webhooks/deliveries/" + id);
  let payload = delivery.body;
  try { payload = JSON.stringify(JSON.parse(delivery.body), null, 2); } catch { /* show the raw body */ }
  const target = subscription.configured ? (subscription.origin || "unknown") : "subscription no longer configured";
  $("detail").hidden = false;
  $("detail-body").replaceChildren(
    h("p", {}, badge(delivery.status), " delivery #" + delivery.id + " · " + delivery.subscriptionId + " → " + target),
    h("p", { class: "muted" }, "event " + delivery.eventId + " · created " + when(delivery.createdAt) +
      " · delivered " + when(delivery.deliveredAt) + " · replays " + (delivery.replayCount || 0) +
      (delivery.lastReplayedAt ? " (last " + when(delivery.lastReplayedAt) + ")" : "")),
    delivery.lastError ? h("p", { class: "err" }, "Last error: " + delivery.lastError) : "",
    h("div", { class: "bar" }, CONFIG.controlsEnabled
      ? h("button", { class: "primary", onclick: () => replay(delivery.id, delivery.status) },
          delivery.status === "pending" ? "Retry now" : "Replay delivery")
      : h("span", { class: "muted" }, "Retry controls are disabled (no OPS_ADMIN_TOKEN configured).")),
    h("h2", {}, "Payload"), h("pre", {}, payload),
    h("h2", { class: "gap" }, "Attempts (" + attempts.length + ")"),
    attempts.length === 0 ? h("p", { class: "muted" }, "No attempts recorded yet.") :
    h("table", {}, h("thead", {}, h("tr", {}, ...["#", "Round", "Outcome", "HTTP", "ms", "When", "Error"].map((t) => h("th", {}, t)))),
      h("tbody", {}, attempts.map((a) => h("tr", {},
        h("td", {}, a.attempt), h("td", {}, a.replayRound), h("td", {}, badge(a.outcome)), h("td", {}, a.statusCode ?? "—"),
        h("td", {}, a.durationMs ?? "—"), h("td", {}, when(a.attemptedAt)), h("td", { class: "wrap" }, a.error || ""))))));
  loadList().catch(() => {});
}

async function replay(id, status) {
  if (status !== "pending" && !confirm("Replay delivery #" + id + "? The receiver gets the same event again (same x-accord-event-id).")) return;
  try {
    const result = await api("/webhooks/deliveries/" + id + "/replay", { method: "POST" });
    flash(result.replayed ? "Delivery #" + id + " queued for replay." : "Delivery #" + id + " is already queued; sending now.", true);
    await refresh();
    await select(id);
  } catch (error) { flash(error.message, false); }
}

async function retryDead(subscription) {
  const scope = subscription ? "subscription " + subscription : "ALL subscriptions";
  if (!confirm("Requeue every dead-lettered delivery for " + scope + "?")) return;
  try {
    const query = subscription ? "?subscription=" + encodeURIComponent(subscription) : "";
    const result = await api("/webhooks/deliveries/retry-dead" + query, { method: "POST" });
    flash(result.requeued + " dead delivery(ies) requeued.", true);
    await refresh();
  } catch (error) { flash(error.message, false); }
}

async function refresh() {
  try {
    await Promise.all([loadSummary(), loadList()]);
    $("updated").textContent = "Updated " + new Date().toLocaleTimeString();
  } catch (error) { flash(error.message, false); }
}

function schedule() {
  clearInterval(state.timer);
  if ($("auto").checked) state.timer = setInterval(refresh, 5000);
}

$("token").value = token();
$("token").addEventListener("change", () => { try { sessionStorage.setItem("opsToken", $("token").value); } catch { /* private mode */ } });
$("token-row").hidden = !CONFIG.controlsEnabled;
for (const id of ["f-status", "f-sub", "f-event"]) $(id).addEventListener("change", () => { state.offset = 0; refresh(); });
$("prev").addEventListener("click", () => { state.offset = Math.max(0, state.offset - CONFIG.pageSize); refresh(); });
$("next").addEventListener("click", () => { state.offset += CONFIG.pageSize; refresh(); });
$("reload").addEventListener("click", refresh);
$("retry-all").hidden = !CONFIG.controlsEnabled;
$("retry-all").addEventListener("click", () => retryDead(""));
$("auto").addEventListener("change", schedule);
$("close").addEventListener("click", () => { state.selected = null; $("detail").hidden = true; loadList(); });
refresh();
schedule();
`;

/** Escapes a value for embedding inside a JSON <script> block. */
const jsonForScript = (value) => JSON.stringify(value).replace(/</g, "\\u003c");

export function renderWebhookDashboard({ nonce, pageSize = 50, controlsEnabled = false }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Webhook deliveries</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<header>
  <h1>Webhook deliveries</h1>
  <div class="bar tight">
    <span id="token-row"><label class="muted">Admin token <input id="token" type="password" autocomplete="off" placeholder="for retry controls"></label></span>
    <label class="muted"><input id="auto" type="checkbox" checked> auto-refresh</label>
    <button id="reload">Refresh</button>
    <button id="retry-all" class="primary" hidden>Retry all dead</button>
    <span id="updated" class="muted"></span>
  </div>
</header>
<main>
  <p id="flash" role="status"></p>
  <section class="panel"><div class="cards" id="cards"></div></section>
  <section class="panel">
    <h2>Subscriptions</h2>
    <table><thead><tr><th>Subscription</th><th>Pending</th><th>Delivered</th><th>Dead</th><th>Replays</th><th>Oldest pending</th><th></th></tr></thead><tbody id="subs"></tbody></table>
  </section>
  <div class="split">
    <section class="panel">
      <h2>Deliveries</h2>
      <div class="bar">
        <select id="f-status" aria-label="Status"><option value="">any status</option><option>pending</option><option>delivered</option><option>dead</option></select>
        <input id="f-sub" placeholder="subscription id" aria-label="Subscription">
        <input id="f-event" placeholder="event id" aria-label="Event id">
      </div>
      <table><thead><tr><th>ID</th><th>Subscription</th><th>Event</th><th>Status</th><th>Attempts</th><th>HTTP</th><th>Next attempt</th><th>Replays</th></tr></thead><tbody id="rows"></tbody></table>
      <p id="empty" class="muted" hidden>No deliveries match.</p>
      <div class="bar"><button id="prev">Previous</button><button id="next">Next</button><span id="page" class="muted"></span></div>
    </section>
    <section class="panel" id="detail" hidden>
      <div class="bar"><h2 class="tight">Delivery</h2><button id="close">Close</button></div>
      <div id="detail-body"></div>
    </section>
  </div>
</main>
<script type="application/json" id="config">${jsonForScript({ pageSize, controlsEnabled })}</script>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>
`;
}
