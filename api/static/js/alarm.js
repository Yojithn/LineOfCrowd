// Alarms: observed risk, forecasts, audio and camera transitions.
import { store, thresholds } from "./store.js";
import { api } from "./api.js";
import { $, h, duration, forecastEta, WORD } from "./util.js";
import { flyToZone, resetView } from "./scene.js";
import { spotlight, healed, markOffline, offlineFor, platformName } from "./cameras.js";
import { toast } from "./toast.js";

let audio = null;
let silenced = false;
const prev = { status: {}, offline: {}, pipeKey: null, seeded: false, focus: null };

export function armAudio() {
  try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { audio = null; }
}

export function speak(text) {
  const s = store.get();
  if (!s.started || !s.prefs.voice || !("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  const v = speechSynthesis.getVoices();
  u.voice = v.find((x) => x.lang === "en-IN") || v.find((x) => x.lang.startsWith("en-GB")) || v.find((x) => x.lang.startsWith("en")) || null;
  u.rate = 1.02;
  speechSynthesis.speak(u);
}

function siren() {
  if (!audio || silenced) return;
  const t0 = audio.currentTime;
  const o = audio.createOscillator(), g = audio.createGain();
  o.type = "triangle";
  for (let i = 0; i < 6; i++) o.frequency.setValueAtTime(i % 2 ? 640 : 920, t0 + i * 0.3);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.09, t0 + 0.05);
  g.gain.setValueAtTime(0.09, t0 + 1.7);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.9);
  o.connect(g).connect(audio.destination);
  o.start(t0);
  o.stop(t0 + 1.95);
}

export function silence() {
  if ($("#alert-response").hidden || silenced) return false;
  silenced = true;
  document.body.classList.remove("alarm");
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  return true;
}

export function initAlarm(pick) {
  $("#alert-silence").addEventListener("click", silence);
  $("#alert-open").addEventListener("click", () => { const id = $("#alert").dataset.zone; if (id) pick(id); });
  $("#alert-ack").addEventListener("click", async () => {
    const iid = $("#alert").dataset.incident;
    if (!iid) return;
    const r = await api.post(`/api/incidents/${iid}/ack`, { by: "control room" });
    toast(r.ok ? `${iid} acknowledged` : r.message, !r.ok);
    silence();
  });
  store.subscribe((s) => { if (s.live) { transitions(s); renderAlert(s); } });
}

function transitions(s) {
  const L = s.live;
  for (const z of L.zones) {
    const was = prev.status[z.id], wasOff = prev.offline[z.id];
    if (prev.seeded && s.started) {
      if (z.status === "critical" && was !== "critical" && !z.offline) {
        const plan = (L.plans || []).find((p) => p.from === z.id);
        silenced = false;
        speak(`Warning. Crush risk at ${z.name}. ${plan ? `Send people to ${plan.to_name}.` : ""}`);
        siren();
        spotlight(z.id);
        if (s.prefs.follow && s.replayT == null) { flyToZone(z.id); prev.focus = z.id; }
      }
      if (z.offline && wasOff === false) {
        markOffline(z.id);
        speak(`${z.name} camera lost. ${platformName(L.mode)} is restarting it.`);
      }
      if (!z.offline && wasOff === true) {
        const secs = offlineFor(z.id);
        healed(z.id, secs);
        speak(`${z.name} camera restored${secs ? ` in ${Math.round(secs)} seconds` : ""}.`);
      }
    } else if (z.offline) markOffline(z.id);
    prev.status[z.id] = z.status;
    prev.offline[z.id] = z.offline;
  }
  const p = L.pipeline;
  const key = p ? `${p.run}:${p.result}` : null;
  if (prev.seeded && s.started && p && key !== prev.pipeKey) {
    if (p.result === "rolled_back") speak(`Release ${p.version} failed its health checks. Rolled back automatically. No downtime.`);
    else if (p.result === "live") speak(`Version ${p.version} is live.`);
    else if (!prev.pipeKey || !prev.pipeKey.startsWith(`${p.run}:`)) speak(`Releasing version ${p.version}.`);
  }
  prev.pipeKey = key;
  prev.seeded = true;
}

