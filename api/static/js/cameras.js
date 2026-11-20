// Camera wall: four live feeds with a CCTV overlay. Click a feed to open its zone.
import { store } from "./store.js";
import { $, WORD } from "./util.js";

const tiles = {};
const offSince = {};

export const platformName = (mode) => ({ k8s: "Kubernetes", compose: "Docker" }[mode] || "The system");

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
    t.el.dataset.s = z.offline ? "offline" : z.status;
    t.el.dataset.frame = frame.available ? "live" : "unavailable";
    t.el.setAttribute("aria-pressed", String(s.selected === z.id));
    t.img.hidden = !frame.available;
    const severity = !z.offline && z.status !== "safe" ? WORD[z.status] + " · " : "";
    const label = severity + frame.label;
    t.el.querySelector(".camera-state").textContent = label;
    t.el.setAttribute("aria-label", z.name + " camera, " + label);
    if (z.offline && !offSince[z.id]) offSince[z.id] = Date.now();
  }
}

export function cameraFrame(z, conn) {
  const t = tiles[z.id];
  const age = t?.received ? Math.floor((Date.now() - t.received) / 1000) : null;
  const available = !z.offline && conn === "live" && !t?.missing && age !== null && age < 4;
  let label;
  if (conn !== "live") label = conn === "lost" ? "Stream disconnected" : "Connecting";
  else if (z.offline) label = ({
    unseen: "Awaiting camera", stale: "Stale report", delayed: "Delayed camera",
    processing_error: "Processing error", no_frames: "No frames",
  })[z.worker_health] || "Offline";
  else if (available) label = (z.sim ? "Simulated" : "Live") + " · received " + age + "s ago";
  else if (age !== null) label = "Unavailable · last frame " + age + "s ago";
  else label = t?.missing ? "Frame unavailable" : "Loading frame";
  return { available, label, url: available ? t.url : null };
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
    const response = await fetch(`/api/frame/${id}.jpg?t=${Date.now()}`, { cache: "no-store" });
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
