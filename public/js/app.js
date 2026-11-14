const REGIONS = {
  all: { center: [-65.0, -35.5], zoom: 3.9, label: "Argentina" },
  cuyo: { center: [-69.0, -32.2], zoom: 6.4, label: "Cuyo" },
  noa: { center: [-66.0, -24.2], zoom: 6.2, label: "NOA" },
  centro: { center: [-64.8, -31.8], zoom: 6.6, label: "Centro" },
  patagonia: { center: [-69.5, -46.5], zoom: 4.8, label: "Patagonia" },
};

const STYLES = {
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
};

const COLOR_MAP = {
  shallow: "#ef4444",
  intermediate: "#f59e0b",
  deep: "#06b6d4",
  preliminar: "#60a5fa",
  revisado: "#84cc16",
  sentido: "#f43f5e",
};

const state = {
  allFeatures: [],
  filteredFeatures: [],
  visibleFeatures: [],
  colorMode: "depth",
  is3D: false,
  selectedId: null,
  replayPlaying: false,
  replaySpeed: 1,
  replayProgress: 100,
  replayTimer: null,
  lastSyncAt: null,
};

let map = null;
let hoverPopup = null;
let pulseFrameId = null;

const darkMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const compactQuery = window.matchMedia("(max-width: 960px), (max-height: 540px)");

function setToolbarOpen(open) {
  const toolbar = document.getElementById("main-toolbar");
  const ctrlBtn = document.getElementById("toggle-controls-btn");
  if (!toolbar || !ctrlBtn) return;
  if (open && compactQuery.matches) {
    setSidebarOpen(false);
  }
  toolbar.classList.toggle("open", open);
  ctrlBtn.setAttribute("aria-expanded", String(open));
}

function setSidebarOpen(open) {
  const sidebar = document.getElementById("radar-sidebar");
  const sideBtn = document.getElementById("toggle-sidebar-btn");
  if (!sidebar || !sideBtn) return;
  if (open && compactQuery.matches) {
    setToolbarOpen(false);
  }
  sidebar.classList.toggle("collapsed", !open);
  sideBtn.setAttribute("aria-expanded", String(open));
}

function syncResponsiveMode() {
  if (compactQuery.matches) {
    setToolbarOpen(false);
    setSidebarOpen(false);
  } else {
    setToolbarOpen(false);
    setSidebarOpen(true);
  }
  if (map) {
    requestAnimationFrame(() => map.resize());
  }
}

async function ensureTemporal() {
  if (typeof Temporal === "undefined") {
    try {
      const mod = await import("https://esm.sh/temporal-polyfill");
      globalThis.Temporal = mod.Temporal;
    } catch {
      // Fallback handled in formatRelativeTime if offline
    }
  }
}

