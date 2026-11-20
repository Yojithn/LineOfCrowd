// Volunteer phone page: your zone's status in one glance, and a hold-to-crash chaos test.
import { api, connect, signInUrl } from "./api.js";
import { $, $$, h, WORD } from "./util.js";

let cfg = null;
let live = null;
let mine = null;
let prevStatus = null;
let responded = null;
const crashes = {};   // zone -> { at, down }
let best = null;

try { mine = localStorage.getItem("cs-zone"); best = Number(localStorage.getItem("cs-best")) || null; } catch { /* private mode */ }

$$(".tabs button").forEach((b) => b.addEventListener("click", () => {
  $$(".tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
  $("#tab-zone").hidden = b.dataset.tab !== "zone";
  $("#tab-break").hidden = b.dataset.tab !== "break";
}));

function pick(id) {
  mine = id;
  prevStatus = null;
  try { localStorage.setItem("cs-zone", id); } catch { /* ignore */ }
  render();
}

function buildChips() {
  $("#chips").replaceChildren(...cfg.zones.map((z) => {
    const b = h("button", { "aria-pressed": "false", "data-id": z.id }, z.name);
    b.addEventListener("click", () => pick(z.id));
    return b;
  }));
}

function holdButton(zone) {
  const btn = h("button", { class: "hold", "aria-label": `Press and hold to crash the ${zone.name} camera`,
    html: '<svg viewBox="0 0 74 74"><circle class="bg" cx="37" cy="37" r="34"/><circle class="fg" cx="37" cy="37" r="34"/></svg><span>Hold to<br>crash</span>' });
  const ring = btn.querySelector(".fg");
  let t0 = 0, raf = 0;
  const HOLD = 1100;
  const reset = () => { cancelAnimationFrame(raf); t0 = 0; ring.style.strokeDashoffset = "220"; btn.classList.remove("armed"); };
  const tick = (t) => {
    const k = Math.min(1, (t - t0) / HOLD);
    ring.style.strokeDashoffset = String(220 * (1 - k));
    if (k < 1) { raf = requestAnimationFrame(tick); return; }
    btn.classList.add("armed");
    navigator.vibrate?.(70);
    fire(zone, btn);
    setTimeout(reset, 400);
  };
  btn.addEventListener("pointerdown", (e) => { if (btn.disabled) return; btn.setPointerCapture(e.pointerId); t0 = performance.now(); raf = requestAnimationFrame(tick); });
  btn.addEventListener("pointerup", () => { if (!btn.classList.contains("armed")) reset(); });
  btn.addEventListener("pointercancel", reset);
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
  btn.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fire(zone, btn); } });
  return btn;
}

async function fire(zone, btn) {
  btn.disabled = true;
  const r = await api.post(`/api/chaos/kill/${zone.id}?by=phone`);
  if (r.status === 401) return location.assign(signInUrl());
  if (r.ok) crashes[zone.id] = { at: Date.now(), down: false };
  else {
    btn.querySelector("span").innerHTML = r.status === 429 ? `Wait<br>${r.data?.retry_after || 5} s` : "Failed";
    setTimeout(() => { btn.disabled = false; btn.querySelector("span").innerHTML = "Hold to<br>crash"; }, 3000);
  }
}

const rows = {};
function buildTargets() {
  $("#targets").replaceChildren(...cfg.zones.map((z) => {
    const sub = h("span", {}, "Running");
    const row = h("div", { class: "target" }, h("div", {}, h("b", {}, `${z.name} camera`), sub), holdButton(z));
    rows[z.id] = { row, sub, btn: row.querySelector(".hold") };
    return row;
  }));
}

$("#respond").addEventListener("click", async () => {
  const inc = openIncident();
  if (!inc) return;
  const zn = cfg.zones.find((z) => z.id === mine)?.name || "this zone";
  const r = await api.post(`/api/incidents/${inc.id}/respond`, { by: `a volunteer at ${zn}` });
  if (r.status === 401) return location.assign(signInUrl());
  responded = r.ok ? inc.id : null;
  $("#respond-note").hidden = false;
  $("#respond-note").textContent = r.ok ? "The control room can see you're on your way." : r.message;
  render();
});

const openIncident = () => (live?.incidents || []).find((i) => i.zone === mine && i.state !== "resolved");

function render() {
  if (!cfg || !live) return;
  $$("#chips button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.id === mine)));
  const z = live.zones.find((q) => q.id === mine);
  if (z) {
    const s = z.offline ? "offline" : z.status;
    $("#hero").dataset.s = s;
    $("#where").textContent = z.name;
    $("#word").textContent = WORD[s];
    $("#fig").textContent = z.offline ? "Camera is restarting" : `${z.density.toFixed(1)} people per m², ${z.count} in view`;
    $("#meter").setAttribute("width", String(Math.min(300, (z.load_pct / 100) * 300)));
    const plan = (live.plans || []).find((p) => p.from === z.id);
    const steps = s === "critical" ? [["Do this now", z.tip], plan && ["Send people to", `${plan.to_name}. It is ${plan.to_load_pct}% full.`]]
      : s === "warning" ? [["Slow things down", "Keep walkways clear and stop people from stopping in the middle."]]
        : s === "offline" ? [["Use your eyes", "The camera is restarting. Watch your area for a few seconds."]]
          : [["All good", "Keep people moving. Nothing to do right now."]];
    $("#todo").replaceChildren(...steps.filter(Boolean).map(([a, b]) => h("li", {}, h("b", {}, a), b)));
    if (s === "critical" && prevStatus && prevStatus !== "critical") navigator.vibrate?.([400, 150, 400, 150, 800]);
    prevStatus = s;
    const inc = openIncident();
    $("#respond").hidden = !inc || responded === inc.id || inc.state === "responding";
    if (!inc) $("#respond-note").hidden = true;
  }

  for (const zz of live.zones) {
    const r = rows[zz.id];
    if (!r) continue;
    const c = crashes[zz.id];
    r.row.dataset.down = String(zz.offline);
    r.sub.textContent = zz.offline ? "Down. Waiting for Kubernetes…" : zz.pod ? `Running on pod ${zz.pod.split("-").slice(-1)[0]}` : "Running";
    if (!c) { r.btn.disabled = zz.offline; continue; }
    if (zz.offline) c.down = true;
    else if (c.down) {
      const secs = (Date.now() - c.at) / 1000;
      delete crashes[zz.id];
      if (!best || secs < best) { best = secs; try { localStorage.setItem("cs-best", String(secs)); } catch { /* ignore */ } }
      $("#score").hidden = false;
      $("#score-n").textContent = `${secs.toFixed(1)} s`;
      $("#best").textContent = `Fastest on this phone: ${best.toFixed(1)} s`;
      r.btn.disabled = false;
      r.btn.querySelector("span").innerHTML = "Hold to<br>crash";
    }
  }
}

async function init() {
  const r = await api.get("/api/config");
  if (!r.ok) { $("#conn").textContent = "Reconnecting…"; setTimeout(init, 2000); return; }
  cfg = r.data;
  buildChips();
  buildTargets();
  if (!mine) mine = cfg.zones[0].id;
  connect((s) => { live = s; $("#conn").textContent = `${s.totals.cameras_online} of ${s.totals.cameras} cameras live`; render(); },
    (c) => { $("#conn").dataset.conn = c; if (c === "lost") $("#conn").textContent = "Reconnecting…"; });
}
init();
