// Incidents: every crush-risk alert opens one. Operators acknowledge, send volunteers, resolve.
import { store } from "./store.js";
import { api } from "./api.js";
import { $, h, clock, duration } from "./util.js";
import { toast } from "./toast.js";

const cards = new Map();
let onPick = () => {};

export function initIncidents(pick) {
  onPick = pick;
  store.subscribe(render);
  setInterval(() => render(store.get()), 1000);   // keep "open for" timers ticking
}

const pending = new Map();
const done = { ack: "acknowledged", respond: "marked as responding", resolve: "resolved" };
export const incidentState = (state) => ({
  open: "Needs acknowledgement", acknowledged: "Acknowledged", responding: "Responding", resolved: "Resolved",
})[state] || state;

export function incidentBusy(inc) {
  return store.get().conn !== "live" || pending.get(inc.id) === inc.state;
}

export async function incidentAction(inc, action) {
  const current = store.get().live?.incidents.find((i) => i.id === inc.id);
  if (!current || current.state !== inc.state || incidentBusy(inc)) return false;
  if (action === "resolve" && !window.confirm("Resolve " + inc.id + " at " + inc.zone_name + "? This closes the incident.")) return false;
  if (action === "respond" && !window.confirm("Mark volunteers as responding to " + inc.id + " at " + inc.zone_name + "?")) return false;
  pending.set(inc.id, inc.state);
  store.set({});
  const r = await api.post("/api/incidents/" + inc.id + "/" + action, { by: "control room" });
  toast(r.ok ? inc.id + " " + done[action] : r.message, !r.ok);
  const release = () => {
    if (pending.get(inc.id) === inc.state) pending.delete(inc.id);
    store.set({});
  };
  if (r.ok) setTimeout(release, 5000);
  else release();
  return r.ok;
}

export function incidentButtons(inc) {
  const button = (action, label, style = "") => h("button", {
    class: ("btn sm " + style).trim(), onclick: () => incidentAction(inc, action),
  }, label);
  const buttons = [];
  if (inc.state === "open") buttons.push(button("ack", "Acknowledge", "go"));
  if (["open", "acknowledged"].includes(inc.state)) buttons.push(button("respond", "Mark volunteers responding"));
  if (inc.state !== "resolved") buttons.push(button("resolve", "Resolve incident", "danger"));
  return buttons;
}

function card(inc) {
  const btns = incidentButtons(inc);
  const title = h("h3", {}, h("button", { class: "linkish", onclick: () => onPick(inc.zone) }, `Crush risk at ${inc.zone_name}`),
    h("span", { class: `state ${inc.state}` }, incidentState(inc.state)));
  return h("article", { class: `inc${inc.state === "open" && !inc.eased ? " hot" : ""}` },
    h("div", {}, h("span", { class: "id" }, `${inc.id}, opened ${clock(inc.opened_at)}`), title),
    btns.length ? h("div", { class: "btns" }, ...btns) : null,
    h("div", { class: "meta" }, h("span", { class: "timer" }), ", peak ", h("b", {}, `${inc.peak_density} per m²`), inc.eased && inc.state !== "resolved" ? ", zone has eased" : ""),
    h("div", { class: "tl" }, inc.timeline.slice(-2).map((e) => `${clock(e.t)} ${e.text}`).join("  /  ")));
}

function render(s) {
  if (!s.live) return;
  const list = s.live.incidents || [];
  const box = $("#incidents");
  const open = list.filter((i) => i.state !== "resolved").length;
  $("#inc-count").textContent = open ? `${open} open` : "none open";
  if (!list.length) {
    if (!box.querySelector(".empty")) box.replaceChildren(h("p", { class: "empty" }, "No incidents yet. A zone reaching crush risk opens one automatically, with steps to follow."));
    return;
  }
  const seen = new Set();
  const order = [];
  const priority = (i) => i.state === "resolved" ? 3 : i.eased ? 2 : i.state === "open" ? 0 : 1;
  for (const inc of [...list].sort((a, b) => priority(a) - priority(b))) {
    const key = `${inc.state}:${inc.eased}:${inc.timeline.length}:${inc.peak_density}`;
    let c = cards.get(inc.id);
    if (!c || c.key !== key) {
      const el = card(inc);
      if (c) c.el.replaceWith(el);
      c = { el, key, inc };
      cards.set(inc.id, c);
    }
    for (const button of c.el.querySelectorAll(".btns button")) button.disabled = incidentBusy(inc);
    const now = s.live.now;
    c.el.querySelector(".timer").textContent = inc.state === "resolved"
      ? `Took ${duration((inc.resolved_at || now) - inc.opened_at)}`
      : `Open for ${duration(now - inc.opened_at)}`;
    seen.add(inc.id);
    order.push(c.el);
  }
  for (const [id, c] of cards) if (!seen.has(id)) { c.el.remove(); cards.delete(id); }
  if (box.querySelector(".empty")) box.replaceChildren();
  order.forEach((el, i) => { if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null); });
}
