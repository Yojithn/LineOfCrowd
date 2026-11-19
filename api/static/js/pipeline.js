// Release pipeline rail and the activity log with filters.
import { store } from "./store.js";
import { $, $$, h, clock } from "./util.js";

const STAGES = [["commit", "Commit"], ["test", "Test"], ["build", "Build"], ["deploy", "Deploy"], ["health", "Health check"], ["live", "Live"]];
const FILTERS = {
  all: () => true,
  alerts: (e) => ["critical", "warning", "recovered", "incident"].includes(e.kind),
  chaos: (e) => ["chaos", "offline", "online"].includes(e.kind),
  release: (e) => ["deploy", "rollback"].includes(e.kind),
};
let onPick = () => {};
let lastLogKey = "";

export function initPipeline(pick) {
  onPick = pick;
  $$("#filters button").forEach((b) => b.addEventListener("click", () => {
    $$("#filters button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    lastLogKey = "";
    store.set({ logFilter: b.dataset.f });
  }));
  store.subscribe(render);
}

function render(s) {
  if (!s.live) return;
  const p = s.live.pipeline;
  const st = (k) => p?.stages?.[k]?.state || "";
  const rolled = p?.stages?.rollback;
  const rail = $("#rail");
  rail.replaceChildren();
  STAGES.forEach(([k, label], i) => {
    let state = st(k), text = label;
    if (k === "live" && rolled) { state = "fail"; text = "Rolled back"; }
    if (i) rail.append(h("span", { class: `wire${st(STAGES[i - 1][0]) === "ok" && state && state !== "skipped" ? " lit" : ""}` }));
    const note = p?.stages?.[k]?.note || (k === "live" && rolled ? rolled.note : "");
    rail.append(h("div", { class: "stage", "data-st": state, title: note ? `${label}: ${note}` : label }, h("i"), text));
  });
  const line = $("#pipe-line");
  if (!p) { line.textContent = "Push to GitHub or run the deploy script to watch a release here."; line.className = "verdict-line"; }
  else {
    $("#pipe-ver").textContent = p.previous ? `${p.previous} to ${p.version}` : p.version;
    if (p.result === "live") { line.textContent = `${p.version} is live. No camera went dark during the release.`; line.className = "verdict-line good"; }
    else if (p.result === "rolled_back") { line.textContent = `${p.version} failed its health checks and was rolled back to ${p.previous || "the last good version"} automatically.`; line.className = "verdict-line bad"; }
    else { line.textContent = `Releasing ${p.version}…`; line.className = "verdict-line"; }
  }
  const events = (s.live.events || []).filter(FILTERS[s.logFilter] || FILTERS.all).slice(0, 14);
  const key = events.map((e) => e.ts).join(",") + s.logFilter;
  if (key === lastLogKey) return;
  lastLogKey = key;
  $("#log").replaceChildren(...(events.length ? events.map((e) => {
    const li = h("li", { "data-k": e.kind, title: e.text }, h("time", {}, clock(e.ts)), h("span", {}, e.text));
    if (e.zone) { li.style.cursor = "pointer"; li.addEventListener("click", () => onPick(e.zone)); }
    return li;
  }) : [h("li", { class: "none" }, h("span", {}, "Nothing here yet. Alerts, chaos tests and releases appear as they happen."))]));
}
