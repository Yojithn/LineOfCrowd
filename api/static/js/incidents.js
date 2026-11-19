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

async function act(inc, action, done) {
  const r = await api.post(`/api/incidents/${inc.id}/${action}`, { by: "control room" });
  toast(r.ok ? `${inc.id} ${done}` : r.message, !r.ok);
}

function card(inc) {
  const btns = [];
  if (inc.state === "open") btns.push(h("button", { class: "btn go sm", onclick: () => act(inc, "ack", "acknowledged") }, "Acknowledge"));
  if (inc.state === "open" || inc.state === "acknowledged") btns.push(h("button", { class: "btn sm", onclick: () => act(inc, "respond", "has volunteers on the way") }, "Send volunteers"));
  if (inc.state !== "resolved") btns.push(h("button", { class: "btn sm", onclick: () => act(inc, "resolve", "resolved") }, "Resolve"));
  const title = h("h3", {}, h("button", { class: "linkish", style: "all:unset;cursor:pointer", onclick: () => onPick(inc.zone) }, `Crush risk at ${inc.zone_name}`),
    h("span", { class: `state ${inc.state}` }, inc.state === "resolved" ? "resolved" : inc.state));
  return h("article", { class: `inc${inc.state === "open" && !inc.eased ? " hot" : ""}` },
    h("div", {}, h("span", { class: "id" }, `${inc.id}, opened ${clock(inc.opened_at)}`), title),
    btns.length ? h("div", { class: "btns" }, ...btns) : null,
    h("div", { class: "meta" }, h("span", { class: "timer" }), ", peak ", h("b", {}, `${inc.peak_density} per m²`), inc.eased && inc.state !== "resolved" ? ", zone has eased" : ""),
    h("div", { class: "tl" }, inc.timeline.slice(-2).map((e) => `${clock(e.t)} ${e.text}`).join("  /  ")));
}

function render(s) {
  const list = s.live?.incidents || [];
  const box = $("#incidents");
  const open = list.filter((i) => i.state !== "resolved").length;
  $("#inc-count").textContent = open ? `${open} open` : "none open";
  if (!list.length) {
    if (!box.querySelector(".empty")) box.replaceChildren(h("p", { class: "empty" }, "No incidents yet. A zone reaching crush risk opens one automatically, with steps to follow."));
    return;
  }
  const seen = new Set();
  const order = [];
  for (const inc of list) {
    const key = `${inc.state}:${inc.eased}:${inc.timeline.length}:${inc.peak_density}`;
    let c = cards.get(inc.id);
    if (!c || c.key !== key) {
      const el = card(inc);
      if (c) c.el.replaceWith(el);
      c = { el, key, inc };
      cards.set(inc.id, c);
    }
    c.inc = inc;
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
