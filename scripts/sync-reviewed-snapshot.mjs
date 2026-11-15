// Publish an already-committed, reviewed tree to a separate branch via GitHub API.
// Does not force-push or modify main. Useful when Git smart HTTP is unavailable.
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = 'Cowskin/cloud-mail';
const branch = 'maintenance/readiness-20261115';
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const exec = promisify(execFile);
async function api(path, body) {
  if (!body) return JSON.parse((await exec('gh', ['api', `repos/${repo}/${path}`], { maxBuffer: 32 * 1024 * 1024 })).stdout);
  return await new Promise((resolveResult, reject) => {
    const child = execFile('gh', ['api', '--method', 'POST', `repos/${repo}/${path}`, '--input', '-'], { maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error); else { try { resolveResult(JSON.parse(stdout)); } catch (e) { reject(e); } }
    });
    child.stdin.end(JSON.stringify(body));
  });
}
if (git('status', '--porcelain')) throw new Error('Commit and review all changes before syncing');
const localCommit = git('rev-parse', 'HEAD');
const localTree = git('rev-parse', 'HEAD^{tree}');
const main = await api('git/ref/heads/main');
const remote = await api(`git/trees/${main.object.sha}?recursive=1`);
if (remote.truncated) throw new Error('Remote tree is truncated');
const known = new Set(remote.tree.filter(t => t.type === 'blob').map(t => t.sha));
const entries = execFileSync('git', ['ls-files', '-s', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).map(line => {
  const [meta, path] = line.split('\t'); const [mode, sha] = meta.split(' ');
  if (path.startsWith('.private/') || path.startsWith('.local-archive/')) throw new Error('Private file is tracked');
  return { path, mode, type: 'blob', sha };
});
for (let start = 0; start < entries.length; start += 4) {
  const results = await Promise.allSettled(entries.slice(start, start + 4).map(async entry => {
    if (!known.has(entry.sha)) {
      const blob = await api('git/blobs', { content: readFileSync(resolve(root, entry.path)).toString('base64'), encoding: 'base64' });
      if (blob.sha !== entry.sha) throw new Error(`Blob mismatch: ${entry.path}`);
      known.add(entry.sha);
    }
  }));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}
const tree = await api('git/trees', { tree: entries });
if (tree.sha !== localTree) throw new Error('Remote snapshot tree differs from local commit');
const commit = await api('git/commits', { message: `Prepare Cloud Mail recovery, tests and release baseline\n\nLocal source commit: ${localCommit}`, tree: tree.sha, parents: [main.object.sha] });
await api('git/refs', { ref: `refs/heads/${branch}`, sha: commit.sha });
const verified = await api(`git/commits/${commit.sha}`);
if (verified.tree.sha !== localTree) throw new Error('Remote verification failed');
const report = { checkedAt: new Date().toISOString(), repo, branch, localCommit, remoteCommit: commit.sha, tree: localTree, treesIdentical: true, mainUnchanged: true };
writeFileSync(resolve(root, '.private/github-sync.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
