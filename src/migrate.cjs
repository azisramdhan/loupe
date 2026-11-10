const fs = require('node:fs');
const path = require('node:path');

// The credential is deliberately left behind: macOS safeStorage keys it to the
// app name, so a copy would only ever fail to decrypt.
const CARRIED = ['config.json', 'repositories', 'builds'];

function migrate(directory, legacyName, io = fs) {
  if (io.existsSync(path.join(directory, 'config.json'))) return null;
  const legacy = path.join(path.dirname(directory), legacyName);
  if (path.resolve(legacy) === path.resolve(directory)) return null;
  if (!io.existsSync(path.join(legacy, 'config.json'))) return null;

  const carried = [];
  io.mkdirSync(directory, { recursive: true });
  for (const entry of CARRIED) {
    const from = path.join(legacy, entry);
    if (!io.existsSync(from)) continue;
    io.cpSync(from, path.join(directory, entry), { recursive: true });
    carried.push(entry);
  }
  return { from: legacy, carried };
}

module.exports = { migrate, CARRIED };
