/**
 * PC Live Dashboard – Chart Configuration & Management
 *
 * Loaded in the browser AFTER Chart.js. Provides:
 *  - Global Chart.js defaults (dark-theme styling)
 *  - RollingBuffer for time-series data
 *  - Factory functions for each chart type
 *  - Update functions for each chart type
 *  - A center-text plugin for doughnut charts
 *  - Formatting utilities (bytes, speed, uptime, percent)
 *
 * Everything is exposed via `window.DashCharts`.
 */

(function () {
  'use strict';

  // ─── Chart.js Global Defaults ───────────────────────────────────────────────

  Chart.defaults.color = '#94a3b8';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
  Chart.defaults.font.family = "'Inter', sans-serif";
  Chart.defaults.animation.duration = 500;
  Chart.defaults.responsive = true;
  Chart.defaults.maintainAspectRatio = false;

  // ─── Center Text Plugin ─────────────────────────────────────────────────────

  /**
   * Draws a percentage string in the centre of a doughnut chart.
   * Attach `centerText` in the chart's `options.plugins` to configure:
   *   { display: true, text: '72%' }
   */
  const centerTextPlugin = {
    id: 'centerText',
    beforeDraw(chart) {
      const opts = chart.options.plugins.centerText;
      if (!opts || !opts.display) return;

      const { ctx, chartArea: { top, bottom, left, right } } = chart;
      const centerX = (left + right) / 2;
      const centerY = (top + bottom) / 2;
      const text = opts.text || '';

      ctx.save();

      // Large percentage value
      ctx.font = `bold 22px 'JetBrains Mono', monospace`;
      ctx.fillStyle = '#e2e8f0'; // text-primary
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, centerX, centerY);

      ctx.restore();
    },
  };

  // Register the plugin globally so every chart has access
  Chart.register(centerTextPlugin);

  // ─── Rolling Buffer ─────────────────────────────────────────────────────────

  /**
   * A fixed-size FIFO buffer for time-series chart data.
   * Once full, the oldest value is dropped when a new one is pushed.
   */
  class RollingBuffer {
    /**
     * @param {number} maxLength - Maximum number of data points to retain.
     */
    constructor(maxLength = 60) {
      this._maxLength = maxLength;
      this._data = [];
    }

    /** Add a value, evicting the oldest entry if at capacity. */
    push(value) {
      this._data.push(value);
      if (this._data.length > this._maxLength) {
        this._data.shift();
      }
    }

    /** Return a shallow copy of the internal array. */
    getAll() {
      return this._data.slice();
    }

    /** Return the most recently pushed value, or undefined. */
    getLast() {
      return this._data[this._data.length - 1];
    }

    /**
     * Return an array of empty strings matching the current data length.
     * Used as x-axis labels when you want grid lines but no text.
     */
    getLabels() {
      return this._data.map(() => '');
    }
  }

  // ─── Formatting Utilities ───────────────────────────────────────────────────

  /**
   * Format a byte count into a human-readable string.
   * @param {number} bytes
   * @returns {string} e.g. '1.5 GB', '340 MB', '1.2 KB'
   */
  function formatBytes(bytes) {
    if (bytes == null || isNaN(bytes)) return '0 B';
    if (bytes === 0) return '0 B';

    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const absBytes = Math.abs(bytes);
    const exponent = Math.min(
      Math.floor(Math.log(absBytes) / Math.log(1024)),
      units.length - 1
    );
    const value = bytes / Math.pow(1024, exponent);
    return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
  }

  /**
   * Format bytes-per-second into a human-readable speed string.
   * @param {number} bytesPerSec
   * @returns {string} e.g. '12.5 MB/s', '340 KB/s'
   */
  function formatSpeed(bytesPerSec) {
    if (bytesPerSec == null || isNaN(bytesPerSec)) return '0 B/s';
    if (bytesPerSec === 0) return '0 B/s';

    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];
    const abs = Math.abs(bytesPerSec);
    const exponent = Math.min(
      Math.floor(Math.log(abs) / Math.log(1024)),
      units.length - 1
    );
    const value = bytesPerSec / Math.pow(1024, exponent);
    return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
  }

  /**
   * Format seconds of uptime into a concise string.
   * @param {number} seconds
   * @returns {string} e.g. '2d 5h 23m 10s'
   */
  function formatUptime(seconds) {
    if (seconds == null || isNaN(seconds) || seconds < 0) return '0s';

    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
  }

  /**
   * Format a number as a percentage string.
   * @param {number} value
   * @returns {string} e.g. '45.2%'
   */
  function formatPercent(value) {
    if (value == null || isNaN(value)) return '0.0%';
    return `${Number(value).toFixed(1)}%`;
  }

  // ─── Gradient Helpers ───────────────────────────────────────────────────────

  /**
   * Build a vertical linear gradient for a line-chart fill.
   * @param {CanvasRenderingContext2D} ctx
   * @param {HTMLCanvasElement} canvas
   * @param {string} color - CSS colour for the top of the gradient.
   * @param {number} alphaTop - Opacity at the top.
   * @returns {CanvasGradient}
   */
  function makeVerticalGradient(ctx, canvas, color, alphaTop = 0.3) {
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    // Parse the colour into r,g,b components
    const temp = document.createElement('canvas').getContext('2d');
    temp.fillStyle = color;
    temp.fillRect(0, 0, 1, 1);
    const [r, g, b] = temp.getImageData(0, 0, 1, 1).data;
    gradient.addColorStop(0, `rgba(${r},${g},${b},${alphaTop})`);
    gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);
    return gradient;
  }

  // ─── Chart Factory Functions ────────────────────────────────────────────────

  /**
   * Create a line chart for usage history (CPU, RAM, GPU, etc.).
   * @param {string} canvasId - ID of the <canvas> element.
   * @param {string} [color='#00f0ff'] - Line/border color.
   * @param {string} [gradientPrefix] - Unused, kept for backward compat.
   * @returns {Chart}
   */
  function createCpuChart(canvasId, color, gradientPrefix) {
    const lineColor = color || '#00f0ff';
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const gradient = makeVerticalGradient(ctx, canvas, lineColor, 0.3);

    return new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Usage %',
            data: [],
            borderColor: lineColor,
            backgroundColor: gradient,
            fill: true,
            tension: 0.4,
            pointRadius: 0,
            borderWidth: 2,
          },
        ],
      },
      options: {
        plugins: {
          legend: { display: false },
          tooltip: { enabled: true },
          centerText: { display: false },
        },
        scales: {
          y: {
            min: 0,
            max: 100,
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: {
              callback: (v) => `${v}%`,
              maxTicksLimit: 5,
            },
          },
          x: {
            display: true,
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: { display: false },
          },
        },
      },
    });
  }

  /**
   * Create a doughnut chart for RAM usage.
   * @param {string} canvasId
   * @returns {Chart}
   */
  function createRamChart(canvasId) {
    const ctx = document.getElementById(canvasId).getContext('2d');

    return new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Used', 'Free'],
        datasets: [
          {
            data: [0, 100],
            backgroundColor: ['#a855f7', 'rgba(255,255,255,0.05)'],
            hoverBackgroundColor: ['#b975f8', 'rgba(255,255,255,0.1)'],
            borderWidth: 0,
          },
        ],
      },
      options: {
        cutout: '75%',
        plugins: {
          legend: { display: false },
          tooltip: { enabled: true },
          centerText: {
            display: true,
            text: '0%',
          },
        },
      },
    });
  }

  /**
   * Create a dual-line chart for network download / upload throughput.
   * @param {string} canvasId
   * @returns {Chart}
   */
  function createNetworkChart(canvasId) {
    const canvas = document.getElementById(canvasId);
    const ctx = canvas.getContext('2d');
    const rxGradient = makeVerticalGradient(ctx, canvas, '#00f0ff', 0.25);
    const txGradient = makeVerticalGradient(ctx, canvas, '#a855f7', 0.25);

    return new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Download',
            data: [],
            borderColor: '#00f0ff',
            backgroundColor: rxGradient,
            fill: true,
            tension: 0.4,
            pointRadius: 0,
            borderWidth: 2,
          },
          {
            label: 'Upload',
            data: [],
            borderColor: '#a855f7',
            backgroundColor: txGradient,
            fill: true,
            tension: 0.4,
            pointRadius: 0,
            borderWidth: 2,
          },
        ],
      },
      options: {
        plugins: {
          legend: {
            display: true,
            labels: {
              usePointStyle: true,
              pointStyle: 'line',
              boxWidth: 20,
              padding: 12,
            },
          },
          tooltip: {
            enabled: true,
            callbacks: {
              label: (context) =>
                `${context.dataset.label}: ${formatSpeed(context.raw)}`,
            },
          },
          centerText: { display: false },
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: {
              callback: (v) => formatSpeed(v),
              maxTicksLimit: 5,
            },
          },
          x: {
            display: true,
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: { display: false },
          },
        },
      },
    });
  }

  /**
   * Create a line chart for GPU utilisation.
   * @param {string} canvasId
   * @param {number} index - GPU index (for future multi-GPU labelling).
   * @returns {Chart}
   */
  function createGpuChart(canvasId, index = 0) {
    const canvas = document.getElementById(canvasId);
    const ctx = canvas.getContext('2d');
    const gradient = makeVerticalGradient(ctx, canvas, '#22c55e', 0.3);

    return new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: `GPU ${index} Usage %`,
            data: [],
            borderColor: '#22c55e',
            backgroundColor: gradient,
            fill: true,
            tension: 0.4,
            pointRadius: 0,
            borderWidth: 2,
          },
        ],
      },
      options: {
        plugins: {
          legend: { display: false },
          tooltip: { enabled: true },
          centerText: { display: false },
        },
        scales: {
          y: {
            min: 0,
            max: 100,
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: {
              callback: (v) => `${v}%`,
              maxTicksLimit: 5,
            },
          },
          x: {
            display: true,
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: { display: false },
          },
        },
      },
    });
  }

  /**
   * Create a horizontal bar chart for disk / partition usage.
   * @param {string} canvasId
   * @returns {Chart}
   */
  function createDiskChart(canvasId) {
    const ctx = document.getElementById(canvasId).getContext('2d');

    return new Chart(ctx, {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Used %',
            data: [],
            backgroundColor: [],
            borderWidth: 0,
            barPercentage: 0.6,
            categoryPercentage: 0.8,
            borderRadius: 4,
          },
          {
            // "Track" dataset: always 100% to show unused portion behind
            label: 'Total',
            data: [],
            backgroundColor: 'rgba(255,255,255,0.05)',
            borderWidth: 0,
            barPercentage: 0.6,
            categoryPercentage: 0.8,
            borderRadius: 4,
          },
        ],
      },
      options: {
        indexAxis: 'y', // horizontal bars
        plugins: {
          legend: { display: false },
          tooltip: {
            enabled: true,
            filter: (item) => item.datasetIndex === 0, // only show "Used"
            callbacks: {
              label: (context) => `${context.raw.toFixed(1)}% used`,
            },
          },
          centerText: { display: false },
        },
        scales: {
          x: {
            min: 0,
            max: 100,
            stacked: false,
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: {
              callback: (v) => `${v}%`,
            },
          },
          y: {
            stacked: false,
            grid: { display: false },
          },
        },
      },
    });
  }

  // ─── Chart Update Functions ─────────────────────────────────────────────────

  /**
   * Push a new CPU usage value into the buffer and refresh the chart.
   * @param {Chart} chart
   * @param {RollingBuffer} buffer
   * @param {number} value - CPU usage 0–100.
   */
  function updateCpuChart(chart, buffer, value) {
    if (!chart) return;
    buffer.push(value);
    chart.data.labels = buffer.getLabels();
    chart.data.datasets[0].data = buffer.getAll();
    chart.update('none'); // skip animation for smooth real-time feel
  }

  /** Alias for updateCpuChart — works for any line chart (CPU, RAM, GPU). */
  const updateLineChart = updateCpuChart;

  /**
   * Update the RAM doughnut chart with new used / free values.
   * @param {Chart} chart
   * @param {number} used - Bytes used.
   * @param {number} free - Bytes free.
   */
  function updateRamChart(chart, used, free) {
    const total = used + free;
    const pct = total > 0 ? ((used / total) * 100).toFixed(1) : '0.0';
    chart.data.datasets[0].data = [used, free];
    chart.options.plugins.centerText.text = `${pct}%`;
    chart.update('none');
  }

  /**
   * Update the network throughput chart with new download/upload samples.
   * @param {Chart} chart
   * @param {RollingBuffer} rxBuffer - Download bytes/s buffer.
   * @param {RollingBuffer} txBuffer - Upload bytes/s buffer.
   * @param {number} rxValue - Current download bytes/s.
   * @param {number} txValue - Current upload bytes/s.
   */
  function updateNetworkChart(chart, rxBuffer, txBuffer, rxValue, txValue) {
    rxBuffer.push(rxValue);
    txBuffer.push(txValue);

    const labels = rxBuffer.getLabels();
    chart.data.labels = labels;
    chart.data.datasets[0].data = rxBuffer.getAll();
    chart.data.datasets[1].data = txBuffer.getAll();
    chart.update('none');
  }

  /**
   * Push a new GPU utilisation value and refresh the chart.
   * @param {Chart} chart
   * @param {RollingBuffer} buffer
   * @param {number} value - GPU utilisation 0–100.
   */
  function updateGpuChart(chart, buffer, value) {
    buffer.push(value);
    chart.data.labels = buffer.getLabels();
    chart.data.datasets[0].data = buffer.getAll();
    chart.update('none');
  }

  /**
   * Update the disk usage bar chart with current partition data.
   * @param {Chart} chart
   * @param {Array<{mount: string, use: number}>} disks
   */
  function updateDiskChart(chart, disks) {
    if (!disks || !Array.isArray(disks)) return;

    const labels = [];
    const usedData = [];
    const trackData = [];
    const colors = [];

    disks.forEach((disk) => {
      labels.push(disk.mount || disk.fs || '?');
      const usage = Number(disk.use) || 0;
      usedData.push(usage);
      trackData.push(100);

      // Colour by severity
      if (usage >= 90) {
        colors.push('#ef4444'); // red
      } else if (usage >= 70) {
        colors.push('#f59e0b'); // amber
      } else {
        colors.push('#22c55e'); // green
      }
    });

    chart.data.labels = labels;
    chart.data.datasets[0].data = usedData;
    chart.data.datasets[0].backgroundColor = colors;
    chart.data.datasets[1].data = trackData;
    chart.update('none');
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  window.DashCharts = {
    // Data structure
    RollingBuffer,

    // Chart factories
    createCpuChart,
    createRamChart,
    createNetworkChart,
    createGpuChart,
    createDiskChart,

    // Chart updaters
    updateCpuChart,
    updateLineChart,
    updateRamChart,
    updateNetworkChart,
    updateGpuChart,
    updateDiskChart,

    // Formatters
    formatBytes,
    formatSpeed,
    formatUptime,
    formatPercent,

    // Plugin
    centerTextPlugin,
  };
})();
