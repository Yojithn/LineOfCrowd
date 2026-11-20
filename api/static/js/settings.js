// Danger levels: tune the crowded and crush-risk densities live, with a preview of the effect.
import { store } from "./store.js";
import { api } from "./api.js";
import { $ } from "./util.js";
import { openModal, closeModal } from "./modal.js";
import { toast } from "./toast.js";

export function initSettings() {
  const w = $("#s-warn"), c = $("#s-crit");
  const update = () => {
    if (+w.value >= +c.value) c.value = (+w.value + 0.5).toFixed(1);
    $("#s-warn-v").textContent = `${(+w.value).toFixed(1)} per m²`;
    $("#s-crit-v").textContent = `${(+c.value).toFixed(1)} per m²`;
    preview(+w.value, +c.value);
  };
  w.addEventListener("input", update);
  c.addEventListener("input", update);
  $("#s-cancel").addEventListener("click", closeModal);
  const save = $("#s-save"), reset = $("#s-reset");
  const submit = async (defaults) => {
    if (save.disabled) return;
    if (store.get().conn !== "live") return toast("Wait for live updates before changing danger levels.", true);
    const prompt = defaults ? "Restore default danger levels for every screen?"
      : "Apply these danger levels to every screen?";
    if (!window.confirm(prompt)) return;
    save.disabled = reset.disabled = true;
    const r = defaults ? await api.del("/api/settings")
      : await api.put("/api/settings", { warning: +(+w.value).toFixed(1), critical: +(+c.value).toFixed(1) });
    save.disabled = reset.disabled = false;
    toast(r.ok ? (defaults ? "Default danger levels restored" : "Danger levels saved for every screen") : r.message, !r.ok);
    if (r.ok && $("#settings").classList.contains("on")) closeModal();
  };
  save.addEventListener("click", () => submit(false));
  reset.addEventListener("click", () => submit(true));
  initSettings.update = update;
}

function preview(warn, crit) {
  const zones = store.get().live?.zones || [];
  const word = (d) => (d >= crit ? "crush risk" : d >= warn ? "crowded" : "calm");
  const changes = zones.filter((z) => !z.offline && word(z.density) !== { safe: "calm", warning: "crowded", critical: "crush risk" }[z.status])
    .map((z) => `${z.name} would become ${word(z.density)}`);
  $("#s-preview").textContent = changes.length ? `${changes.join(". ")}.` : "No zone would change state right now.";
}

export function openSettings() {
  const t = store.get().live?.thresholds || store.get().cfg.thresholds;
  $("#s-warn").value = t.warning;
  $("#s-crit").value = t.critical;
  initSettings.update();
  openModal($("#settings"));
}
