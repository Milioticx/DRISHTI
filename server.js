// ============================================================
// DRISHTI BACKEND
// ============================================================

const express = require("express");
const cors = require("cors");
const http = require("http");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const { WebSocketServer } = require("ws");
const { SerialPort } = require("serialport");

// ============================================================
// APP SETUP
// ============================================================

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8080;

// ============================================================
// UART CONFIGURATION
// ============================================================

const UART_FRAME_SIZE = 21;
const UART_SYNC_BYTE = 0xaa;
const UART_BAUD_RATE = 115200;

// Leave empty while using simulator/debug testing.
// Example when hardware is connected:
// DRISHTI_UART_PORT=COM5
const UART_PORT_PATH = process.env.DRISHTI_UART_PORT || "";

const DEBUG_UART = process.env.DRISHTI_DEBUG_UART === "true";

// ============================================================
// HAZARD CLASSES
// ============================================================

const CLASSES = ["NORMAL", "FLASH_FLOOD", "WILDFIRE", "GAS_LEAK"];

// Hardware protocol terminology
const HARDWARE_HAZARD_LABELS = ["NORMAL", "FLOOD", "WILDFIRE", "TOXIC_GAS"];

// ============================================================
// NODE AREAS
// ============================================================

const AREAS = {
  "N-01": "North zone",
  "N-02": "Central zone",
  "N-03": "South zone",
};

// ============================================================
// DATABASE
// ============================================================

const dataDir = path.join(__dirname, "data");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, {
    recursive: true,
  });
}

const dbPath = path.join(dataDir, "drishti.db");

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS nodes (
    node_id TEXT PRIMARY KEY,
    area TEXT,
    status TEXT DEFAULT 'OFFLINE',
    last_seen TEXT,
    battery REAL,
    rssi REAL,
    latency_ms REAL
  );

  CREATE TABLE IF NOT EXISTS telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    node_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,

    gas_ppm REAL,
    gas_rate_ppm_s REAL,

    water_height_m REAL,
    water_rate_cm_min REAL,

    fire_temp_c REAL,
    temp_rate_c_min REAL,

    vibration_rms REAL,

    ai_class INTEGER,
    ai_label TEXT,

    battery REAL,
    rssi REAL,
    latency_ms REAL
  );

  CREATE INDEX IF NOT EXISTS
  idx_telemetry_node_time
  ON telemetry(node_id, timestamp);

  CREATE INDEX IF NOT EXISTS
  idx_telemetry_time
  ON telemetry(timestamp);