function renderAlert(s) {
  const L = s.live;
  const t = thresholds(s);
  const active = L.zones.filter((z) => !z.offline);
  const critical = active.filter((z) => z.status === "critical").sort((a, b) => b.density - a.density);
  const crowded = active.filter((z) => z.status === "warning").sort((a, b) => b.density - a.density);
  const observed = [...critical, ...crowded];
  const stale = s.conn === "lost";
  const forecasts = stale ? [] : active
    .map((zone) => ({ zone, eta: forecastEta(zone) }))
    .filter(({ eta }) => eta != null)
    .sort((a, b) => a.eta - b.eta);
  const [z, ...others] = observed;
  const box = $("#alert");
  box.hidden = !z && !forecasts.length;
  box.dataset.s = critical.length ? "critical" : "warning";
  box.dataset.zone = z?.id || "";
  $("#alert-observed").hidden = !z;
  $("#alert-predicted").hidden = !forecasts.length;
  $("#forecast-level").textContent = t.critical;
  $("#alert-forecasts").replaceChildren(...forecasts.map(({ zone, eta }) =>
    h("li", {}, h("b", {}, zone.name), h("span", {}, `About ${duration(Math.ceil(eta))}`))));

  const timing = stale ? "Last reported" : "Observed";
  announce("#critical-announcement", critical.map((zone) => `${timing} crush risk at ${zone.name}.`).sort().join(" "));
  announce("#warning-announcement", [
    ...crowded.map((zone) => `${timing} crowding at ${zone.name}.`),
    ...forecasts.map(({ zone }) => `Crush risk forecast for ${zone.name}.`),
  ].sort().join(" "));
  if (!critical.length) {
    if (s.prefs.follow && prev.focus && s.replayT == null) resetView();
    prev.focus = null;
    silenced = false;
  }
  document.body.classList.toggle("alarm", Boolean(critical.length) && !silenced);
  $("#alert-response").hidden = !critical.length;
  box.dataset.incident = "";
  if (!z) return;

  $("#alert-kicker").textContent = stale ? "Last reported · stream disconnected" : "Live observation";
  $("#alert-title").textContent = `${WORD[z.status]} at ${z.name}`;
  $("#alert-text").textContent = `${densityReason(z, t)} · ${z.count.toLocaleString()} people in view`;
  $("#alert-other").hidden = !others.length;
  $("#alert-other").replaceChildren(...others.map((zone) =>
    h("li", { "data-s": zone.status }, h("b", {}, `${WORD[zone.status]} at ${zone.name}`),
      h("span", {}, densityReason(zone, t)))));
  if (critical.length) renderResponse(L, z);
  else $("#alert-age").textContent = "";
}

function announce(selector, message) {
  const el = $(selector);
  if (el.textContent !== message) el.textContent = message;
}

function densityReason(z, t) {
  return `${z.density.toFixed(2)} people/m² · threshold ${t[z.status]}`;
}

function renderResponse(L, z) {
  const plan = (L.plans || []).find((p) => p.from === z.id);
  const inc = (L.incidents || []).find((i) => i.zone === z.id && i.state !== "resolved");
  $("#alert").dataset.incident = inc?.id || "";
  $("#alert-age").textContent = inc ? `${inc.id} · ${inc.state} · ${duration(L.now - inc.opened_at)}` : "";
  const steps = z.tip ? [z.tip] : [];
  if (plan) steps.push(`Send people to ${plan.to_name}, which is ${plan.to_load_pct}% full.`);
  if ((z.flow?.counterflow || 0) >= 0.55) steps.push("Groups are pushing in opposite directions here. Stop the inbound stream first.");
  const key = steps.join("|");
  if ($("#alert-steps").dataset.key !== key) {
    $("#alert-steps").dataset.key = key;
    $("#alert-steps").replaceChildren(...steps.map((t) => h("li", {}, h("span", {}, t))));
  }
  const ack = $("#alert-ack");
  ack.disabled = !inc || inc.state !== "open";
  ack.textContent = inc && inc.state !== "open" ? "Acknowledged" : "Acknowledge";
}
