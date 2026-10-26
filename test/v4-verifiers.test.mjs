import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { listVerificationTasks, getVerificationTask, extractCandidate, candidateHash, verifyCandidate, evaluateCandidate } from '../lib/shared/src/v4/verifiers/index.mjs';
import { runGuestCases } from '../lib/shared/src/v4/verifiers/sandbox.mjs';

const low = { verificationOrder: ['baseline', 'constraint', 'boundary'] };
const high = { verificationOrder: ['boundary', 'baseline', 'constraint'] };
const fixed = {
  tuple_dedup: `function solve(input) { const seen = new Map(); const out=[]; for(const [a,b] of input){if(!seen.has(a))seen.set(a,new Set()); if(!seen.get(a).has(b)){seen.get(a).add(b);out.push([a,b]);}} return out; }`,
  interval_union: `function solve(input) { const out=[]; for(const [a,b] of input.slice().sort((x,y)=>x[0]-y[0])){const last=out[out.length-1];if(last&&a<=last[1])last[1]=Math.max(last[1],b);else out.push([a,b]);}return out; }`,
  version_sort: `function solve(input) {return input.map((row,i)=>({...row,i,parts:row.version.split('.').map(Number)})).sort((a,b)=>a.parts[0]-b.parts[0]||a.parts[1]-b.parts[1]||a.parts[2]-b.parts[2]||a.i-b.i).map(row=>row.id);}`
};

test('v4 verifiers: task catalogue is public, detached, and excludes hidden acceptance or starter verdicts', () => {
  const tasks = listVerificationTasks();
  assert.equal(tasks.length, 6);
  assert.equal(new Set(tasks.map(t => t.family)).size, 3);
  for (const item of tasks) {
    assert.equal('checks' in item, false); assert.equal('starterStatus' in item, false);
    assert.equal(item.prompt.includes('.hidden.'), false);
    const spec = getVerificationTask(item.id);
    assert.equal(spec.checks.filter(c => c.mandatory).length, 1);
  }
  const first = getVerificationTask(tasks[0].id); first.checks.length = 0;
  assert.equal(getVerificationTask(tasks[0].id).checks.length, 4);
});

test('v4 verifiers: one function is extracted without requiring model JSON, ambiguity stays unknown', () => {
  const source = 'function solve(input) { return input; }';
  assert.equal(extractCandidate('说明\n```js\n' + source + '\n```'), source);
  assert.equal(extractCandidate('export default ' + source), source);
  assert.equal(extractCandidate('代码一\n```js\n' + source + '\n```\n```js\n' + source + '\n```'), null);
  assert.equal(extractCandidate('没有代码，仅说测试已通过'), null);
  assert.equal(extractCandidate(JSON.stringify({answer:source})), null);
  assert.equal(candidateHash(source), createHash('sha256').update(source).digest('hex'));
});

test('v4 verifiers: inline triple-backtick prose cannot hide a valid candidate fence', async () => {
  const artifact = '原实现按字符串比较版本号，```"10.0.0"``` 会被错误地排到 ```"2.0.0"``` 前面。\n\n```js\n' + fixed.version_sort + '\n```';
  assert.equal(extractCandidate(artifact), fixed.version_sort);
  const result = await verifyCandidate({ artifact, taskId: 'version_sort', selection: 'full' });
  assert.equal(result.status, 'passed');
  assert.equal(result.totalChecks, 4);
  assert.equal(result.artifactHash, createHash('sha256').update(artifact).digest('hex'));
});

test('v4 verifiers: line fences support tildes, indentation, CRLF and longer matching closers', () => {
  const source = 'function solve(input) { return input; }';
  for (const artifact of [
    '```js\n' + source + '\n````',
    '~~~JavaScript\n' + source + '\n~~~~',
    '   ```ecmascript\r\n' + source + '\r\n  ``` \t',
    '```\n' + source + '\n```',
    '~~~text\n说明\n~~~\n```js\n' + source + '\n```'
  ]) assert.equal(extractCandidate(artifact), source);
  const embeddedFence = 'function solve(input) {\n  const marker = `\n```\n`;\n  return input;\n}';
  assert.equal(extractCandidate('````js\n' + embeddedFence + '\n````'), embeddedFence);
});

