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

By default the dashboard is on port 3000 and only this computer can open it. Stop the server with `Ctrl+C`.

## System tray app (Windows)

The tray app puts a PC Live Dash icon in the notification area and gives you a settings window. Start it by double-clicking `tray.cmd`, or run:

```powershell
npm run tray
```

If the server is not already running, the tray app starts it in the background and stops it again when you choose **Quit**. If the Windows service is running, the tray app controls that instead.

Right-click the icon for the menu:

- **Open Dashboard** opens the dashboard in your browser. Double-clicking the icon does the same.
- **Settings...** opens the settings window.
- **Allow LAN access** is a quick on/off switch for access from other devices.
- **Copy LAN address** appears while LAN access is on.
- **Quit** closes the tray app.

The settings window has:

| Setting | What it does |
| --- | --- |
| Allow other devices on my network | Lets phones and other PCs on your network open the dashboard at the address shown. Off by default. |
| Port | The port the dashboard uses. Default 3000. |
| Start PC Live Dash when I sign in to Windows | Starts the tray app, and with it the server, at sign-in. |

Changes take effect straight away without restarting the server, and open dashboards reconnect on their own. If a new port is already taken, the server goes back to the previous one.

LAN access and the port are saved in `config.json` in the project folder, so they survive restarts and also apply to the Windows service. The startup option is saved in the current user's Windows `Run` registry key.

> **Note:** there is no authentication. With LAN access on, anyone on your network who can reach the port can see your process list, services and network addresses. Only turn it on for a network you trust. The first time it is turned on, Windows Firewall may ask whether to allow Node.js.

### Settings without the tray app

You can edit `config.json` by hand and restart the server:

```json
{
  "lanAccess": true,
  "port": 3000
}
```

The `HOST` and `PORT` environment variables override the saved settings, and the tray app shows those settings as fixed:

```powershell
$env:HOST = "0.0.0.0"; $env:PORT = 8080; npm start
```

## Running as a Windows service

Installing the service makes the dashboard start with Windows and keep running in the background.

1. Open PowerShell or Command Prompt **as Administrator**, go to the project folder and run:

   ```powershell
   node install-service.js
   ```

   This registers a service called **PC Live Dashboard Server** (`PCLiveDashboard`) and starts it. The dashboard is served on the port saved in `config.json`, or 3000 if none is saved. Windows may show a few permission prompts. The service wrapper and its logs are written to a `daemon/` folder inside the project.

2. To remove the service, again from an Administrator terminal:

   ```powershell
   node uninstall-service.js
   ```

You can also start, stop and restart the service from the Windows Services app (`services.msc`).

The service runs `server.js` from this folder, so keep the folder in place after installing. Use the tray app to change the port or LAN access while the service is running. A service cannot show a tray icon itself, so start the tray app separately with `tray.cmd`.

## Troubleshooting

Two small scripts help when a metric looks wrong:

```bash
node diagnose.js   # prints what systeminformation reports for CPU load, GPU and CPU temperature
node test-cpu.js   # prints overall and per-core CPU load once a second for five seconds
```

Common issues:

- **GPU shows N/A**: on NVIDIA cards, check that `nvidia-smi` runs from a terminal. For AMD and Intel, the server falls back to `gpu.ps1`, which needs PowerShell and the Windows GPU performance counters.
- **Port already in use**: another program is using the port. Pick a different one in the tray settings, in `config.json`, or with `PORT`.
- **Tray icon does not appear**: check the hidden icons arrow in the taskbar. The tray app needs Windows PowerShell, which ships with Windows.
- **Service install does nothing**: make sure the terminal is running as Administrator. If it reports that `node-windows` is missing, run `npm install` again.

## How accurate are the numbers

Most values are read directly from the system. A few are estimates, used when the hardware does not report a value. The dashboard marks these with "≈" or "est.":

- **CPU temperature** is estimated from CPU load when Windows does not expose a sensor reading, which is common without administrator rights.
- **CPU fan speed** is always an estimate derived from CPU temperature.
- **GPU fan RPM** is estimated from the fan percentage. The percentage itself is a real reading.
- **GPU power draw** is estimated from utilisation when `nvidia-smi` does not report it.

## How it works

`server.js` serves the `public/` folder with Express and pushes metrics to every connected browser over WebSocket in three tiers:

| Tier | Interval | Metrics |
| --- | --- | --- |
| Fast | 2 s | CPU load, memory, network throughput |
| Medium | 5 s | Processes, disk usage and I/O, GPU, CPU temperature and speed |
| Slow | 15 s | Battery, uptime, services |

Static details such as the CPU model, OS and network interfaces are sent once when a browser connects. Collection pauses when no browser is connected, so an idle service uses almost no CPU. Messages carry only the fields the dashboard shows, and a background browser tab skips rebuilding its tables until you return to it.

Chart.js is served from the installed npm package, so the dashboard works without internet. Only the fonts load from Google Fonts, and the page falls back to system fonts when offline.

## Project structure

```
server.js              Express + WebSocket server and metric collection
tray.ps1               System tray app with the settings window
tray.cmd               Double-click launcher for the tray app
config.json            Saved settings, created on first change (not committed)
lib/cpu-load.js        CPU load sampling
lib/settings.js        Saved settings and listening address rules
lib/parsers.js         Parsers for nvidia-smi and PowerShell output
test/                  Unit tests for lib/
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

## Development

```bash
npm test       # unit tests (Node's built-in test runner)
npm run lint   # ESLint, needs Node 20 or newer
```

## License

MIT
