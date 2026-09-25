# DRISHTI — SIH26178 · Complete Working System

STM32 edge node → nRF24 → STM32 hub → USB/UART → Node backend (SQLite) → WebSocket → Dashboard

## Run
```
npm install
npm start            # http://localhost:8080
```
Then choose ONE data source:

| Source | How |
|---|---|
| **Backend reads the hub** (recommended for demo day) | Windows: `set DRISHTI_UART_PORT=COM5` · Linux/Mac: `DRISHTI_UART_PORT=/dev/ttyACM0 npm start` |
| **Browser reads the hub** (no COM config) | Open http://localhost:8080 in Chrome/Edge → **Connect Gateway (USB)**. Frames are saved to the DB automatically. |
| **No hardware** | `npm run simulate` in a 2nd terminal, or click **Demo mode** on any page |

Only one program can own the COM port: use either the backend or the browser button, not both.

## Frame (21 B, little-endian, 115200 baud) — matches shared_protocol.h / TelemetryFrame_t
`AA | node u8 | seq u32 | water mm i16 | surge mm/s i16 | gas ppm i16 | gas rate i16 | temp °C i16 | vibration i16 | class u8 | sum16 u16`
Class: 0 NORMAL · 1 FLASH FLOOD · 2 WILDFIRE · 3 GAS LEAK
Decoded identically in `server.js` (Node) and `frontend/core.js` (browser) — both compute the same sum-16 checksum over the first 19 bytes.

## Pages
- `frontend/index.html` — Command Center: live status, 6 metric tiles, combined chart, node list, alert log, raw frame view.
- `frontend/nodes.html` — Node Status: one animated card per node — gauges, all 6 readings, mini trend, link-quality bar, live advisory.
- `frontend/analytics.html` — Analytics: per-node history trend, peak-reading comparison bars, hazard-class distribution, full incident timeline.
- `frontend/legacy/` — earlier 3-page UI, kept at `/legacy/index.html`.

`core.js` holds the shared frame decoder, state store, backend/WebSocket link and chart/gauge drawing — all three pages import it so they never drift from the hardware protocol or from each other.

## Hosting (public URL + live browser hardware hookup)
1. Push this folder to a GitHub repo (`.gitignore` already excludes `node_modules/` and `data/`).
2. On render.com → **New → Blueprint** → point at the repo. `render.yaml` configures the service (build: `npm install`, start: `npm start`, free plan).
3. Render gives you an HTTPS URL. Leave `DRISHTI_UART_PORT` unset — the cloud server has no USB port, so this only works via **Path B**: on demo day, open the URL in Chrome/Edge on the laptop physically wired to the gateway and click **Connect Gateway (USB)**. Your browser reads the serial port and POSTs frames to the hosted backend, which broadcasts them over WebSocket to everyone else viewing the same URL.
4. Free-tier services sleep after ~15 min idle (first request after that takes 30–60s) and their filesystem resets on redeploy, so `data/drishti.db` won't persist long-term unless you add a paid disk (see the commented `disk:` block in `render.yaml`).
5. Test with two devices before presenting: hardware connected on one, the hosted URL open on another, confirm the second updates live.

## Layout
`server.js` API+WS+UART · `ml/` training scripts · `firmware/hazard_model.h`
Delete `data/` to reset the database.
