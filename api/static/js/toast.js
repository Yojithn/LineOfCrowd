// Short confirmations at the bottom of the screen.
import { $, h } from "./util.js";

export function toast(text, bad = false, ms = 3200) {
  const t = h("div", { class: `toast${bad ? " bad" : ""}`, role: bad ? "alert" : "status" }, text);
  $("#toasts").append(t);
  setTimeout(() => t.remove(), ms);
}
