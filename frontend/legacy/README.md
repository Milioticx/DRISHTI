# DRISHTI SIH 2026 Dashboard

A polished 3-page front-end prototype for the DRISHTI disaster-recognition system shown in the SIH presentation.

## Pages
- `index.html` — Command Center: live aggregated gas, flood water, water rise rate, temperature, temperature rate, alerts and node status.
- `nodes.html` — Live Nodes: detailed readings for all 3 nodes and a sensor matrix.
- `analytics.html` — Analytics & Response: risk index, rate-of-change chart and incident/response timeline.

## Run
Open `index.html` in a browser, or serve the folder with a simple local server:

```bash
python -m http.server 8000
```
Then visit `http://localhost:8000`.

## Connecting the real STM32 / LoRa gateway
The current `app.js` intentionally simulates telemetry every 2 seconds so the UI is immediately demo-ready. Replace `simulate()` with your actual transport layer. A convenient payload from your gateway is:

```json
{
  "node_id": "N-02",
  "timestamp": "2026-09-24T02:38:12Z",
  "gas_ppm": 86,
  "water_height_m": 0.84,
  "water_rate_cm_min": 2.8,
  "fire_temp_c": 48.6,
  "temp_rate_c_min": 1.4,
  "battery_pct": 89,
  "rssi_dbm": -71
}
```

Then feed each message into the `state.nodes` object and update the history arrays. The UI does not require a backend to demonstrate the concept.

## Design direction
Dark emergency-command UI, cyan/green telemetry accents, compact cards, 3-node mesh visualization, edge-AI terminology, and terminology aligned to the provided DRISHTI / SIH presentation.
