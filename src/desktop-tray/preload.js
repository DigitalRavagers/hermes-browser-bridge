const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('hermesTray', {
  minimizeToTray: () => true,
  openDashboard: () => true
});
