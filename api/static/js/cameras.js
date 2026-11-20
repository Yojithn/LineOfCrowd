// Camera wall: four live feeds with a CCTV overlay. Click a feed to open its zone.
import { store } from "./store.js";
import { $, clock } from "./util.js";

import { api } from "./api.js";
import { toast } from "./toast.js";

const tiles = {};
const offSince = {};

export function initCameras(cfg, onPick) {
  const tpl = $("#tpl-cam");
  const wall = $("#camera-grid");
  for (const z of cfg.zones) {
    const el = tpl.content.firstElementChild.cloneNode(true);
    el.dataset.zone = z.id;
    el.querySelector(".nm").textContent = z.name;
    el.querySelector("img").alt = `Live camera at ${z.name}`;
    el.setAttribute("aria-label", `${z.name} camera. Open zone details`);
    el.addEventListener("click", () => onPick(z.id));
    wall.append(el);
    tiles[z.id] = { el, img: el.querySelector("img"), url: null, received: 0, missing: false, busy: false };
  }
  store.subscribe(render);
  setInterval(refreshFrames, 1000);

}

function render(s) {
  if (!s.live) return;
  for (const z of s.live.zones) {
    const t = tiles[z.id];
    if (!t) continue;
    const frame = cameraFrame(z, s.conn);
    t.el.dataset.s = z.offline || s.conn !== "live" ? "offline" : z.status;
    t.el.dataset.frame = frame.available ? "live" : "unavailable";
    t.el.setAttribute("aria-pressed", String(s.selected === z.id));
    t.img.hidden = !frame.available;
    const worker = workerStatus(z, s.conn);
    const preview = t.el.querySelector(".camera-state");
    const processing = t.el.querySelector(".worker-state");
    preview.dataset.s = frame.tone;
    preview.textContent = "Preview · " + frame.label;
    processing.dataset.s = worker.tone;
    processing.textContent = "Worker · " + worker.label;
    t.el.setAttribute("aria-label", z.name + " camera. " + preview.textContent + ". " + processing.textContent);
    if (z.offline && !offSince[z.id]) offSince[z.id] = Date.now();
  }
}

export function cameraFrame(z, conn) {
  const t = tiles[z.id];
  const age = t?.received ? Math.floor((Date.now() - t.received) / 1000) : null;
  const available = !z.offline && conn === "live" && !t?.missing && age !== null && age < 4;
  let label = "Loading";
  if (conn !== "live") label = conn === "lost" ? "Reconnecting" : "Connecting";
  else if (available) label = z.sim ? "Online (simulated)" : "Online";
  else if (z.worker_health === "disconnected" || z.worker_health === "no_frames") label = "Offline";
  else if (z.offline || t?.missing || age !== null) label = "Unavailable";
  return { available, label, tone: available ? "safe" : "offline", url: available ? t.url : null };
}

export function workerStatus(z, conn) {
  if (conn !== "live") return { label: "Status delayed", tone: "offline" };
  if (!z.offline) return { label: "Processing", tone: "safe" };
  const label = ({
    unseen: "Awaiting reports", stale: "Reports stale", delayed: "Measurements delayed",
    processing_error: "Processing error", no_frames: "No frames", disconnected: "Disconnected",
  })[z.worker_health] || "Unavailable";
  return { label: z.last_seen ? label + " · " + clock(z.last_seen) : label,
    tone: ["stale", "delayed", "processing_error", "no_frames"].includes(z.worker_health) ? "warning" : "offline" };
}

const drills = new Set();
export function cameraDrillPending(id) { return drills.has(id); }

export async function cameraDrill(zone, action) {
  const s = store.get();
  if (drills.has(zone.id)) return;
  if (s.conn !== "live") return toast("Wait for live updates before starting a drill.", true);
  const current = s.live?.zones.find((z) => z.id === zone.id);
  if (!current || (action === "surge" && (!current.sim || current.offline))) {
    return toast("This drill is unavailable for the current camera state.", true);
  }
  const kill = action === "kill";
  if (kill && !window.confirm("Crash the camera worker at " + zone.name + "? Monitoring for this zone will be interrupted until recovery.")) return;
  drills.add(zone.id);
  store.set({});
  const r = await api.post("/api/chaos/" + action + "/" + zone.id + (kill ? "?by=dashboard" : ""));
  toast(r.ok ? (kill ? "Camera crash requested at " : "Surge drill started at ") + zone.name : r.message, !r.ok);
  setTimeout(() => { drills.delete(zone.id); store.set({}); }, r.ok ? 4000 : 0);
}

export function healed(id, secs) {
  const t = tiles[id];
  if (!t) return;
  delete offSince[id];
  const b = t.el.querySelector(".healed");
  b.textContent = secs ? `Back in ${Math.floor(secs)} s` : "Back online";
  b.classList.remove("on");
  void b.offsetWidth;
  b.classList.add("on");
}
export function markOffline(id) { offSince[id] = Date.now(); }
export const offlineFor = (id) => (offSince[id] ? (Date.now() - offSince[id]) / 1000 : null);

let spotTimer = 0;
export function spotlight(id, ms = 9000) {
  Object.values(tiles).forEach((t) => t.el.classList.remove("spot"));
  const t = tiles[id];
  if (!t) return;
  t.el.classList.add("spot");
  clearTimeout(spotTimer);
  spotTimer = setTimeout(() => t.el.classList.remove("spot"), ms);
}

function refreshFrames() {
  const live = store.get().live;
  for (const z of live?.zones || []) {
    const t = tiles[z.id];
    if (!t || t.busy || z.offline || store.get().conn !== "live") continue;
    fetchFrame(z.id, t);
  }
  render(store.get());
}

async function fetchFrame(id, tile) {
  tile.busy = true;
  let url;
  try {
    const response = await fetch(`/api/frame/${id}.jpg?t=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error("Frame unavailable");
    url = URL.createObjectURL(await response.blob());
    const image = new Image();
    image.src = url;
    await image.decode();
    tile.img.src = url;
    if (tile.url) URL.revokeObjectURL(tile.url);
    tile.url = url;
    tile.received = Date.now();
    tile.missing = false;
    url = null;
  } catch {
    tile.missing = true;
  } finally {
    if (url) URL.revokeObjectURL(url);
    tile.busy = false;
    render(store.get());
    document.dispatchEvent(new CustomEvent("frame", { detail: { id } }));
  }
}
