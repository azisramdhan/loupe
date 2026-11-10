const fs = require('node:fs');
const path = require('node:path');
const { writeJSON } = require('../src/storage.cjs');
const { projects, projectFor } = require('../src/catalog.cjs');

const [name, directory, sha, appPath] = process.argv.slice(2);
const project = projects.find(p => p.name.toLowerCase() === String(name).toLowerCase())
  || projectFor(name);
const ALLOWED = { ios: /\.(app|ipa)$/, android: /\.apk$/ };
if (!project || !directory || !/^[a-f0-9]{40}$/.test(sha || '') || !appPath || !ALLOWED[project.platform].test(appPath)) {
  console.error('Usage: npm run register-build -- <project> /absolute/build-directory <40-character-commit-sha> /absolute/app');
  console.error(`Projects: ${projects.map(p => `${p.name} (${ALLOWED[p.platform].source})`).join(', ')}`);
  process.exit(1);
}
const absolute = fs.realpathSync(appPath);
const manifest = { repository: project.repository, platform: project.platform, sha, appId: project.appId, appPath: absolute };
const destination = path.resolve(directory, `${sha}.json`);
writeJSON(destination, manifest);
console.log(`Registered ${sha} -> ${absolute}`);
console.log(`Manifest: ${destination}`);
