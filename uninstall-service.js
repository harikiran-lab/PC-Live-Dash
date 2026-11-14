const Service = require('node-windows').Service;
const path = require('path');

// Create a new service object matching the install config
const svc = new Service({
  name: 'PCLiveDashboard',
  script: path.join(__dirname, 'server.js')
});

// Listen for the "uninstall" event
svc.on('uninstall', function() {
  console.log('PC Live Dashboard Service uninstalled successfully.');
});

svc.uninstall();
