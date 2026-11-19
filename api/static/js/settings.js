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
  $("#s-save").addEventListener("click", async () => {
    const r = await api.put("/api/settings", { warning: +(+w.value).toFixed(1), critical: +(+c.value).toFixed(1) });
    toast(r.ok ? "Danger levels saved for every screen" : r.message, !r.ok);
    if (r.ok) closeModal();
  });
  $("#s-reset").addEventListener("click", async () => {
    const r = await api.del("/api/settings");
    toast(r.ok ? "Danger levels reset to the defaults" : r.message, !r.ok);
    if (r.ok) closeModal();
  });
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
