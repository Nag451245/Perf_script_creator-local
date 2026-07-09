# JMeter Agent Closed-Loop Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing replay/lineage engine into `--agent` so deterministic evidence drives repair before learning memory or AI escalation.

**Architecture:** Add a small blueprint context/artifact layer, activate the tested OAuth state/nonce rewire during generation, classify the first chronological failure, run a replay-lineage preflight in agent mode, and feed that evidence into reports and AI prompts. Keep patching schema-gated and keep final JMX generation owned by the current `generate()` and `runValidate()` flow.

**Tech Stack:** Node.js 18+, built-in `node:test`, existing JMeter engine adapters, existing local modules in `src/`.

---

## File Structure

- Create `src/blueprint-context.js`: constructs and persists blueprint context artifacts.
- Create `src/failure-classifier.js`: classifies first chronological failures into blueprint categories.
- Create `src/blueprint-agent.js`: orchestrates replay-lineage preflight and summarizes evidence for `runner.js`.
- Modify `src/generate.js`: call `rewireClientMintedOauthVars()` and record its reasoning.
- Modify `src/runner.js`: run blueprint evidence before learning/AI, persist artifacts, and include evidence in AI prompt construction.
- Modify `src/report.js`: link blueprint context and repair artifacts.
- Modify `tests/local.test.js`: add unit coverage for each new behavior.

No external engine files should be changed.

## Task 1: Activate OAuth State/Nonce Rewire in Generation

**Files:**
- Modify: `src/generate.js`
- Test: `tests/local.test.js`

- [ ] **Step 1: Write the failing test**

Add this test near the existing OAuth rewire tests in `tests/local.test.js`:

```js
test('generate: OAuth state/nonce rewire is active in the shipped JMX', () => {
    const state = 'recordedState1234567890';
    const nonce = 'recordedNonce1234567890';
    const { entries, pages } = parse(har([
        entry('GET', `https://login.example.com/authorize?response_type=code&client_id=abc&redirect_uri=https%3A%2F%2Fapp.test%2Fcb&state=${state}&nonce=${nonce}`, {
            query: [
                { name: 'response_type', value: 'code' },
                { name: 'client_id', value: 'abc' },
                { name: 'redirect_uri', value: 'https://app.test/cb' },
                { name: 'state', value: state },
                { name: 'nonce', value: nonce },
            ],
        }),
    ]));

    const out = tmp();
    const gen = generate(entries, pages, out, 'oauth-rewire-active');
    const xml = fs.readFileSync(gen.jmxPath, 'utf8');

    assert.match(xml, /__RandomString\(32,abcdef0123456789,\)/);
    assert.ok(gen.reasoning.some(r => r.phase === 'oauth-client-state'));
});
```

- [ ] **Step 2: Run the failing test**

Run: `npm test -- --test-name-pattern "OAuth state/nonce rewire is active"`

Expected: FAIL because `generate()` does not currently call `rewireClientMintedOauthVars()`.

- [ ] **Step 3: Implement the minimal generation change**

In `src/generate.js`, include `rewireClientMintedOauthVars` in the transform import:

```js
const {
    wrapPollingInWhileController,
    injectGhostSynthesizers,
    injectAssertionsFromMined,
    injectGaussianTimers,
    applyLoadProfile,
    disableSamplersByPattern,
    repairAuth0LoginStateExtractors,
    rewireClientMintedOauthVars,
    correlateFormHiddenInputs,
    repairDeadExtractorConsumers,
} = require('./transforms');
```

After `repairStaticOauthConstants()` and before host rewrite, add:

```js
const oauthClientVars = rewireClientMintedOauthVars(xml);
xml = oauthClientVars.xml;
if (oauthClientVars.rewired.length) note('oauth-client-state',
    `${oauthClientVars.rewired.length} OAuth client-minted state/nonce variable(s) rewired`,
    `/authorize URLs with OAuth2 hallmarks require fresh client-side state`,
    `used native JMeter __RandomString functions for ${oauthClientVars.rewired.join(', ')}`);
