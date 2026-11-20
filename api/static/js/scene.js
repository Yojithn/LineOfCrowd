// The 3D venue: Mysuru Palace outlined in Dasara bulbs, zones, crowd pressure, heat, people and flow.
/* global deck */
import { store, zonesView } from "./store.js";
import { COL, ZARI, JASMINE, WORD, clamp, reducedMotion } from "./util.js";

const M_LAT = 111320;
let LNG0 = 0, LAT0 = 0, M_LNG = 1;
const ll = (dx, dy, z = 0) => [LNG0 + dx / M_LNG, LAT0 + dy / M_LAT, z];
const rect = (cx, cy, w, h) => [ll(cx - w / 2, cy - h / 2), ll(cx + w / 2, cy - h / 2), ll(cx + w / 2, cy + h / 2), ll(cx - w / 2, cy + h / 2)];

const G = { floor: [], grid: [], wall: [], walks: [], palace: [], towers: [], dome: [], bulbs: [], zones: [] };
let deckgl = null;
let overview = null;
let bootAt = 0;
let hoverZone = null;
let lastStateAt = 0;
let lastTick = 0;

export function lightUp() { bootAt = performance.now(); }

function buildGeometry(cfg) {
  const v = cfg.venue;
  [LNG0, LAT0] = v.center;
  M_LNG = M_LAT * Math.cos((LAT0 * Math.PI) / 180);
  const [x0, y0] = v.wall.min_m, [x1, y1] = v.wall.max_m;
  G.floor = [{ polygon: [ll(x0, y0), ll(x1, y0), ll(x1, y1), ll(x0, y1)] }];
  for (let x = x0; x <= x1; x += 40) G.grid.push({ path: [ll(x, y0), ll(x, y1)] });
  for (let y = y0; y <= y1; y += 40) G.grid.push({ path: [ll(x0, y), ll(x1, y)] });
  G.wall = [{ path: [ll(x0, y0), ll(x1, y0), ll(x1, y1), ll(x0, y1), ll(x0, y0)] }];

  const [pw, ph] = v.palace.size_m;
  const H = v.palace.height_m;
  const foot = [[-pw / 2, -ph / 2], [pw / 2, -ph / 2], [pw / 2, -14], [pw / 2 + 14, -14], [pw / 2 + 14, 14], [pw / 2, 14], [pw / 2, ph / 2], [-pw / 2, ph / 2]];
  G.palace = [{ polygon: foot.map(([x, y]) => ll(x, y)) }];
  const corners = [[-pw / 2 + 5, -ph / 2 + 5], [pw / 2 - 5, -ph / 2 + 5], [pw / 2 - 5, ph / 2 - 5], [-pw / 2 + 5, ph / 2 - 5]];
  G.towers = corners.map(([x, y]) => ({ pos: ll(x, y), h: H + 10 }));
  G.dome = [{ pos: ll(18, 0), h: v.palace.dome_m - 10 }];

  // Bulbs along every edge, up each tower and around the dome, lit bottom to top at start.
  const bulbs = [];
  const edge = (a, b, z) => {
    const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2.6));
    for (let i = 0; i < n; i++) bulbs.push({ p: ll(a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n, z) });
  };
  for (const z of [0.6, 11, 22, H]) foot.forEach((p, i) => edge(p, foot[(i + 1) % foot.length], z));
  for (const [x, y] of corners) {
    for (let z = H; z <= H + 10; z += 2) bulbs.push({ p: ll(x, y, z) });
    for (let a = 0; a < 12; a++) bulbs.push({ p: ll(x + 4.6 * Math.cos((a / 12) * 6.283), y + 4.6 * Math.sin((a / 12) * 6.283), H + 10) });
  }
  for (let z = H; z <= v.palace.dome_m; z += 2.4) {
    const r = 10 * Math.sqrt(Math.max(0, 1 - ((z - H) / (v.palace.dome_m - H)) ** 2)) + 0.4;
    const n = Math.max(4, Math.round((r * 6.283) / 2.4));
    for (let i = 0; i < n; i++) bulbs.push({ p: ll(18 + r * Math.cos((i / n) * 6.283), r * Math.sin((i / n) * 6.283), z) });
  }
  bulbs.sort((a, b) => a.p[2] - b.p[2] || a.p[0] - b.p[0]);
  bulbs.forEach((b, i) => { b.i = i / bulbs.length; });
  G.bulbs = bulbs;

  G.zones = cfg.zones.map((z) => ({
    id: z.id, name: z.name, cx: z.offset_m[0], cy: z.offset_m[1], w: z.size_m[0], h: z.size_m[1],
    landmark: z.id === "gate" ? "ENTRANCE" : z.id === "exit" ? "EXIT" : "",
    polygon: rect(z.offset_m[0], z.offset_m[1], z.size_m[0], z.size_m[1]), center: ll(z.offset_m[0], z.offset_m[1]),
  }));
  const c = Object.fromEntries(G.zones.map((z) => [z.id, z]));
  for (const [a, b] of [["gate", "stage"], ["stage", "food"], ["stage", "exit"], ["gate", "exit"], ["gate", "food"]]) {
    if (c[a] && c[b]) G.walks.push({ path: [c[a].center, c[b].center] });
  }
}

