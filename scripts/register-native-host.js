const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME;
const target = path.join(HOME, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'NativeMessagingHosts', 'com.digitalravagers.hermes.browser.json');
const here = __dirname;
const hostScript = path.join(here, '..', 'native-host.js');

const manifest = {
  name: 'com.digitalravagers.hermes.browser',
  description: 'Native messaging host for Hermes Browser Bridge',
  path: hostScript.replace(/\\/g, '/'),
  type: 'stdio',
  allowed_origins: ['chrome-extension://__MSG_APP_ID__/']
};

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(manifest, null, 2));
console.log('Wrote', target);
