// CrowdSentinel control room: wires the modules together.
import { store } from "./store.js";
import { api, connect } from "./api.js";
import { $, $$, names, tween } from "./util.js";
import { initScene, resetView, flyToZone, lightUp } from "./scene.js";
import { initLedger } from "./ledger.js";
import { initCameras } from "./cameras.js";
import { openDrawer, closeDrawer, drawerOpen } from "./drawer.js";
import { initIncidents } from "./incidents.js";
import { initCluster, closeInspector } from "./cluster.js";
import { initPipeline } from "./pipeline.js";
import { initReplay, setReplay, goLive, step } from "./replay.js";
import { initPalette, openPalette } from "./palette.js";
import { initSettings, openSettings } from "./settings.js";
import { initAlarm, armAudio, speak, silence } from "./alarm.js";
import { drawBootPalace, bootChecks, lightBoot } from "./boot.js";
import { openModal, closeModal, modalOpen } from "./modal.js";
import { toast } from "./toast.js";

const LAYER_NAMES = { pressure: "pressure columns", heat: "heat map", people: "people", flow: "flow arrows" };

function pick(id) {
  if (drawerOpen() === id) return closeDrawer();
  openDrawer(id);
}

function toggleLayer(k) {
  const layers = { ...store.get().layers, [k]: !store.get().layers[k] };
  store.set({ layers });
  $("#pressure-key").hidden = !layers.pressure;
  $$("#layers button").forEach((b) => b.setAttribute("aria-pressed", String(layers[b.dataset.layer])));
}

function setPref(k, v, msg) {
  store.set({ prefs: { ...store.get().prefs, [k]: v } });
  if (k === "follow") $("#follow").setAttribute("aria-pressed", String(v));
  if (msg) toast(msg);
  if (k === "voice" && !v && "speechSynthesis" in window) speechSynthesis.cancel();
}

async function crash(z) {
  const r = await api.post(`/api/chaos/kill/${z.id}?by=dashboard`);
  toast(r.ok ? `Crashed the ${z.name} camera` : r.message, !r.ok);
}
async function surge(z) {
  const r = await api.post(`/api/chaos/surge/${z.id}`);
  toast(r.ok ? `Surge drill started at ${z.name}` : r.message, !r.ok);
}

function actions() {
  const s = store.get();
  const now = s.live?.now || Date.now() / 1000;
  const out = [];
  for (const z of s.cfg.zones) {
    const sim = s.live?.zones.find((q) => q.id === z.id)?.sim;
    out.push({ title: `Open ${z.name}`, group: "Zone", run: () => openDrawer(z.id) });
    out.push({ title: `Crash the ${z.name} camera`, group: "Chaos test", run: () => crash(z) });
    if (sim) out.push({ title: `Surge drill at ${z.name}`, group: "Drill", run: () => surge(z) });
  }
  for (const [k, label] of Object.entries(LAYER_NAMES)) {
    out.push({ title: `${s.layers[k] ? "Hide" : "Show"} ${label}`, group: "Map layer", run: () => toggleLayer(k) });
  }
  for (const m of [2, 5, 10]) out.push({ title: `Replay ${m} minutes ago`, group: "Replay", run: () => setReplay(now - m * 60) });
  out.push({ title: "Back to live", group: "Replay", run: goLive });
  for (const inc of (s.live?.incidents || []).filter((i) => i.state !== "resolved")) {
    out.push({ title: `Resolve ${inc.id} at ${inc.zone_name}`, group: "Incident", run: async () => {
      const r = await api.post(`/api/incidents/${inc.id}/resolve`, { by: "control room" });
      toast(r.ok ? `${inc.id} resolved` : r.message, !r.ok);
    } });
  }
  out.push(
    { title: "Change danger levels", group: "Settings", run: openSettings },
    { title: "Reset map view", group: "Map", run: resetView },
    { title: s.prefs.voice ? "Turn voice alerts off" : "Turn voice alerts on", group: "Settings", run: () => setPref("voice", !s.prefs.voice, s.prefs.voice ? "Voice alerts off" : "Voice alerts on") },
    { title: s.prefs.follow ? "Stop following alerts on the map" : "Follow alerts on the map", group: "Map", run: () => setPref("follow", !s.prefs.follow) },
    { title: "Silence the alarm", group: "Alarm", run: silence },
    { title: "Show the volunteer QR code", group: "Share", run: openQR },
    { title: "Open the volunteer phone page", group: "Share", run: () => window.open("/m", "_blank", "noopener") },
    { title: "Show keyboard shortcuts", group: "Help", run: () => openModal($("#keys")) },
  );
  return out;
}

