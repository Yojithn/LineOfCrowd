// Zone drawer: live feed, 15-minute chart with a hover readout, a flow rose of how people move,
// the open incident for this zone, and the actions an operator can take.
import { store, thresholds } from "./store.js";
import { api } from "./api.js";
import { $, h, WORD, TREND, clock, clamp, duration, forecastEta, tween } from "./util.js";
import { flyToZone } from "./scene.js";

import { incidentBusy, incidentButtons, incidentState } from "./incidents.js";
import { cameraFrame, workerStatus, cameraDrill, cameraDrillPending } from "./cameras.js";

const box = () => $("#drawer");
let openId = null;
let series = [];          // [[t, density|null], ...] for the chart
let returnFocus = null;
let hoverX = null;
const el = {};

export const drawerOpen = () => openId;

export function openDrawer(id) {
  const cfgZone = store.get().cfg.zones.find((z) => z.id === id);
  if (!cfgZone || openId === id) return;
  if (openId !== id) returnFocus = returnFocus || document.activeElement;
  openId = id;
  hoverX = null;
  series = [];
  store.set({ selected: id });
  build(cfgZone);
  box().classList.add("open");
  box().setAttribute("aria-hidden", "false");
  el.close.focus({ preventScroll: true });
  if (matchMedia("(max-width: 1100px)").matches) $("#cams").scrollIntoView({ block: "nearest" });
  loadHistory(id);
  render(store.get());
}

export function closeDrawer() {
  if (!openId) return false;
  openId = null;
  store.set({ selected: null });
  box().classList.remove("open");
  box().setAttribute("aria-hidden", "true");
  returnFocus?.focus?.();
  returnFocus = null;
  return true;
}

async function loadHistory(id) {
  const r = await api.get("/api/history");
  if (openId !== id) return;
  if (r.ok) series = (r.data.zones[id] || []).map((p) => [p[0], p[1]]);
  drawChart();
}

function build(zc) {
  const d = box();
  d.innerHTML = "";
  el.st = h("div", { class: "st" });
  el.mode = h("span", { class: "label", hidden: true }, "Live inspection");
  el.close = h("button", { class: "x", "aria-label": "Close zone details", html: "&#x2715;", onclick: closeDrawer });
  el.feed = h("img", { alt: `Live camera at ${zc.name}` });
  el.feed.hidden = true;
  el.feedState = h("div", { class: "feed-state", role: "status" }, "Waiting for camera frame");
  el.feedType = h("span", { class: "feed-type" }, "Feed type pending");
  el.feedHealth = h("span", { class: "feed-health" }, "Connecting");
  el.pod = h("span", { class: "feed-pod" }, "Camera / pod pending");
  el.observed = h("p", { class: "observed-zone" });
  el.counter = h("p", { class: "movement-status" });
  el.people = h("b", {}, "0");
  el.dens = h("b", {}, "0.0");
  el.load = h("b", {}, "0%");
  el.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.read = h("div", { class: "read" });
  el.rose = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.rose.setAttribute("viewBox", "0 0 150 150");
  el.move = h("p");
  el.flow = h("p");
  el.fc = h("p");
  el.ver = h("p");
  el.inc = h("div");
  el.surge = h("button", { class: "btn", onclick: () => cameraDrill(zc, "surge") }, "Run surge drill");
  el.crash = h("button", { class: "btn danger", onclick: () => cameraDrill(zc, "kill") }, "Crash camera worker");
  const chart = h("div", { class: "chart" }, el.svg, el.read);
  chart.addEventListener("pointermove", (e) => { const r = el.svg.getBoundingClientRect(); hoverX = (e.clientX - r.left) / r.width; drawChart(); });
  chart.addEventListener("pointerleave", () => { hoverX = null; drawChart(); });

  d.append(
    h("header", {}, h("div", {}, el.mode, h("h2", {}, zc.name), el.st), h("div", { class: "inspect-actions" }, h("button", { class: "btn sm", onclick: () => flyToZone(zc.id) }, "Show on map"), el.close)),
    h("div", { class: "body" },
      h("section", { class: "overview", "aria-label": "Zone overview" },
        h("div", { class: "stats" },
          h("div", { class: "density-stat" }, el.dens, h("span", { class: "label" }, "People / m²")),
          h("div", {}, el.people, h("span", { class: "label" }, "People in view")),
          h("div", {}, el.load, h("span", { class: "label" }, "Of crush-risk threshold")))),
      el.observed, el.inc, el.feedHealth, el.counter,
      h("details", { class: "inspect-section" }, h("summary", {}, "Density history · 15 min"),
        chart, h("div", { class: "chart-axis" }, h("span", {}, "15 min ago"), h("span", {}, "Observed · people / m²"), h("span", {}, "Now"))),
      h("details", { class: "inspect-section" }, h("summary", {}, "Movement and counterflow"),
        h("div", { class: "duo" }, h("div", { class: "compass" }, el.rose), h("div", {}, el.move, el.flow))),
      h("details", { class: "inspect-section forecast" }, h("summary", {}, "Forecast"), el.fc),
      h("details", { class: "inspect-section" }, h("summary", {}, "Camera details"),
        h("div", { class: "feed" }, el.feed, el.feedState, el.feedType), el.pod, el.ver),
      h("details", { class: "inspect-section operations" }, h("summary", {}, "System drills"),
        h("div", { class: "actions" }, el.surge, el.crash))));
}