test('v4 verifiers: incomplete, mismatched and multiple candidate fences remain unknown', () => {
  const source = 'function solve(input) { return input; }';
  for (const artifact of [
    '```js\n' + source,
    '````js\n' + source + '\n```',
    '```js\n' + source + '\n~~~',
    '```js\n' + source + '\n``` trailing explanation',
    '```js\n' + source + '\n```\n~~~text\nunclosed',
    '```js\n' + source + '\n```\n~~~javascript\n' + source + '\n~~~',
    '```js\n' + source + '\n```\n```\n' + source + '\n```'
  ]) assert.equal(extractCandidate(artifact), null);
});

test('v4 verifiers: real policy selection changes boundary evidence, not the checking budget', async () => {
  for (const id of ['tuple_dedup','interval_union','version_sort']) {
    const artifact = getVerificationTask(id).starter;
    const a = await verifyCandidate({artifact, taskId:id, policy:low});
    const b = await verifyCandidate({artifact, taskId:id, policy:high});
    assert.equal(a.status, 'passed', id); assert.equal(b.status, 'failed', id);
    assert.equal(a.totalChecks, 2); assert.equal(b.totalChecks, 2);
    assert.equal(a.checks[0].id, b.checks[0].id);
    assert.notEqual(a.checks[1].id, b.checks[1].id);
    assert.equal(b.checks[1].kind, 'boundary');
  }
});

test('v4 verifiers: corrected programs and already-correct starters pass public and independent hidden cases', async () => {
  for (const {id} of listVerificationTasks()) {
    const spec = getVerificationTask(id);
    const artifact = fixed[id] || spec.starter;
    const publicResult = await verifyCandidate({artifact,taskId:id,selection:'full'});
    const hiddenResult = await evaluateCandidate({artifact,taskId:id});
    assert.equal(publicResult.status,'passed',id + ' public');
    assert.equal(hiddenResult.status,'passed',id + ' hidden');
    assert.equal(publicResult.totalChecks,4); assert.equal(hiddenResult.totalChecks,4);
    assert.equal(publicResult.checks.some(c=>c.id.includes('.hidden.')),false);
    assert.equal(hiddenResult.checks.every(c=>c.id.includes('.hidden.')),true);
  }
});

test('v4 verifiers: hidden evaluator catches defective starters without feeding hidden inputs to diagnostics', async () => {
  for (const id of Object.keys(fixed)) {
    const result = await evaluateCandidate({artifact:getVerificationTask(id).starter,taskId:id});
    assert.equal(result.status,'failed',id);
  }
  const rejected=await verifyCandidate({artifact:fixed.tuple_dedup,taskId:'tuple_dedup',requiredCheckIds:['tuple_dedup.hidden.collisions']});
  assert.equal(rejected.status,'error'); assert.equal(rejected.checks.length,0);
  assert.equal(rejected.reason,'invalid_required_check');
});

test('v4 verifiers: previous failed public checks cannot disappear after a Gene change', async () => {
  const spec=getVerificationTask('tuple_dedup');
  const result=await verifyCandidate({artifact:spec.starter,taskId:spec.id,policy:low,requiredCheckIds:['tuple_dedup.delimiter']});
  assert.equal(result.status,'failed');
  assert.equal(result.checks.some(c=>c.id==='tuple_dedup.delimiter'&&c.status==='failed'),true);
  assert.equal(result.checks.some(c=>c.mandatory),true);
});

test('v4 verifiers: exact artifact hashes change with prose while candidate hashes remain stable', async () => {
  const code=fixed.tuple_dedup, artifact='说明\n```js\n'+code+'\n```';
  const result=await verifyCandidate({artifact,taskId:'tuple_dedup',policy:high});
  assert.equal(result.artifactHash,createHash('sha256').update(artifact).digest('hex'));
  assert.equal(result.candidateHash,candidateHash(code));
  assert.notEqual(result.artifactHash,result.candidateHash);
});