function openQR() {
  const s = store.get();
  const url = `${s.cfg.public_url}/m`;
  $("#qr-img").src = `/api/qr.svg?dark=%2324130f&data=${encodeURIComponent(url)}`;
  $("#qr-url").textContent = url;
  $("#qr-warn").hidden = !/localhost|127\.0\.0\.1/.test(url);
  openModal($("#qr-dialog"));
}

function renderHeader(s) {
  const L = s.live;
  if (!L) return;
  const crit = L.zones.filter((z) => !z.offline && z.status === "critical").map((z) => z.name);
  const warn = L.zones.filter((z) => !z.offline && z.status === "warning").map((z) => z.name);
  const off = L.zones.filter((z) => z.offline).length;
  let text = "All zones calm";
  if (crit.length) text = `Crush risk at ${names(crit)}`;
  else if (warn.length) text = `Crowded at ${names(warn)}`;
  else if (off) text = `${off} camera${off > 1 ? "s" : ""} restarting, the rest are calm`;
  const stale = s.conn === "lost";
  const verdict = $("#verdict-text");
  if (stale) text = "Live stream disconnected";
  $("#verdict").dataset.s = stale || L.overall === "degraded" ? "offline" : L.overall;
  if (verdict.textContent !== text) verdict.textContent = text;
  tween($("#t-people"), L.totals.people, 0);
  $("#t-cams").textContent = `${L.totals.cameras_online}/${L.totals.cameras}`;
  $("#served-by").textContent = L.served_by;
}

function onKey(e) {
  const typing = e.target.closest("input, textarea, select");
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); return modalOpen() ? closeModal() : openPalette(); }
  if (e.key === "Escape") {
    if (closeModal() || closeInspector() || closeDrawer() || goLive() || silence()) e.preventDefault();
    return;
  }
  if (typing || modalOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
  const s = store.get();
  if (!s.started) { if (e.key === "Enter") start(); return; }
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit) {
    const z = s.cfg.zones[+digit[1] - 1];
    if (z) { if (e.shiftKey) surge(z); else openDrawer(z.id); }
    return;
  }
  if (e.target.closest("#track") && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  const k = e.key.toLowerCase();
  if (e.key === "/") { e.preventDefault(); openPalette(); }
  else if (e.key === "?") openModal($("#keys"));
  else if (k === "h") toggleLayer("heat");
  else if (k === "p") toggleLayer("people");
  else if (k === "f") toggleLayer("flow");
  else if (k === "c") toggleLayer("pressure");
  else if (k === "l") goLive();
  else if (k === "r") resetView();
  else if (k === "q") openQR();
  else if (k === "m") setPref("voice", !s.prefs.voice, s.prefs.voice ? "Voice alerts off" : "Voice alerts on");
  else if (e.key === "ArrowLeft") step(e.shiftKey ? -60 : -10);
  else if (e.key === "ArrowRight") step(e.shiftKey ? 60 : 10);
}

function start() {
  const s = store.get();
  if (s.started) return;
  armAudio();
  store.set({ started: true });
  lightBoot(() => {
    $("#boot").classList.add("gone");
    lightUp();
    speak(`CrowdSentinel online. Watching ${s.cfg.zones.length} zones at ${s.cfg.venue.name}.`);
  });
}

async function init() {
  drawBootPalace();
  let r = await api.get("/api/config");
  while (!r.ok) {
    $("#verdict-text").textContent = "Control server not reachable. Retrying…";
    await new Promise((res) => setTimeout(res, 2000));
    r = await api.get("/api/config");
  }
  const cfg = r.data;
  store.set({ cfg });
  try { await document.fonts.load("650 15px Anek"); } catch { /* fall back silently */ }

  initScene(cfg, pick);
  initLedger(cfg, pick);
  initCameras(cfg, pick);
  initIncidents(pick);
  initCluster();
  initPipeline(pick);
  initReplay();
  initPalette(actions);
  initSettings();
  initAlarm(pick);
  store.subscribe(renderHeader);
  store.subscribe(bootChecks);
  store.subscribe((s) => { $("#served").dataset.conn = s.conn; });

  connect((live) => store.set({ live }), (conn) => { if (store.get().conn !== conn) store.set({ conn }); });

  $("#start").addEventListener("click", start);
  $("#open-palette").addEventListener("click", openPalette);
  $("#open-qr").addEventListener("click", openQR);
  $$("#layers button").forEach((b) => b.addEventListener("click", () => toggleLayer(b.dataset.layer)));
  $("#follow").addEventListener("click", () => setPref("follow", !store.get().prefs.follow));
  $("#reset-view").addEventListener("click", resetView);
  document.addEventListener("keydown", onKey);
  const tick = () => { $("#clock").textContent = new Date().toLocaleTimeString("en-GB"); };
  tick();
  setInterval(tick, 1000);
  window.CS = { store, flyToZone };   // handy in the browser console during the demo
}

init();
