// Small shared helpers. No framework: every component builds its DOM once and updates it in place.

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

/** Create an element: h("button", { class: "btn", onclick }, "Text") */
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export const WORD = { safe: "Calm", warning: "Crowded", critical: "Crush risk", offline: "No signal" };
export const COL = { safe: [61, 185, 166], warning: [255, 145, 36], critical: [255, 59, 48], offline: [138, 116, 97] };
export const ZARI = [207, 163, 73];
export const JASMINE = [243, 234, 219];

export const clock = (ts) => new Date(ts * 1000).toLocaleTimeString("en-GB");
export function duration(s) {
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}
export const names = (a) => (a.length <= 1 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);
export const shortPod = (p) => (p ? p.split("-").slice(-2).join("-") : "");

/** Animate a number in an element's first text node. */
export function tween(el, to, decimals = 0, ms = 450) {
  const node = el.firstChild && el.firstChild.nodeType === 3 ? el.firstChild : el.insertBefore(document.createTextNode(""), el.firstChild);
  const from = el._v ?? to;
  el._v = to;
  if (reducedMotion() || from === to || !Number.isFinite(from)) { node.nodeValue = to.toFixed(decimals); return; }
  const t0 = performance.now();
  cancelAnimationFrame(el._raf);
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms), e = 1 - (1 - k) ** 3;
    node.nodeValue = (from + (to - from) * e).toFixed(decimals);
    if (k < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

/** SVG sparkline with the two danger levels drawn as dashed guides. */
export function spark(values, t, color, w = 200, hgt = 34) {
  const max = Math.max(t.critical * 1.25, ...values, 0.1);
  const y = (v) => (hgt - (v / max) * hgt).toFixed(1);
  const pts = values.length > 1
    ? values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${y(v ?? 0)}`).join(" ")
    : `0,${hgt} ${w},${hgt}`;
  return `<svg viewBox="0 0 ${w} ${hgt}" preserveAspectRatio="none" aria-hidden="true">
    <line x1="0" x2="${w}" y1="${y(t.critical)}" y2="${y(t.critical)}" stroke="#ff3b30" stroke-opacity=".5" stroke-dasharray="2 4" vector-effect="non-scaling-stroke"/>
    <line x1="0" x2="${w}" y1="${y(t.warning)}" y2="${y(t.warning)}" stroke="#ff9124" stroke-opacity=".35" stroke-dasharray="2 4" vector-effect="non-scaling-stroke"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
}

export const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
