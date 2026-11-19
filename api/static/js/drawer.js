// Zone drawer: live feed, 15-minute chart with a hover readout, a flow rose of how people move,
// the open incident for this zone, and the actions an operator can take.
import { store, thresholds } from "./store.js";
import { api } from "./api.js";
import { $, h, WORD, TREND, clock, clamp, duration, forecastEta, esc, shortPod, tween } from "./util.js";
import { toast } from "./toast.js";
import { flyToZone } from "./scene.js";

const box = () => $("#drawer");
let openId = null;
let series = [];          // [[t, density|null], ...] for the chart
let returnFocus = null;
let hoverX = null;
const el = {};

export const drawerOpen = () => openId;

export function openDrawer(id) {
  const cfgZone = store.get().cfg.zones.find((z) => z.id === id);
  if (!cfgZone) return;
  if (openId !== id) returnFocus = returnFocus || document.activeElement;
  openId = id;
  store.set({ selected: id });
  build(cfgZone);
  box().classList.add("open");
  box().setAttribute("aria-hidden", "false");
  el.close.focus({ preventScroll: true });
  loadHistory(id);
  render(store.get());
}

export function closeDrawer() {
  if (!openId) return false;
  openId = null;
  store.set({ selected: null });
  box().classList.remove("open");
  box().setAttribute("aria-hidden", "true");
  returnFocus?.focus?.({ preventScroll: true });
  returnFocus = null;
  return true;
}

async function loadHistory(id) {
  series = [];
  const r = await api.get("/api/history");
  if (r.ok && openId === id) series = (r.data.zones[id] || []).map((p) => [p[0], p[1]]);
  drawChart();
}

function build(zc) {
  const d = box();
  d.innerHTML = "";
  el.st = h("div", { class: "st" });
  el.close = h("button", { class: "x", "aria-label": "Close zone details", html: "&#x2715;", onclick: closeDrawer });
  el.feed = h("img", { alt: `Live camera at ${zc.name}` });
  el.people = h("b", {}, "0");
  el.dens = h("b", {}, "0.0");
  el.load = h("b", {}, "0%");
  el.cam = h("b", {}, "--");
  el.camLabel = h("span", { class: "label" }, "Detection time");
  el.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.read = h("div", { class: "read" });
  el.rose = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.rose.setAttribute("viewBox", "0 0 150 150");
  el.move = h("p");
  el.fc = h("p");
  el.ver = h("p");
  el.inc = h("div");
  el.surge = h("button", { class: "btn", onclick: () => surge(zc) }, "Run surge drill");
  el.crash = h("button", { class: "btn danger", onclick: () => crash(zc) }, "Crash this camera");
  const chart = h("div", { class: "chart" }, el.svg, el.read);
  chart.addEventListener("pointermove", (e) => { const r = el.svg.getBoundingClientRect(); hoverX = (e.clientX - r.left) / r.width; drawChart(); });
  chart.addEventListener("pointerleave", () => { hoverX = null; drawChart(); });

  d.append(
    h("header", {}, h("div", {}, el.st, h("h2", {}, zc.name)), el.close),
    h("div", { class: "body" },
      h("div", { class: "feed" }, el.feed),
      h("div", { class: "stats" },
        h("div", {}, el.people, h("span", { class: "label" }, "People in view")),
        h("div", {}, el.dens, h("span", { class: "label" }, "Per m²")),
        h("div", {}, el.load, h("span", { class: "label" }, "Of crush level")),
        h("div", {}, el.cam, el.camLabel)),
      h("div", {}, h("span", { class: "label" }, "Last 15 minutes. Hover to read a moment."), chart),
      h("div", { class: "duo" }, h("div", { class: "compass" }, el.rose), h("div", {}, el.move, el.fc, el.ver)),
      el.inc,
      h("div", { class: "actions" }, el.surge, el.crash,
        h("button", { class: "btn", onclick: () => flyToZone(zc.id) }, "Show on map"))));
}

async function surge(zc) {
  const r = await api.post(`/api/chaos/surge/${zc.id}`);
  toast(r.ok ? `Surge drill started at ${zc.name}` : r.message, !r.ok);
}