`);

// ============================================================
// DATABASE STATEMENTS
// ============================================================

const insertTelemetryStmt = db.prepare(`
    INSERT INTO telemetry (
      node_id,
      timestamp,

      gas_ppm,
      gas_rate_ppm_s,

      water_height_m,
      water_rate_cm_min,

      fire_temp_c,
      temp_rate_c_min,

      vibration_rms,

      ai_class,
      ai_label,

      battery,
      rssi,
      latency_ms
    )
    VALUES (
      @node_id,
      @timestamp,

      @gas_ppm,
      @gas_rate_ppm_s,

      @water_height_m,
      @water_rate_cm_min,

      @fire_temp_c,
      @temp_rate_c_min,

      @vibration_rms,

      @ai_class,
      @ai_label,

      @battery,
      @rssi,
      @latency_ms
    )
  `);

const upsertNodeStmt = db.prepare(`
    INSERT INTO nodes (
      node_id,
      area,
      status,
      last_seen,
      battery,
      rssi,
      latency_ms
    )
    VALUES (
      @node_id,
      @area,
      @status,
      @last_seen,
      @battery,
      @rssi,
      @latency_ms
    )

    ON CONFLICT(node_id)
    DO UPDATE SET

      area =
        excluded.area,

      status =
        excluded.status,

      last_seen =
        excluded.last_seen,

      battery =
        excluded.battery,

      rssi =
        excluded.rssi,

      latency_ms =
        excluded.latency_ms
  `);

// ============================================================
// WEBSOCKET
// ============================================================

const wss = new WebSocketServer({
  noServer: true,
});

// ============================================================
// UART STATE
// ============================================================

let uartPort = null;

let uartBuffer = Buffer.alloc(0);

const lastUartTemperature = new Map();

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function classLabel(code) {
  const n = Number(code);

  if (Number.isInteger(n) && CLASSES[n]) {
    return CLASSES[n];
  }

  return CLASSES[0];
}

// ------------------------------------------------------------

function normalize(body) {
  const aiClass = Number.isInteger(body.ai_class) ? body.ai_class : 0;

  return {
    node_id: String(body.node_id || "N-01"),

    timestamp: body.timestamp || new Date().toISOString(),

    gas_ppm: Number(body.gas_ppm || 0),

    gas_rate_ppm_s: Number(body.gas_rate_ppm_s || 0),

    water_height_m: Number(body.water_height_m || 0),

    water_rate_cm_min: Number(body.water_rate_cm_min || 0),

    fire_temp_c: Number(body.fire_temp_c || 0),

    temp_rate_c_min: Number(body.temp_rate_c_min || 0),

    vibration_rms: Number(body.vibration_rms || 0),

    ai_class: aiClass,

    ai_label: body.ai_label || classLabel(aiClass),

    battery: body.battery == null ? null : Number(body.battery),

    rssi: body.rssi == null ? null : Number(body.rssi),

    latency_ms: body.latency_ms == null ? null : Number(body.latency_ms),
  };
}

// ------------------------------------------------------------

function broadcast(message) {
  const payload = JSON.stringify(message);

  for (const client of wss.clients) {
    if (client.readyState === 1) {
      try {
        client.send(payload);
      } catch (err) {
        console.error("[WS] Send error:", err.message);
      }
    }
  }
}

// ------------------------------------------------------------

function upsertNode(data) {
  upsertNodeStmt.run({
    node_id: data.node_id,

    area: AREAS[data.node_id] || "Unknown zone",

    status: "ONLINE",

    last_seen: data.timestamp,

    battery: data.battery,

    rssi: data.rssi,

    latency_ms: data.latency_ms,
  });
}

// ------------------------------------------------------------

function insertTelemetry(data) {
  insertTelemetryStmt.run(data);
}

// ------------------------------------------------------------

function ingest(body, source = "api") {
  const data = normalize(body);

  upsertNode(data);

  insertTelemetry(data);

  broadcast({
    type: "telemetry",
    source,
    data,
  });

  return data;
}

// ============================================================
// UART FRAME DECODER
// ============================================================

function decodeUartFrame(frame) {
  if (!Buffer.isBuffer(frame)) {
    throw new Error("Frame must be a Buffer");
  }

  if (frame.length !== UART_FRAME_SIZE) {
    throw new Error(
      `Invalid frame length: ${frame.length}, expected ${UART_FRAME_SIZE}`,
    );
  }

  if (frame[0] !== UART_SYNC_BYTE) {
    throw new Error(
      `Invalid sync byte: 0x${frame[0].toString(16).padStart(2, "0")}`,
    );
  }

  // ----------------------------------------------------------
  // CHECKSUM
  // ----------------------------------------------------------

  let calculatedChecksum = 0;

  for (let i = 0; i < 19; i++) {
    calculatedChecksum += frame[i];
  }

  calculatedChecksum &= 0xffff;

  const receivedChecksum = frame.readUInt16LE(19);

  if (calculatedChecksum !== receivedChecksum) {
    throw new Error(
      `Checksum mismatch: calculated=${calculatedChecksum}, received=${receivedChecksum}`,
    );
  }

  // ----------------------------------------------------------
  // DECODE FRAME
  // ----------------------------------------------------------

  const nodeNumber = frame.readUInt8(1);

  const nodeId = `N-${String(nodeNumber).padStart(2, "0")}`;

  const seqNum = frame.readUInt32LE(2);

  const waterMm = frame.readInt16LE(6);

  const waterSurgeMmS = frame.readInt16LE(8);

  const gasPpm = frame.readInt16LE(10);

  const gasRatePpmS = frame.readInt16LE(12);

  const temperatureC = frame.readInt16LE(14);

  const vibrationRms = frame.readInt16LE(16);

  const hazardCode = frame.readUInt8(18);

  // ----------------------------------------------------------
  // TEMPERATURE RATE
  // ----------------------------------------------------------

  const now = Date.now();

  let tempRateCMin = 0;

  const previous = lastUartTemperature.get(nodeId);

  if (previous) {
    const elapsedSeconds = (now - previous.timestamp) / 1000;

    if (elapsedSeconds > 0) {
      tempRateCMin =
        ((temperatureC - previous.temperatureC) / elapsedSeconds) * 60;
    }
  }

  lastUartTemperature.set(nodeId, {
    temperatureC,
    timestamp: now,
  });

  // ----------------------------------------------------------
  // RETURN NORMALIZED DATA
  // ----------------------------------------------------------

  return {
    node_id: nodeId,

    seq_num: seqNum,

    timestamp: new Date().toISOString(),

    gas_ppm: gasPpm,

    gas_rate_ppm_s: gasRatePpmS,

    water_height_m: waterMm / 1000,

    water_rate_cm_min: waterSurgeMmS * 6,

    fire_temp_c: temperatureC,

    temp_rate_c_min: tempRateCMin,

    vibration_rms: vibrationRms,

    ai_class: hazardCode,

    ai_label: classLabel(hazardCode),

    battery: null,

    rssi: null,

    latency_ms: null,
  };
}

// ============================================================
// UART BUFFER PROCESSOR
// ============================================================

function processUartData(chunk) {
  if (!Buffer.isBuffer(chunk)) {
    chunk = Buffer.from(chunk);
  }

  uartBuffer = Buffer.concat([uartBuffer, chunk]);

  while (uartBuffer.length >= UART_FRAME_SIZE) {
    const syncIndex = uartBuffer.indexOf(UART_SYNC_BYTE);

    if (syncIndex === -1) {
      uartBuffer = uartBuffer.subarray(Math.max(0, uartBuffer.length - 1));

      return;
    }

    if (syncIndex > 0) {
      uartBuffer = uartBuffer.subarray(syncIndex);
    }

    if (uartBuffer.length < UART_FRAME_SIZE) {
      return;
    }

    const frame = uartBuffer.subarray(0, UART_FRAME_SIZE);

    try {
      const decoded = decodeUartFrame(frame);

      ingest(decoded, "uart-gateway");

      console.log(
        `[UART] ${decoded.node_id}` +
          ` seq=${decoded.seq_num}` +
          ` water=${decoded.water_height_m.toFixed(3)}m` +
          ` gas=${decoded.gas_ppm}ppm` +
          ` temp=${decoded.fire_temp_c}C` +
          ` hazard=${decoded.ai_label}`,
      );

      uartBuffer = uartBuffer.subarray(UART_FRAME_SIZE);
    } catch (err) {
      console.error(`[UART] Invalid frame: ${err.message}`);

      // Move forward by one byte
      // and try to recover sync.
      uartBuffer = uartBuffer.subarray(1);
    }
  }
}

// ============================================================
// UART CONNECTION
// ============================================================

function connectUart() {
  if (!UART_PORT_PATH) {
    console.log(
      "[UART] Disabled. Set DRISHTI_UART_PORT when STM32 hardware is connected.",
    );

    return;
  }

  console.log(`[UART] Opening ${UART_PORT_PATH} @ ${UART_BAUD_RATE} baud`);

  try {
    uartPort = new SerialPort({
      path: UART_PORT_PATH,

      baudRate: UART_BAUD_RATE,

      dataBits: 8,

      stopBits: 1,

      parity: "none",

      rtscts: false,

      autoOpen: false,
    });

    uartPort.on("data", (chunk) => {
      processUartData(chunk);
    });

    uartPort.on("error", (err) => {
      console.error("[UART] Error:", err.message);
    });

    uartPort.on("close", () => {
      console.log("[UART] Port closed. Reconnecting in 2 seconds...");

      setTimeout(() => connectUart(), 2000);
    });

    uartPort.open((err) => {
      if (err) {
        console.error("[UART] Open failed:", err.message);

        setTimeout(() => connectUart(), 2000);

        return;
      }

      console.log(`[UART] Connected to ${UART_PORT_PATH}`);
    });
  } catch (err) {
    console.error("[UART] Connection error:", err.message);

    setTimeout(() => connectUart(), 2000);
  }
}

// ============================================================
// UART DEBUG - RAW HEX
// ============================================================

app.post("/api/debug/uart-hex", (req, res) => {
  if (!DEBUG_UART) {
    return res.status(404).json({
      error: "UART debug disabled",
    });
  }

  try {
    const hex = String(req.body.hex || "").replace(/\s+/g, "");

    if (!hex) {
      return res.status(400).json({
        error: "hex is required",
      });
    }

    if (!/^[0-9a-fA-F]+$/.test(hex)) {
      return res.status(400).json({
        error: "hex contains invalid characters",
      });
    }

    if (hex.length % 2 !== 0) {
      return res.status(400).json({
        error: "hex must contain an even number of characters",
      });
    }

    const frame = Buffer.from(hex, "hex");

    processUartData(frame);

    res.json({
      ok: true,
      bytes_received: frame.length,
    });
  } catch (err) {
    console.error("[UART DEBUG]", err.message);

    res.status(400).json({
      ok: false,
      error: err.message,
    });
  }
});

// ============================================================
// UART DEBUG - AUTOMATIC FRAME GENERATOR
// ============================================================

app.post("/api/debug/uart-frame", (req, res) => {
  if (!DEBUG_UART) {
    return res.status(404).json({
      error: "UART debug disabled",
    });
  }

  try {
    const {
      node_id = 1,

      seq_num = 1,

      water_mm = 0,

      water_surge_mm_s = 0,

      gas_ppm = 0,

      gas_rate_ppm_s = 0,

      temp_c = 25,

      vibration_rms = 0,

      hazard_code = 0,
    } = req.body;

    const frame = Buffer.alloc(UART_FRAME_SIZE);

    // --------------------------------------------------------
    // FRAME FIELDS
    // --------------------------------------------------------

    frame[0] = UART_SYNC_BYTE;

    frame[1] = Number(node_id);

    frame.writeUInt32LE(Number(seq_num), 2);

    frame.writeInt16LE(Number(water_mm), 6);

    frame.writeInt16LE(Number(water_surge_mm_s), 8);

    frame.writeInt16LE(Number(gas_ppm), 10);

    frame.writeInt16LE(Number(gas_rate_ppm_s), 12);

    frame.writeInt16LE(Number(temp_c), 14);

    frame.writeInt16LE(Number(vibration_rms), 16);

    frame[18] = Number(hazard_code);

    // --------------------------------------------------------
    // CHECKSUM
    // --------------------------------------------------------

    let checksum = 0;

    for (let i = 0; i < 19; i++) {
      checksum += frame[i];
    }

    checksum &= 0xffff;

    frame.writeUInt16LE(checksum, 19);

    // Feed generated frame
    // through real UART decoder.
    processUartData(frame);

    res.json({
      ok: true,

      checksum,

      checksum_hex: checksum.toString(16).padStart(4, "0").toUpperCase(),

      hex: frame.toString("hex").toUpperCase(),

      bytes: Array.from(frame),
    });
  } catch (err) {
    console.error("[UART DEBUG]", err.message);

    res.status(400).json({
      ok: false,
      error: err.message,
    });
  }
});

// ============================================================
// HEALTH
// ============================================================

app.get("/health", (req, res) => {
  res.json({
    ok: true,

    service: "DRISHTI backend",

    timestamp: new Date().toISOString(),

    uart: {
      enabled: Boolean(UART_PORT_PATH),

      port: UART_PORT_PATH || null,

      baud_rate: UART_BAUD_RATE,
    },
  });
});

// ============================================================
// API - NODES
// ============================================================

app.get("/api/nodes", (req, res) => {
  const nodes = db
    .prepare(
      `
        SELECT *
        FROM nodes
        ORDER BY node_id
      `,
    )
    .all();

  res.json(nodes);
});

// ============================================================
// API - LATEST TELEMETRY
// ============================================================

app.get("/api/telemetry/latest", (req, res) => {
  const rows = db
    .prepare(
      `
        SELECT *
        FROM telemetry
        WHERE id IN (
          SELECT MAX(id)
          FROM telemetry
          GROUP BY node_id
        )
        ORDER BY node_id
      `,
    )
    .all();

  res.json(rows);
});

// ============================================================
// API - HISTORY
// ============================================================

app.get("/api/telemetry/history", (req, res) => {
  const nodeId = req.query.node_id;

  const limit = Math.min(Number(req.query.limit || 100), 5000);

  let rows;

  if (nodeId) {
    rows = db
      .prepare(
        `
          SELECT *
          FROM telemetry
          WHERE node_id = ?
          ORDER BY id DESC
          LIMIT ?
        `,
      )
      .all(nodeId, limit);
  } else {
    rows = db
      .prepare(
        `
          SELECT *
          FROM telemetry
          ORDER BY id DESC
          LIMIT ?
        `,
      )
      .all(limit);
  }

  res.json(rows.reverse());
});

// ============================================================
// API - ALERTS
// ============================================================

app.get("/api/alerts", (req, res) => {
  const limit = Math.min(Number(req.query.limit || 50), 500);

  const alerts = db
    .prepare(
      `
        SELECT *
        FROM telemetry
        WHERE ai_class != 0
        ORDER BY id DESC
        LIMIT ?
      `,
    )
    .all(limit);

  res.json(alerts);
});

// ============================================================
// API - POST TELEMETRY
// ============================================================

app.post("/api/telemetry", (req, res) => {
  try {
    const data = ingest(req.body, "api");

    res.json({
      ok: true,
      data,
    });
  } catch (err) {
    console.error("[API] telemetry error:", err.message);

    res.status(400).json({
      ok: false,
      error: err.message,
    });
  }
});

// ============================================================
// API - BATCH TELEMETRY
// ============================================================

app.post("/api/telemetry/batch", (req, res) => {
  try {
    const items = Array.isArray(req.body) ? req.body : req.body.items;

    if (!Array.isArray(items)) {
      return res.status(400).json({
        ok: false,
        error: "Expected an array of telemetry objects",
      });
    }

    const results = [];

    for (const item of items) {
      results.push(ingest(item, "api-batch"));
    }

    res.json({
      ok: true,

      count: results.length,

      data: results,
    });
  } catch (err) {
    console.error("[API] batch error:", err.message);

    res.status(400).json({
      ok: false,
      error: err.message,
    });
  }
});

// ============================================================
// NODE OFFLINE MONITOR
// ============================================================

setInterval(() => {
  const cutoff = Date.now() - 30000;

  const nodes = db
    .prepare(
      `
        SELECT
          node_id,
          last_seen
        FROM nodes
      `,
    )
    .all();

  for (const node of nodes) {
    if (!node.last_seen) {
      continue;
    }

    const lastSeen = new Date(node.last_seen).getTime();

    if (lastSeen < cutoff) {
      db.prepare(
        `
          UPDATE nodes
          SET status = 'OFFLINE'
          WHERE node_id = ?
        `,
      ).run(node.node_id);

      broadcast({
        type: "node_status",

        node_id: node.node_id,

        status: "OFFLINE",
      });
    }
  }
}, 5000);

// ============================================================
// WEBSOCKET UPGRADE
// ============================================================

server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`)
    .pathname;

  if (pathname !== "/ws") {
    socket.destroy();

    return;
  }

  wss.handleUpgrade(request, socket, head, (websocket) => {
    wss.emit("connection", websocket, request);
  });
});

