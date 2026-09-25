/* =========================================================
   DRISHTI — Disaster Intelligence Dashboard
   SIH 2026 Prototype
   ---------------------------------------------------------
   Pages:
   1. Command Center       -> index.html
   2. Live Nodes           -> nodes.html
   3. Environmental Analytics -> analytics.html
   ========================================================= */

"use strict";

/* =========================================================
   CONFIGURATION
   ========================================================= */

const API = `${location.protocol}//${location.host}/api`;

const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

const POLL_INTERVAL = 1000;
const MAX_HISTORY = 60;

const MODEL_CLASSES = ["NORMAL", "FLASH_FLOOD", "WILDFIRE", "GAS_LEAK"];

const MODEL_LABELS = {
  NORMAL: "Normal",
  FLASH_FLOOD: "Flash Flood",
  WILDFIRE: "Wildfire",
  GAS_LEAK: "Gas Leak",
};

const MODEL_SHORT = {
  NORMAL: "Normal",
  FLASH_FLOOD: "Flash Flood",
  WILDFIRE: "Wildfire",
  GAS_LEAK: "Gas Leak",
};

const NODE_AREAS = {
  "N-01": "North",
  "N-02": "Central",
  "N-03": "South",
};

/*
 * Prototype presentation thresholds.
 * These are NOT certified engineering/regulatory limits.
 * They are used only to visualize relative risk on the dashboard.
 */
const RISK_LIMITS = {
  floodHeight: {
    low: 0.8,
    high: 1.8,
  },

  floodRate: {
    low: 1.0,
    high: 3.0,
  },

  fireTemp: {
    low: 35.0,
    high: 55.0,
  },

  fireRate: {
    low: 0.5,
    high: 1.5,
  },

  gasPpm: {
    low: 100.0,
    high: 300.0,
  },

  gasRate: {
    low: 4.0,
    high: 10.0,
  },
};

/* =========================================================
   GLOBAL STATE
   ========================================================= */

const state = {
  nodes: [],

  history: {
    gas: [],
    water: [],
    temp: [],
  },

  alerts: [],

  lastPacket: null,

  wsConnected: false,

  lastUpdate: null,
};

/* =========================================================
   BASIC HELPERS
   ========================================================= */

function $(id) {
  return document.getElementById(id);
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "" || value === "--") {
    return null;
  }

  const n = Number(value);

  return Number.isFinite(n) ? n : null;
}

function numberOrZero(value) {
  const n = nullableNumber(value);
  return n === null ? 0 : n;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function round(value, decimals = 1) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return 0;
  }

  const factor = 10 ** decimals;

  return Math.round(n * factor) / factor;
}