function fit(cfg) {
  const el = document.getElementById("deck");
  const [x0, y0] = cfg.venue.wall.min_m, [x1, y1] = cfg.venue.wall.max_m;
  const mpp0 = 78271.517 * Math.cos((LAT0 * Math.PI) / 180);
  const z = Math.min(Math.log2((mpp0 * el.clientWidth) / ((x1 - x0) * 1.05)), Math.log2((mpp0 * el.clientHeight) / ((y1 - y0) * 1.05))) + 0.38;
  const [lng, lat] = ll((x0 + x1) / 2 + 55, (y0 + y1) / 2 - 70);
  overview = { longitude: lng, latitude: lat, zoom: z, pitch: 54, bearing: -16, maxPitch: 78, minZoom: z - 2, maxZoom: z + 3 };
  return overview;
}

function fly(view, ms = 1600) {
  deckgl?.setProps({ initialViewState: { ...view, transitionDuration: reducedMotion() ? 0 : ms, transitionInterpolator: new deck.FlyToInterpolator() } });
}
export function resetView() { fly(fit(store.get().cfg), 1200); }
export function flyToZone(id) {
  const g = G.zones.find((z) => z.id === id);
  if (!g || !overview) return;
  const [lng, lat] = ll(g.cx - 40, g.cy + 15);
  fly({ ...overview, longitude: lng, latitude: lat, zoom: overview.zoom + 0.45, pitch: 57, bearing: -10 });
}
export const zoneCenter = (id) => G.zones.find((z) => z.id === id)?.center;

function bulbAlpha(i, now) {
  if (!bootAt) return 0.07;
  return clamp(((now - bootAt) / 2600 - i) * 6, 0.07, 1);
}

// heat ramp: transparent rosewood, verdigris, saffron, sindoor, white-hot jasmine
const HEAT = [[61, 185, 166, 0], [61, 185, 166, 120], [255, 145, 36, 170], [255, 59, 48, 210], [255, 120, 90, 230], [255, 236, 214, 245]];

