// Start screen. At Dasara the palace lights come on at dusk; here they come on when monitoring starts.
import { store } from "./store.js";
import { $ } from "./util.js";

export function drawBootPalace() {
  const svg = $("#boot-palace");
  const pts = [];
  const line = (x1, y1, x2, y2, gap = 7) => {
    const n = Math.max(1, Math.round(Math.hypot(x2 - x1, y2 - y1) / gap));
    for (let i = 0; i <= n; i++) pts.push([x1 + ((x2 - x1) * i) / n, y1 + ((y2 - y1) * i) / n]);
  };
  const arc = (cx, cy, r, gap = 7) => {
    const n = Math.max(4, Math.round((Math.PI * r) / gap));
    for (let i = 0; i <= n; i++) { const a = Math.PI + (Math.PI * i) / n; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  };
  line(30, 146, 590, 146); line(30, 100, 590, 100); line(30, 100, 30, 146); line(590, 100, 590, 146);
  for (let x = 75; x <= 545; x += 67) arc(x, 134, 15, 6);
  line(255, 100, 255, 58); line(365, 100, 365, 58); line(255, 58, 365, 58); arc(310, 58, 40); pts.push([310, 10], [310, 4]);
  for (const cx of [95, 525]) { line(cx - 22, 100, cx - 22, 66); line(cx + 22, 100, cx + 22, 66); arc(cx, 66, 22); pts.push([cx, 38]); }
  for (const cx of [190, 430]) { line(cx - 14, 100, cx - 14, 80); line(cx + 14, 100, cx + 14, 80); arc(cx, 80, 14, 6); }
  svg.innerHTML = pts.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.1" data-y="${y.toFixed(0)}"/>`).join("");
}

export function bootChecks(s) {
  if (s.started) return;
  const li = (k) => $(`#boot-checks li[data-k="${k}"]`);
  if (s.conn === "lost" && !s.live) { li("api").className = "bad"; li("api").textContent = "Control server not reachable yet. Retrying."; return; }
  if (!s.live) return;
  li("api").className = "ok";
  li("api").textContent = `Control server connected (${s.live.mode} mode)`;
  const on = s.live.totals.cameras_online;
  li("cams").className = on ? "ok" : "";
  li("cams").textContent = on ? `${on} of ${s.live.totals.cameras} cameras reporting` : "Waiting for camera feeds";
  const pods = s.live.pods || [];
  const ready = pods.filter((p) => p.state === "ready").length;
  li("pods").className = ready ? "ok" : "";
  li("pods").textContent = s.live.mode === "k8s" ? `${ready} of ${pods.length} Kubernetes pods healthy` : `${ready} services healthy`;
}

/** Light the palace on the start screen bottom to top, then reveal the room. */
export function lightBoot(done) {
  const dots = [...document.querySelectorAll("#boot-palace circle")];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  dots.forEach((c) => {
    const delay = reduce ? 0 : (150 - +c.dataset.y) * 7 + Math.random() * 90;
    c.style.transition = `opacity 0.25s ease ${delay}ms, fill 0.25s ease ${delay}ms`;
    c.style.opacity = "1";
    c.style.fill = "#ffdc96";
  });
  setTimeout(done, reduce ? 0 : 1300);
  void store;
}
