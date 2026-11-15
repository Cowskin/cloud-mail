// Generate a private operational snapshot without printing credentials.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, '.private');
mkdirSync(target, { recursive: true, mode: 0o700 });
chmodSync(target, 0o700);
const cli = resolve(root, 'd1-backup-worker/node_modules/.bin/wrangler');
for (const directory of ['mail-worker', 'd1-backup-worker']) {
  const cwd = resolve(root, directory);
  const run = (...args) => JSON.parse(execFileSync(cli, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const deployments = run('deployments', 'list', '--json');
  const ordered = [...deployments].sort((a, b) => new Date(b.created_on) - new Date(a.created_on));
  const version = ordered[0]?.versions?.[0]?.version_id;
  if (!version) throw new Error(`No deployment version for ${directory}`);
  const details = run('versions', 'view', version, '--json');
  writeFileSync(resolve(target, `${directory}-version.json`), JSON.stringify(details, null, 2) + '\n', { mode: 0o600 });
  const bindings = details.resources?.bindings || [];
  const variables = bindings.filter(b => b.type === 'plain_text').map(b => `${b.name}=${JSON.stringify(b.text)}`);
  writeFileSync(resolve(target, `${directory}.env`), '# Exported ordinary variables only; encrypted secret values are not available.\n' + variables.join('\n') + '\n', { mode: 0o600 });
  console.log(`${directory}: version snapshot and ${variables.length} ordinary variables saved privately`);
}
