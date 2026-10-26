import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'lib');
// Only remove this checkout's generated lib directory, never a computed parent.
assert.equal(dirname(output), root); assert.equal(basename(output), 'lib');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(resolve(root, 'shared'), resolve(output, 'shared'), { recursive: true });
await writeFile(resolve(root, 'lib/index.mjs'), (await readFile(resolve(root, 'src/index.mjs'), 'utf8')).replaceAll('../shared/', './shared/'));
await cp(resolve(root, 'src/request-ledger.mjs'), resolve(root, 'lib/request-ledger.mjs'));
await cp(resolve(root, 'src/tool-integration.mjs'), resolve(root, 'lib/tool-integration.mjs'));
const client = await build({ entryPoints: [resolve(root, 'src/client.jsx')], bundle: true, write: false, format: 'cjs', platform: 'browser', external: ['react'], jsx: 'transform', minify: false });
await writeFile(resolve(root, 'lib/client.js'), `window.__ModuleLoader__.load({id:'dsh-gene-editing',factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`);
console.log('Built standalone Host, Web Client and shared compatibility assets.');
