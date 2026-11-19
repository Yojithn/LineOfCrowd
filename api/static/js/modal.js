// Modal dialogs: one scrim, a stack, focus kept inside, focus returned on close.
import { $ } from "./util.js";

const stack = [];
const FOCUSABLE = "button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])";

export const modalOpen = () => stack.length > 0;

export function openModal(el, { onClose, focus } = {}) {
  if (stack.some((m) => m.el === el)) return;
  stack.push({ el, onClose, ret: document.activeElement });
  $("#scrim").classList.add("on");
  el.classList.add("on");
  (focus || el.querySelector(FOCUSABLE))?.focus();
}

export function closeModal() {
  const m = stack.pop();
  if (!m) return false;
  m.el.classList.remove("on");
  if (!stack.length) $("#scrim").classList.remove("on");
  m.onClose?.();
  m.ret?.focus?.({ preventScroll: true });
  return true;
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Tab" || !stack.length) return;
  const items = [...stack[stack.length - 1].el.querySelectorAll(FOCUSABLE)];
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
document.addEventListener("DOMContentLoaded", () => $("#scrim")?.addEventListener("click", () => { while (closeModal()); }));
