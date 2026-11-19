// Left rail: one row per zone with the number that matters, its trend and its forecast.
import { store, zonesView, thresholds } from "./store.js";
import { $, h, WORD, tween, spark, duration, COL, rgb } from "./util.js";

const rows = {};

function forecastText(z, t) {
  if (z.offline) return { text: "Camera restarting", hot: false };
  if (z.status === "critical") return { text: "Crush risk now", hot: true };
  const f = z.forecast || {};
  if (f.eta_s != null && f.eta_s <= 600 && z.density >= t.warning * 0.75) return { text: `Crush risk in ${duration(f.eta_s)}`, hot: true };
  if (f.trend === "rising") return { text: "Rising slowly", hot: false };
  if (f.trend === "falling") return { text: "Easing", hot: false };
  return { text: "Steady", hot: false };
}

export function initLedger(cfg, onPick) {
  const box = $("#zones");
  cfg.zones.forEach((zc, i) => {
    const el = h("button", { class: "zone", "data-s": "safe", "aria-pressed": "false", title: `Open ${zc.name} (${i + 1})` },
      h("div", { class: "top" }, h("span", { class: "nm" }, zc.name), h("span", { class: "st" }, "Calm")),
      h("div", { class: "row" },
        h("span", { class: "d big" }, "0.0"),
        h("span", { class: "u" }, "per m²", h("br"), h("span", { class: "c" }, "0 people"))),
      h("div", { class: "spark" }),
      h("div", { class: "fc" }, "Steady"),
      h("div", { class: "load" }, h("i")));
    el.addEventListener("click", () => onPick(zc.id));
    box.append(el);
    rows[zc.id] = el;
  });
  store.subscribe(render);
}

function render(s) {
  if (!s.live) return;
  const t = thresholds(s);
  $("#levels").textContent = `calm under ${t.warning}, crush risk ${t.critical}+ per m²`;
  for (const z of zonesView(s)) {
    const el = rows[z.id];
    if (!el) continue;
    const st = z.offline ? "offline" : z.status;
    el.dataset.s = st;
    el.setAttribute("aria-pressed", String(s.selected === z.id));
    el.querySelector(".st").textContent = WORD[st];
    tween(el.querySelector(".d"), z.offline ? 0 : z.density, 1);
    el.querySelector(".c").textContent = z.offline ? "no signal" : `${z.count} people`;
    el.querySelector(".spark").innerHTML = spark(z.trend?.length ? z.trend : [0], t, rgb(COL[st]));
    const fc = forecastText(z, t);
    const fcEl = el.querySelector(".fc");
    fcEl.textContent = s.replayT != null ? "Replaying" : fc.text;
    fcEl.classList.toggle("hot", s.replayT == null && fc.hot);
    el.querySelector(".load i").style.width = `${Math.min(100, z.load_pct || 0)}%`;
  }
}
