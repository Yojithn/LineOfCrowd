// Short confirmations at the bottom of the screen.
import { $, h } from "./util.js";
import { SIGN_IN_MESSAGE, signInUrl } from "./api.js";

/** link: optional { label, href } shown inside the toast. Sign-in errors get one automatically. */
export function toast(text, bad = false, ms = 3200, link = null) {
  if (text === SIGN_IN_MESSAGE) {
    link = { label: "Sign in", href: signInUrl() };
    ms = Math.max(ms, 8000);
  }
  const t = h("div", { class: `toast${bad ? " bad" : ""}`, role: bad ? "alert" : "status" }, text);
  if (link) {
    t.classList.add("has-link");
    t.append(h("a", { href: link.href }, link.label));
  }
  $("#toasts").append(t);
  setTimeout(() => t.remove(), ms);
}
