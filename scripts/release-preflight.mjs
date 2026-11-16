import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cwd = resolve(root, 'mail-worker');
const cli = resolve(root, 'd1-backup-worker/node_modules/.bin/wrangler');
if (!cli) throw new Error('Install Worker dependencies before preflight');
const run = (...args) => JSON.parse(execFileSync(cli, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
const deployments = run('deployments', 'list', '--json');
const latest = [...deployments].sort((a,b) => new Date(b.created_on) - new Date(a.created_on))[0];
const version = latest.versions[0].version_id;
const details = run('versions', 'view', version, '--json');
const bindings = details.resources?.bindings || [];
for (const name of ['db', 'kv', 'assets', 'admin', 'domain', 'jwt_secret', 'CARD_PROTECTION_SECRET']) {
  if (!bindings.some(b => b.name === name)) throw new Error(`Missing production binding: ${name}`);
}
const indexes = ['idx_email_user_type_del_id','idx_email_account_user_type_del_id','idx_email_type_status_id','idx_email_to_nocase_type','idx_email_from_nocase_type','idx_attachment_email_id','idx_star_user_email',
  'idx_email_meta_owner','idx_email_meta_type_status','idx_email_meta_subject','idx_email_meta_name','idx_email_meta_date','idx_email_meta_storage','idx_email_delivery_pending'];
const data = run('d1', 'execute', 'cloud-mail-db', '--remote', '--json', '--command', "SELECT name FROM sqlite_master WHERE type='index'");
const found = new Set(data.flatMap(r => r.results || []).map(r => r.name));
for (const index of indexes) if (!found.has(index)) throw new Error(`Apply migration first; missing ${index}`);
const triggers = run('d1', 'execute', 'cloud-mail-db', '--remote', '--json', '--command', "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'email_metadata_%'");
if (triggers.flatMap(r=>r.results||[]).length !== 3) throw new Error('Metadata synchronization triggers are missing');
const coverage=run('d1','execute','cloud-mail-db','--remote','--json','--command',`SELECT count(*) AS missing
  FROM email e INDEXED BY idx_email_type_status_id LEFT JOIN email_metadata m ON m.email_id=e.email_id WHERE m.email_id IS NULL`)[0].results[0].missing;
if (coverage) throw new Error(`Backfill metadata before deployment: ${coverage} missing rows`);
const protection=run('d1','execute','cloud-mail-db','--remote','--json','--command',
  'SELECT enabled,version,verifier IS NOT NULL AS configured,sealed_key IS NOT NULL AS runtimeReady FROM card_protection WHERE id=1')[0].results[0];
if (!protection || (protection.enabled && (!protection.configured || !protection.runtimeReady))) throw new Error('Card protection migration or key material is missing');
const response = await fetch('https://mail.happyx2.com/api/setting/websiteConfig');
if (!response.ok || (await response.json()).code !== 200) throw new Error('Production public configuration is unavailable');
const report = { checkedAt: new Date().toISOString(), version, indexes: indexes.length, metadataTriggers:3, missingMetadata:coverage, cardProtection: {enabled:!!protection.enabled,version:protection.version,configured:!!protection.configured}, requiredBindingsPresent: true, publicConfigurationHealthy: true, secretValuesBackedUp: false };
mkdirSync(resolve(root, '.private'), { recursive: true, mode: 0o700 });
writeFileSync(resolve(root, '.private/release-preflight.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