function layers(now) {
  const s = store.get();
  const zones = zonesView(s);
  const byId = Object.fromEntries(zones.map((z) => [z.id, z]));
  const zd = G.zones.map((g) => ({ ...g, s: byId[g.id] }));
  const L = s.layers;
  const pulse = reducedMotion() ? 1 : 0.5 + 0.5 * Math.sin(now / 170);
  const booting = bootAt && now - bootAt < 3400;
  const bulbKey = booting ? Math.round((now - bootAt) / 50) : bootAt ? "on" : "off";
  const dt = Math.min((performance.now() - lastStateAt) / 1000, 1.2);
  const statusOf = (z) => (z.s ? z.s.status : "offline");
  const live = (z) => z.s && !z.s.offline;
  const elev = (z) => (live(z) ? 4 + z.s.density * 16 : 3);
  const tick = s.live?.now;

  const people = [];
  if (L.people || L.heat) {
    for (const z of zd) {
      if (!live(z)) continue;
      if (z.s.points.length) {
        for (const [x, y, vx, vy] of z.s.points) {
          const px = clamp(x + vx * dt, 0, 1), py = clamp(y + vy * dt, 0, 1);
          people.push({ p: ll(z.cx + (px - 0.5) * z.w * 0.92, z.cy + (0.5 - py) * z.h * 0.92, 0.5), s: z.s.status, w: Math.max(0.2, z.s.density) });
        }
      } else if (s.replayT != null) {
        // replay has counts but no positions: scatter them deterministically inside the zone
        for (let i = 0; i < z.s.count; i++) {
          const a = (i * 137.5) % 360, r = Math.sqrt((i + 0.5) / Math.max(1, z.s.count)) * 0.45;
          people.push({ p: ll(z.cx + Math.cos(a) * r * z.w, z.cy + Math.sin(a) * r * z.h, 0.5), s: z.s.status, w: Math.max(0.2, z.s.density) });
        }
      }
    }
  }

  const arrows = [];
  const rings = [];
  if (L.flow) {
    for (const z of zd) {
      const f = z.s?.flow;
      if (!live(z) || !f || f.moving < 4) continue;
      const turbulent = f.counterflow > 0.55 && z.s.status !== "safe";
      const a = (f.angle * Math.PI) / 180;
      const len = clamp(22 + f.speed * 900, 22, 80);
      const [dx, dy] = [Math.cos(a), -Math.sin(a)];       // image y points down, map y points north
      const tip = [z.cx + dx * len, z.cy + dy * len];
      const back = [z.cx - dx * len * 0.35, z.cy - dy * len * 0.35];
      const side = (k) => [tip[0] - dx * 12 + -dy * k, tip[1] - dy * 12 + dx * k];
      const zz = elev(z) + 6;
      arrows.push({ path: [ll(...back, zz), ll(...tip, zz)], hot: turbulent });
      arrows.push({ path: [ll(...side(9), zz), ll(...tip, zz), ll(...side(-9), zz)], hot: turbulent });
      if (turbulent) rings.push({ p: z.center, k: f.counterflow });
    }
  }

  const plans = (s.replayT == null ? s.live?.plans || [] : [])
    .map((p) => ({ from: G.zones.find((g) => g.id === p.from), to: G.zones.find((g) => g.id === p.to) }))
    .filter((p) => p.from && p.to);

  return [
    new deck.PolygonLayer({ id: "venue-floor", data: G.floor, getPolygon: (d) => d.polygon, stroked: false, filled: true, getFillColor: [31, 18, 14, 255] }),
    new deck.PathLayer({ id: "grid", data: G.grid, getPath: (d) => d.path, getColor: [105, 74, 54, 105], widthUnits: "pixels", getWidth: 1 }),
    new deck.PathLayer({ id: "walks", data: G.walks, getPath: (d) => d.path, getColor: [120, 84, 62, 120], widthUnits: "meters", getWidth: 7, capRounded: true }),
    new deck.PathLayer({ id: "wall", data: G.wall, getPath: (d) => d.path, getColor: [...ZARI, 110], widthUnits: "pixels", getWidth: 1.5 }),
    new deck.PolygonLayer({
      id: "zones", data: zd, getPolygon: (d) => d.polygon, stroked: true, filled: true, pickable: true, lineWidthUnits: "pixels",
      getLineWidth: (d) => (d.id === s.selected ? 3.5 : d.id === hoverZone ? 2.5 : 1.7),
      getFillColor: (d) => [...COL[statusOf(d)], statusOf(d) === "critical" ? 65 + 65 * pulse : d.id === s.selected ? 76 : d.id === hoverZone ? 68 : 48],
      getLineColor: (d) => (d.id === s.selected ? [...JASMINE, 255] : d.landmark ? [...ZARI, 240] : [...ZARI, 190]),
      updateTriggers: { getFillColor: [tick, s.replayT, Math.round(pulse * 10), s.selected, hoverZone], getLineColor: [tick, s.replayT, s.selected], getLineWidth: [s.selected, hoverZone] },
    }),
    new deck.PolygonLayer({
      id: "palace", data: G.palace, getPolygon: (d) => d.polygon, extruded: true, wireframe: true,
      getElevation: store.get().cfg.venue.palace.height_m, getFillColor: [52, 30, 22, 240], getLineColor: [...ZARI, 70],
      material: { ambient: 0.65, diffuse: 0.5, shininess: 6 },
    }),
    new deck.ColumnLayer({ id: "towers", data: G.towers, getPosition: (d) => d.pos, radius: 4.5, diskResolution: 20, extruded: true, getElevation: (d) => d.h, getFillColor: [56, 33, 24, 245], material: { ambient: 0.65, diffuse: 0.5 } }),
    new deck.ColumnLayer({ id: "dome", data: G.dome, getPosition: (d) => d.pos, radius: 10, diskResolution: 28, extruded: true, getElevation: (d) => d.h, getFillColor: [62, 37, 26, 245], material: { ambient: 0.65, diffuse: 0.5 } }),
    new deck.ScatterplotLayer({
      id: "bulb-glow", data: G.bulbs, getPosition: (d) => d.p, billboard: true, radiusUnits: "meters", getRadius: 2.6,
      getFillColor: (d) => [255, 186, 92, 44 * bulbAlpha(d.i, now)], updateTriggers: { getFillColor: bulbKey },
    }),
    new deck.ScatterplotLayer({
      id: "bulbs", data: G.bulbs, getPosition: (d) => d.p, billboard: true, radiusUnits: "meters", getRadius: 0.75, radiusMinPixels: 0.8,
      getFillColor: (d) => [255, 222, 150, 255 * bulbAlpha(d.i, now)], updateTriggers: { getFillColor: bulbKey },
    }),
    L.heat && new deck.HeatmapLayer({
      id: "heat", data: people, getPosition: (d) => d.p, getWeight: (d) => d.w, radiusPixels: 46, intensity: 1.1, threshold: 0.04,
      colorRange: HEAT, aggregation: "SUM", updateTriggers: { getPosition: [tick, s.replayT] },
    }),
    L.people && new deck.ScatterplotLayer({
      id: "people", data: people, getPosition: (d) => d.p, radiusUnits: "meters", getRadius: 2.1, radiusMinPixels: 2,
      stroked: true, lineWidthUnits: "pixels", getLineWidth: 1, getLineColor: [36, 19, 15, 245],
      getFillColor: (d) => (d.s === "critical" ? [255, 198, 190, 250] : [243, 234, 219, 245]),
    }),
    L.pressure && new deck.ColumnLayer({
      id: "pressure", data: zd, getPosition: (d) => d.center, diskResolution: 6, radius: 12, extruded: true, pickable: true,
      getElevation: elev, getFillColor: (d) => [...COL[statusOf(d)], live(d) ? 220 : 90],
      material: { ambient: 0.7, diffuse: 0.6 }, updateTriggers: { getElevation: [tick, s.replayT], getFillColor: [tick, s.replayT] },
    }),
    L.flow && new deck.ScatterplotLayer({
      id: "turbulence", data: rings, getPosition: (d) => d.p, stroked: true, filled: false, radiusUnits: "meters",
      getRadius: (d) => 26 + 10 * pulse, lineWidthUnits: "pixels", getLineWidth: 2,
      getLineColor: (d) => [255, 59, 48, 120 + 120 * d.k], updateTriggers: { getRadius: Math.round(pulse * 10) },
    }),
    L.flow && new deck.PathLayer({
      id: "flow", data: arrows, getPath: (d) => d.path, getColor: (d) => (d.hot ? [255, 120, 100, 245] : [243, 234, 219, 230]),
      widthUnits: "pixels", getWidth: 4, capRounded: true, jointRounded: true,
    }),
    new deck.ArcLayer({
      id: "redirect", data: plans, getSourcePosition: (d) => d.from.center, getTargetPosition: (d) => d.to.center,
      getSourceColor: [...COL.critical, 255], getTargetColor: [...COL.safe, 255], getWidth: 4 + 3 * pulse, getHeight: 0.6,
      widthUnits: "pixels", updateTriggers: { getWidth: Math.round(pulse * 8) },
    }),
    new deck.TextLayer({
      id: "labels", data: zd, getPosition: (d) => [d.center[0], d.center[1], (L.pressure ? elev(d) : 4) + 12],
      getText: (d) => statusOf(d) === "safe" ? d.name : d.name + "\n" + WORD[statusOf(d)],
      characterSet: "auto", fontFamily: "Anek, sans-serif", fontWeight: 650, getSize: 15, lineHeight: 1.12,
      getColor: [243, 234, 219, 255], background: true, getBackgroundColor: [36, 19, 15, 238], backgroundPadding: [9, 6],
      getTextAnchor: "middle", getAlignmentBaseline: "bottom",
      updateTriggers: { getText: [tick, s.replayT], getPosition: [tick, s.replayT, L.pressure] },
    }),
  ].filter(Boolean);
}