function formatRelativeTime(isoStr) {
  if (!isoStr) return "desconocido";
  if (typeof Temporal !== "undefined") {
    try {
      const now = Temporal.Now.zonedDateTimeISO("America/Argentina/Buenos_Aires");
      const target = Temporal.Instant.from(isoStr).toZonedDateTimeISO("America/Argentina/Buenos_Aires");
      const diff = now.since(target, { largestUnit: "day", smallestUnit: "minute" });
      if (diff.days === 0 && diff.hours === 0 && diff.minutes < 1) {
        return "recién";
      }
      if (typeof diff.toLocaleString === "function") {
        return `hace ${diff.toLocaleString("es-AR", { style: "short" })}`;
      }
      if (diff.days > 0) return `hace ${diff.days}d ${diff.hours}h`;
      if (diff.hours > 0) return `hace ${diff.hours}h ${diff.minutes}m`;
      return `hace ${diff.minutes}m`;
    } catch {
      // Fall through cleanly
    }
  }
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(isoStr)) / 60000));
  if (mins < 1) return "recién";
  if (mins < 60) return `hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `hace ${hrs} h`;
  return `hace ${Math.floor(hrs / 24)} d`;
}

function getEventColor(props) {
  if (state.colorMode === "status") {
    return COLOR_MAP[props.status] || COLOR_MAP.revisado;
  }
  const depth = Number(props.depth_km) || 0;
  if (depth < 70) return COLOR_MAP.shallow;
  if (depth <= 300) return COLOR_MAP.intermediate;
  return COLOR_MAP.deep;
}

function getMagColorExpr() {
  if (state.colorMode === "status") {
    return [
      "match",
      ["get", "status"],
      "preliminar", COLOR_MAP.preliminar,
      "sentido", COLOR_MAP.sentido,
      COLOR_MAP.revisado,
    ];
  }
  return [
    "step",
    ["get", "depth_km"],
    COLOR_MAP.shallow,
    70, COLOR_MAP.intermediate,
    300, COLOR_MAP.deep,
  ];
}

function buildLegend() {
  const el = document.getElementById("legend-bar");
  if (state.colorMode === "depth") {
    el.innerHTML = `
      <span class="legend-item"><span class="legend-dot" style="background:${COLOR_MAP.shallow}"></span>Superficial (&lt;70 km)</span>
      <span class="legend-item"><span class="legend-dot" style="background:${COLOR_MAP.intermediate}"></span>Intermedio (70–300 km)</span>
      <span class="legend-item"><span class="legend-dot" style="background:${COLOR_MAP.deep}"></span>Profundo (&gt;300 km)</span>
    `;
  } else {
    el.innerHTML = `
      <span class="legend-item"><span class="legend-dot" style="background:${COLOR_MAP.preliminar}"></span>Preliminar (automático)</span>
      <span class="legend-item"><span class="legend-dot" style="background:${COLOR_MAP.revisado}"></span>Revisado</span>
      <span class="legend-item"><span class="legend-dot" style="background:${COLOR_MAP.sentido}"></span>Sentido (revisado)</span>
    `;
  }
}

function installToolbarRovingFallback() {
  if ("focusGroup" in HTMLElement.prototype) return;
  const bar = document.getElementById("main-toolbar");
  if (!bar) return;
  const items = Array.from(bar.querySelectorAll("button"));
  items.forEach((b, i) => {
    b.tabIndex = i === 0 ? 0 : -1;
  });
  bar.addEventListener("focusin", ({ target }) => {
    if (items.includes(target)) {
      items.forEach((b) => {
        b.tabIndex = b === target ? 0 : -1;
      });
    }
  });
  bar.addEventListener("keydown", (e) => {
    const idx = items.indexOf(document.activeElement);
    if (idx === -1) return;
    const rtl = getComputedStyle(bar).direction === "rtl";
    const steps = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 };
    let nextIdx = null;
    if (e.key in steps) {
      nextIdx = (idx + steps[e.key] + items.length) % items.length;
    } else if (e.key === "Home") {
      nextIdx = 0;
    } else if (e.key === "End") {
      nextIdx = items.length - 1;
    }
    if (nextIdx !== null) {
      e.preventDefault();
      items[nextIdx].focus();
    }
  });
}

function installRangeProgressFallback() {
  if (CSS.supports("accent-color", "#38bdf8")) return;
  document.querySelectorAll('input[type="range"]').forEach((slider) => {
    const sync = () => {
      const min = Number(slider.min) || 0;
      const max = Number(slider.max) || 100;
      const val = Number(slider.value) || 0;
      const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
      slider.style.setProperty("--progress", `${pct}%`);
    };
    slider.addEventListener("input", sync);
    sync();
  });
}

async function fetchData() {
  const days = document.getElementById("days-select").value;
  const minMag = document.getElementById("min-mag-range").value;
  const feltOnly = document.getElementById("felt-only-check").checked;

  const params = new URLSearchParams({ limit: "500" });
  if (days) params.set("days", days);
  if (Number(minMag) > 0) params.set("min_mag", minMag);
  if (feltOnly) params.set("felt_only", "true");

  const res = await fetch(`/api/earthquakes?${params.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  state.allFeatures = data.features || [];
  state.lastSyncAt = data.metadata?.last_sync_at || null;

  updateSyncBadge(data.metadata);
  updateKPIs(data.metadata?.stats, state.allFeatures);
  applyReplaySlice();
  renderHistogram();
}

function updateSyncBadge(metadata) {
  const el = document.getElementById("sync-status");
  if (!metadata?.last_sync_at) {
    el.textContent = "Sin sincronización aún";
    return;
  }
  const rel = formatRelativeTime(metadata.last_sync_at);
  const warnCount = metadata.warnings?.length || 0;
  el.textContent = warnCount
    ? `INPRES ${rel} · (${warnCount} aviso de red)`
    : `Fuente INPRES · ${rel}`;
}