function formatNumber(value, decimals = 1, fallback = "--") {
  const n = nullableNumber(value);

  if (n === null) {
    return fallback;
  }

  return n.toFixed(decimals);
}

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatTime(timestamp) {
  if (!timestamp) {
    return "--:--:--";
  }

  const d = new Date(timestamp);

  if (Number.isNaN(d.getTime())) {
    return "--:--:--";
  }

  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDateTime(timestamp) {
  if (!timestamp) {
    return "Unknown time";
  }

  const d = new Date(timestamp);

  if (Number.isNaN(d.getTime())) {
    return "Unknown time";
  }

  return d.toLocaleString([], {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function titleCase(value) {
  if (!value) {
    return "";
  }

  return String(value)
    .toLowerCase()
    .replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

function getNodeArea(id) {
  return NODE_AREAS[id] || "Field Zone";
}

function getModelName(aiClass) {
  const n = Number(aiClass);

  if (Number.isInteger(n) && n >= 0 && n < MODEL_CLASSES.length) {
    return MODEL_CLASSES[n];
  }

  return "NORMAL";
}

function getModelLabel(name) {
  return MODEL_LABELS[name] || titleCase(name);
}

/* =========================================================
   HAZARD / RISK HELPERS
   ========================================================= */

function rangeScore(value, low, high) {
  const n = nullableNumber(value);

  if (n === null || high <= low) {
    return 0;
  }

  return clamp(((n - low) / (high - low)) * 100);
}

function weightedScore(first, second, firstWeight = 0.5) {
  return clamp(first * firstWeight + second * (1 - firstWeight));
}

function calculateNodeRisk(node) {
  /* -----------------------------
     FLOOD
     ----------------------------- */

  const floodHeight = rangeScore(
    node.water,
    RISK_LIMITS.floodHeight.low,
    RISK_LIMITS.floodHeight.high,
  );

  const floodRate = rangeScore(
    node.waterRate,
    RISK_LIMITS.floodRate.low,
    RISK_LIMITS.floodRate.high,
  );

  let flood = weightedScore(floodHeight, floodRate, 0.55);

  /* -----------------------------
     FIRE
     ----------------------------- */

  const fireTemp = rangeScore(
    node.temp,
    RISK_LIMITS.fireTemp.low,
    RISK_LIMITS.fireTemp.high,
  );

  const fireRate = rangeScore(
    node.tempRate,
    RISK_LIMITS.fireRate.low,
    RISK_LIMITS.fireRate.high,
  );

  let fire = weightedScore(fireTemp, fireRate, 0.55);

  /* -----------------------------
     GAS
     ----------------------------- */

  const gasPpm = rangeScore(
    node.gas,
    RISK_LIMITS.gasPpm.low,
    RISK_LIMITS.gasPpm.high,
  );

  const gasRate = rangeScore(
    node.gasRate,
    RISK_LIMITS.gasRate.low,
    RISK_LIMITS.gasRate.high,
  );

  let gas = weightedScore(gasPpm, gasRate, 0.6);

  /* -----------------------------
     EDGE AI OVERRIDE
     ----------------------------- */

  const aiRisk = node.aiName === "NORMAL" ? 0 : 90;

  if (node.aiName === "FLASH_FLOOD") {
    flood = Math.max(flood, aiRisk);
  }

  if (node.aiName === "WILDFIRE") {
    fire = Math.max(fire, aiRisk);
  }

  if (node.aiName === "GAS_LEAK") {
    gas = Math.max(gas, aiRisk);
  }

  /* -----------------------------
     OVERALL
     ----------------------------- */

  const sensorRisk = Math.max(flood, fire, gas);

  const overall = Math.round(Math.max(sensorRisk, aiRisk));

  /* -----------------------------
     DOMINANT HAZARD
     ----------------------------- */

  let dominant = "NORMAL";

  if (node.aiName !== "NORMAL") {
    dominant = node.aiName;
  } else if (sensorRisk > 0) {
    const candidates = [
      ["FLASH_FLOOD", flood],
      ["WILDFIRE", fire],
      ["GAS_LEAK", gas],
    ];

    candidates.sort((a, b) => b[1] - a[1]);

    dominant = candidates[0][0];
  }

  return {
    flood: Math.round(flood),
    fire: Math.round(fire),
    gas: Math.round(gas),

    sensorRisk: Math.round(sensorRisk),

    aiRisk,

    overall,

    dominant,
  };
}

function getRiskClass(risk) {
  if (risk >= 75) {
    return "danger";
  }

  if (risk >= 45) {
    return "warn";
  }

  return "good";
}

function getRiskText(risk) {
  if (risk >= 75) {
    return "High Risk";
  }

  if (risk >= 45) {
    return "Watch";
  }

  return "Normal";
}

/* =========================================================
   TELEMETRY NORMALIZATION
   ========================================================= */

function normalize(row) {
  row = row || {};

  const rawId = row.id ?? row.node_id ?? row.nodeId ?? row.node ?? "N-01";

  let id = String(rawId);

  if (/^\d+$/.test(id)) {
    id = `N-${String(id).padStart(2, "0")}`;
  }

  const area = row.area ?? row.zone ?? row.location ?? getNodeArea(id);

  /* -----------------------------
     GAS
     ----------------------------- */

  const gas = nullableNumber(
    row.gas ??
      row.gas_ppm ??
      row.gasPpm ??
      row.filtered_gas_ppm ??
      row.filteredGasPpm,
  );

  const gasRate = nullableNumber(
    row.gasRate ??
      row.gas_rate ??
      row.gas_rate_ppm_s ??
      row.gasRatePpmS ??
      row.gas_rate_ppm_sec,
  );

  /* -----------------------------
     WATER
     ----------------------------- */

  let water = nullableNumber(
    row.water ?? row.water_height_m ?? row.waterHeight ?? row.water_height,
  );

  const rawWaterMM = nullableNumber(
    row.filtered_water_mm ?? row.water_mm ?? row.filteredWaterMm,
  );

  if (water === null && rawWaterMM !== null) {
    water = rawWaterMM / 1000;
  }

  let waterRate = nullableNumber(
    row.waterRate ??
      row.water_rate ??
      row.water_rate_cm_min ??
      row.waterRateCmMin ??
      row.water_surge_rate,
  );

  const rawWaterRateMMS = nullableNumber(
    row.water_surge_rate ?? row.water_surge_mm_s ?? row.waterSurgeRate,
  );

  /*
   * 1 mm/s = 6 cm/min
   */
  if (waterRate === null && rawWaterRateMMS !== null) {
    waterRate = rawWaterRateMMS * 6;
  }

  /* =====================================================
     TEMPERATURE
     =====================================================

     IMPORTANT:
     Supports all common names used by:
       simulator
       backend
       UART decoder
       STM32
       dashboard API
     ===================================================== */

  const temp = nullableNumber(
    row.temp ??
      row.temperature ??
      row.temp_c ??
      row.temperature_c ??
      row.fire_temp_c ??
      row.fire_temperature ??
      row.fireTemperature ??
      row.temperatureC ??
      row.tempC ??
      row.filtered_temp_c ??
      row.filteredTempC,
  );

  const tempRate = nullableNumber(
    row.tempRate ??
      row.temp_rate ??
      row.temp_rate_c_min ??
      row.temperature_rate ??
      row.temperatureRate ??
      row.fire_temp_rate ??
      row.fire_temperature_rate ??
      row.tempRateCMin ??
      row.temp_rate_c_per_min,
  );

  /* -----------------------------
     VIBRATION
     ----------------------------- */

  const vibration = nullableNumber(
    row.vibration ??
      row.vibration_rms ??
      row.vibrationRms ??
      row.vibration_rms_value,
  );

  /* -----------------------------
     NETWORK VALUES
     ----------------------------- */

  const battery = nullableNumber(
    row.battery ?? row.battery_pct ?? row.battery_percent ?? row.batteryPercent,
  );

  const rssi = nullableNumber(row.rssi ?? row.signal ?? row.signal_strength);

  const latency = nullableNumber(
    row.latency ?? row.latency_ms ?? row.latencyMs,
  );

  /* -----------------------------
     AI CLASSIFICATION
     ----------------------------- */

  let aiClass = nullableNumber(
    row.aiClass ??
      row.ai_class ??
      row.hazard_code ??
      row.hazardCode ??
      row.class_id ??
      row.classId,
  );

  if (aiClass === null) {
    aiClass = 0;
  }

  aiClass = clamp(Math.round(aiClass), 0, MODEL_CLASSES.length - 1);

  let aiName =
    row.aiName ??
    row.ai_name ??
    row.hazard_status ??
    row.hazardStatus ??
    row.class_name ??
    row.className;

  if (!aiName) {
    aiName = getModelName(aiClass);
  }

  aiName = String(aiName).toUpperCase();

  if (!MODEL_CLASSES.includes(aiName)) {
    aiName = getModelName(aiClass);
  }

  /* -----------------------------
     SEQUENCE / TIMESTAMP
     ----------------------------- */

  const seq =
    row.seq ?? row.seq_num ?? row.sequence ?? row.sequence_number ?? null;

  const timestamp =
    row.timestamp ??
    row.ts ??
    row.time ??
    row.created_at ??
    row.createdAt ??
    new Date().toISOString();

  return {
    id,
    area,

    gas,
    gasRate,

    water,
    waterRate,

    temp,
    tempRate,

    vibration,

    battery,
    rssi,
    latency,

    aiClass,
    aiName,

    seq,
    timestamp,
  };
}

/* =========================================================
   HISTORY
   ========================================================= */

function pushHistory(metric, value, timestamp) {
  const n = nullableNumber(value);

  if (n === null) {
    return;
  }

  if (!state.history[metric]) {
    state.history[metric] = [];
  }

  state.history[metric].push({
    value: n,
    timestamp: timestamp || new Date().toISOString(),
  });

  if (state.history[metric].length > MAX_HISTORY) {
    state.history[metric].splice(0, state.history[metric].length - MAX_HISTORY);
  }
}

/* =========================================================
   NODE UPSERT
   ========================================================= */

function upsertNode(node) {
  const index = state.nodes.findIndex((item) => item.id === node.id);

  if (index === -1) {
    state.nodes.push(node);
  } else {
    state.nodes[index] = {
      ...state.nodes[index],
      ...node,
    };
  }

  state.nodes.sort((a, b) => a.id.localeCompare(b.id));
}

/* =========================================================
   INGEST TELEMETRY
   ========================================================= */

function ingestRow(row) {
  const node = normalize(row);

  upsertNode(node);

  state.lastPacket = node.timestamp;
  state.lastUpdate = Date.now();

  pushHistory("gas", node.gas, node.timestamp);

  pushHistory("water", node.water, node.timestamp);

  pushHistory("temp", node.temp, node.timestamp);

  renderAll();
}

/* =========================================================
   API
   ========================================================= */

async function apiGet(path) {
  const response = await fetch(`${API}${path}`, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

/* =========================================================
   INITIAL BOOT
   ========================================================= */

async function boot() {
  try {
    const latest = await apiGet("/telemetry/latest");

    if (Array.isArray(latest)) {
      state.nodes = latest.map(normalize);
    } else if (latest && typeof latest === "object") {
      state.nodes = Object.values(latest).map(normalize);
    }

    renderAll();
  } catch (error) {
    console.warn("[DRISHTI] latest telemetry unavailable:", error);
  }

  /* -----------------------------
     HISTORY
     ----------------------------- */

  try {
    const history = await apiGet("/telemetry/history?limit=60");

    if (Array.isArray(history)) {
      for (const row of history) {
        const node = normalize(row);

        pushHistory("gas", node.gas, node.timestamp);

        pushHistory("water", node.water, node.timestamp);

        pushHistory("temp", node.temp, node.timestamp);
      }
    }

    renderAll();
  } catch (error) {
    console.warn("[DRISHTI] history unavailable:", error);
  }

  /* -----------------------------
     ALERTS
     ----------------------------- */

  try {
    const alerts = await apiGet("/alerts?limit=20");

    if (Array.isArray(alerts)) {
      state.alerts = alerts;
    }
  } catch (error) {
    console.warn("[DRISHTI] alerts unavailable:", error);
  }

  renderAll();
}

/* =========================================================
   LIVE POLLING
   ========================================================= */

async function refreshLiveNodes() {
  try {
    const latest = await apiGet("/telemetry/latest");

    if (Array.isArray(latest)) {
      latest.forEach((row) => {
        ingestRow(row);
      });
    } else if (latest && typeof latest === "object") {
      Object.values(latest).forEach((row) => ingestRow(row));
    }

    setBackendStatus(true);
  } catch (error) {
    setBackendStatus(false);

    console.warn("[DRISHTI] polling error:", error);
  }
}

/* =========================================================
   WEBSOCKET
   ========================================================= */

function connectWebSocket() {
  try {
    const socket = new WebSocket(WS_URL);

    socket.addEventListener("open", () => {
      state.wsConnected = true;
      setBackendStatus(true);

      console.log("[DRISHTI] WebSocket connected");
    });

    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);

        /*
         * Supported backend event shapes:
         *
         * {
         *   type: "telemetry",
         *   data: {...}
         * }
         *
         * {
         *   type: "snapshot",
         *   data: [...]
         * }
         *
         * or raw telemetry object.
         */

        if (message.type === "telemetry") {
          ingestRow(message.data || message.row || message);

          return;
        }

        if (message.type === "snapshot") {
          const rows = Array.isArray(message.data) ? message.data : [];

          rows.forEach(ingestRow);

          return;
        }

        if (message.type === "node_status") {
          if (message.data) {
            ingestRow(message.data);
          }

          return;
        }

        if (message.node_id || message.nodeId || message.id) {
          ingestRow(message);
        }
      } catch (error) {
        console.warn("[DRISHTI] invalid WebSocket message", error);
      }
    });

    socket.addEventListener("close", () => {
      state.wsConnected = false;

      setBackendStatus(false);

      setTimeout(connectWebSocket, 2500);
    });

    socket.addEventListener("error", () => {
      state.wsConnected = false;
    });
  } catch (error) {
    console.warn("[DRISHTI] WebSocket unavailable", error);

    setTimeout(connectWebSocket, 3000);
  }
}

/* =========================================================
   BACKEND STATUS
   ========================================================= */

function setBackendStatus(online) {
  const elements = document.querySelectorAll(".system-pill, .backend-status");

  elements.forEach((element) => {
    const text = element.querySelector("b");

    if (text) {
      text.textContent = online ? "Backend online" : "Backend offline";
    }

    element.classList.toggle("offline", !online);
  });

  const topLive = document.querySelector(".top-actions .live");

  if (topLive) {
    topLive.innerHTML = `<span class="pulse"></span> ${
      online ? "LIVE" : "OFFLINE"
    }`;
  }
}

/* =========================================================
   CLOCK
   ========================================================= */

function updateClock() {
  const clock = $("clock");

  if (!clock) {
    return;
  }

  const now = new Date();

  clock.textContent = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

setInterval(updateClock, 1000);

/* =========================================================
   OVERVIEW PAGE
   ========================================================= */

function renderOverview() {
  if (document.body.dataset.page !== "overview") {
    return;
  }

  if (!state.nodes.length) {
    return;
  }

  /* -----------------------------
     Highest gas
     ----------------------------- */

  const gasNodes = state.nodes.filter((node) => node.gas !== null);

  const highestGas = gasNodes.length
    ? gasNodes.reduce((a, b) =>
        numberOrZero(a.gas) > numberOrZero(b.gas) ? a : b,
      )
    : null;

  /* -----------------------------
     Highest water
     ----------------------------- */

  const waterNodes = state.nodes.filter((node) => node.water !== null);

  const highestWater = waterNodes.length
    ? waterNodes.reduce((a, b) =>
        numberOrZero(a.water) > numberOrZero(b.water) ? a : b,
      )
    : null;

  /* -----------------------------
     Highest temperature
     ----------------------------- */

  const tempNodes = state.nodes.filter((node) => node.temp !== null);

  const highestTemp = tempNodes.length
    ? tempNodes.reduce((a, b) =>
        numberOrZero(a.temp) > numberOrZero(b.temp) ? a : b,
      )
    : null;

  /* -----------------------------
     GAS CARD
     ----------------------------- */

  const gasValue = $("gasValue");

  if (gasValue) {
    gasValue.textContent = highestGas ? formatNumber(highestGas.gas, 0) : "--";
  }

  const gasNode = $("gasNode");

  if (gasNode) {
    gasNode.textContent = highestGas ? highestGas.id : "--";
  }

  /* -----------------------------
     WATER CARD
     ----------------------------- */

  const waterValue = $("waterValue");

  if (waterValue) {
    waterValue.textContent = highestWater
      ? formatNumber(highestWater.water, 2)
      : "--";
  }

  const waterRate = $("waterRate");

  if (waterRate) {
    waterRate.textContent =
      highestWater && highestWater.waterRate !== null
        ? `${highestWater.waterRate >= 0 ? "+" : ""}${formatNumber(
            highestWater.waterRate,
            1,
          )} cm/min`
        : "--";
  }

  /* -----------------------------
     TEMPERATURE CARD
     ----------------------------- */

  const tempValue = $("tempValue");

  if (tempValue) {
    tempValue.textContent = highestTemp
      ? formatNumber(highestTemp.temp, 1)
      : "--";
  }

  const tempRate = $("tempRate");

  if (tempRate) {
    tempRate.textContent =
      highestTemp && highestTemp.tempRate !== null
        ? `${highestTemp.tempRate >= 0 ? "+" : ""}${formatNumber(
            highestTemp.tempRate,
            1,
          )} °C/min`
        : "--";
  }

  /* -----------------------------
     AI CARD
     ----------------------------- */

  const hazardNodes = state.nodes.filter((node) => node.aiName !== "NORMAL");

  const aiNode = hazardNodes.length ? hazardNodes[0] : state.nodes[0];

  const aiState = $("aiState");

  if (aiState) {
    aiState.textContent = aiNode ? getModelLabel(aiNode.aiName) : "Monitoring";
  }

  const aiNodeElement = $("aiNode");

  if (aiNodeElement) {
    aiNodeElement.textContent = aiNode
      ? `${aiNode.id} • class ${aiNode.aiClass}`
      : "--";
  }

  /* -----------------------------
     BATTERY
     ----------------------------- */

  const batteryBar = $("batteryBar");

  if (batteryBar) {
    const batteryValues = state.nodes
      .map((node) => node.battery)
      .filter((value) => value !== null);

    const averageBattery = batteryValues.length
      ? batteryValues.reduce((a, b) => a + b, 0) / batteryValues.length
      : null;

    batteryBar.style.width =
      averageBattery === null ? "0%" : `${clamp(averageBattery)}%`;
  }

  /* -----------------------------
     HERO METADATA
     ----------------------------- */

  const lastPacket = $("lastPacket");

  if (lastPacket) {
    lastPacket.textContent = state.lastPacket
      ? formatDateTime(state.lastPacket)
      : "Waiting";
  }

  const latency = $("latency");

  if (latency) {
    const values = state.nodes
      .map((node) => node.latency)
      .filter((value) => value !== null);

    latency.textContent = values.length
      ? `${Math.round(values.reduce((a, b) => a + b, 0) / values.length)} ms`
      : "--";
  }

  renderSparklines();
}

/* =========================================================
   SPARKLINES
   ========================================================= */

function renderSparkline(element, metric) {
  if (!element) {
    return;
  }

  const values = state.history[metric] || [];

  const usable = values
    .map((item) => nullableNumber(item.value))
    .filter((value) => value !== null)
    .slice(-20);

  if (usable.length < 2) {
    element.innerHTML = "";
    return;
  }

  const width = 260;
  const height = 50;
  const padding = 3;

  const min = Math.min(...usable);

  const max = Math.max(...usable);

  const range = max - min || 1;

  const points = usable.map((value, index) => {
    const x = padding + (index / (usable.length - 1)) * (width - padding * 2);

    const y =
      height - padding - ((value - min) / range) * (height - padding * 2);

    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  element.innerHTML = `
    <svg
      viewBox="0 0 ${width} ${height}"
      preserveAspectRatio="none"
      width="100%"
      height="50"
      aria-hidden="true"
    >
      <polyline
        points="${points.join(" ")}"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  `;
}

function renderSparklines() {
  renderSparkline($("gasSpark"), "gas");

  renderSparkline($("waterSpark"), "water");

  renderSparkline($("tempSpark"), "temp");
}

/* =========================================================
   TREND CHART
   ========================================================= */

function renderTrend() {
  const svg = $("trendChart");

  if (!svg) {
    return;
  }

  const select = $("chartMetric");

  const metric = select ? select.value : "water";

  const history = state.history[metric] || [];

  const values = history
    .map((item) => nullableNumber(item.value))
    .filter((value) => value !== null)
    .slice(-30);

  const legend = $("chartLegend");

  const labels = {
    water: "Water height",
    gas: "Gas concentration",
    temp: "Temperature",
  };

  const units = {
    water: "m",
    gas: "ppm",
    temp: "°C",
  };

  if (legend) {
    legend.textContent = labels[metric] || "Telemetry";
  }

  if (values.length < 2) {
    svg.innerHTML = `
      <text
        x="380"
        y="140"
        text-anchor="middle"
        fill="#7d8ba3"
        font-size="16"
        font-family="Inter, sans-serif"
      >
        Waiting for live telemetry...
      </text>
    `;

    return;
  }

  const width = 760;
  const height = 280;

  const left = 42;
  const right = 20;
  const top = 24;
  const bottom = 42;

  const chartWidth = width - left - right;

  const chartHeight = height - top - bottom;

  let min = Math.min(...values);

  let max = Math.max(...values);

  if (min === max) {
    min -= 1;
    max += 1;
  }

  const padding = (max - min) * 0.1;

  min -= padding;
  max += padding;

  const points = values.map((value, index) => {
    const x = left + (index / (values.length - 1)) * chartWidth;

    const y = top + chartHeight - ((value - min) / (max - min)) * chartHeight;

    return {
      x,
      y,
      value,
    };
  });

  const polyline = points
    .map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(" ");

  const areaPoints = [
    `${left},${top + chartHeight}`,
    ...points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`),
    `${left + chartWidth},${top + chartHeight}`,
  ].join(" ");

  const gridLines = [];

  for (let i = 0; i <= 4; i++) {
    const ratio = i / 4;

    const y = top + chartHeight * ratio;

    const value = max - (max - min) * ratio;

    gridLines.push(`
      <line
        x1="${left}"
        y1="${y}"
        x2="${left + chartWidth}"
        y2="${y}"
        stroke="rgba(140,160,190,0.12)"
        stroke-width="1"
      />

      <text
        x="${left - 9}"
        y="${y + 4}"
        text-anchor="end"
        fill="#71809a"
        font-size="11"
        font-family="Inter, sans-serif"
      >
        ${value.toFixed(metric === "gas" ? 0 : 1)}
      </text>
    `);
  }

  const dots = points
    .map(
      (point) => `
          <circle
            cx="${point.x}"
            cy="${point.y}"
            r="3.2"
            fill="#53d8ff"
          />
        `,
    )
    .join("");

  const latest = values[values.length - 1];

  svg.innerHTML = `
    <defs>
      <linearGradient
        id="trendFill"
        x1="0"
        y1="0"
        x2="0"
        y2="1"
      >
        <stop
          offset="0%"
          stop-color="#53d8ff"
          stop-opacity="0.20"
        />

        <stop
          offset="100%"
          stop-color="#53d8ff"
          stop-opacity="0"
        />
      </linearGradient>
    </defs>

    ${gridLines.join("")}

    <polygon
      points="${areaPoints}"
      fill="url(#trendFill)"
    />

    <polyline
      points="${polyline}"
      fill="none"
      stroke="#53d8ff"
      stroke-width="3"
      stroke-linecap="round"
      stroke-linejoin="round"
    />

    ${dots}

    <text
      x="${left}"
      y="${height - 8}"
      fill="#71809a"
      font-size="11"
      font-family="Inter, sans-serif"
    >
      OLDER
    </text>

    <text
      x="${left + chartWidth}"
      y="${height - 8}"
      text-anchor="end"
      fill="#71809a"
      font-size="11"
      font-family="Inter, sans-serif"
    >
      LATEST
    </text>

    <text
      x="${left + chartWidth}"
      y="${points[points.length - 1].y - 10}"
      text-anchor="end"
      fill="#e7f3ff"
      font-size="12"
      font-weight="700"
      font-family="Inter, sans-serif"
    >
      ${formatNumber(latest, metric === "gas" ? 0 : 2)} ${units[metric]}
    </text>
  `;
}

/* =========================================================
   ALERTS
   ========================================================= */

function renderAlerts() {
  const list = $("alertsList");

  if (!list) {
    return;
  }

  const activeNodes = state.nodes.filter((node) => node.aiName !== "NORMAL");

  const alertCount = $("alertCount");

  if (alertCount) {
    alertCount.textContent = activeNodes.length
      ? `${activeNodes.length} active`
      : "0 active";
  }

  const sideCount = $("sideAlertCount");

  if (sideCount) {
    sideCount.textContent = String(activeNodes.length);
  }

  if (!activeNodes.length) {
    list.innerHTML = `
      <div class="alert-empty">
        <span>✓</span>
        <div>
          <strong>All nodes normal</strong>
          <small>
            No active AI hazard classifications.
          </small>
        </div>
      </div>
    `;

    return;
  }

  list.innerHTML = activeNodes
    .map((node) => {
      const risk = calculateNodeRisk(node);

      return `
          <div class="alert-item">
            <div class="alert-symbol">!</div>

            <div class="alert-main">
              <strong>
                ${escapeHTML(getModelLabel(node.aiName))}
              </strong>

              <small>
                ${escapeHTML(node.id)} • ${escapeHTML(node.area)} • risk ${
                  risk.overall
                }/100
              </small>
            </div>

            <time>
              ${escapeHTML(formatDateTime(node.timestamp))}
            </time>
          </div>
        `;
    })
    .join("");
}

/* =========================================================
   NODE PAGE — IMPROVED NODE BOXES
   ========================================================= */

function renderNodes() {
  if (document.body.dataset.page !== "nodes") {
    return;
  }

  const grid = $("nodeDetailGrid");

  if (!grid) {
    return;
  }

  /* -----------------------------
     SUMMARY
     ----------------------------- */

  const packetRate = $("packetRate");

  if (packetRate) {
    /*
     * Simulator sends roughly one packet
     * every 2 seconds per node.
     */
    packetRate.textContent = state.nodes.length
      ? String(state.nodes.length * 30)
      : "0";
  }

  const batteryValues = state.nodes
    .map((node) => node.battery)
    .filter((value) => value !== null);

  const nodeBattery = $("nodeBattery");

  if (nodeBattery) {
    nodeBattery.textContent = batteryValues.length
      ? `${Math.round(
          batteryValues.reduce((a, b) => a + b, 0) / batteryValues.length,
        )}%`
      : "N/A";
  }

  const latencyValues = state.nodes
    .map((node) => node.latency)
    .filter((value) => value !== null);

  const nodeLatency = $("nodeLatency");

  if (nodeLatency) {
    nodeLatency.textContent = latencyValues.length
      ? `${Math.round(
          latencyValues.reduce((a, b) => a + b, 0) / latencyValues.length,
        )} ms`
      : "N/A";
  }

  /* -----------------------------
     NODE CARDS
     ----------------------------- */

  grid.innerHTML = state.nodes.map((node) => createNodeCard(node)).join("");

  renderSensorTable();
}

/* =========================================================
   NODE CARD
   ========================================================= */

function createNodeCard(node) {
  const risk = calculateNodeRisk(node);

  const riskClass = getRiskClass(risk.overall);

  const modelLabel = getModelLabel(node.aiName);

  const isNormal = node.aiName === "NORMAL";

  const gasText = node.gas === null ? "--" : `${formatNumber(node.gas, 0)} ppm`;

  const waterText =
    node.water === null ? "--" : `${formatNumber(node.water, 2)} m`;

  const tempText =
    node.temp === null ? "--" : `${formatNumber(node.temp, 1)} °C`;

  const vibrationText =
    node.vibration === null ? "--" : formatNumber(node.vibration, 0);

  const waterRateText =
    node.waterRate === null
      ? "--"
      : `${node.waterRate >= 0 ? "+" : ""}${formatNumber(
          node.waterRate,
          1,
        )} cm/min`;

  const tempRateText =
    node.tempRate === null
      ? "--"
      : `${node.tempRate >= 0 ? "+" : ""}${formatNumber(
          node.tempRate,
          1,
        )} °C/min`;

  const gasRateText =
    node.gasRate === null
      ? "--"
      : `${node.gasRate >= 0 ? "+" : ""}${formatNumber(node.gasRate, 1)} ppm/s`;

  return `
    <article
      class="drishti-node-card ${riskClass}"
      data-node="${escapeHTML(node.id)}"
    >

      <div class="drishti-node-header">

        <div class="node-identity">

          <div class="node-status-dot ${isNormal ? "normal" : "hazard"}"></div>

          <div>
            <div class="node-id">
              ${escapeHTML(node.id)}
            </div>

            <div class="node-area">
              ${escapeHTML(node.area)}
            </div>
          </div>

        </div>

        <span
          class="node-ai-pill ${riskClass}"
        >
          ${escapeHTML(modelLabel)}
        </span>

      </div>


      <div class="node-card-divider"></div>


      <div class="node-sensor-grid">

        <div class="node-sensor">
          <span class="sensor-label">
            GAS
          </span>

          <strong>
            ${escapeHTML(gasText)}
          </strong>

          <small>
            Δ ${escapeHTML(gasRateText)}
          </small>
        </div>


        <div class="node-sensor">
          <span class="sensor-label">
            WATER
          </span>

          <strong>
            ${escapeHTML(waterText)}
          </strong>

          <small>
            Δ ${escapeHTML(waterRateText)}
          </small>
        </div>


        <div class="node-sensor">
          <span class="sensor-label">
            TEMPERATURE
          </span>

          <strong>
            ${escapeHTML(tempText)}
          </strong>

          <small>
            Δ ${escapeHTML(tempRateText)}
          </small>
        </div>


        <div class="node-sensor">
          <span class="sensor-label">
            VIBRATION
          </span>

          <strong>
            ${escapeHTML(vibrationText)}
          </strong>

          <small>
            RMS signal
          </small>
        </div>

      </div>


      <div class="node-card-footer">

        <div class="risk-info">

          <div class="risk-title">
            <span>Environmental risk</span>

            <strong>
              ${risk.overall}/100
            </strong>
          </div>

          <div class="risk-track">
            <div
              class="risk-fill ${riskClass}"
              style="width:${risk.overall}%"
            ></div>
          </div>

        </div>


        <div class="node-meta">

          <span>
            AI class ${Number(node.aiClass)}
          </span>

          <span>
            ${node.seq !== null ? `SEQ ${node.seq}` : "LIVE"}
          </span>

        </div>

      </div>

    </article>
  `;
}

/* =========================================================
   SENSOR TABLE
   ========================================================= */

function renderSensorTable() {
  const table = $("sensorTable");

  if (!table) {
    return;
  }

  table.innerHTML = state.nodes
    .map((node) => {
      const model = getModelLabel(node.aiName);

      const risk = calculateNodeRisk(node);

      return `
          <tr>

            <td>
              <strong>
                ${escapeHTML(node.id)}
              </strong>

              <small>
                ${escapeHTML(node.area)}
              </small>
            </td>

            <td>
              ${node.gas === null ? "--" : `${formatNumber(node.gas, 0)} ppm`}
            </td>

            <td>
              ${node.water === null ? "--" : `${formatNumber(node.water, 2)} m`}
            </td>

            <td>
              ${
                node.waterRate === null
                  ? "--"
                  : `${node.waterRate >= 0 ? "+" : ""}${formatNumber(
                      node.waterRate,
                      1,
                    )} cm/min`
              }
            </td>

            <td>
              ${node.temp === null ? "--" : `${formatNumber(node.temp, 1)} °C`}
            </td>

            <td>
              ${
                node.tempRate === null
                  ? "--"
                  : `${node.tempRate >= 0 ? "+" : ""}${formatNumber(
                      node.tempRate,
                      1,
                    )} °C/min`
              }
            </td>

            <td>
              ${
                node.gasRate === null
                  ? "--"
                  : `${node.gasRate >= 0 ? "+" : ""}${formatNumber(
                      node.gasRate,
                      1,
                    )} ppm/s`
              }
            </td>

            <td>
              ${
                node.vibration === null ? "--" : formatNumber(node.vibration, 0)
              }
            </td>

            <td>
              <span
                class="table-ai ${getRiskClass(risk.overall)}"
              >
                ${escapeHTML(model)}
              </span>
            </td>

          </tr>
        `;
    })
    .join("");
}

/* =========================================================
   ANALYTICS PAGE
   ========================================================= */

function renderAnalytics() {
  if (document.body.dataset.page !== "analytics") {
    return;
  }

  if (!state.nodes.length) {
    return;
  }

  const nodeRisks = state.nodes.map((node) => ({
    node,
    risk: calculateNodeRisk(node),
  }));

  /* -----------------------------
     NETWORK RISK
     ----------------------------- */

  const networkRisk = nodeRisks.length
    ? Math.max(...nodeRisks.map((item) => item.risk.overall))
    : 0;

  const riskScore = $("riskScore");

  if (riskScore) {
    riskScore.textContent = String(Math.round(networkRisk));
  }

  /* -----------------------------
     CATEGORY RISK
     ----------------------------- */

  const floodRisk = nodeRisks.length
    ? Math.max(...nodeRisks.map((item) => item.risk.flood))
    : 0;

  const fireRisk = nodeRisks.length
    ? Math.max(...nodeRisks.map((item) => item.risk.fire))
    : 0;

  const gasRisk = nodeRisks.length
    ? Math.max(...nodeRisks.map((item) => item.risk.gas))
    : 0;

  const floodBar = $("riskFlood");

  if (floodBar) {
    floodBar.style.width = `${clamp(floodRisk)}%`;
  }

  const fireBar = $("riskFire");

  if (fireBar) {
    fireBar.style.width = `${clamp(fireRisk)}%`;
  }

  const gasBar = $("riskGas");

  if (gasBar) {
    gasBar.style.width = `${clamp(gasRisk)}%`;
  }

  /* -----------------------------
     DOMINANT HAZARD
     ----------------------------- */

  let dominant = "NORMAL";

  if (nodeRisks.length) {
    const hazardNodes = nodeRisks.filter(
      (item) => item.node.aiName !== "NORMAL",
    );

    if (hazardNodes.length) {
      hazardNodes.sort((a, b) => b.risk.overall - a.risk.overall);

      dominant = hazardNodes[0].node.aiName;
    } else {
      const categories = [
        ["FLASH_FLOOD", floodRisk],
        ["WILDFIRE", fireRisk],
        ["GAS_LEAK", gasRisk],
      ];

      categories.sort((a, b) => b[1] - a[1]);

      dominant = categories[0][1] > 0 ? categories[0][0] : "NORMAL";
    }
  }

  /* -----------------------------
     RISK BANNER
     ----------------------------- */

  const heading = document.querySelector(".risk-copy h2");

  const description = document.querySelector(".risk-copy p");

  if (heading) {
    if (dominant === "FLASH_FLOOD") {
      heading.textContent = "Flash-flood conditions detected.";
    } else if (dominant === "WILDFIRE") {
      heading.textContent = "Elevated wildfire heat signal detected.";
    } else if (dominant === "GAS_LEAK") {
      heading.textContent = "Elevated gas concentration detected.";
    } else {
      heading.textContent = "Environmental conditions are being monitored.";
    }
  }

  if (description) {
    if (dominant === "FLASH_FLOOD") {
      description.textContent =
        "Water-level and rate-of-rise signals are being monitored alongside edge AI classification.";
    } else if (dominant === "WILDFIRE") {
      description.textContent =
        "Temperature and rate-of-rise signals are being monitored alongside edge AI classification.";
    } else if (dominant === "GAS_LEAK") {
      description.textContent =
        "Gas concentration and rate-of-rise signals are being monitored alongside edge AI classification.";
    } else {
      description.textContent =
        "Multi-sensor environmental telemetry is being monitored across all sensing zones.";
    }
  }

  renderIncidentTimeline();
}

/* =========================================================
   INCIDENT TIMELINE
   ========================================================= */

function renderIncidentTimeline() {
  const timeline = $("incidentTimeline");

  if (!timeline) {
    return;
  }

  const active = state.nodes.filter((node) => node.aiName !== "NORMAL");

  if (!active.length) {
    timeline.innerHTML = `
      <div class="incident-item">
        <div class="incident-marker good">
          ✓
        </div>

        <div>
          <strong>
            No active incidents
          </strong>

          <small>
            All edge nodes currently classified as normal.
          </small>
        </div>
      </div>
    `;

    return;
  }

  timeline.innerHTML = active
    .map((node) => {
      const risk = calculateNodeRisk(node);

      return `
          <div class="incident-item">

            <div class="incident-marker">
              !
            </div>

            <div class="incident-content">

              <div class="incident-top">
                <strong>
                  ${escapeHTML(getModelLabel(node.aiName))}
                </strong>

                <span>
                  ${escapeHTML(formatDateTime(node.timestamp))}
                </span>
              </div>

              <small>
                ${escapeHTML(node.id)} • ${escapeHTML(node.area)} • risk ${
                  risk.overall
                }/100
              </small>

            </div>

          </div>
        `;
    })
    .join("");
}

/* =========================================================
   PIPELINE STATUS
   ========================================================= */

function updatePipeline() {
  const pipeline = document.querySelectorAll(".timeline .step");

  if (!pipeline.length) {
    return;
  }

  const hasTelemetry = state.nodes.length > 0;

  const hasHazard = state.nodes.some((node) => node.aiName !== "NORMAL");

  pipeline.forEach((step, index) => {
    step.classList.remove("active", "complete");

    if (!hasTelemetry) {
      if (index === 0) {
        step.classList.add("active");
      }

      return;
    }

    if (index <= 2) {
      step.classList.add("complete");
    }

    if (hasHazard && index === 3) {
      step.classList.add("active");
    }
  });
}

/* =========================================================
   RENDER ALL
   ========================================================= */

function renderAll() {
  renderOverview();

  renderTrend();

  renderAlerts();

  renderNodes();

  renderAnalytics();

  updatePipeline();
}

/* =========================================================
   CHART SELECTOR
   ========================================================= */

function setupChartSelector() {
  const select = $("chartMetric");

  if (!select) {
    return;
  }

  select.addEventListener("change", () => {
    renderTrend();
  });
}

/* =========================================================
   RANGE BUTTONS
   ========================================================= */

function setupRangeButtons() {
  const buttons = document.querySelectorAll(".range-btn");

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      buttons.forEach((item) => item.classList.remove("active"));

      button.classList.add("active");

      /*
       * Prototype:
       * live mode is the actual
       * backend-fed view.
       *
       * 1H / 24H remain UI
       * controls for future
       * historical queries.
       */
    });
  });
}

/* =========================================================
   NODE CARD VISUAL ENHANCEMENTS
   =========================================================

   These styles are injected because the existing
   styles.css was designed around the older node cards.
   This lets the second page immediately get the
   upgraded cards without requiring a CSS replacement.
   ========================================================= */

function injectNodeCardStyles() {
  if (document.getElementById("drishti-node-card-styles")) {
    return;
  }

  const style = document.createElement("style");

  style.id = "drishti-node-card-styles";

  style.textContent = `
    .drishti-node-card {
      position: relative;
      overflow: hidden;
      min-height: 315px;
      padding: 22px;
      border: 1px solid rgba(105, 140, 175, 0.18);
      border-radius: 18px;
      background:
        radial-gradient(
          circle at 90% 0%,
          rgba(83, 216, 255, 0.08),
          transparent 34%
        ),
        linear-gradient(
          145deg,
          rgba(15, 26, 39, 0.98),
          rgba(8, 15, 24, 0.98)
        );
      box-shadow:
        0 18px 50px rgba(0,0,0,0.18),
        inset 0 1px 0 rgba(255,255,255,0.025);
      transition:
        transform .2s ease,
        border-color .2s ease,
        box-shadow .2s ease;
    }

    .drishti-node-card:hover {
      transform: translateY(-3px);
      border-color: rgba(83, 216, 255, 0.35);
      box-shadow:
        0 22px 55px rgba(0,0,0,0.25),
        0 0 35px rgba(83,216,255,0.05);
    }

    .drishti-node-card.danger {
      border-color: rgba(255, 105, 105, 0.28);
    }

    .drishti-node-card.warn {
      border-color: rgba(255, 193, 87, 0.25);
    }

    .drishti-node-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .node-identity {
      display: flex;
      align-items: center;
      gap: 11px;
    }

    .node-status-dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: #45e0a0;
      box-shadow: 0 0 14px rgba(69,224,160,.75);
      flex: 0 0 auto;
    }

    .node-status-dot.hazard {
      background: #ffbd5a;
      box-shadow: 0 0 14px rgba(255,189,90,.7);
    }

    .node-id {
      font-family: "Space Grotesk", sans-serif;
      font-size: 19px;
      font-weight: 700;
      letter-spacing: .02em;
      color: #eef6ff;
    }

    .node-area {
      margin-top: 2px;
      color: #71839b;
      font-size: 12px;
    }

    .node-ai-pill {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      padding: 0 10px;
      border-radius: 999px;
      border: 1px solid rgba(69,224,160,.2);
      background: rgba(69,224,160,.07);
      color: #55e3a4;
      font-size: 11px;
      font-weight: 700;
      white-space: nowrap;
    }

    .node-ai-pill.warn {
      border-color: rgba(255,193,87,.25);
      background: rgba(255,193,87,.07);
      color: #ffc45f;
    }

    .node-ai-pill.danger {
      border-color: rgba(255,105,105,.25);
      background: rgba(255,105,105,.07);
      color: #ff8585;
    }

    .node-card-divider {
      height: 1px;
      margin: 19px 0;
      background: rgba(130,155,180,.12);
    }

    .node-sensor-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .node-sensor {
      min-height: 82px;
      padding: 12px;
      border-radius: 12px;
      border: 1px solid rgba(120,150,180,.11);
      background: rgba(255,255,255,.025);
    }

    .sensor-label {
      display: block;
      margin-bottom: 6px;
      color: #71849c;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: .12em;
    }

    .node-sensor strong {
      display: block;
      color: #edf6ff;
      font-size: 17px;
      line-height: 1.15;
      font-weight: 700;
    }

    .node-sensor small {
      display: block;
      margin-top: 5px;
      color: #6e819a;
      font-size: 10px;
    }

    .node-card-footer {
      margin-top: 19px;
    }

    .risk-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 7px;
      color: #73869e;
      font-size: 11px;
    }

    .risk-title strong {
      color: #dce9f7;
      font-size: 12px;
    }

    .risk-track {
      width: 100%;
      height: 5px;
      overflow: hidden;
      border-radius: 99px;
      background: rgba(120,150,180,.13);
    }

    .risk-fill {
      height: 100%;
      border-radius: inherit;
      background: #45e0a0;
      box-shadow: 0 0 12px rgba(69,224,160,.35);
      transition: width .35s ease;
    }

    .risk-fill.warn {
      background: #ffc45f;
      box-shadow: 0 0 12px rgba(255,196,95,.3);
    }

    .risk-fill.danger {
      background: #ff7373;
      box-shadow: 0 0 12px rgba(255,115,115,.3);
    }

    .node-meta {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      margin-top: 10px;
      color: #53667e;
      font-size: 10px;
    }

    .node-meta span:last-child {
      color: #71869e;
    }

    .table-ai {
      display: inline-flex;
      align-items: center;
      padding: 5px 9px;
      border-radius: 999px;
      border: 1px solid rgba(69,224,160,.2);
      color: #55e3a4;
      background: rgba(69,224,160,.06);
      font-size: 10px;
      font-weight: 700;
    }

    .table-ai.warn {
      color: #ffc45f;
      border-color: rgba(255,196,95,.22);
      background: rgba(255,196,95,.06);
    }

    .table-ai.danger {
      color: #ff8585;
      border-color: rgba(255,115,115,.22);
      background: rgba(255,115,115,.06);
    }

    .table-wrap table td:first-child {
      white-space: nowrap;
    }

    .table-wrap table td:first-child small {
      display: inline-block;
      margin-left: 5px;
      color: #71839b;
      font-size: 10px;
    }

    .alert-empty {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 18px;
      border-radius: 12px;
      border: 1px solid rgba(69,224,160,.12);
      background: rgba(69,224,160,.035);
    }

    .alert-empty > span {
      display: grid;
      place-items: center;
      width: 30px;
      height: 30px;
      border-radius: 50%;
      color: #50dfa0;
      background: rgba(69,224,160,.08);
    }

    .alert-empty strong {
      display: block;
      color: #dceaf7;
      font-size: 13px;
    }

    .alert-empty small {
      display: block;
      margin-top: 3px;
      color: #71839b;
      font-size: 11px;
    }

    @media (max-width: 900px) {
      .node-sensor-grid {
        grid-template-columns: 1fr 1fr;
      }
    }

    @media (max-width: 560px) {
      .drishti-node-card {
        padding: 17px;
      }

      .node-sensor-grid {
        grid-template-columns: 1fr;
      }
    }
  `;

  document.head.appendChild(style);
}

/* =========================================================
   INIT
   ========================================================= */

async function init() {
  injectNodeCardStyles();

  setupChartSelector();

  setupRangeButtons();

  updateClock();

  await boot();

  connectWebSocket();

  /*
   * Polling remains enabled even when WebSocket
   * is available. This makes the prototype more
   * robust during gateway/backend reconnects.
   */
  setInterval(refreshLiveNodes, POLL_INTERVAL);

  renderAll();
}

/* =========================================================
   START
   ========================================================= */

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
