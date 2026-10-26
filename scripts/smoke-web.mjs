import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const init = spawn(process.execPath, [resolve(root, 'scripts/profile.mjs'), '--test', '--smoke'], { cwd: root, stdio: 'ignore', windowsHide: true });
assert.equal((await once(init, 'exit'))[0], 0);
const env = { ...process.env, DSH_HOME: resolve(root, '.web-smoke-home') };
for (const key of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PROXY/i.test(key)) delete env[key];
const server = spawn(process.execPath, [resolve(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'gene', '--no-open', '--host', '127.0.0.1', '--port', '0'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let output = '';
const base = await new Promise((accept, reject) => {
  const timeout = setTimeout(() => { server.kill('SIGTERM'); reject(new Error('Web cold-start timed out')); }, 45000);
  const read = buffer => {
    output += buffer.toString();
    const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/);
    if (match) { clearTimeout(timeout); accept(match[1]); }
  };
  server.stdout.on('data', read); server.stderr.on('data', read);
  server.on('exit', code => { clearTimeout(timeout); reject(new Error(`Web startup exited ${code}: ${output.replace(/token=[^\s]+/g, 'token=[redacted]').slice(-2000)}`)); });
});
try {
  const login = await fetch(base, { redirect: 'manual' });
  const cookie = login.headers.getSetCookie().map(row => row.split(';', 1)[0]).join('; ');
  const response = login.status >= 300 && login.status < 400 ? await fetch(new URL(login.headers.get('location'), base), { headers: { cookie } }) : login;
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.ok(html.includes('dsh-gene-editing'), 'real boot manifest includes client package');
  const clientPath = [...html.matchAll(/(?:src|href)="([^"]*dsh-gene-editing[^"]*)"/g)][0]?.[1]?.replaceAll('&amp;', '&');
  assert.ok(clientPath, 'HTML contains the authoritative versioned combo bundle URL');
  const bundle = await fetch(new URL(clientPath, base), { headers: { cookie } });
  assert.equal(bundle.status, 200);
  const source = await bundle.text();
  assert.ok(source.includes('Gene Editing') && source.includes('conversation.session.header.actions'));
  const report = { checkedAt: new Date().toISOString(), runtime: '@deepseek-ai/dsh@0.2.1-rc.3', coldStart: 'passed', clientManifest: 'passed', clientAsset: 'passed', realModelCalls: 0 };
  await writeFile(resolve(root, 'web-smoke-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  server.kill('SIGTERM');
  await once(server, 'exit');
}
