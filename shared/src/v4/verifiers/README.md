# V4 bounded function verifiers

The runtime accepts one synchronous JavaScript `solve(input)` candidate in a JavaScript fence or as plain source. It does not require an answer JSON envelope. Multiple JavaScript fences are ambiguous; prose or an unsupported task is `unknown`, not a successful verification.

`index.mjs` exports:

- `listVerificationTasks()`: public IDs, titles, families and prompts only. No starter verdicts, diagnostic cases, or hidden inputs.
- `getVerificationTask(id)`: a detached trusted task specification, including `starterStatus` and public diagnostics. Use only in trusted experiment/runtime setup; do not expose this entire object as the browser catalogue.
- `verifyCandidate({artifact, taskId, selection, policy, requiredCheckIds, signal})`: `diagnostic` runs mandatory smoke plus one optional check ranked by `policy.verificationOrder`; prior failed public IDs in `requiredCheckIds` must also run. `full` runs all public checks. Hidden IDs are rejected.
- `evaluateCandidate({artifact, taskId, signal})`: separate held-out acceptance inputs from `hidden-cases.mjs`, intended only for experiment scoring. Its results must never be fed into model repair.
- `extractCandidate(artifact)` and `candidateHash(artifact)`: normalized candidate extraction and its SHA-256. Every result also carries `artifactHash`, the SHA-256 of the exact full answer text, so old evidence cannot certify a changed answer.

`passed` means only the named assertions passed. Guest syntax/runtime errors and incorrect values produce `failed`. Missing executable code or unsupported task produces `unknown`. Worker/process/protocol infrastructure failure produces `error`. Cancellation rejects with the caller's abort reason.

## Execution boundary

The parent sends only source and selected `{id,input}` pairs to a child process. Expected values remain outside that process. Candidate code is never evaluated by Node: the trusted worker uses the pinned `quickjs-emscripten@0.32.0` WASM interpreter, with no host function, module loader, filesystem, network, Node, or console capability exposed to the guest. Each check receives a fresh runtime and context. The library documents this capability boundary and explicit runtime limits in its [primary README](https://github.com/justjake/quickjs-emscripten).

Each guest has a 16 MiB heap limit, 512 KiB stack limit, interrupt deadline (250 ms by default) and interrupt-count ceiling. The worker has a 6-second parent deadline, 96 MiB Node old-space limit, bounded input/output, scrubbed environment, and a Node permission read allowlist covering its own file and dependencies. It receives no credentials or inherited `NODE_OPTIONS`. The supported worker environment is Node 24; the current project host is v24.15.0.

QuickJS/WASM supplies the guest isolation boundary; a separate process supplies cancellation and failure containment. This is not a general OS container or arbitrary repository test runner. No file/network capability is granted to guest code. Use a different reviewed executor before supporting such capabilities.

A private serializer captures guest intrinsics before candidate evaluation, rejects cycles, accessors, promises, non-finite/non-JSON values, excessive depth and excessive output, and returns a JSON string through a handle. It is not affected by a candidate replacing global `JSON.stringify` or `Object.keys`. Equality assertions run in the parent against trusted expected values.

## Task coverage

Six new deterministic function tasks cover structured identity, interval algebra and ordered selection. Three supplied starters are defective and three are already correct. Public diagnostic sets and hidden acceptance fixtures are separate. These six tasks are a small exploratory cohort; they do not establish broad generalization. The earlier cache, rate-limit and top-k questions are not reused as new held-out cases.

From the repository root, build with `npm run build`, then run focused checks with `node --test test/v4-verifiers.test.mjs`. The tests load the built runtime shipped in the package. `npm run check` includes them automatically. Tests exercise correct/defective starters, real policy-dependent check selection, separate hidden acceptance, stale failure rechecks, guest capability isolation, serializer tampering, resource interruption and cancellation.
