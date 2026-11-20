// One place for app state. Components subscribe and re-render once per animation frame.

const state = {
  cfg: null,            // /api/config
  live: null,           // latest /api/stream payload
  history: null,        // /api/history (15 min replay)
  replayT: null,        // unix time being replayed, or null for live
  selected: null,       // zone id open in the drawer
  layers: { pressure: false, heat: false, people: false, flow: false },
  prefs: { voice: true, follow: true },
  started: false,
  receivedAt: 0,
  conn: "connecting",   // connecting | live | lost
  logFilter: "all",
};

const subs = new Set();
let queued = false;

export const store = {
  get: () => state,
  set(patch) {
    Object.assign(state, patch);
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; subs.forEach((fn) => fn(state)); });
  },
  subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
};

/** The zones as they should be shown right now: live, or reconstructed from replay history. */
export function zonesView(s = state) {
  const live = s.live?.zones || [];
  if (s.replayT == null || !s.history) {
    if (s.conn === "live") return live;
    return live.map((z) => ({ ...z, status: "offline", offline: true }));
  }
  const t = s.replayT;
  return live.map((z) => {
    const series = s.history.zones[z.id] || [];
    let i = series.length - 1;
    while (i > 0 && series[i][0] > t) i--;
    const p = series[i];
    const upto = series.slice(Math.max(0, i - 59), i + 1).map((q) => q[1]);
    if (!p || p[0] > t) return { ...z, density: 0, count: 0, status: "offline", offline: true, points: [], flow: {}, trend: [] };
    const offline = p[3] === "offline" || p[1] == null;
    return {
      ...z, density: p[1] ?? 0, count: p[2] ?? 0, status: offline ? "offline" : p[3], offline,
      points: [], flow: {}, trend: upto,
      forecast: { trend: "steady", per_min: 0, eta_s: null },
      load_pct: Math.round(((p[1] ?? 0) / s.live.thresholds.critical) * 100),
    };
  });
}

export const thresholds = (s = state) => s.live?.thresholds || s.cfg?.thresholds || { warning: 2, critical: 4 };
export const zoneCfg = (id, s = state) => s.cfg?.zones.find((z) => z.id === id);
