import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const WORKER = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const MODULES = resolve(dirname(createRequire(import.meta.url).resolve('quickjs-emscripten')), '../..');
const MAX_PAYLOAD = 196608;
const MAX_OUTPUT = 262144;

export async function runGuestCases({ source, cases, signal, timeoutMs = 6000, perCaseMs = 250 }) {
  signal?.throwIfAborted();
  const payload = JSON.stringify({ source, cases: cases.map(({ id, input }) => ({ id, input })), perCaseMs });
  if (Buffer.byteLength(payload) > MAX_PAYLOAD) return { error: 'input_limit' };
  return new Promise((resolveResult, reject) => {
    // No credentials, NODE_OPTIONS, or inherited package hooks enter the worker environment.
    const env = {};
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
    const child = spawn(process.execPath, [
      '--permission', '--allow-fs-read=' + WORKER, '--allow-fs-read=' + MODULES,
      '--max-old-space-size=96', WORKER
    ], { cwd: dirname(WORKER), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const chunks = [];
    let bytes = 0, stderrBytes = 0, forcedError = null, done = false;
    const timer = setTimeout(() => { forcedError = 'runner_timeout'; child.kill(); }, Math.max(100, Math.min(30000, timeoutMs)));
    const abort = () => { forcedError = 'aborted'; child.kill(); };
    signal?.addEventListener('abort', abort, { once: true });
    const finish = (result, error) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(signal.reason || new DOMException('Aborted', 'AbortError'));
      else if (error) resolveResult({ error });
      else resolveResult(result);
    };
    child.on('error', () => finish(null, 'runner_unavailable'));
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) { forcedError = 'output_limit'; child.kill(); }
      else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT) { forcedError = 'runner_output_limit'; child.kill(); }
    });
    child.on('close', code => {
      if (forcedError) return finish(null, forcedError);
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (code !== 0 || result.error || !Array.isArray(result.rows)) return finish(null, result.error || 'runner_failure');
        if (result.rows.length !== cases.length || result.rows.some((row, i) => row.id !== cases[i].id || !['executed', 'failed'].includes(row.status))) return finish(null, 'runner_protocol');
        finish(result);
      } catch { finish(null, 'runner_protocol'); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(payload);
    // Close the race between the initial signal check and listener registration.
    if (signal?.aborted) abort();
  });
}