document.addEventListener("frame", (e) => {
  if (e.detail.id !== openId || !el.feed) return;
  updateFeed(store.get());
});

function updateFeed(s) {
  if (!openId) return;
  const z = s.live?.zones.find((zone) => zone.id === openId);
  if (!z) return;
  const frame = cameraFrame(z, s.conn);
  if (frame.url && el.feed.src !== frame.url) el.feed.src = frame.url;
  el.feed.hidden = !frame.available;
  el.feedState.hidden = frame.available;
  el.feedState.textContent = frame.label;
  const worker = workerStatus(z, s.conn);
  el.feedHealth.replaceChildren(
    h("span", { "data-s": frame.tone }, "Preview · " + frame.label),
    h("span", { "data-s": worker.tone }, "Worker · " + worker.label));

}
setInterval(() => updateFeed(store.get()), 1000);

function direction(deg) {
  const a = ((deg % 360) + 360) % 360;
  if (a < 45 || a >= 315) return "to the right of the camera";
  if (a < 135) return "toward the camera";
  if (a < 225) return "to the left of the camera";
  return "away from the camera";
}

function drawRose(z) {
  const f = z.flow || {};
  const hot = (f.counterflow || 0) >= 0.55 && f.moving >= 4;
  let s = `<circle cx="75" cy="75" r="62" fill="none" stroke="${hot ? "#ff3b30" : "#563628"}" stroke-width="${hot ? 2 : 1}" ${hot ? 'stroke-dasharray="5 4"' : ""}/>
    <circle cx="75" cy="75" r="31" fill="none" stroke="#3f271e"/>
    <line x1="75" y1="9" x2="75" y2="141" stroke="#3f271e"/><line x1="9" y1="75" x2="141" y2="75" stroke="#3f271e"/>
    <text x="75" y="7" fill="#8a7461" font-size="9" text-anchor="middle">away</text>
    <text x="75" y="149" fill="#8a7461" font-size="9" text-anchor="middle">toward</text>`;
  for (const [, , vx, vy] of z.points || []) {
    const sp = Math.hypot(vx, vy);
    if (sp < 0.008) continue;
    const len = clamp(sp * 1100, 6, 60);
    s += `<line x1="75" y1="75" x2="${(75 + (vx / sp) * len).toFixed(1)}" y2="${(75 + (vy / sp) * len).toFixed(1)}" stroke="#f3eadb" stroke-opacity=".28" stroke-width="1.2" stroke-linecap="round"/>`;
  }
  if (f.moving >= 4) {
    const a = (f.angle * Math.PI) / 180;
    const len = clamp(f.speed * 1500 * (f.coherence || 1), 14, 58);
    const x = 75 + Math.cos(a) * len, y = 75 + Math.sin(a) * len;
    const hx = (k) => (x - Math.cos(a) * 10 + -Math.sin(a) * k).toFixed(1);
    const hy = (k) => (y - Math.sin(a) * 10 + Math.cos(a) * k).toFixed(1);
    const c = hot ? "#ff6a5e" : "#f3eadb";
    s += `<line x1="75" y1="75" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${c}" stroke-width="3.5" stroke-linecap="round"/>
      <polyline points="${hx(7)},${hy(7)} ${x.toFixed(1)},${y.toFixed(1)} ${hx(-7)},${hy(-7)}" fill="none" stroke="${c}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  s += `<circle cx="75" cy="75" r="3" fill="#cfa349"/>`;
  el.rose.innerHTML = s;
  if (z.offline) el.move.innerHTML = "<b>Movement unavailable.</b> Waiting for fresh measurements.";
  else if (!f.moving || f.moving < 4) el.move.innerHTML = "<b>Mostly standing still.</b> Too few people are moving to read a direction.";
  else el.move.innerHTML = `<b>${f.moving} people moving.</b> Predominantly ${direction(f.angle)}.`;
  el.flow.textContent = z.offline ? ""
    : f.moving >= 4 ? hot ? "Low directional agreement; movement is varied." : "Movement is mostly aligned."
    : "Insufficient movement to assess flow.";
}

function drawChart() {
  if (!el.svg || !openId) return;
  const s = store.get();
  const t = thresholds(s);
  const W = Math.max(200, el.svg.clientWidth || 400), H = 130, pad = 4;
  const now = s.live?.now || Date.now() / 1000;
  const t0 = now - 15 * 60;
  const vals = series.filter((p) => p[0] >= t0);
  const max = Math.max(t.critical * 1.3, ...vals.map((p) => p[1] || 0));
  const X = (ts) => ((ts - t0) / (now - t0)) * W;
  const Y = (v) => H - pad - (v / max) * (H - pad * 2);
  let path = "", pen = false;
  for (const [ts, v] of vals) {
    if (v == null) { pen = false; continue; }
    path += `${pen ? "L" : "M"}${X(ts).toFixed(1)},${Y(v).toFixed(1)}`;
    pen = true;
  }
  let svg = `<rect x="0" y="0" width="${W}" height="${Y(t.critical).toFixed(1)}" fill="#ff3b30" fill-opacity=".08"/>
    <rect x="0" y="${Y(t.critical).toFixed(1)}" width="${W}" height="${(Y(t.warning) - Y(t.critical)).toFixed(1)}" fill="#ff9124" fill-opacity=".07"/>
    <line x1="0" x2="${W}" y1="${Y(t.critical).toFixed(1)}" y2="${Y(t.critical).toFixed(1)}" stroke="#ff3b30" stroke-opacity=".6" stroke-dasharray="3 4"/>
    <line x1="0" x2="${W}" y1="${Y(t.warning).toFixed(1)}" y2="${Y(t.warning).toFixed(1)}" stroke="#ff9124" stroke-opacity=".45" stroke-dasharray="3 4"/>
    <text x="${W - 4}" y="${(Y(t.critical) - 4).toFixed(1)}" fill="#ff8d85" font-size="10" text-anchor="end">crush risk ${t.critical}</text>
    <text x="${W - 4}" y="${(Y(t.warning) - 4).toFixed(1)}" fill="#ffb066" font-size="10" text-anchor="end">crowded ${t.warning}</text>
    <line x1="0" x2="${W}" y1="${H - pad}" y2="${H - pad}" stroke="#563628"/>
    <text x="4" y="11" fill="#bba48c" font-size="10">${max.toFixed(1)} /m²</text>
    <text x="4" y="${H - 7}" fill="#bba48c" font-size="10">0</text>
    <path d="${path}" fill="none" stroke="#f3eadb" stroke-width="2" stroke-linejoin="round"/>`;
  el.read.style.display = "none";
  if (hoverX != null && vals.length) {
    const ts = t0 + hoverX * (now - t0);
    let best = vals[0];
    for (const p of vals) if (Math.abs(p[0] - ts) < Math.abs(best[0] - ts)) best = p;
    const x = X(best[0]);
    svg += `<line class="cross" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="0" y2="${H}" stroke="#f3eadb" stroke-opacity=".5"/>`;
    if (best[1] != null) svg += `<circle cx="${x.toFixed(1)}" cy="${Y(best[1]).toFixed(1)}" r="4" fill="#f3eadb"/>`;
    el.read.style.display = "block";
    el.read.style.left = `${clamp((x / W) * 100, 8, 92)}%`;
    el.read.textContent = `${clock(best[0])}, ${best[1] == null ? "no signal" : `${best[1].toFixed(1)} per m²`}`;
  }
  el.svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  el.svg.innerHTML = svg;
}

function render(s) {
  if (!openId || !s.live) return;
  const z = s.live.zones.find((q) => q.id === openId);
  if (!z) return;
  const st = z.offline || s.conn !== "live" ? "offline" : z.status;
  box().dataset.s = st;
  el.mode.hidden = s.replayT == null;
  el.st.textContent = s.conn !== "live" ? "Updates delayed" : WORD[st];
  if (st === "offline") { el.people.textContent = "--"; el.people._v = undefined; el.dens.textContent = "--"; el.dens._v = undefined; el.load.textContent = "--"; }
  else { tween(el.people, z.count, 0); tween(el.dens, z.density, 2); el.load.textContent = `${z.load_pct}%`; }
  el.observed.hidden = !z.last_measurement_at;
  el.observed.textContent = (st === "offline" ? "Last measurement " : "Measured at ") + clock(z.last_measurement_at);
  el.feedType.textContent = z.worker_health === "unseen" ? "Awaiting camera" : z.sim ? "Simulated feed" : "Camera feed";
  el.pod.textContent = `Camera / pod: ${z.pod || "Unavailable"}`;
  el.ver.textContent = z.version && st !== "offline" ? `Camera software ${z.version} · detection ${Math.round(z.infer_ms)} ms` : "";
  updateFeed(s);
  const last = series[series.length - 1];
  if (s.conn === "live" && (!last || s.live.now - last[0] >= 2)) series.push([s.live.now, z.offline ? null : z.density]);
  series = series.filter((p) => p[0] >= s.live.now - 15 * 60);
  drawChart();
  drawRose(st === "offline" ? { offline: true } : z);
  el.counter.dataset.s = st !== "offline" && z.flow?.counterflow_confirmed ? "warning" : "offline";
  el.counter.textContent = st === "offline" ? "Counterflow unavailable." : z.flow?.counterflow_confirmed
    ? "Confirmed counterflow" : z.flow?.moving >= 4 ? z.flow.moving + " people moving" : "No clear movement direction";
  const f = z.forecast || {};
  const eta = forecastEta(z);
  el.fc.textContent = z.offline ? "Forecast unavailable until measurements resume." : s.conn !== "live" ? "Forecast unavailable while the stream is disconnected."
    : z.status === "critical" ? "Observed crush risk."
    : eta != null ? `Predicted ${TREND[f.trend]?.toLowerCase() || "trend"}: crush-risk threshold in about ${duration(Math.ceil(eta))} if the trend holds.`
    : `Predicted trend: ${TREND[f.trend]?.toLowerCase() || "unavailable"}. No valid threshold arrival estimate.`;
  el.surge.hidden = !z.sim;
  el.crash.disabled = s.conn !== "live" || cameraDrillPending(z.id);
  el.surge.disabled = el.crash.disabled || z.offline;

  const inc = (s.live.incidents || []).find((i) => i.zone === openId && i.state !== "resolved");
  el.inc.hidden = !inc;
  if (!inc) { el.inc.innerHTML = ""; delete el.inc.dataset.key; return; }
  const key = `${inc.id}:${inc.state}:${inc.timeline.length}`;
  if (el.inc.dataset.key === key) {
    for (const button of el.inc.querySelectorAll("button")) button.disabled = incidentBusy(inc);
    return;
  }
  el.inc.dataset.key = key;
  el.inc.innerHTML = "";
  const btns = incidentButtons(inc);
  btns.forEach((button) => { button.disabled = incidentBusy(inc); });
  el.inc.append(h("div", { class: "inc" + (inc.state === "open" && !inc.eased ? " hot" : "") },
    h("div", {}, h("span", { class: "id" }, `${inc.id}, opened ${clock(inc.opened_at)}`), h("h3", {}, "Open incident", h("span", { class: `state ${inc.state}` }, incidentState(inc.state)))),
    h("div", { class: "btns" }, ...btns),
    h("div", { class: "meta" }, "Peak ", h("b", {}, `${inc.peak_density} per m²`), `, ${inc.peak_count} people`),
    h("div", { class: "tl" }, inc.timeline.slice(-3).map((e) => `${clock(e.t)} ${e.text}`).join("  /  "))));
}

store.subscribe(render);