function updateKPIs(stats, features) {
  const s = stats || {};
  document.getElementById("kpi-24h").textContent = s.last_24h ?? "0";
  document.getElementById("kpi-max").textContent =
    s.max_magnitude != null ? `M${Number(s.max_magnitude).toFixed(1)}` : "—";
  document.getElementById("kpi-felt").textContent = s.felt_count ?? "0";
  document.getElementById("kpi-depth").textContent =
    s.avg_depth_km != null ? `${s.avg_depth_km} km` : "—";
  document.getElementById("feed-count").textContent = String(features.length);
}

function applyReplaySlice() {
  const features = state.allFeatures;
  if (!features.length) {
    state.visibleFeatures = [];
    document.getElementById("replay-cursor-label").textContent = "Sin eventos";
    document.getElementById("replay-count-label").textContent = "0 / 0";
    syncMapData();
    renderEventList();
    renderSubductionProfile();
    return;
  }

  // Sort ascending chronologically for replay
  const asc = [...features].sort((a, b) =>
    a.properties.occurred_at.localeCompare(b.properties.occurred_at)
  );
  const pct = state.replayProgress;

  if (pct >= 100) {
    state.visibleFeatures = features;
    document.getElementById("replay-cursor-label").textContent = "Tiempo real";
    document.getElementById("replay-count-label").textContent = `${features.length} eventos`;
  } else {
    const tMin = Date.parse(asc[0].properties.occurred_at);
    const tMax = Date.parse(asc[asc.length - 1].properties.occurred_at);
    const tCursor = tMin + ((tMax - tMin) * pct) / 100;
    const slicedAsc = asc.filter((f) => Date.parse(f.properties.occurred_at) <= tCursor);
    state.visibleFeatures = slicedAsc.reverse();

    const cursorIso = new Date(tCursor).toISOString();
    const d = new Date(cursorIso);
    document.getElementById("replay-cursor-label").textContent = d.toLocaleString("es-AR", {
      timeZone: "America/Argentina/Buenos_Aires",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    document.getElementById("replay-count-label").textContent =
      `${state.visibleFeatures.length} / ${features.length}`;
  }

  syncMapData();
  renderEventList();
  renderSubductionProfile();
}

function getPulseCutoffFeatures() {
  if (!state.visibleFeatures.length) return [];
  if (state.replayProgress < 100) {
    return state.visibleFeatures.slice(0, 3);
  }
  const cutoffMs = Date.now() - 12 * 3600 * 1000;
  const recent = state.visibleFeatures.filter(
    (f) => Date.parse(f.properties.occurred_at) >= cutoffMs
  );
  return recent.length ? recent.slice(0, 8) : state.visibleFeatures.slice(0, 2);
}

function syncMapData() {
  if (!map) return;
  const eqSource = map.getSource("earthquakes");
  if (eqSource) {
    eqSource.setData({ type: "FeatureCollection", features: state.visibleFeatures });
  }
  const pulseSource = map.getSource("earthquakes-pulse");
  if (pulseSource) {
    pulseSource.setData({ type: "FeatureCollection", features: getPulseCutoffFeatures() });
  }
}

function renderEventList() {
  const list = document.getElementById("event-list");
  if (!state.visibleFeatures.length) {
    list.innerHTML = `<li style="padding:12px;color:var(--muted);font-size:0.8rem;">No hay sismos que coincidan con los filtros actuales.</li>`;
    return;
  }

  list.innerHTML = state.visibleFeatures
    .slice(0, 80)
    .map((f) => {
      const p = f.properties;
      const color = getEventColor(p);
      const selectedClass = p.id === state.selectedId ? "selected" : "";
      const rel = formatRelativeTime(p.occurred_at);
      return `
        <li>
          <button type="button" class="event-item-btn ${selectedClass}" data-id="${p.id}">
            <span class="mag-badge" style="background:${color}">${Number(p.magnitude).toFixed(1)}</span>
            <span class="ev-main">
              <span class="ev-prov">${escapeHtml(p.province)}</span>
              <span class="ev-sub">${p.local_date} ${p.local_time} · ${p.depth_km} km · ${rel}</span>
            </span>
            <span class="ev-tags">
              <span class="status-chip ${p.status}">${escapeHtml(p.status)}</span>
            </span>
          </button>
        </li>
      `;
    })
    .join("");
}

function selectEvent(id, fly = true) {
  state.selectedId = id;
  const feat = state.visibleFeatures.find((f) => f.properties.id === id)
    || state.allFeatures.find((f) => f.properties.id === id);

  renderEventList();
  renderSubductionProfile();

  const card = document.getElementById("inspector-card");
  if (!feat) {
    card.classList.add("hidden");
    return;
  }

  const p = feat.properties;
  const rel = formatRelativeTime(p.occurred_at);
  let alertHtml = "";
  if (p.felt && (p.intensity || p.epiczone)) {
    alertHtml = `
      <p class="inspector-alert felt">
        <strong>Sismo sentido</strong>${p.intensity ? ` · Intensidad: ${escapeHtml(p.intensity)}` : ""}
        ${p.epiczone ? `<br>${escapeHtml(p.epiczone)}` : ""}
      </p>
    `;
  } else if (p.status === "preliminar") {
    alertHtml = `
      <p class="inspector-alert prelim">
        Determinación automática preliminar de INPRES; sujeta a revisión sismológica.
      </p>
    `;
  }

  card.innerHTML = `
    <div class="inspector-top">
      <div>
        <h3 class="inspector-title">${escapeHtml(p.province)} · M${Number(p.magnitude).toFixed(1)}</h3>
        <span style="font-size:0.72rem;color:var(--muted)">${p.local_date} ${p.local_time} ART (${rel})</span>
      </div>
      <button type="button" id="close-inspector-btn" class="ghost-btn" aria-label="Cerrar detalle">✕</button>
    </div>
    <div class="inspector-meta">
      <div><span>Profundidad</span><strong>${p.depth_km} km</strong></div>
      <div><span>Coordenadas</span><strong>${Number(p.lat).toFixed(2)}, ${Number(p.lon).toFixed(2)}</strong></div>
      <div><span>Estado</span><strong style="text-transform:capitalize">${escapeHtml(p.status)}</strong></div>
    </div>
    ${alertHtml}
    <a class="inspector-link" href="${escapeHtml(p.detail_url || "https://www.inpres.gob.ar/")}" target="_blank" rel="noopener noreferrer">
      Ver ficha oficial en INPRES ↗
    </a>
  `;
  card.classList.remove("hidden");

  if (compactQuery.matches) {
    setSidebarOpen(true);
    card.scrollIntoView({
      block: "nearest",
      behavior: reducedMotionQuery.matches ? "auto" : "smooth",
    });
  }

  document.getElementById("close-inspector-btn")?.addEventListener("click", () => {
    state.selectedId = null;
    card.classList.add("hidden");
    renderEventList();
    renderSubductionProfile();
  });

  if (fly && map) {
    map.flyTo({
      center: [p.lon, p.lat],
      zoom: Math.max(map.getZoom(), 6.8),
      duration: reducedMotionQuery.matches ? 0 : 900,
    });
  }
}

function renderSubductionProfile() {
  const svg = document.getElementById("subduction-svg");
  if (!svg) return;

  const W = 680;
  const H = 185;
  const padL = 44;
  const padR = 16;
  const padT = 26;
  const padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const lonMin = -76;
  const lonMax = -53;
  const maxDepth = 650;

  const xOf = (lon) => padL + ((Math.max(lonMin, Math.min(lonMax, lon)) - lonMin) / (lonMax - lonMin)) * plotW;
  const yOf = (depth) => padT + (Math.max(0, Math.min(maxDepth, depth)) / maxDepth) * plotH;

  // Stylized Andean mountain silhouette peaking around lon -70 to -67
  const mountainPts = [
    [-76, 18], [-73, 18], [-71.5, 16], [-70.2, 7], [-69.0, 2], [-67.5, 6],
    [-65.5, 13], [-63.0, 17], [-58.0, 18], [-53, 18],
  ]
    .map(([lon, y]) => `${xOf(lon).toFixed(1)},${y}`)
    .join(" ");

  const y70 = yOf(70).toFixed(1);
  const y300 = yOf(300).toFixed(1);
  const y600 = yOf(600).toFixed(1);

  const dots = state.visibleFeatures
    .map((f) => {
      const p = f.properties;
      const cx = xOf(p.lon).toFixed(1);
      const cy = yOf(p.depth_km).toFixed(1);
      const r = Math.max(3, Math.min(11, 2 + (p.magnitude - 1.5) * 1.5)).toFixed(1);
      const fill = getEventColor(p);
      const isSel = p.id === state.selectedId;
      const stroke = isSel ? "#ffffff" : "rgba(15,23,42,0.7)";
      const strokeW = isSel ? 2.4 : 1;
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" fill-opacity="0.88" stroke="${stroke}" stroke-width="${strokeW}" data-id="${p.id}" style="cursor:pointer">
        <title>${escapeHtml(p.province)} · M${p.magnitude} · ${p.depth_km} km</title>
      </circle>`;
    })
    .join("");

  svg.innerHTML = `
    <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="rgba(148,163,184,0.06)" rx="6"/>
    <polyline points="${mountainPts}" fill="rgba(148,163,184,0.22)" stroke="rgba(148,163,184,0.5)" stroke-width="1.2"/>
    <text x="${xOf(-74)}" y="14" font-size="9" fill="currentColor" opacity="0.65">Fosa / Pacífico</text>
    <text x="${xOf(-69.5)}" y="14" font-size="9" fill="currentColor" opacity="0.8" font-weight="600">Andes</text>
    <text x="${xOf(-60)}" y="14" font-size="9" fill="currentColor" opacity="0.65">Llanura</text>

    <line x1="${padL}" y1="${y70}" x2="${W - padR}" y2="${y70}" stroke="#ef4444" stroke-opacity="0.35" stroke-dasharray="4 4"/>
    <line x1="${padL}" y1="${y300}" x2="${W - padR}" y2="${y300}" stroke="#f59e0b" stroke-opacity="0.35" stroke-dasharray="4 4"/>
    <line x1="${padL}" y1="${y600}" x2="${W - padR}" y2="${y600}" stroke="#06b6d4" stroke-opacity="0.28" stroke-dasharray="4 4"/>

    <text x="4" y="${padT + 8}" font-size="9" fill="currentColor" opacity="0.7">0 km</text>
    <text x="4" y="${Number(y70) + 3}" font-size="9" fill="#ef4444">70</text>
    <text x="4" y="${Number(y300) + 3}" font-size="9" fill="#f59e0b">300</text>
    <text x="4" y="${Number(y600) + 3}" font-size="9" fill="#06b6d4">600</text>

    <text x="${xOf(-75)}" y="${H - 5}" font-size="9" fill="currentColor" opacity="0.65">75°O</text>
    <text x="${xOf(-70)}" y="${H - 5}" font-size="9" fill="currentColor" opacity="0.65">70°O</text>
    <text x="${xOf(-65)}" y="${H - 5}" font-size="9" fill="currentColor" opacity="0.65">65°O</text>
    <text x="${xOf(-60)}" y="${H - 5}" font-size="9" fill="currentColor" opacity="0.65">60°O</text>
    <text x="${xOf(-55)}" y="${H - 5}" font-size="9" fill="currentColor" opacity="0.65">55°O</text>

    ${dots}
  `;
}

function renderHistogram() {
  const svg = document.getElementById("timeline-histogram");
  if (!svg) return;
  const features = state.allFeatures;
  if (!features.length) {
    svg.innerHTML = "";
    return;
  }
  const bins = 40;
  const counts = new Array(bins).fill(0);
  const times = features.map((f) => Date.parse(f.properties.occurred_at));
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const span = Math.max(1, maxT - minT);

  for (const t of times) {
    const idx = Math.min(bins - 1, Math.floor(((t - minT) / span) * bins));
    counts[idx] += 1;
  }
  const maxC = Math.max(1, ...counts);
  const barW = 400 / bins;
  svg.innerHTML = counts
    .map((c, i) => {
      const h = c === 0 ? 1.5 : Math.max(3, (c / maxC) * 24);
      const y = 26 - h;
      return `<rect x="${(i * barW + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${(barW - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="var(--accent)" opacity="${c === 0 ? 0.2 : 0.72}"/>`;
    })
    .join("");
}

const TERRAIN_TILES = ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"];

function addMapSourcesAndLayers() {
  if (!map) return;

  try {
    if (!map.getSource("hillshade-dem")) {
      map.addSource("hillshade-dem", {
        type: "raster-dem",
        tiles: TERRAIN_TILES,
        encoding: "terrarium",
        tileSize: 256,
        maxzoom: 15,
      });
      const firstSymbolId = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
      const isDark = darkMediaQuery.matches;
      map.addLayer(
        {
          id: "andes-hillshade",
          type: "hillshade",
          source: "hillshade-dem",
          paint: {
            "hillshade-exaggeration": 0.5,
            "hillshade-shadow-color": isDark ? "#020617" : "#475569",
            "hillshade-highlight-color": isDark ? "#334155" : "#ffffff",
            "hillshade-accent-color": isDark ? "#0f172a" : "#94a3b8",
          },
        },
        firstSymbolId
      );
    }

    if (!map.getSource("terrain-dem")) {
      map.addSource("terrain-dem", {
        type: "raster-dem",
        tiles: TERRAIN_TILES,
        encoding: "terrarium",
        tileSize: 256,
        maxzoom: 15,
      });
    }

    map.setTerrain(state.is3D ? { source: "terrain-dem", exaggeration: 2.8 } : null);
  } catch (err) {
    console.warn("No se pudo inicializar el relieve DEM:", err);
  }

  if (!map.getSource("earthquakes-pulse")) {
    map.addSource("earthquakes-pulse", {
      type: "geojson",
      data: { type: "FeatureCollection", features: getPulseCutoffFeatures() },
    });
    map.addLayer({
      id: "eq-pulse-ring",
      type: "circle",
      source: "earthquakes-pulse",
      paint: {
        "circle-radius": 18,
        "circle-color": "transparent",
        "circle-stroke-width": 2,
        "circle-stroke-color": getMagColorExpr(),
        "circle-stroke-opacity": 0.6,
      },
    });
  }

  if (!map.getSource("earthquakes")) {
    map.addSource("earthquakes", {
      type: "geojson",
      data: { type: "FeatureCollection", features: state.visibleFeatures },
    });

    map.addLayer({
      id: "eq-felt-halo",
      type: "circle",
      source: "earthquakes",
      filter: ["==", ["get", "felt"], true],
      paint: {
        "circle-radius": [
          "interpolate",
          ["exponential", 1.6],
          ["get", "magnitude"],
          1.5, 14,
          4.0, 26,
          6.5, 46,
        ],
        "circle-color": "#f43f5e",
        "circle-opacity": 0.18,
        "circle-blur": 0.7,
      },
    });

    map.addLayer({
      id: "eq-circles",
      type: "circle",
      source: "earthquakes",
      paint: {
        "circle-radius": [
          "interpolate",
          ["exponential", 1.65],
          ["get", "magnitude"],
          1.5, 4.5,
          3.0, 8,
          4.5, 14,
          6.0, 24,
          7.5, 36,
        ],
        "circle-color": getMagColorExpr(),
        "circle-opacity": 0.88,
        "circle-stroke-width": ["case", ["==", ["get", "felt"], true], 2, 1],
        "circle-stroke-color": "#ffffff",
      },
    });

    map.addLayer({
      id: "eq-labels",
      type: "symbol",
      source: "earthquakes",
      filter: ["any", [">=", ["get", "magnitude"], 4.0], ["==", ["get", "felt"], true]],
      layout: {
        "text-field": ["concat", "M", ["to-string", ["get", "magnitude"]]],
        "text-size": 10,
        "text-offset": [0, 1.3],
        "text-allow-overlap": false,
      },
      paint: {
        "text-color": darkMediaQuery.matches ? "#f8fafc" : "#0f172a",
        "text-halo-color": darkMediaQuery.matches ? "#0f172a" : "#ffffff",
        "text-halo-width": 1.4,
      },
    });
  }
}

function startPulseAnimation() {
  if (pulseFrameId) cancelAnimationFrame(pulseFrameId);
  if (reducedMotionQuery.matches) return;

  const animate = (ts) => {
    if (map && map.getLayer("eq-pulse-ring")) {
      const phase = (ts % 2200) / 2200;
      const radius = 8 + phase * 26;
      const opacity = (1 - phase) * 0.75;
      map.setPaintProperty("eq-pulse-ring", "circle-radius", radius);
      map.setPaintProperty("eq-pulse-ring", "circle-stroke-opacity", opacity);
    }
    pulseFrameId = requestAnimationFrame(animate);
  };
  pulseFrameId = requestAnimationFrame(animate);
}

function updateLayerColors() {
  if (!map) return;
  const expr = getMagColorExpr();
  if (map.getLayer("eq-circles")) map.setPaintProperty("eq-circles", "circle-color", expr);
  if (map.getLayer("eq-pulse-ring")) map.setPaintProperty("eq-pulse-ring", "circle-stroke-color", expr);
}

function initMap() {
  const initialStyle = darkMediaQuery.matches ? STYLES.dark : STYLES.light;
  map = new maplibregl.Map({
    container: "map",
    style: initialStyle,
    center: REGIONS.all.center,
    zoom: REGIONS.all.zoom,
    pitch: 0,
    maxPitch: 60,
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");

  hoverPopup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    offset: 12,
  });

  map.on("style.load", () => {
    addMapSourcesAndLayers();
    syncMapData();
    startPulseAnimation();
  });

  map.on("mouseenter", "eq-circles", (e) => {
    map.getCanvas().style.cursor = "pointer";
    const feat = e.features?.[0];
    if (!feat) return;
    const p = feat.properties;
    hoverPopup
      .setLngLat(feat.geometry.coordinates)
      .setHTML(
        `<div style="color:#0f172a;font-size:12px;line-height:1.35">
          <strong>${escapeHtml(p.province)} · M${Number(p.magnitude).toFixed(1)}</strong><br>
          Prof: ${p.depth_km} km · ${p.local_date} ${p.local_time}<br>
          <span>Estado: ${escapeHtml(p.status)}</span>
        </div>`
      )
      .addTo(map);
  });

  map.on("mouseleave", "eq-circles", () => {
    map.getCanvas().style.cursor = "";
    hoverPopup.remove();
  });

  map.on("click", (e) => {
    const hasLayer = Boolean(map.getLayer("eq-circles"));
    const feat = hasLayer
      ? map.queryRenderedFeatures(e.point, { layers: ["eq-circles"] })?.[0]
      : null;
    if (feat) {
      selectEvent(feat.properties.id, true);
      return;
    }
    if (compactQuery.matches) {
      setToolbarOpen(false);
      setSidebarOpen(false);
    }
  });

  // React to OS light/dark theme changes dynamically
  darkMediaQuery.addEventListener("change", (evt) => {
    if (map) {
      map.setStyle(evt.matches ? STYLES.dark : STYLES.light);
    }
  });
}

function setReplayPlaying(playing) {
  state.replayPlaying = playing;
  const btn = document.getElementById("replay-play-btn");
  const label = document.getElementById("play-label");
  btn.setAttribute("aria-pressed", String(playing));
  label.textContent = playing ? "Pausa" : "Replay";

  if (state.replayTimer) {
    clearInterval(state.replayTimer);
    state.replayTimer = null;
  }

  if (playing) {
    if (state.replayProgress >= 100) {
      state.replayProgress = 0;
    }
    state.replayTimer = setInterval(() => {
      state.replayProgress = Math.min(100, state.replayProgress + 1.5 * state.replaySpeed);
      const slider = document.getElementById("replay-slider");
      slider.value = String(state.replayProgress);
      slider.dispatchEvent(new Event("input"));
      if (state.replayProgress >= 100) {
        setReplayPlaying(false);
      }
    }, 140);
  }
}

function wireUIEvents() {
  const statusEl = document.getElementById("toolbar-status");

  // Region buttons
  const regionBtns = Array.from(document.querySelectorAll("[data-region]"));
  regionBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.region;
      regionBtns.forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      const target = REGIONS[key] || REGIONS.all;
      if (map) {
        map.flyTo({
          center: target.center,
          zoom: target.zoom,
          duration: reducedMotionQuery.matches ? 0 : 1000,
        });
      }
      statusEl.textContent = `Vista enfocada en ${target.label}`;
      if (compactQuery.matches) {
        setToolbarOpen(false);
      }
    });
  });

  // Color mode toggle
  const colorBtns = Array.from(document.querySelectorAll("[data-colormode]"));
  colorBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      state.colorMode = btn.dataset.colormode;
      colorBtns.forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      buildLegend();
      updateLayerColors();
      renderEventList();
      renderSubductionProfile();
      statusEl.textContent = `Coloreado por ${state.colorMode === "depth" ? "profundidad" : "estado INPRES"}`;
    });
  });

  // 3D terrain & pitch toggle
  const btn3D = document.getElementById("toggle-3d-btn");
  btn3D.addEventListener("click", () => {
    state.is3D = !state.is3D;
    btn3D.setAttribute("aria-pressed", String(state.is3D));
    if (map) {
      if (state.is3D && map.getSource("terrain-dem")) {
        map.setTerrain({ source: "terrain-dem", exaggeration: 2.8 });
      } else {
        map.setTerrain(null);
      }
      map.easeTo({
        pitch: state.is3D ? 60 : 0,
        bearing: state.is3D ? -18 : 0,
        zoom: state.is3D ? Math.max(map.getZoom(), 5.2) : map.getZoom(),
        duration: reducedMotionQuery.matches ? 0 : 750,
      });
    }
    statusEl.textContent = state.is3D ? "Relieve 3D activado" : "Vista 2D activada";
  });

  // Manual refresh
  const refreshBtn = document.getElementById("refresh-btn");
  refreshBtn.addEventListener("click", async () => {
    if (refreshBtn.getAttribute("aria-disabled") === "true") return;
    refreshBtn.setAttribute("aria-disabled", "true");
    statusEl.textContent = "Actualizando desde INPRES…";
    try {
      await fetch("/api/refresh", { method: "POST" });
      await fetchData();
      statusEl.textContent = "Datos sísmicos actualizados";
    } catch {
      statusEl.textContent = "Error al consultar INPRES";
    } finally {
      refreshBtn.removeAttribute("aria-disabled");
    }
  });

  // Filters
  const minMagRange = document.getElementById("min-mag-range");
  const minMagVal = document.getElementById("min-mag-value");
  minMagRange.addEventListener("input", () => {
    minMagVal.textContent = Number(minMagRange.value).toFixed(1);
  });
  minMagRange.addEventListener("change", () => fetchData().catch(console.error));
  document.getElementById("days-select").addEventListener("change", () => fetchData().catch(console.error));
  document.getElementById("felt-only-check").addEventListener("change", () => fetchData().catch(console.error));

  // Event list click
  document.getElementById("event-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".event-item-btn");
    if (btn?.dataset.id) selectEvent(btn.dataset.id, true);
  });

  // Subduction SVG click
  document.getElementById("subduction-svg").addEventListener("click", (e) => {
    const dot = e.target.closest("circle[data-id]");
    if (dot?.dataset.id) selectEvent(dot.dataset.id, true);
  });

  // Subduction collapse toggle
  const subBtn = document.getElementById("toggle-subduction-btn");
  const subWrap = document.getElementById("subduction-svg-wrap");
  subBtn.addEventListener("click", () => {
    const expanded = subBtn.getAttribute("aria-expanded") === "true";
    subBtn.setAttribute("aria-expanded", String(!expanded));
    subBtn.textContent = expanded ? "Mostrar" : "Ocultar";
    subWrap.classList.toggle("hidden", expanded);
  });

  // Compact toolbar & sidebar toggles
  const ctrlBtn = document.getElementById("toggle-controls-btn");
  ctrlBtn?.addEventListener("click", () => {
    const expanded = ctrlBtn.getAttribute("aria-expanded") === "true";
    setToolbarOpen(!expanded);
  });

  const sideBtn = document.getElementById("toggle-sidebar-btn");
  sideBtn?.addEventListener("click", () => {
    const expanded = sideBtn.getAttribute("aria-expanded") === "true";
    setSidebarOpen(!expanded);
  });

  compactQuery.addEventListener("change", syncResponsiveMode);
  window.addEventListener("orientationchange", () => {
    if (map) {
      requestAnimationFrame(() => map.resize());
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !compactQuery.matches) return;
    if (ctrlBtn?.getAttribute("aria-expanded") === "true") {
      setToolbarOpen(false);
      ctrlBtn.focus();
    } else if (sideBtn?.getAttribute("aria-expanded") === "true") {
      setSidebarOpen(false);
      sideBtn.focus();
    }
  });

  // Replay controls
  document.getElementById("replay-play-btn").addEventListener("click", () => {
    setReplayPlaying(!state.replayPlaying);
  });

  const speedBtn = document.getElementById("replay-speed-btn");
  speedBtn.addEventListener("click", () => {
    const next = state.replaySpeed === 1 ? 2 : state.replaySpeed === 2 ? 5 : 1;
    state.replaySpeed = next;
    speedBtn.textContent = `${next}x`;
  });

  const slider = document.getElementById("replay-slider");
  slider.addEventListener("input", () => {
    state.replayProgress = Number(slider.value);
    applyReplaySlice();
  });

  document.getElementById("replay-reset-btn").addEventListener("click", () => {
    setReplayPlaying(false);
    state.replayProgress = 100;
    slider.value = "100";
    slider.dispatchEvent(new Event("input"));
  });
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function boot() {
  syncResponsiveMode();
  await ensureTemporal();
  installToolbarRovingFallback();
  installRangeProgressFallback();
  buildLegend();
  wireUIEvents();
  initMap();

  await fetchData();

  // Auto-refresh UI every 90s while staying on real-time mode
  setInterval(() => {
    if (!state.replayPlaying && state.replayProgress >= 100) {
      fetchData().catch(console.error);
    }
  }, 90000);
}

boot().catch(console.error);
