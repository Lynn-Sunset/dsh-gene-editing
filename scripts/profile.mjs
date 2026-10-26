import { mkdir, writeFile, cp, appendFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = resolve(root, process.argv.includes('--smoke') ? '.web-smoke-home' : process.argv.includes('--test') ? '.test-home' : '.dsh-home');
const profile = resolve(home, 'profiles/gene');
await mkdir(resolve(profile, 'node_modules'), { recursive: true });
await writeFile(resolve(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-gene', private: true,
  dependencies: { 'dsh-gene-editing': 'file:../../..' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-gene-editing'] } } }, null, 2));
const installed = resolve(profile, 'node_modules/dsh-gene-editing');
await mkdir(installed, { recursive: true });
for (const file of ['package.json', 'cordis.patch.yml', 'controlled.patch.yml', 'lib']) await cp(resolve(root, file), resolve(installed, file), { recursive: true });
await cp(resolve(root, 'controlled.patch.yml'), resolve(profile, 'cordis.patch.yml'));
await appendFile(resolve(profile, 'cordis.patch.yml'), `\n- id: workspace-controller\n  config:\n    documentsDirectory: ${JSON.stringify(home)}\n`);
if (process.argv.includes('--test')) await appendFile(resolve(profile, 'cordis.patch.yml'), `\n- id: agent-loop\n  config:\n    agents:\n      - id: gene-smoke\n        sessionId: gene-smoke\n        provider: deepseek\n        model: deepseek-v4-flash\n        reasoningEffort: high\n        cwd: ${JSON.stringify(root)}\n- insert:\n    - id: gene-ui-fixture\n      name: ${JSON.stringify(resolve(root, 'test/ui-fixture.mjs'))}\n`);
console.log(`Isolated profile: ${profile}`);
if (process.argv.includes('--run') || process.argv.includes('--dump')) {
  const env = { ...process.env, DSH_HOME: home };
  if (process.argv.includes('--test')) for (const key of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PROXY/i.test(key)) delete env[key];
  const args = [resolve(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'gene'];
  if (process.argv.includes('--dump')) args.push('--dump-config');
  else args.push('--no-open', '--host', '127.0.0.1', '--port', process.argv.includes('--test') ? '18479' : '18478');
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  if (process.argv.includes('--run')) await writeFile(resolve(home, 'server.pid'), String(child.pid));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