// ============================================================
// WEBSOCKET CONNECTION
// ============================================================

wss.on("connection", (ws) => {
  console.log("[WS] Client connected");

  ws.send(
    JSON.stringify({
      type: "connection",

      status: "connected",

      timestamp: new Date().toISOString(),
    }),
  );

  ws.on("close", () => {
    console.log("[WS] Client disconnected");
  });
});

// ============================================================
// SERVE FRONTEND
// ============================================================
//
// IMPORTANT:
// Your website files are inside:
// D:\DRISHTI\full\frontend
//
// So Express must serve that folder.
// ============================================================

app.use(express.static(path.join(__dirname, "frontend")));

// Root URL:
// http://localhost:8080/

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "frontend", "index.html"));
});

// ============================================================
// START SERVER
// ============================================================

server.listen(PORT, () => {
  console.log(`DRISHTI backend listening on http://localhost:${PORT}`);

  connectUart();
});

// ============================================================
// SHUTDOWN
// ============================================================

function shutdown() {
  console.log("\n[SERVER] Shutting down...");

  try {
    if (uartPort && uartPort.isOpen) {
      uartPort.close();
    }
  } catch (err) {
    console.error("[UART] Close error:", err.message);
  }

  try {
    db.close();
  } catch (err) {
    console.error("[DB] Close error:", err.message);
  }

  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);

process.on("SIGTERM", shutdown);
