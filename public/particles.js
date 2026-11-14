/* ============================================================
   Particles Background — Futuristic Tech Aesthetic
   Lightweight canvas-based animated particle network
   ============================================================ */

(function initParticles() {
  'use strict';

  const canvas = document.getElementById('particles-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  /* ---------- Configuration ---------- */
  const CONFIG = {
    particleCount: 80,
    minRadius: 1,
    maxRadius: 2,
    minSpeed: 0.2,
    maxSpeed: 0.8,
    minOpacity: 0.2,
    maxOpacity: 0.5,
    connectionDistance: 120,
    maxConnectionsPerParticle: 5,
    lineMaxOpacity: 0.15,
    tintChance: 0.15,             // 15 % of particles get a colored tint
    colors: {
      base: { r: 255, g: 255, b: 255 },
      cyan: { r: 0, g: 240, b: 255 },
      violet: { r: 168, g: 85, b: 247 },
    },
  };

  let particles = [];
  let animFrameId = null;
  let width = 0;
  let height = 0;

  /* ---------- Helpers ---------- */
  function rand(min, max) {
    return Math.random() * (max - min) + min;
  }

  function pickTint() {
    const roll = Math.random();
    if (roll < CONFIG.tintChance / 2) return CONFIG.colors.cyan;
    if (roll < CONFIG.tintChance) return CONFIG.colors.violet;
    return CONFIG.colors.base;
  }

  /* ---------- Particle factory ---------- */
  function createParticle() {
    const color = pickTint();
    const angle = rand(0, Math.PI * 2);
    const speed = rand(CONFIG.minSpeed, CONFIG.maxSpeed);

    return {
      x: rand(0, width),
      y: rand(0, height),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius: rand(CONFIG.minRadius, CONFIG.maxRadius),
      opacity: rand(CONFIG.minOpacity, CONFIG.maxOpacity),
      color,
      connections: 0,
    };
  }

  /* ---------- Resize handler ---------- */
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    width = window.innerWidth;
    height = window.innerHeight;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ---------- Initialise particles ---------- */
  function initParticleArray() {
    particles = [];
    for (let i = 0; i < CONFIG.particleCount; i++) {
      particles.push(createParticle());
    }
  }

  /* ---------- Update positions ---------- */
  function update() {
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];

      p.x += p.vx;
      p.y += p.vy;

      // Wrap around edges with a small buffer
      if (p.x < -10) p.x = width + 10;
      else if (p.x > width + 10) p.x = -10;

      if (p.y < -10) p.y = height + 10;
      else if (p.y > height + 10) p.y = -10;

      // Reset per-frame connection counter
      p.connections = 0;
    }
  }

  /* ---------- Draw ---------- */
  function draw() {
    ctx.clearRect(0, 0, width, height);

    const connDist = CONFIG.connectionDistance;
    const connDistSq = connDist * connDist;

    // Draw connections first (behind particles)
    for (let i = 0; i < particles.length; i++) {
      const a = particles[i];
      if (a.connections >= CONFIG.maxConnectionsPerParticle) continue;

      for (let j = i + 1; j < particles.length; j++) {
        const b = particles[j];
        if (b.connections >= CONFIG.maxConnectionsPerParticle) continue;

        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distSq = dx * dx + dy * dy;

        if (distSq < connDistSq) {
          const dist = Math.sqrt(distSq);
          const opacity = (1 - dist / connDist) * CONFIG.lineMaxOpacity;

          // Blend the two particle colours for the line
          const cr = Math.round((a.color.r + b.color.r) / 2);
          const cg = Math.round((a.color.g + b.color.g) / 2);
          const cb = Math.round((a.color.b + b.color.b) / 2);

          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${opacity.toFixed(3)})`;
          ctx.lineWidth = 0.6;
          ctx.stroke();

          a.connections++;
          b.connections++;
        }
      }
    }

    // Draw particles
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${p.color.r}, ${p.color.g}, ${p.color.b}, ${p.opacity.toFixed(3)})`;
      ctx.fill();
    }
  }

  /* ---------- Animation loop ---------- */
  function loop() {
    update();
    draw();
    animFrameId = requestAnimationFrame(loop);
  }

  /* ---------- Bootstrap ---------- */
  function start() {
    resize();
    initParticleArray();
    loop();
  }

  /* Debounced resize */
  let resizeTimer = null;
  window.addEventListener('resize', function () {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resize();
      // Keep existing particles but clamp any that are now out-of-bounds
      for (let i = 0; i < particles.length; i++) {
        if (particles[i].x > width) particles[i].x = rand(0, width);
        if (particles[i].y > height) particles[i].y = rand(0, height);
      }
    }, 150);
  });

  // Kick off once the DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  // Pause animation when tab is hidden to save resources
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (animFrameId) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
      }
    } else {
      if (!animFrameId) {
        loop();
      }
    }
  });
})();
