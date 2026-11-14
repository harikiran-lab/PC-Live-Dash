const si = require('systeminformation');

async function diagnose() {
    console.log('=== PC Live Dashboard Diagnostics ===\n');

    // CPU Load
    try {
        const load = await si.currentLoad();
        console.log('--- CPU Load ---');
        console.log('currentLoad:', load.currentLoad);
        console.log('currentLoadUser:', load.currentLoadUser);
        console.log('currentLoadSystem:', load.currentLoadSystem);
        console.log('currentLoadIdle:', load.currentLoadIdle);
        console.log('avgLoad:', load.avgLoad);
        console.log('Number of logical cores:', load.cpus ? load.cpus.length : 'N/A');
        if (load.cpus) {
            load.cpus.forEach((c, i) => console.log(`  Core ${i}: ${c.load.toFixed(1)}%`));
        }
    } catch (e) {
        console.error('CPU Load ERROR:', e.message);
    }

    console.log('');

    // GPU
    try {
        const graphics = await si.graphics();
        console.log('--- GPU Graphics ---');
        console.log('Controllers count:', graphics.controllers ? graphics.controllers.length : 0);
        if (graphics.controllers) {
            graphics.controllers.forEach((gpu, i) => {
                console.log(`\nGPU ${i}:`);
                console.log('  vendor:', gpu.vendor);
                console.log('  model:', gpu.model);
                console.log('  vram:', gpu.vram, 'MB');
                console.log('  memoryTotal:', gpu.memoryTotal);
                console.log('  memoryUsed:', gpu.memoryUsed);
                console.log('  memoryFree:', gpu.memoryFree);
                console.log('  utilizationGpu:', gpu.utilizationGpu);
                console.log('  utilizationMemory:', gpu.utilizationMemory);
                console.log('  temperatureGpu:', gpu.temperatureGpu);
                console.log('  fanSpeed:', gpu.fanSpeed);
                console.log('  powerDraw:', gpu.powerDraw);
                console.log('  driverVersion:', gpu.driverVersion);
                console.log('  bus:', gpu.bus);
            });
        }
        console.log('\nDisplays count:', graphics.displays ? graphics.displays.length : 0);
    } catch (e) {
        console.error('GPU ERROR:', e.message);
    }

    console.log('');

    // CPU Temperature
    try {
        const temp = await si.cpuTemperature();
        console.log('--- CPU Temperature ---');
        console.log('main:', temp.main);
        console.log('cores:', temp.cores);
        console.log('max:', temp.max);
    } catch (e) {
        console.error('CPU Temp ERROR:', e.message);
    }

    console.log('\n=== Diagnostics Complete ===');
}

// Run twice - first call primes, second gives real values
(async () => {
    // Prime
    await si.currentLoad();
    // Wait a second for delta
    await new Promise(r => setTimeout(r, 1500));
    await diagnose();
    process.exit(0);
})();
