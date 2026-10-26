// Trusted worker: candidate JavaScript is evaluated ONLY by the WASM QuickJS guest.
// No host functions, module loader, file, network, process, or console APIs are exposed.
import { getQuickJS } from 'quickjs-emscripten';

const INPUT_LIMIT = 196608;
const inputChunks = [];
let inputBytes = 0;
for await (const chunk of process.stdin) {
  inputBytes += chunk.length;
  if (inputBytes > INPUT_LIMIT) {
    process.stdout.write(JSON.stringify({ error: 'input_limit' }));
    process.exit(1);
  }
  inputChunks.push(chunk);
}
const input = Buffer.concat(inputChunks).toString('utf8');

// Capture pristine guest intrinsics before evaluating the candidate. Serializing through
// these private handles prevents a candidate from forging output by replacing JSON.stringify.
const SERIALIZER = `(() => {
  const keys = Object.keys, descriptor = Object.getOwnPropertyDescriptor, hasOwn = Object.hasOwn;
  const getPrototype = Object.getPrototypeOf, symbols = Object.getOwnPropertySymbols;
  const objectPrototype = Object.prototype, arrayPrototype = Array.prototype;
  const isArray = Array.isArray, isFiniteNumber = Number.isFinite;
  const stringifyString = JSON.stringify, numberString = String, make = Object.create;
  return value => {
    const parents = make(null);
    let nodes = 0;
    const visit = (item, depth) => {
      if (++nodes > 12000 || depth > 24) throw new Error('output_limit');
      if (item === null) return 'null';
      if (typeof item === 'string') {
        if (item.length > 32768) throw new Error('output_limit');
        return stringifyString(item);
      }
      if (typeof item === 'boolean') return item ? 'true' : 'false';
      if (typeof item === 'number') {
        if (!isFiniteNumber(item)) throw new Error('non_json_number');
        return numberString(item);
      }
      if (typeof item !== 'object') throw new Error('non_json_value');
      for (let i = 0; i < depth; i++) if (parents[i] === item) throw new Error('cyclic_output');
      const array = isArray(item), prototype = getPrototype(item);
      if (prototype !== null && prototype !== (array ? arrayPrototype : objectPrototype)) throw new Error('non_plain_output');
      if (symbols(item).length) throw new Error('non_json_symbol');
      parents[depth] = item;
      let text = array ? '[' : '{';
      const names = keys(item);
      const lengthDescriptor = array ? descriptor(item, 'length') : null;
      const length = array ? lengthDescriptor.value : names.length;
      if (length > 12000) throw new Error('output_limit');
      for (let i = 0; i < length; i++) {
        const key = array ? numberString(i) : names[i];
        const field = descriptor(item, key);
        if (!field || !hasOwn(field, 'value')) throw new Error('non_json_accessor');
        if (i) text += ',';
        if (!array) text += stringifyString(key) + ':';
        text += visit(field.value, depth + 1);
        if (text.length > 32768) throw new Error('output_limit');
      }
      delete parents[depth];
      return text + (array ? ']' : '}');
    };
    return visit(value, 0);
  };
})()`;

function describeError(ctx, handle) {
  // Guest error messages are untrusted, bounded data; they never supply execution instructions.
  try {
    const dumped = ctx.dump(handle);
    return String(dumped?.message || dumped?.name || 'candidate_error').slice(0, 240);
  } catch { return 'candidate_error'; }
}

try {
  const request = JSON.parse(input);
  if (typeof request.source !== 'string' || request.source.length > 65536 || !Array.isArray(request.cases) || request.cases.length > 32) throw new Error('invalid_request');
  const perCaseMs = Math.max(25, Math.min(1000, Number(request.perCaseMs) || 250));
  const QuickJS = await getQuickJS();
  const rows = [];
  for (const item of request.cases) {
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(16 * 1024 * 1024);
    runtime.setMaxStackSize(512 * 1024);
    const deadline = Date.now() + perCaseMs;
    let ticks = 0;
    runtime.setInterruptHandler(() => Date.now() >= deadline || ++ticks > 10000);
    const ctx = runtime.newContext();
    const handles = [];
    const keep = result => {
      if (result.error) {
        const message = describeError(ctx, result.error);
        result.error.dispose();
        throw new Error(message);
      }
      handles.push(result.value);
      return result.value;
    };
    try {
      const serialize = keep(ctx.evalCode(SERIALIZER, 'trusted-serializer.js'));
      const argument = keep(ctx.evalCode('JSON.parse(' + JSON.stringify(JSON.stringify(item.input)) + ')', 'trusted-input.js'));
      keep(ctx.evalCode(request.source, 'candidate.js', { type: 'global' }));
      const fn = keep(ctx.evalCode('typeof solve === "function" ? solve : undefined', 'trusted-entry.js'));
      if (ctx.typeof(fn) !== 'function') throw new Error('missing_solve_function');
      const result = keep(ctx.callFunction(fn, ctx.undefined, argument));
      const serialized = keep(ctx.callFunction(serialize, ctx.undefined, result));
      const text = ctx.getString(serialized);
      if (Buffer.byteLength(text) > 65536) throw new Error('output_limit');
      rows.push({ id: item.id, status: 'executed', actual: JSON.parse(text) });
    } catch (error) {
      rows.push({ id: item.id, status: 'failed', error: String(error.message || 'candidate_error').slice(0, 240) });
    } finally {
      for (const handle of handles.reverse()) handle.dispose();
      ctx.dispose();
      runtime.dispose();
    }
  }
  process.stdout.write(JSON.stringify({ rows }));
} catch {
  process.stdout.write(JSON.stringify({ error: 'runner_failure' }));
  process.exitCode = 1;
}
