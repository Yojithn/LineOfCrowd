// Command menu (Ctrl K): every action in the room, one search away.
import { store } from "./store.js";
import { $, h, esc } from "./util.js";
import { openModal, closeModal } from "./modal.js";

let actions = () => [];
let items = [];
let sel = 0;

export function initPalette(buildActions) {
  actions = buildActions;
  const q = $("#palette-q");
  q.addEventListener("input", () => { sel = 0; draw(); });
  q.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
    if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    if (e.key === "Enter" && items[sel]) { run(items[sel]); e.preventDefault(); }
  });
}

export function openPalette() {
  $("#palette-q").value = "";
  sel = 0;
  draw();
  openModal($("#palette"), { focus: $("#palette-q") });
}

function run(item) {
  closeModal();
  item.run();
}

/** Fuzzy match: letters in order, rewarding word starts and runs. Returns score and matched indexes. */
function match(text, q) {
  if (!q) return { score: 0, hits: [] };
  const t = text.toLowerCase();
  let ti = 0, score = 0, run = 0;
  const hits = [];
  for (const ch of q.toLowerCase()) {
    if (ch === " ") continue;
    const at = t.indexOf(ch, ti);
    if (at < 0) return null;
    run = at === ti ? run + 1 : 0;
    score += 1 + run * 2 + (at === 0 || t[at - 1] === " " ? 3 : 0) - (at - ti) * 0.05;
    hits.push(at);
    ti = at + 1;
  }
  return { score, hits };
}

function highlight(text, hits) {
  const set = new Set(hits);
  return [...text].map((c, i) => (set.has(i) ? `<mark>${esc(c)}</mark>` : esc(c))).join("");
}

function draw() {
  const q = $("#palette-q").value.trim();
  items = actions()
    .map((a) => ({ ...a, m: match(a.title, q) }))
    .filter((a) => a.m)
    .sort((a, b) => b.m.score - a.m.score)
    .slice(0, 12);
  const list = $("#palette-list");
  list.replaceChildren();
  if (!items.length) { list.append(h("li", { class: "none" }, `Nothing matches "${q}".`)); return; }
  items.forEach((a, i) => {
    const li = h("li", { role: "option", "aria-selected": String(i === sel), id: `pal-${i}` },
      h("span", { html: highlight(a.title, a.m.hits) }), h("small", {}, a.group));
    li.addEventListener("pointermove", () => { if (sel !== i) { sel = i; draw(); } });
    li.addEventListener("click", () => run(a));
    list.append(li);
  });
  $("#palette-q").setAttribute("aria-activedescendant", `pal-${sel}`);
  list.children[sel]?.scrollIntoView({ block: "nearest" });
  void store;
}
