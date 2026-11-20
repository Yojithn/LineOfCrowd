// Left rail: current readings and recent density history for each zone.
import { store, zonesView, thresholds } from "./store.js";
import { $, h, WORD, spark, TREND } from "./util.js";

const rows = {};
const priority = { critical: 0, warning: 1, offline: 2, safe: 3 };

export function initLedger(cfg, onPick) {
  const box = $("#zones");
  cfg.zones.forEach((zc, i) => {
    const status = h("span", { class: "st" }, "Waiting");
    const density = h("b", { class: "d big" }, "—");
    const count = h("span", { class: "count" }, "—");
    const chart = h("span", { class: "spark", "aria-hidden": "true" });
    const trend = h("span", { class: "trend" }, "No history");
    const el = h("button", { class: "zone", "data-s": "offline", "aria-pressed": "false",
      "aria-controls": "drawer", title: `Open ${zc.name} (${i + 1})` },
      h("span", { class: "top" }, h("span", { class: "nm" }, zc.name), status),
      h("span", { class: "readings" },
        h("span", { class: "density" }, density, h("span", { class: "unit" }, "people/m²")),
        h("span", { class: "people" }, count, " people")),
      h("span", { class: "history" }, chart, trend));
    el.addEventListener("click", () => onPick(zc.id));
    box.append(el);
    rows[zc.id] = { el, status, density, count, chart, trend };
  });
  store.subscribe(render);
}

function render(s) {
  if (!s.live) return;
  const t = thresholds(s);
  $("#levels").textContent = `Crowded ≥ ${t.warning} · Crush risk ≥ ${t.critical} people/m²`;
  const box = $("#zones");
  const zones = [...zonesView(s)].sort((a, b) => priority[a.status] - priority[b.status] ||
    (a.status === "critical" || a.status === "warning" ? b.density - a.density : 0));
  for (const [i, z] of zones.entries()) {
    const row = rows[z.id];
    if (!row) continue;
    const { el, status, density, count, chart, trend } = row;
    if (!box.contains(document.activeElement) && box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
    const stale = s.conn !== "live" && s.replayT == null;
    const st = z.offline ? "offline" : z.status;
    el.dataset.s = st;
    el.setAttribute("aria-pressed", String(s.selected === z.id));
    status.textContent = stale ? "Delayed" : WORD[st];
    density.textContent = z.offline ? "—" : z.density.toFixed(2);
    count.textContent = z.offline ? "—" : z.count.toLocaleString();
    const hasHistory = !z.offline && z.trend?.filter(Number.isFinite).length >= 2;
    chart.innerHTML = hasHistory ? spark(z.trend, t, "var(--c)") : "";
    trend.textContent = stale ? "Waiting for updates" : z.offline ? "Readings unavailable"
      : !hasHistory ? "Gathering history"
      : s.replayT != null ? "Replay"
      : [TREND[z.forecast?.trend] || "Trend unavailable", z.flow?.counterflow_confirmed && "Counterflow"].filter(Boolean).join(" · ");
  }
}
