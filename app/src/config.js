'use strict';
// App settings stored as JSON in the app's data folder.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PORT = 41769;
// ID of the bundled extension. It is fixed by the "key" in extension/manifest.json,
// and only a browser extension can send this Origin, so it is trusted by default.
const BUNDLED_EXTENSION_ID = 'kdnempddaodnginhpkpilbagmmimkkbg';

const DEFAULTS = {
  port: DEFAULT_PORT,
  concurrency: 2,
  approvedExtensions: [BUNDLED_EXTENSION_ID],
  ytdlpPath: '',
};

function loadConfig(dir) {
  const file = path.join(dir, 'config.json');
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // First run or unreadable file: use defaults.
  }
  const config = { ...DEFAULTS, ...stored };
  if (!Array.isArray(config.approvedExtensions)) config.approvedExtensions = [...DEFAULTS.approvedExtensions];
  const envPort = Number(process.env.YTDLP_BRIDGE_PORT);
  if (envPort) config.port = envPort;
  return {
    data: config,
    save() {
      fs.mkdirSync(dir, { recursive: true });
      const { port, ...rest } = config;
      // An env override is for tests only; do not persist it.
      fs.writeFileSync(file, JSON.stringify({ ...rest, port: envPort ? stored.port ?? DEFAULT_PORT : port }, null, 2));
    },
  };
}

module.exports = { loadConfig, DEFAULT_PORT, BUNDLED_EXTENSION_ID };
