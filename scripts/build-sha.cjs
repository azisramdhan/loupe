const path = require('node:path');
const os = require('node:os');
const { buildAndRegister, checkoutRoot } = require('../src/build.cjs');
const { projects, projectFor } = require('../src/catalog.cjs');

const [name, sha, buildDirectory, checkoutDirectory] = process.argv.slice(2);
const project = projects.find(p => p.name.toLowerCase() === String(name).toLowerCase())
  || projectFor(name);
if (!project || !/^[a-f0-9]{40}$/.test(sha || '')) {
  console.error('Usage: npm run build-sha -- <project> <40-character-commit-sha> [build-directory] [checkout-directory]');
  console.error(`Projects: ${projects.map(p => p.name).join(', ')}`);
  console.error('Get the SHA from the run card, or: gh pr view <number> --repo <owner/repo> --json headRefOid');
  process.exit(1);
}
const config = {
  buildDirectory: buildDirectory || path.join(os.homedir(), 'Library', 'Application Support', 'Loupe', 'builds'),
  checkoutDirectory: checkoutDirectory || checkoutRoot()
};
buildAndRegister(project, sha, config, step => console.log(step))
  .then(manifest => {
    console.log(`Registered ${manifest.sha}`);
    console.log(`  app      : ${manifest.appPath}`);
    console.log(`  manifest : ${path.join(config.buildDirectory, `${sha}.json`)}`);
  })
  .catch(error => { console.error(error.message); process.exit(1); });
