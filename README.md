# PC Live Dash

A real-time PC hardware monitoring dashboard that runs in your browser. A small Node.js server reads system metrics and streams them over WebSocket to a single-page front end with live gauges, charts and tables.

It is built for Windows first (GPU and disk I/O use Windows-specific fallbacks, and it can run as a Windows service), but the core metrics also work on Linux and macOS.

## What it shows

- **CPU**: overall and per-core load, model, core and thread counts, current speed, temperature
- **Memory**: RAM and swap usage
- **GPU**: utilisation, VRAM, temperature, fan speed and power draw per adapter
- **Disks**: usage per volume, read and write speeds
- **Network**: interfaces and live upload and download rates
- **Processes and services**: sortable, searchable tables, plus a "running apps" list
- **Battery and uptime**

The layout is customisable from the settings sidebar: cards can be dragged, resized, hidden, grouped and locked. Layout preferences are saved in the browser's `localStorage`.

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer
- Windows 10 or 11 for the full feature set
- Optional: an NVIDIA GPU with `nvidia-smi` on the `PATH` for detailed GPU stats
- An internet connection in the browser, because Chart.js and the fonts load from a CDN

## Setup

```bash
git clone https://github.com/harikiran-lab/PC-Live-Dash.git
cd PC-Live-Dash
npm install
```

## Running

```bash
npm start
```

Then open <http://localhost:3000>.

To use a different port, set the `PORT` environment variable:

```powershell
# PowerShell
$env:PORT = 8080; npm start
```

```bash
# bash
PORT=8080 npm start
```

Stop the server with `Ctrl+C`.

> **Note:** the server listens on all network interfaces and has no authentication, so anyone on your network who can reach the port can see your process list, services, hardware details and network addresses. Run it only on a network you trust, or block the port in your firewall.

## Running as a Windows service

Installing the service makes the dashboard start with Windows and keep running in the background.

1. Install the service helper. It is not listed in `package.json`, so it needs installing once:

   ```powershell
   npm install node-windows
   ```

2. Open PowerShell or Command Prompt **as Administrator**, go to the project folder and run:

   ```powershell
   node install-service.js
   ```

   This registers a service called **PC Live Dashboard Server** (`PCLiveDashboard`), starts it, and serves the dashboard on port 3000. Windows may show a few permission prompts. The service wrapper and its logs are written to a `daemon/` folder inside the project.

3. To remove the service, again from an Administrator terminal:

   ```powershell
   node uninstall-service.js
   ```

You can also start, stop and restart the service from the Windows Services app (`services.msc`).

The service runs `server.js` from this folder, so keep the folder in place after installing. To change the port, edit the `PORT` value in `install-service.js`, then uninstall and reinstall the service.

## Troubleshooting

Two small scripts help when a metric looks wrong:

```bash
node diagnose.js   # prints what systeminformation reports for CPU load, GPU and CPU temperature
node test-cpu.js   # prints overall and per-core CPU load once a second for five seconds
```

Common issues:

- **GPU shows N/A**: on NVIDIA cards, check that `nvidia-smi` runs from a terminal. For AMD and Intel, the server falls back to `gpu.ps1`, which needs PowerShell and the Windows GPU performance counters.
- **Port already in use**: another program is using port 3000. Set a different `PORT`.
- **Service install does nothing**: make sure the terminal is running as Administrator and that `node-windows` is installed.

## How accurate are the numbers

Most values are read directly from the system. A few are estimates, used when the hardware does not report a value:

- **CPU temperature** is estimated from CPU load when Windows does not expose a sensor reading, which is common without administrator rights.
- **CPU fan speed** is always an estimate derived from CPU temperature.
- **GPU fan RPM** is estimated from the fan percentage.
- **GPU power draw** is estimated from utilisation when `nvidia-smi` does not report it.

## How it works

`server.js` serves the `public/` folder with Express and pushes metrics to every connected browser over WebSocket in three tiers:

| Tier | Interval | Metrics |
| --- | --- | --- |
| Fast | 2 s | CPU load, memory, network throughput |
| Medium | 5 s | Processes, disk usage and I/O, GPU, CPU temperature and speed |
| Slow | 15 s | Battery, uptime, services |

Static details such as the CPU model, OS and network interfaces are sent once when a browser connects.

## Project structure

```
server.js              Express + WebSocket server and metric collection
gpu.ps1                PowerShell fallback for GPU utilisation and VRAM (AMD, Intel)
install-service.js     Registers the Windows service
uninstall-service.js   Removes the Windows service
diagnose.js            Prints raw CPU, GPU and temperature readings
test-cpu.js            Prints CPU load samples
public/
  index.html           Dashboard page
  app.js               WebSocket client, rendering, layout and settings
  charts.js            Chart.js setup and formatting helpers
  particles.js         Animated background
  styles.css           Styles
```

## License

MIT
