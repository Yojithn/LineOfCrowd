// Replay: drag along the last 15 minutes and the map and zone list show that moment.
import { store } from "./store.js";
import { api } from "./api.js";
import { $, clock, duration, clamp, COL, rgb } from "./util.js";

const SPAN = 15 * 60;
let dragging = false;

const liveNow = () => store.get().live?.now || Date.now() / 1000;

export function initReplay() {
  const track = $("#track");
  const frac = (e) => clamp((e.clientX - track.getBoundingClientRect().left) / track.clientWidth, 0, 1);
  track.addEventListener("pointerdown", (e) => { dragging = true; track.setPointerCapture(e.pointerId); seek(frac(e)); });
  track.addEventListener("pointermove", (e) => {
    const f = frac(e);
    const tip = $("#track-tip");
    tip.style.left = `${f * 100}%`;
    tip.textContent = f > 0.995 ? "Live" : `${clock(liveNow() - SPAN + f * SPAN)}`;
    if (dragging) seek(f);
  });
  track.addEventListener("pointerup", () => { dragging = false; });
  track.addEventListener("keydown", (e) => {
    const big = e.shiftKey ? 60 : 10;
    if (e.key === "ArrowLeft") { step(-big); e.preventDefault(); }
    if (e.key === "ArrowRight") { step(big); e.preventDefault(); }
    if (e.key === "Home") { setReplay(liveNow() - SPAN); e.preventDefault(); }
    if (e.key === "End") { goLive(); e.preventDefault(); }
  });
  $("#live-pill").addEventListener("click", goLive);
  $("#to-live").addEventListener("click", goLive);
  window.addEventListener("resize", draw);
  refresh();
  setInterval(refresh, 6000);
  store.subscribe(render);
}

async function refresh() {
  const r = await api.get("/api/history");
  if (r.ok) { store.set({ history: r.data }); draw(); }
}

function seek(f) { if (f > 0.995) goLive(); else setReplay(liveNow() - SPAN + f * SPAN); }

export function setReplay(t) {
  const now = liveNow();
  if (t >= now - 2) return goLive();
  store.set({ replayT: Math.max(now - SPAN, t) });
  document.body.classList.add("replaying");
}
export function goLive() {
  if (store.get().replayT == null) return false;
  store.set({ replayT: null });
  document.body.classList.remove("replaying");
  return true;
}
export function step(sec) { setReplay((store.get().replayT ?? liveNow()) + sec); }

/** A seismograph of the venue: one bar every 6 s, as tall as the most crowded zone, coloured by its risk. */
function draw() {
  const s = store.get();
  const svg = $("#track-svg");
  const W = svg.clientWidth || 600, H = 40;
  if (!s.history) return;
  const now = s.history.now, t0 = now - SPAN, B = 150, bw = W / B;
  const crit = s.live?.thresholds?.critical || 4;
  const max = new Array(B).fill(null);
  const stat = new Array(B).fill("safe");
  const rank = { safe: 0, warning: 1, critical: 2, offline: -1 };
  for (const pts of Object.values(s.history.zones)) {
    for (const [t, d, , st] of pts) {
      const i = Math.floor(((t - t0) / SPAN) * B);
      if (i < 0 || i >= B || d == null) continue;
      if (max[i] == null || d > max[i]) max[i] = d;
      if (rank[st] > rank[stat[i]]) stat[i] = st;
    }
  }
  let out = `<line x1="0" x2="${W}" y1="${H - 1}" y2="${H - 1}" stroke="#563628"/>`;
  max.forEach((d, i) => {
    if (d == null) return;
    const hgt = Math.max(2, (Math.min(d, crit * 1.3) / (crit * 1.3)) * (H - 10));
    out += `<rect x="${(i * bw).toFixed(1)}" y="${(H - 1 - hgt).toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${hgt.toFixed(1)}" fill="${rgb(COL[stat[i]], 0.75)}"/>`;
  });
  const marks = { critical: "#ff3b30", offline: "#bba48c", rollback: "#ff3b30", deploy: "#cfa349", chaos: "#ff9124" };
  for (const e of s.history.events) {
    if (!marks[e.kind] || e.ts < t0) continue;
    const x = ((e.ts - t0) / SPAN) * W;
    out += `<circle cx="${x.toFixed(1)}" cy="4" r="3" fill="${marks[e.kind]}"><title>${clock(e.ts)} ${e.text.replace(/[<&]/g, "")}</title></circle>`;
  }
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = out;
}

function render(s) {
  const now = liveNow();
  const f = s.replayT == null ? 1 : clamp((s.replayT - (now - SPAN)) / SPAN, 0, 1);
  $("#track-handle").style.left = `${f * 100}%`;
  $("#track").setAttribute("aria-valuenow", String(Math.round(f * 100)));
  $("#track").setAttribute("aria-valuetext", s.replayT == null ? "Live" : `${clock(s.replayT)}`);
  if (s.replayT != null) $("#replay-label").textContent = `Replaying ${clock(s.replayT)}, ${duration(now - s.replayT)} ago`;
}
