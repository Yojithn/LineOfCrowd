// Alarms: voice, siren, the red alert card, following the map to trouble, and noticing recoveries.
import { store } from "./store.js";
import { api } from "./api.js";
import { $, h, duration, clock } from "./util.js";
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
  if (!document.body.classList.contains("alarm") && !$("#alert").classList.contains("on")) return false;
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
  setInterval(() => { const s = store.get(); if (s.live) renderAlert(s); }, 1000);
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
  const crit = L.zones.filter((z) => !z.offline && z.status === "critical").sort((a, b) => b.density - a.density);
  const box = $("#alert");
  if (!crit.length) {
    if (box.classList.contains("on") && s.prefs.follow && prev.focus && s.replayT == null) resetView();
    box.classList.remove("on");
    document.body.classList.remove("alarm");
    prev.focus = null;
    return;
  }
  const z = crit[0];
  const plan = (L.plans || []).find((p) => p.from === z.id);
  const inc = (L.incidents || []).find((i) => i.zone === z.id && i.state !== "resolved");
  box.dataset.zone = z.id;
  box.dataset.incident = inc?.id || "";
  $("#alert-kicker").textContent = inc ? `${inc.id}, ${inc.state}` : "Crush risk";
  $("#alert-age").textContent = inc ? `open ${duration(L.now - inc.opened_at)}` : clock(L.now);
  $("#alert-title").textContent = `Crush risk at ${z.name}`;
  $("#alert-text").textContent = `${z.density.toFixed(1)} people per m²${z.forecast?.trend === "rising" ? " and rising" : ""}. ${z.count} people in this camera's view.${crit.length > 1 ? ` ${crit.length - 1} more zone${crit.length > 2 ? "s" : ""} at crush risk.` : ""}`;
  const steps = [z.tip];
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
  box.classList.add("on");
  document.body.classList.toggle("alarm", !silenced);
}
