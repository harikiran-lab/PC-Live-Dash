const Service = require('node-windows').Service;
const path = require('path');

// Create a new service object
const svc = new Service({
  name: 'PCLiveDashboard',
  displayName: 'PC Live Dashboard Server',
  description: 'Futuristic PC Hardware Live Monitoring Dashboard (http://localhost:3000)',
  script: path.join(__dirname, 'server.js'),
  env: [
    {
      name: 'PORT',
      value: 3000
    }
  ]
});

// Listen for the "install" event
svc.on('install', function() {
  console.log('PC Live Dashboard Service installed successfully!');
  console.log('Starting the service...');
  svc.start();
});

svc.on('alreadyinstalled', function() {
  console.log('PC Live Dashboard Service is already installed.');
});

svc.on('start', function() {
  console.log('PC Live Dashboard Service started.');
});

svc.install();