async function crash(zc) {
  el.crash.disabled = true;
  const r = await api.post(`/api/chaos/kill/${zc.id}?by=dashboard`);
  toast(r.ok ? `Crashed the ${zc.name} camera. Watch it come back.` : r.message, !r.ok);
  setTimeout(() => { if (el.crash) el.crash.disabled = false; }, 4000);
}

async function act(inc, action, label) {
  const r = await api.post(`/api/incidents/${inc.id}/${action}`, { by: "control room" });
  toast(r.ok ? `${inc.id}: ${label}` : r.message, !r.ok);
}

document.addEventListener("frame", (e) => { if (e.detail.id === openId && el.feed) el.feed.src = e.detail.url; });

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
  if (z.offline) el.move.innerHTML = "<b>Camera restarting.</b> Movement will show again in a few seconds.";
  else if (!f.moving || f.moving < 4) el.move.innerHTML = "<b>Mostly standing still.</b> Too few people are moving to read a direction.";
  else if (hot) el.move.innerHTML = `<b>Turbulent.</b> Groups are pushing in opposite directions, an early warning sign in a packed crowd.`;
  else el.move.innerHTML = `<b>Orderly.</b> ${f.moving} people moving, mostly ${direction(f.angle)}.`;
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
  const st = z.offline ? "offline" : z.status;
  box().dataset.s = st;
  el.st.textContent = WORD[st];
  if (z.offline) { el.people.textContent = "--"; el.people._v = undefined; } else tween(el.people, z.count, 0);
  tween(el.dens, z.offline ? 0 : z.density, 1);
  el.load.textContent = `${z.load_pct}%`;
  if (z.sim) { el.cam.textContent = "Simulated"; el.camLabel.textContent = "Camera feed"; }
  else { el.cam.textContent = `${Math.round(z.infer_ms)} ms`; el.camLabel.textContent = "Detection time"; }
  const last = series[series.length - 1];
  if (!last || s.live.now - last[0] >= 2) series.push([s.live.now, z.offline ? null : z.density]);
  drawChart();
  drawRose(z);
  const f = z.forecast || {};
  const eta = forecastEta(z);
  el.fc.textContent = z.offline ? "" : s.conn === "lost" ? "Forecast unavailable while the stream is disconnected."
    : z.status === "critical" ? "Observed crush risk."
    : eta != null ? `Forecast: crush risk in about ${duration(Math.ceil(eta))} if the trend holds.`
    : `${TREND[f.trend] || "Trend unavailable"}. No current crush-risk forecast.`;
  el.ver.innerHTML = z.version ? `Camera software <b>${esc(z.version)}</b> on pod <b>${esc(shortPod(z.pod))}</b>` : "";
  el.surge.hidden = !z.sim;

  const inc = (s.live.incidents || []).find((i) => i.zone === openId && i.state !== "resolved");
  if (!inc) { el.inc.innerHTML = ""; return; }
  const key = `${inc.id}:${inc.state}:${inc.timeline.length}`;
  if (el.inc.dataset.key === key) return;
  el.inc.dataset.key = key;
  el.inc.innerHTML = "";
  const btns = [];
  if (inc.state === "open") btns.push(h("button", { class: "btn go", onclick: () => act(inc, "ack", "acknowledged") }, "Acknowledge"));
  if (inc.state !== "responding") btns.push(h("button", { class: "btn", onclick: () => act(inc, "respond", "volunteers sent") }, "Send volunteers"));
  btns.push(h("button", { class: "btn", onclick: () => act(inc, "resolve", "resolved") }, "Resolve"));
  el.inc.append(h("div", { class: "inc hot" },
    h("div", {}, h("span", { class: "id" }, `${inc.id}, opened ${clock(inc.opened_at)}`), h("h3", {}, "Open incident", h("span", { class: `state ${inc.state}` }, inc.state))),
    h("div", { class: "btns" }, ...btns),
    h("div", { class: "meta" }, "Peak ", h("b", {}, `${inc.peak_density} per m²`), `, ${inc.peak_count} people`),
    h("div", { class: "tl" }, inc.timeline.slice(-3).map((e) => `${clock(e.t)} ${e.text}`).join("  /  "))));
}

store.subscribe(render);
