// Alarms: observed risk, forecasts, audio and camera transitions.
import { store, thresholds } from "./store.js";
import { incidentAction, incidentBusy, incidentState } from "./incidents.js";
import { $, h, clock, duration, forecastEta, WORD } from "./util.js";
import { flyToZone, resetView } from "./scene.js";
import { spotlight, healed, markOffline, offlineFor } from "./cameras.js";

let audio = null;
let silenced = false;
const tones = new Set();
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
  tones.add(o);
  o.onended = () => tones.delete(o);
  o.start(t0);
  o.stop(t0 + 1.95);
}

export function silence() {
  if ($("#alert-response").hidden || silenced) return false;
  silenced = true;
  for (const tone of tones) tone.stop();
  $("#alert-silence").disabled = true;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  return true;
}

export function initAlarm(pick) {
  $("#alert-silence").addEventListener("click", silence);
  $("#alert-open").addEventListener("click", () => { const id = $("#alert").dataset.zone; if (id) pick(id); });
  $("#alert-ack").addEventListener("click", async () => {
    const iid = $("#alert").dataset.incident;
    if (!iid) return;
    const inc = store.get().live?.incidents.find((i) => i.id === iid);
    if (inc && await incidentAction(inc, "ack")) silence();
  });
  store.subscribe((s) => { if (s.live) { if (s.conn === "live") transitions(s); renderAlert(s, pick); } });
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
        speak(z.name + " monitoring unavailable.");
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

function renderAlert(s, pick) {
  const L = s.live;
  const t = thresholds(s);
  const active = L.zones.filter((z) => !z.offline);
  const incidents = new Map((L.incidents || []).filter((i) => i.state !== "resolved").map((i) => [i.zone, i]));
  const acknowledged = (zone) => ["acknowledged", "responding"].includes(incidents.get(zone.id)?.state);
  const critical = active.filter((z) => z.status === "critical").sort((a, b) =>
    Number(acknowledged(a)) - Number(acknowledged(b)) || b.density - a.density);
  const crowded = active.filter((z) => z.status === "warning").sort((a, b) => b.density - a.density);
  const observed = [...critical, ...crowded];
  const stale = s.conn !== "live";
  const forecasts = stale ? [] : active
    .map((zone) => ({ zone, eta: forecastEta(zone) }))
    .filter(({ eta }) => eta != null)
    .sort((a, b) => a.eta - b.eta);
  const [z, ...others] = observed;
  const box = $("#alert");
  box.hidden = !z && !forecasts.length;
  box.dataset.s = critical.length ? "critical" : z ? "warning" : "info";
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
  $("#alert-silence").disabled = silenced;
  $("#alert-response").hidden = !critical.length;
  box.dataset.incident = "";
  if (!z) return;

  const inc = incidents.get(z.id);
  box.dataset.attention = inc?.state === "open" || !inc ? "active" : "acknowledged";
  $("#alert-kicker").textContent = (z.status === "critical" ? "Critical" : "Warning") +
    (stale ? " · Last reported" : "") + (inc && z.status === "critical" ? " · " + incidentState(inc.state) : "");
  $("#alert-age").textContent = observedAt(z, L);
  $("#alert-open").setAttribute("aria-label", "Open " + z.name);
  $("#alert-title").textContent = WORD[z.status] + " at " + z.name;
  $("#alert-text").textContent = densityReason(z, t) + " · " + z.count.toLocaleString() + " people in view";
  const otherList = $("#alert-other");
  otherList.hidden = !others.length;
  // Keep the interactive rows mounted when only the readings change.
  const rows = others.map((zone) => {
    let li = [...otherList.children].find((row) => row.dataset.zone === zone.id);
    if (!li) li = h("li", { "data-zone": zone.id },
      h("button", { class: "linkish", onclick: () => pick(zone.id) }), h("span"));
    li.dataset.s = zone.status;
    li.firstChild.textContent = WORD[zone.status] + " at " + zone.name + " · Open zone";
    const state = zone.status === "critical" && incidents.get(zone.id)?.state;
    li.lastChild.textContent = [state && incidentState(state), densityReason(zone, t), observedAt(zone, L)].filter(Boolean).join(" · ");
    return li;
  });
  rows.forEach((row, i) => { if (otherList.children[i] !== row) otherList.insertBefore(row, otherList.children[i] || null); });
  while (otherList.children.length > rows.length) otherList.lastChild.remove();
  if (critical.length) renderResponse(L, z, inc, stale);
}

function announce(selector, message) {
  const el = $(selector);
  if (el.textContent !== message) el.textContent = message;
}

function densityReason(z, t) {
  return `${z.density.toFixed(2)} people/m² · threshold ${t[z.status]}`;
}

function observedAt(z, L) {
  return "Observed " + clock(z.last_measurement_at ?? z.last_seen ?? L.now);
}

function renderResponse(L, z, inc, stale) {
  const plan = (L.plans || []).find((p) => p.from === z.id);
  $("#alert").dataset.incident = inc?.id || "";
  const steps = !stale && z.tip ? [z.tip] : [];
  if (!stale && plan) steps.push(`Send people to ${plan.to_name} at ${plan.to_load_pct}% of its crush-risk threshold.`);
  if (!stale && z.flow?.counterflow_confirmed) steps.push("Groups are pushing in opposite directions here. Stop the inbound stream first.");
  const key = steps.join("|");
  if ($("#alert-steps").dataset.key !== key) {
    $("#alert-steps").dataset.key = key;
    $("#alert-steps").replaceChildren(...steps.map((t) => h("li", {}, h("span", {}, t))));
  }
  const ack = $("#alert-ack");
  ack.hidden = !inc || inc.state !== "open";
  ack.disabled = !inc || incidentBusy(inc);
}
