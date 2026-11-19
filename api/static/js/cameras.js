// Camera wall: four live feeds with a CCTV overlay. Click a feed to open its zone.
import { store } from "./store.js";
import { $, WORD, shortPod, tween } from "./util.js";

const tiles = {};
const offSince = {};

export const platformName = (mode) => ({ k8s: "Kubernetes", compose: "Docker" }[mode] || "The system");

export function initCameras(cfg, onPick) {
  const tpl = $("#tpl-cam");
  const wall = $("#cams");
  for (const z of cfg.zones) {
    const el = tpl.content.firstElementChild.cloneNode(true);
    el.dataset.zone = z.id;
    el.querySelector(".nm").textContent = z.name;
    el.querySelector("img").alt = `Live camera at ${z.name}`;
    el.setAttribute("aria-label", `${z.name} camera. Open zone details`);
    el.addEventListener("click", () => onPick(z.id));
    wall.insertBefore(el, $("#drawer"));
    tiles[z.id] = { el, img: el.querySelector("img"), canvas: el.querySelector("canvas"), url: null, busy: false };
  }
  store.subscribe(render);
  setInterval(refreshFrames, 1000);
  setInterval(staticNoise, 110);
}

function render(s) {
  if (!s.live) return;
  const who = platformName(s.live.mode);
  for (const z of s.live.zones) {         // cameras always show live, even during replay
    const t = tiles[z.id];
    if (!t) continue;
    const st = z.offline ? "offline" : z.status;
    t.el.dataset.s = st;
    t.el.classList.toggle("off", z.offline);
    t.el.querySelector(".chip").textContent = WORD[st];
    t.el.querySelector(".who").textContent = who;
    const n = t.el.querySelector(".n");
    if (z.offline) { n.firstChild.nodeValue = "--"; n._v = undefined; } else tween(n, z.count, 0);
    t.el.querySelector(".sub").textContent = z.offline ? "" : `${z.density.toFixed(1)} per m², ${z.load_pct}% of crush level`;
    t.el.querySelector(".rec").textContent = z.sim ? "Live, simulated feed" : "Live";
    t.el.querySelector(".ver").textContent = z.version ? `${z.version}\n${shortPod(z.pod)}` : "";
    if (z.offline && !offSince[z.id]) offSince[z.id] = Date.now();
  }

}

export function healed(id, secs) {
  const t = tiles[id];
  if (!t) return;
  delete offSince[id];
  const b = t.el.querySelector(".healed");
  b.textContent = secs ? `Back in ${secs.toFixed(1)} s` : "Back online";
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
    if (!t || z.offline || t.busy) continue;
    t.busy = true;
    fetch(`/api/frame/${z.id}.jpg?t=${Date.now()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (!b) return;
        const url = URL.createObjectURL(b);
        const img = new Image();
        img.onload = () => {
          t.img.src = url;
          if (t.url) URL.revokeObjectURL(t.url);
          t.url = url;
          document.dispatchEvent(new CustomEvent("frame", { detail: { id: z.id, url, at: Date.now() } }));
        };
        img.src = url;
      })
      .catch(() => {})
      .finally(() => { t.busy = false; });
  }
}

function staticNoise() {
  for (const [id, t] of Object.entries(tiles)) {
    if (!t.el.classList.contains("off")) continue;
    const c = t.canvas.getContext("2d");
    const im = c.createImageData(160, 90);
    for (let i = 0; i < im.data.length; i += 4) {
      const v = Math.random() * 190;
      im.data[i] = v; im.data[i + 1] = v * 0.86; im.data[i + 2] = v * 0.74; im.data[i + 3] = 255;
    }
    c.putImageData(im, 0, 0);
    const secs = offlineFor(id);
    if (secs != null) t.el.querySelector(".off-t").textContent = `${secs.toFixed(1)} s`;
  }
}
