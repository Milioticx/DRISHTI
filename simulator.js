const http = require("http");

const nodes = [
  {
    node_id: "N-01",
    gas_ppm: 42,
    gas_rate_ppm_s: 2.2,
    water_height_m: 0.63,
    water_rate_cm_min: 0.5,
    fire_temp_c: 27.8,
    temp_rate_c_min: 0.2,
    vibration_rms: 5,
    battery_pct: 94,
    rssi_dbm: -61,
    latency_ms: 31,
    ai_class: 0,
  },

  {
    node_id: "N-02",
    gas_ppm: 86,
    gas_rate_ppm_s: 6.4,
    water_height_m: 1.3,
    water_rate_cm_min: 2.8,
    fire_temp_c: 48.5,
    temp_rate_c_min: 1.4,
    vibration_rms: 6,
    battery_pct: 89,
    rssi_dbm: -71,
    latency_ms: 42,
    ai_class: 1,
  },

  {
    node_id: "N-03",
    gas_ppm: 310,
    gas_rate_ppm_s: 8.2,
    water_height_m: 0.71,
    water_rate_cm_min: 0.9,
    fire_temp_c: 40.5,
    temp_rate_c_min: 0.7,
    vibration_rms: 8,
    battery_pct: 91,
    rssi_dbm: -66,
    latency_ms: 37,
    ai_class: 2,
  },
];

const labels = ["NORMAL", "FLASH_FLOOD", "WILDFIRE", "GAS_LEAK"];

function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function postTelemetry(node) {
  const payload = {
    node_id: node.node_id,

    timestamp: new Date().toISOString(),

    gas_ppm: Number(node.gas_ppm.toFixed(1)),
    gas_rate_ppm_s: Number(node.gas_rate_ppm_s.toFixed(1)),

    water_height_m: Number(node.water_height_m.toFixed(3)),
    water_rate_cm_min: Number(node.water_rate_cm_min.toFixed(1)),

    fire_temp_c: Number(node.fire_temp_c.toFixed(1)),
    temp_rate_c_min: Number(node.temp_rate_c_min.toFixed(1)),

    vibration_rms: Number(node.vibration_rms.toFixed(1)),

    battery_pct: Number(node.battery_pct.toFixed(1)),
    rssi_dbm: Math.round(node.rssi_dbm),
    latency_ms: Math.round(node.latency_ms),

    ai_class: node.ai_class,
  };

  const data = JSON.stringify(payload);

  const req = http.request(
    {
      hostname: "localhost",
      port: 8080,
      path: "/api/telemetry",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    },
    (res) => {
      let response = "";

      res.on("data", (chunk) => {
        response += chunk;
      });

      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(
            `[SENT] ${node.node_id} | ` +
              `Gas ${payload.gas_ppm} ppm | ` +
              `Water ${payload.water_height_m} m | ` +
              `Temp ${payload.fire_temp_c} C | ` +
              `${labels[payload.ai_class]}`,
          );
        } else {
          console.log(
            `[ERROR] ${node.node_id} | HTTP ${res.statusCode} | ${response}`,
          );
        }
      });
    },
  );

  req.on("error", (error) => {
    console.error(`[CONNECTION ERROR] ${node.node_id}: ${error.message}`);
  });

  req.write(data);
  req.end();
}

function updateNode(node) {
  /*
   * GAS
   *
   * Small continuous variation.
   */
  node.gas_ppm += randomBetween(-2.5, 2.5);

  /*
   * Keep each node in its own realistic scenario range.
   */
  if (node.node_id === "N-01") {
    node.gas_ppm = clamp(node.gas_ppm, 35, 55);
  }

  if (node.node_id === "N-02") {
    node.gas_ppm = clamp(node.gas_ppm, 70, 110);
  }

  if (node.node_id === "N-03") {
    node.gas_ppm = clamp(node.gas_ppm, 280, 340);
  }

  /*
   * WATER
   *
   * Water changes more noticeably so that
   * the Live Nodes page visibly updates.
   */
  if (node.node_id === "N-01") {
    node.water_height_m += randomBetween(-0.015, 0.025);
    node.water_height_m = clamp(node.water_height_m, 0.55, 1.1);

    node.water_rate_cm_min = randomBetween(0.2, 0.8);
  }

  if (node.node_id === "N-02") {
    node.water_height_m += randomBetween(0.015, 0.045);
    node.water_height_m = clamp(node.water_height_m, 1.2, 2.0);

    node.water_rate_cm_min = randomBetween(2.2, 3.5);
  }

  if (node.node_id === "N-03") {
    node.water_height_m += randomBetween(-0.015, 0.025);
    node.water_height_m = clamp(node.water_height_m, 0.6, 1.2);

    node.water_rate_cm_min = randomBetween(0.5, 1.2);
  }

  /*
   * TEMPERATURE
   */
  if (node.node_id === "N-01") {
    node.fire_temp_c += randomBetween(-0.25, 0.35);
    node.fire_temp_c = clamp(node.fire_temp_c, 25, 35);

    node.temp_rate_c_min = randomBetween(0.1, 0.4);
  }

  if (node.node_id === "N-02") {
    node.fire_temp_c += randomBetween(-0.2, 0.4);
    node.fire_temp_c = clamp(node.fire_temp_c, 45, 55);

    node.temp_rate_c_min = randomBetween(1.0, 1.8);
  }

  if (node.node_id === "N-03") {
    node.fire_temp_c += randomBetween(-0.3, 0.45);
    node.fire_temp_c = clamp(node.fire_temp_c, 38, 48);

    node.temp_rate_c_min = randomBetween(0.5, 1.0);
  }

  /*
   * GAS RATE
   */
  node.gas_rate_ppm_s += randomBetween(-0.4, 0.4);

  if (node.node_id === "N-01") {
    node.gas_rate_ppm_s = clamp(node.gas_rate_ppm_s, 1.0, 3.5);
  }

  if (node.node_id === "N-02") {
    node.gas_rate_ppm_s = clamp(node.gas_rate_ppm_s, 5.0, 8.0);
  }

  if (node.node_id === "N-03") {
    node.gas_rate_ppm_s = clamp(node.gas_rate_ppm_s, 7.0, 10.0);
  }

  /*
   * VIBRATION
   */
  node.vibration_rms += randomBetween(-0.4, 0.4);
  node.vibration_rms = clamp(node.vibration_rms, 3, 12);

  /*
   * NETWORK
   */
  node.latency_ms = Math.round(randomBetween(28, 50));

  node.rssi_dbm += randomBetween(-1.5, 1.5);
  node.rssi_dbm = clamp(node.rssi_dbm, -85, -50);

  /*
   * BATTERY
   *
   * Very slow decrease.
   */
  node.battery_pct -= randomBetween(0.001, 0.01);
  node.battery_pct = clamp(node.battery_pct, 70, 100);
}

console.log("");
console.log("==============================================");
console.log(" DRISHTI LIVE TELEMETRY SIMULATOR");
console.log("==============================================");
console.log("Backend: http://localhost:8080");
console.log("Interval: 2 seconds");
console.log("Nodes: N-01, N-02, N-03");
console.log("==============================================");
console.log("");

function sendAllNodes() {
  nodes.forEach((node) => {
    updateNode(node);

    postTelemetry(node);
  });
}

sendAllNodes();

setInterval(sendAllNodes, 2000);