export function initScene(cfg, onPickZone) {
  buildGeometry(cfg);
  deckgl = new deck.Deck({
    parent: document.getElementById("deck"),
    views: new deck.MapView({ repeat: false }),
    initialViewState: fit(cfg),
    controller: { dragPan: true, dragRotate: true, touchRotate: true, scrollZoom: { speed: 0.01, smooth: true }, keyboard: false },
    layers: [],
    onHover: ({ object, layer }) => {
      const id = object && (layer?.id === "zones" || layer?.id === "pressure") ? object.id : null;
      if (id !== hoverZone) hoverZone = id;
    },
    onClick: ({ object, layer }) => {
      if (object && (layer?.id === "zones" || layer?.id === "pressure")) onPickZone(object.id);
    },
    getCursor: ({ isDragging, isHovering }) => (isDragging ? "grabbing" : isHovering ? "pointer" : "grab"),
    getTooltip: ({ object, layer }) => {
      if (!object || !(layer?.id === "zones" || layer?.id === "pressure") || !object.s) return null;
      const z = object.s;
      return {
        text: z.offline ? `${object.name} - No signal` : `${object.name} - ${z.density.toFixed(1)} people/m2 - ${z.status === "safe" ? "Calm" : z.status === "warning" ? "Crowded" : z.status === "critical" ? "Crush risk" : "No signal"}`,
        style: { background: "#f3eadb", color: "#24130f", font: "600 13px Anek, sans-serif", borderRadius: "6px", padding: "6px 10px" },
      };
    },
  });
  store.subscribe((s) => { if (s.live && s.live.now !== lastTick) { lastTick = s.live.now; lastStateAt = performance.now(); } });
  let last = 0;
  const loop = (now) => {
    if (now - last > 33) { last = now; deckgl.setProps({ layers: layers(now) }); }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.addEventListener("resize", () => fit(cfg));
}