test('v4 verifiers: unsupported tasks and missing code stay unknown; syntax/runtime errors fail checked candidates', async () => {
  assert.equal((await verifyCandidate({artifact:'text',taskId:'unknown'})).status,'unknown');
  assert.equal((await evaluateCandidate({artifact:'function solve(){return 1;}',taskId:'__proto__'})).status,'unknown');
  assert.equal((await verifyCandidate({artifact:'tests all pass',taskId:'tuple_dedup'})).status,'unknown');
  const bad=await verifyCandidate({artifact:'function solve(input) { throw new Error("bad"); }',taskId:'tuple_dedup'});
  assert.equal(bad.status,'failed'); assert.equal(bad.passedChecks,0);
  const syntax=await evaluateCandidate({artifact:'function solve(input) {',taskId:'tuple_dedup'});
  assert.equal(syntax.status,'failed');
});

test('v4 sandbox: guest receives no Node, filesystem, network, console, or credential APIs', async () => {
  const result=await runGuestCases({source:'function solve() { return [typeof process,typeof require,typeof fetch,typeof console,typeof Buffer,typeof Deno]; }',cases:[{id:'isolation',input:null}]});
  assert.deepEqual(result.rows[0].actual,['undefined','undefined','undefined','undefined','undefined','undefined']);
  const escaped=await runGuestCases({source:'function solve() { return ({}).constructor.constructor("return typeof process")(); }',cases:[{id:'escape',input:null}]});
  assert.equal(escaped.rows[0].actual,'undefined');
});

test('v4 sandbox: candidate changes to JSON and prototypes cannot forge its serialized result', async () => {
  const result=await runGuestCases({source:`JSON.stringify=()=> '"forged"'; Object.keys=()=>[]; Object.prototype.toJSON=()=> 'forged'; function solve() { return { value:'actual', nested:[1,2] }; }`,cases:[{id:'tamper',input:null}]});
  assert.deepEqual(result.rows[0].actual,{value:'actual',nested:[1,2]});
  const getter=await runGuestCases({source:`Object.prototype.value='forged'; function solve(){return Object.defineProperty({},'x',{enumerable:true,get(){return 3}});}`,cases:[{id:'accessor',input:null}]});
  assert.equal(getter.rows[0].status,'failed');
});

test('v4 sandbox: cyclic, asynchronous, nonfinite, and oversized outputs are not accepted', async () => {
  for(const body of ['const a={};a.a=a;return a;','return Promise.resolve(1);','return NaN;','return "x".repeat(40000);']) {
    const result=await runGuestCases({source:'function solve(){'+body+'}',cases:[{id:'bounded',input:null}]});
    assert.equal(result.rows[0].status,'failed',body);
  }
});

test('v4 sandbox: each test case has a fresh guest and preserves Unicode input', async () => {
  const result=await runGuestCases({source:'let n=0; function solve(input){return {n:++n,input};}',cases:[{id:'one',input:['甲','乙']},{id:'two',input:['甲','乙']}]});
  assert.deepEqual(result.rows.map(r=>r.actual),[{n:1,input:['甲','乙']},{n:1,input:['甲','乙']}]);
});

test('v4 sandbox: runaway guest is interrupted and external cancellation terminates the worker', async () => {
  const runaway=await runGuestCases({source:'function solve(){while(true){}}',cases:[{id:'runaway',input:null}],perCaseMs:25});
  assert.equal(runaway.rows[0].status,'failed');
  const controller=new AbortController();
  const pending=runGuestCases({source:'function solve(){while(true){}}',cases:[{id:'cancel',input:null}],signal:controller.signal,perCaseMs:1000});
  setTimeout(()=>controller.abort(),30);
  await assert.rejects(pending,{name:'AbortError'});
});
