const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('path');

let tray = null;
let win = null;

function createWindow() {
  if (win) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 1140, height: 860, show: false,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js') }
  });
  win.loadURL('http://127.0.0.1:8765');
  win.on('closed', () => { win = null; });
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  const ctx = Menu.buildFromTemplate([
    { label: 'Open dashboard', click: createWindow },
    { label: 'Quit', click: () => app.quit() }
  ]);
  tray.setToolTip('Hermes Browser Bridge');
  tray.setContextMenu(ctx);
  tray.on('click', createWindow);
}

app.whenReady().then(() => {
  createTray();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
