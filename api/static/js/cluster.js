// Cluster: every pod as a hexagon. New pods grow in, deleted pods shatter.
// Click one to inspect it, and delete it to watch Kubernetes heal.
import { store } from "./store.js";
import { api } from "./api.js";
import { $, h, reducedMotion, esc, shortPod } from "./util.js";
import { toast } from "./toast.js";

const hexes = new Map();
let seeded = false;
let inspecting = null;

export function initCluster() {
  store.subscribe(render);
  document.addEventListener("pointerdown", (e) => {
    if (inspecting && !e.target.closest(".inspector, .hex")) closeInspector();
  });
}

export function closeInspector() {
  if (!inspecting) return false;
  hexes.get(inspecting)?.setAttribute("aria-expanded", "false");
  inspecting = null;
  $("#inspector").classList.remove("on");
  return true;
}

function shatter(el) {
  if (reducedMotion()) return;
  const r = el.getBoundingClientRect();
  for (let i = 0; i < 9; i++) {
    const s = h("i", { class: "shard" });
    const a = (i / 9) * Math.PI * 2;
    s.style.left = `${r.left + r.width / 2 - 7}px`;
    s.style.top = `${r.top + r.height / 2 - 7}px`;
    s.style.setProperty("--dx", `${Math.cos(a) * (40 + Math.random() * 40)}px`);
    s.style.setProperty("--dy", `${Math.sin(a) * (40 + Math.random() * 40)}px`);
    s.style.setProperty("--r", `${Math.random() * 540 - 270}deg`);
    document.body.append(s);
    setTimeout(() => s.remove(), 1000);
  }
}

function inspect(name, anchor) {
  if (inspecting === name) return closeInspector();
  closeInspector();
  inspecting = name;
  anchor.setAttribute("aria-expanded", "true");
  fill();
  const box = $("#inspector");
  box.classList.add("on");
  const r = anchor.getBoundingClientRect();
  const w = 270;
  box.style.left = `${Math.min(window.innerWidth - w - 12, Math.max(12, r.left + r.width / 2 - w / 2))}px`;
  box.style.top = `${Math.max(12, r.top - box.offsetHeight - 10)}px`;
  box.querySelector("button")?.focus();
}

function fill() {
  const s = store.get();
  const p = (s.live?.pods || []).find((q) => q.name === inspecting);
  const box = $("#inspector");
  if (!p) { box.innerHTML = `<h3>${esc(inspecting)}</h3><p>This pod is gone. Kubernetes has replaced it.</p>`; return; }
  const k8s = s.live.mode === "k8s";
  const canDelete = p.role === "worker" || (p.role === "api" && k8s);
  const age = p.created ? `${Math.round(s.live.now - p.created)} s` : "n/a";
  const what = p.role === "worker" ? `Camera for ${s.cfg.zones.find((z) => z.id === p.zone)?.name || p.zone}` : p.role === "api" ? "API and dashboard server" : "Shared live state";
  const note = p.role === "api"
    ? (p.name === s.live.served_by ? "Your live stream comes from this pod. Delete it and the stream moves to the other API pod." : "Delete it and the other API pod keeps everything running.")
    : p.role === "redis" ? "Redis has a single copy, so it can't be deleted from here." : "Delete it and the Deployment starts a replacement in seconds.";
  box.innerHTML = "";
  box.append(
    h("h3", {}, p.name),
    h("dl", {}, h("dt", {}, "Role"), h("dd", {}, what), h("dt", {}, "State"), h("dd", {}, p.state),
      h("dt", {}, "Version"), h("dd", {}, p.version || "n/a"), h("dt", {}, "Restarts"), h("dd", {}, String(p.restarts ?? 0)),
      h("dt", {}, "Age"), h("dd", {}, age)),
    h("p", {}, note),
    ...(canDelete ? [h("button", { class: "btn danger", onclick: () => kill(p) }, "Delete this pod")] : []));
}

async function kill(p) {
  const r = await api.post(`/api/chaos/pod/${encodeURIComponent(p.name)}`);
  toast(r.ok ? `Deleted ${shortPod(p.name)}. Watch the replacement appear.` : r.message, !r.ok);
  closeInspector();
}

function render(s) {
  const pods = s.live?.pods;
  if (!pods) return;
  const hive = $("#hive");
  const seen = new Set();
  for (const p of pods) {
    seen.add(p.name);
    let el = hexes.get(p.name);
    if (!el) {
      el = h("button", { class: "hex", "aria-expanded": "false" }, h("span"));
      el.addEventListener("click", () => inspect(p.name, el));
      if (seeded) { el._born = true; setTimeout(() => { el._born = false; }, 700); }
      hexes.set(p.name, el);
    }
    const label = p.role === "worker" ? p.zone : p.role;
    const sub = p.state === "ready" ? (p.version || "") : p.state;
    el.className = `hex ${p.state}${el._born ? " born" : ""}${p.name === s.live.served_by ? " serving" : ""}`;
    el.firstChild.innerHTML = `${esc(label)}<em>${esc(sub)}</em>`;
    el.setAttribute("aria-label", `${p.name}, ${p.state}. Inspect`);
    el.title = p.name;
  }
  // keep DOM order equal to API order without re-creating nodes
  pods.forEach((p, i) => { const el = hexes.get(p.name); if (hive.children[i] !== el) hive.insertBefore(el, hive.children[i] || null); });
  for (const [name, el] of hexes) {
    if (!seen.has(name)) { if (el.isConnected) shatter(el); el.remove(); hexes.delete(name); }
  }
  seeded = true;
  const ready = pods.filter((p) => p.state === "ready").length;
  $("#pod-count").textContent = `${pods.length} pods, ${ready} healthy`;
  $("#t-pods").textContent = `${ready}/${pods.length}`;
  if (inspecting) fill();
}
