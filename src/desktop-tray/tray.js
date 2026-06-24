#!/usr/bin/env node

// tray.js — stands up an Electron tray + treats existing bridge as warm.
// Run: node tray.js
const { spawn } = require('child_process');
const path = require('path');

const here = __dirname;
const bridge = path.join(here, '..', 'bridge');

const child = spawn('node', ['index.js'], { cwd: bridge, stdio: 'inherit', shell: process.platform === 'win32' });

child.on('exit', (code) => process.exit(code ?? 0));