```

- [ ] **Step 4: Verify the test passes**

Run: `npm test -- --test-name-pattern "OAuth state/nonce rewire is active"`

Expected: PASS.

## Task 2: Add Blueprint Context Artifacts

**Files:**
- Create: `src/blueprint-context.js`
- Modify: `tests/local.test.js`

- [ ] **Step 1: Write tests for context creation and persistence**

Add imports:

```js
const blueprintContext = require('../src/blueprint-context');
```

Add tests:

```js
test('blueprint context: creates a serializable run context', () => {
    const ctx = blueprintContext.createBlueprintContext({
        entries: [entry('GET', 'https://app.test/start')],
        secondaryEntries: [],
        pages: [],
        mode: 'har',
        outDir: 'out',
        name: 'flow',
        runCfg: { targetBaseUrlOverride: 'https://stage.test' },
        agentCfg: { enabled: true },
    });

    assert.strictEqual(ctx.name, 'flow');
    assert.strictEqual(ctx.mode, 'har');
    assert.deepStrictEqual(ctx.lineage.links, []);
    assert.deepStrictEqual(ctx.loop.attempts, []);
    assert.strictEqual(ctx.runCfg.targetBaseUrlOverride, 'https://stage.test');
});

test('blueprint context: writes audit artifacts', () => {
    const out = tmp();
    const ctx = blueprintContext.createBlueprintContext({
        entries: [], secondaryEntries: [], pages: [], mode: 'har',
        outDir: out, name: 'audit', runCfg: {}, agentCfg: {},
    });
    ctx.lineage.links.push({ varName: 'c_token', producer: 0, consumer: 1 });
    ctx.loop.attempts.push({ round: 1, firstFailure: { category: 'auth_correlation_failed' } });

    const written = blueprintContext.writeBlueprintArtifacts(ctx);

    assert.ok(fs.existsSync(written.contextPath));
    assert.ok(fs.existsSync(written.lineagePath));
    assert.ok(fs.existsSync(written.repairRoundsPath));
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- --test-name-pattern "blueprint context"`

Expected: FAIL because `src/blueprint-context.js` does not exist.

- [ ] **Step 3: Create `src/blueprint-context.js`**

Use this implementation:

```js
'use strict';

const fs = require('fs');
const path = require('path');

function createBlueprintContext({
    entries = [],
    secondaryEntries = [],
    pages = [],
    mode = '',
    outDir,
    name,
    runCfg = {},
    agentCfg = {},
} = {}) {
    return {
        name,
        mode,
        outDir,
        entriesCount: entries.length,
        secondaryEntriesCount: secondaryEntries.length,
        pagesCount: pages.length,
        runCfg: summarizeRunCfg(runCfg),
        agentCfg: summarizeAgentCfg(agentCfg),
        cleanups: [],
        lineage: { links: [], orphans: [], dynamics: [], producersByValue: {} },
        dataModel: { csvFile: null, parameters: [], protectedBusinessFields: [] },
        validation: { assertions: [], softFailureRules: [], businessGuard: null },
        loop: { attempts: [], firstFailure: null, patches: [] },
        ai: { promptEvidence: null, acceptedFixes: [], rejectedFixes: [] },
    };
}

function summarizeRunCfg(runCfg) {
    return {
        targetBaseUrlOverride: runCfg.targetBaseUrlOverride || '',
        hasCredentials: !!(runCfg.credentials && runCfg.credentials.username),
        disableCalls: Array.isArray(runCfg.disableCalls) ? runCfg.disableCalls.slice() : [],
        businessGoal: runCfg.businessGoal || '',
    };
}

function summarizeAgentCfg(agentCfg) {
    return {
        enabled: agentCfg.enabled === true,
        maxLlmRounds: agentCfg.maxLlmRounds,
        javaSafeMode: agentCfg.javaSafeMode !== false,
    };
}

function writeJson(file, value) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
    return file;
}

function writeBlueprintArtifacts(ctx) {
    if (!ctx || !ctx.outDir || !ctx.name) {
        throw new Error('blueprint context requires outDir and name');
    }
    fs.mkdirSync(ctx.outDir, { recursive: true });
    const base = path.join(ctx.outDir, ctx.name);
    return {
        contextPath: writeJson(`${base}_blueprint_context.json`, ctx),
        lineagePath: writeJson(`${base}_lineage.json`, ctx.lineage || {}),
        repairRoundsPath: writeJson(`${base}_repair_rounds.json`, ctx.loop || {}),
    };
}

module.exports = { createBlueprintContext, writeBlueprintArtifacts };
```

- [ ] **Step 4: Verify context tests pass**

Run: `npm test -- --test-name-pattern "blueprint context"`

Expected: PASS.

## Task 3: Add First-Failure Classification

**Files:**
- Create: `src/failure-classifier.js`
- Modify: `tests/local.test.js`

- [ ] **Step 1: Write classifier tests**

Add import:

```js
const failureClassifier = require('../src/failure-classifier');
```

Add tests:

```js
test('failure classifier: classifies auth and correlation failures', () => {
    const auth = failureClassifier.classifyFirstFailure({
        samples: [{ label: 'Step 04 - GET /me', success: false, responseCode: '401', isTransaction: false }],
    });
    assert.strictEqual(auth.category, 'auth_correlation_failed');

    const unresolved = failureClassifier.classifyFirstFailure({
        unresolvedFailures: [{ samplerLabel: 'Step 05 - GET /cb', varName: 'code', issue: 'unresolved variable' }],
    });
    assert.strictEqual(unresolved.category, 'unresolved_variable');
    assert.strictEqual(unresolved.variable, 'code');
});

test('failure classifier: classifies payload and soft failure signals', () => {
    const badPayload = failureClassifier.classifyFirstFailure({
        samples: [{ label: 'Step 07 - POST /graphql', success: false, responseCode: '400', isTransaction: false }],
    });
    assert.strictEqual(badPayload.category, 'payload_or_header_failed');

    const soft = failureClassifier.classifyFirstFailure({
        samples: [{ label: 'Step 08 - POST /api', success: false, responseCode: '200', failureMessage: 'Session Expired', isTransaction: false }],
    });
    assert.strictEqual(soft.category, 'soft_failure_200');
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- --test-name-pattern "failure classifier"`

Expected: FAIL because `src/failure-classifier.js` does not exist.

- [ ] **Step 3: Create `src/failure-classifier.js`**

Use this implementation:

```js
'use strict';

function classifyFirstFailure(result = {}) {
    const unresolved = firstUnresolved(result);
    if (unresolved) return unresolved;

    const sample = (result.samples || []).find(s => !s.isTransaction && s.success === false);
    if (!sample) return null;

    const code = String(sample.responseCode || sample.code || '');
    const message = String(sample.failureMessage || sample.responseMessage || sample.assertionMessage || '');
    const label = sample.label || sample.name || '';
    const base = { sampler: label, responseCode: code, message };

    if (/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(message + ' ' + label)) {
        return { ...base, category: 'unresolved_variable' };
    }
    if (/session expired|invalid_token|unauthorized|csrf|forbidden/i.test(message) && (code === '200' || code === '')) {
        return { ...base, category: 'soft_failure_200' };
    }
    if (code === '401' || code === '403') {
        return { ...base, category: 'auth_correlation_failed' };
    }
    if (code === '400' || code === '422' || /^5\d\d$/.test(code)) {
        return { ...base, category: 'payload_or_header_failed' };
    }
    if (code === '200' && message) {
        return { ...base, category: 'soft_failure_200' };
    }
    return { ...base, category: 'unknown_failure' };
}

function firstUnresolved(result) {
    const failure = (result.unresolvedFailures || []).find(u => u.varName || /unresolved|\$\{/i.test(String(u.issue || u.manualFixHint || '')));
    if (!failure) return null;
    return {
        sampler: failure.samplerLabel || failure.samplerName || '',
        responseCode: failure.responseCode || '',
        message: failure.issue || failure.manualFixHint || '',
        variable: failure.varName || '',
        category: 'unresolved_variable',
    };
}

module.exports = { classifyFirstFailure };
```

- [ ] **Step 4: Verify classifier tests pass**

Run: `npm test -- --test-name-pattern "failure classifier"`

Expected: PASS.

## Task 4: Add Blueprint Agent Preflight

**Files:**
- Create: `src/blueprint-agent.js`
- Modify: `tests/local.test.js`

- [ ] **Step 1: Write preflight tests**

Add import:

```js
const blueprintAgent = require('../src/blueprint-agent');
```

Add tests:

```js
test('blueprint agent: skips replay preflight without a target', async () => {
    const ctx = blueprintContext.createBlueprintContext({
        entries: [entry('GET', 'https://app.test/start')],
        outDir: tmp(), name: 'skip', mode: 'har', runCfg: {}, agentCfg: { enabled: true },
    });

    const res = await blueprintAgent.runBlueprintPreflight({
        ctx,
        entries: [entry('GET', 'https://app.test/start')],
        runCfg: {},
        onLog: () => {},
    });

    assert.strictEqual(res.skipped, true);
    assert.match(res.reason, /targetBaseUrlOverride/);
});

test('blueprint agent: records replay lineage evidence', async () => {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
    });
    await listenLocal(server);
    const port = server.address().port;
    const out = tmp();
    const ctx = blueprintContext.createBlueprintContext({
        entries: [entry('GET', 'http://recorded.test/start')],
        outDir: out, name: 'preflight', mode: 'har',
        runCfg: { targetBaseUrlOverride: `http://127.0.0.1:${port}` },
        agentCfg: { enabled: true },
    });

    try {
        const res = await blueprintAgent.runBlueprintPreflight({
            ctx,
            entries: [entry('GET', 'http://recorded.test/start')],
            runCfg: { targetBaseUrlOverride: `http://127.0.0.1:${port}` },
            onLog: () => {},
        });

        assert.strictEqual(res.skipped, false);
        assert.ok(Array.isArray(ctx.lineage.links));
        assert.strictEqual(ctx.loop.attempts.length, 1);
    } finally {
        await closeServer(server);
    }
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- --test-name-pattern "blueprint agent"`

Expected: FAIL because `src/blueprint-agent.js` does not exist.

- [ ] **Step 3: Create `src/blueprint-agent.js`**

Use this implementation:

```js
'use strict';

const { correlateAndReplay } = require('./replay-correlate');
const { classifyFirstFailure } = require('./failure-classifier');

async function runBlueprintPreflight({ ctx, entries, runCfg = {}, onLog = () => {} }) {
    const targetBaseUrl = String(runCfg.targetBaseUrlOverride || '').trim();
    if (!targetBaseUrl) {
        const skipped = { skipped: true, reason: 'run.targetBaseUrlOverride is required for blueprint replay preflight' };
        if (ctx) ctx.loop.attempts.push({ phase: 'replay-preflight', ...skipped });
        return skipped;
    }

    onLog(`blueprint preflight: replay-lineage against ${targetBaseUrl}`);
    const replay = await correlateAndReplay({
        entries,
        targetBaseUrl,
        insecure: !!(runCfg.fastReplay && runCfg.fastReplay.insecure),
        onLog,
    });

    if (ctx) {
        ctx.lineage.links = replay.links || [];
        ctx.lineage.orphans = replay.orphans || [];
        ctx.loop.attempts.push({
            phase: 'replay-preflight',
            skipped: false,
            reachedEnd: replay.reachedEnd,
            applied: replay.applied,
            verified: replay.verified,
            firstFailure: firstReplayFailure(replay),
        });
        ctx.loop.firstFailure = ctx.loop.firstFailure || classifyFirstFailure({ samples: replay.samples || [] });
    }

    return { skipped: false, replay };
}

function firstReplayFailure(replay) {
    const f = (replay.failures || [])[0];
    if (!f) return null;
    return {
        index: f.index,
        url: f.url,
        responseCode: String(f.status || ''),
        recordedCode: String(f.recStatus || ''),
        category: (f.status === 401 || f.status === 403) ? 'auth_correlation_failed' : 'payload_or_header_failed',
    };
}

module.exports = { runBlueprintPreflight, _internal: { firstReplayFailure } };
```

- [ ] **Step 4: Verify preflight tests pass**

Run: `npm test -- --test-name-pattern "blueprint agent"`

Expected: PASS.

## Task 5: Wire Blueprint Evidence into Runner Before AI

**Files:**
- Modify: `src/runner.js`
- Modify: `tests/local.test.js`

- [ ] **Step 1: Write runner prompt evidence test**

Add a test for prompt evidence:

```js
test('AI fix prompt: includes blueprint lineage and first-failure evidence when provided', () => {
    const built = runnerInternal.buildGeminiFixPrompt({
        failures: [{ samplerName: 'Step 02 - GET /me', responseCode: '401', failureMessage: 'Unauthorized' }],
        jmxContent: '<HTTPSamplerProxy testname="Step 02 - GET /me" enabled="true"></HTTPSamplerProxy><hashTree/>',
        correlations: [],
        blueprintEvidence: {
            firstFailure: { category: 'auth_correlation_failed', sampler: 'Step 02 - GET /me' },
            lineageSummary: [{ variable: 'c_session', producer: 0, consumer: 1 }],
            repairAttempts: [{ phase: 'replay-preflight', reachedEnd: false }],
        },
    });

    assert.match(built.userPrompt, /BLUEPRINT EVIDENCE/);
    assert.match(built.userPrompt, /auth_correlation_failed/);
    assert.match(built.userPrompt, /c_session/);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- --test-name-pattern "BLUEPRINT EVIDENCE"`

Expected: FAIL because `buildGeminiFixPrompt()` does not accept `blueprintEvidence`.

- [ ] **Step 3: Update imports and prompt signature in `src/runner.js`**

At the top:

```js
const blueprintContext = require('./blueprint-context');
const blueprintAgent = require('./blueprint-agent');
const { classifyFirstFailure } = require('./failure-classifier');
```

Change `escalateToLlm()` signature:

```js
async function escalateToLlm({ result, jmxPath, correlations, outDir, name, onLog, flowNotes = [], blueprintEvidence = null }) {
```

Pass evidence into prompt creation:

```js
const prompt = buildGeminiFixPrompt({ failures, jmxContent, correlations, flowNotes, blueprintEvidence });
```

Change `buildGeminiFixPrompt()` signature:

```js
function buildGeminiFixPrompt({ failures, jmxContent, correlations = [], flowNotes = [], blueprintEvidence = null }) {
```

Add this section before `## FAILURES`:

```js
${blueprintEvidence ? `## BLUEPRINT EVIDENCE
${JSON.stringify(blueprintEvidence, null, 2)}

` : ''}
```

- [ ] **Step 4: Wire preflight into `runValidate()`**

After `strictGuard` is built and before the engine `runFeedbackLoop()` race, create and run the context:

```js
const blueprintCtx = blueprintContext.createBlueprintContext({
    entries,
    secondaryEntries: genOpts.secondaryEntries || [],
    pages,
    mode: 'run',
    outDir,
    name,
    runCfg: enrichedRunCfg,
    agentCfg: agent,
});
blueprintCtx.validation.businessGuard = {
    enabled: strictGuard.enabled,
    protectedSamplers: strictGuard.protectedSamplers,
};
let blueprintEvidence = null;
if (agent.enabled) {
    try {
        const preflight = await blueprintAgent.runBlueprintPreflight({
            ctx: blueprintCtx,
            entries: gen.flat,
            runCfg: enrichedRunCfg,
            onLog,
        });
        blueprintEvidence = summarizeBlueprintEvidence(blueprintCtx, preflight);
    } catch (e) {
        onLog(`blueprint preflight skipped after error: ${e.message}`);
        blueprintCtx.loop.attempts.push({ phase: 'replay-preflight', error: e.message });
    }
}
```

Add helper near other runner helpers:

```js
function summarizeBlueprintEvidence(ctx) {
    if (!ctx) return null;
    return {
        firstFailure: ctx.loop.firstFailure || null,
        lineageSummary: (ctx.lineage.links || []).slice(0, 25).map(l => ({
            variable: l.varName,
            producer: l.producer,
            consumer: l.consumer,
        })),
        orphanCount: (ctx.lineage.orphans || []).length,
        repairAttempts: ctx.loop.attempts || [],
    };
}
```

Pass `blueprintEvidence` into `runLlmPatchRounds()` and then into `escalateToLlm()`.

After final verification, write artifacts:

```js
if (blueprintCtx) {
    blueprintCtx.loop.firstFailure = blueprintCtx.loop.firstFailure || classifyFirstFailure(finalResult);
    blueprintContext.writeBlueprintArtifacts(blueprintCtx);
}
```

- [ ] **Step 5: Export helper under `_internal`**

Add `summarizeBlueprintEvidence` to `module.exports._internal`.

- [ ] **Step 6: Verify prompt test passes**

Run: `npm test -- --test-name-pattern "BLUEPRINT EVIDENCE"`

Expected: PASS.

## Task 6: Report Blueprint Artifacts

**Files:**
- Modify: `src/report.js`
- Modify: `tests/local.test.js`

- [ ] **Step 1: Write artifact-link test**

Add:

```js
test('HTML report: links blueprint agent artifacts', () => {
    const out = tmp();
    fs.writeFileSync(path.join(out, 'bp_blueprint_context.json'), '{}');
    fs.writeFileSync(path.join(out, 'bp_lineage.json'), '{}');
    fs.writeFileSync(path.join(out, 'bp_repair_rounds.json'), '{}');

    const reportPath = writeHtmlReportFn(out, 'bp', {
        mode: 'agent', verdict: 'needs attention', stats: {}, samples: [],
    });
    const html = fs.readFileSync(reportPath, 'utf8');

    assert.match(html, /bp_blueprint_context\.json/);
    assert.match(html, /bp_lineage\.json/);
    assert.match(html, /bp_repair_rounds\.json/);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- --test-name-pattern "blueprint agent artifacts"`

Expected: FAIL because `report.js` does not list these artifact suffixes.

- [ ] **Step 3: Add artifact suffixes in `src/report.js`**

Add these rows to `ARTIFACTS`:

```js
['_blueprint_context.json', 'Blueprint agent phase context'],
['_lineage.json', 'Blueprint dynamic producer-to-consumer lineage'],
['_repair_rounds.json', 'Blueprint closed-loop repair rounds'],
```

- [ ] **Step 4: Verify report test passes**

Run: `npm test -- --test-name-pattern "blueprint agent artifacts"`

Expected: PASS.

## Task 7: Full Test Run and Review

**Files:**
- Review: `src/generate.js`
- Review: `src/runner.js`
- Review: `src/blueprint-context.js`
- Review: `src/blueprint-agent.js`
- Review: `src/failure-classifier.js`
- Review: `tests/local.test.js`

- [ ] **Step 1: Run the complete suite**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 2: Check lint diagnostics for edited files**

Use Cursor diagnostics on:

- `src/generate.js`
- `src/runner.js`
- `src/blueprint-context.js`
- `src/blueprint-agent.js`
- `src/failure-classifier.js`
- `tests/local.test.js`

Expected: no new diagnostics.

- [ ] **Step 3: Manual review checklist**

Confirm these invariants in the diff:

- No external engine files changed.
- No credentials, tokens, cookies, or raw sensitive bodies are written into new artifacts.
- AI still accepts only schema-gated patch kinds.
- Blueprint preflight runs only in agent mode.
- Lack of `run.targetBaseUrlOverride` skips replay preflight without failing generation.
- Final shipped JMX does not keep debug-only artifacts.
- No git commit is created unless the user explicitly asks for one.

## Plan Self-Review

- Spec coverage: This plan implements the first rollout increment from the design spec and activates the already-tested OAuth rewire call. Later hygiene transforms, soft-failure scanner, and 2x2 scale gate remain documented follow-up increments.
- Placeholder scan: No placeholder steps remain; each code change includes concrete snippets.
- Type consistency: `BlueprintAgentContext`, `blueprintEvidence`, `runBlueprintPreflight()`, `classifyFirstFailure()`, and `summarizeBlueprintEvidence()` use consistent property names across tasks.
