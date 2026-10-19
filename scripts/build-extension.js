const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const extensionDir = path.join(root, 'extension');

const css = fs.readFileSync(path.join(extensionDir, 'panel.css'), 'utf8');
fs.writeFileSync(path.join(extensionDir, 'styles.js'), `window.__LB_CSS = ${JSON.stringify(css)};\n`);

const waJs = require.resolve('@wppconnect/wa-js');
const vendorDir = path.join(extensionDir, 'vendor');
fs.mkdirSync(vendorDir, { recursive: true });
fs.copyFileSync(waJs, path.join(vendorDir, 'wppconnect-wa.js'));

console.log('Extension assets built: styles.js and vendor/wppconnect-wa.js');
