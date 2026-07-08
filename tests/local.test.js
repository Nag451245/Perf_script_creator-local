'use strict';
/**
 * Self-tests for perfscript-local's OWN logic (generate / report / runner).
 * These are integration-ish: they exercise the real reused engine, since that's
 * exactly what the app does. HAR fixtures are embedded + parsed so the tests are
 * self-contained (no dependence on input/ files).
 *
 * Run: npm test   (node --test)
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { HarParser } = require('../src/engine');
const { generate, _internal: generateInternal } = require('../src/generate');
const { writeHtmlReport } = require('../src/report');
const { resolveAgentOptions, labelForAgentOptions } = require('../src/agent-config');
const { sanitizeJavaUnsafeJmx } = require('../src/java-safe');
const { flagsForRunMode } = require('../src/ui-run-mode');
const { resolveGeminiModel } = require('../src/gemini-model');
const inputState = require('../src/input-state');
const { archiveSuccessfulRun } = require('../src/success-archive');
const { writeFinalJmxPointer } = require('../src/final-artifact');
const businessGuard = require('../src/business-guard');
const { escalateToLlm, _internal: runnerInternal } = require('../src/runner');
const learningStore = require('../src/learning-store');
const { groupInputs } = require('../src/ingest');
const { knownDefinedVars, planExtractor, _internal: extractorsInternal } = require('../src/extractors');
const { wrapPollingInWhileController, injectGhostSynthesizers, injectAssertionsFromMined, injectGaussianTimers, applyLoadProfile, stripGuiListenersForRun, rewireClientMintedOauthVars, repairAuth0LoginStateExtractors, correlateFormHiddenInputs } = require('../src/transforms');
const { scrubRecordingXml } = require('../src/scrubber');
const { rewriteHost } = require('../src/host-rewrite');
const { diffRunAgainstRecording, summarizeJtlFast, _internal: verifierInternal } = require('../src/verifier');
const { replayAll, _internal: replayInternal } = require('../src/fast-replay');
const { correlateAndReplay } = require('../src/replay-correlate');
const { applyLlmPatches, validateLlmPatches } = require('../src/llm-patcher');
const { writeHtmlReport: writeHtmlReportFn } = require('../src/report');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'psl-test-')); }
function listenLocal(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function closeServer(server) {
    return new Promise(resolve => server.close(resolve));
}
function parse(har) {
    const o = new HarParser().parseFromBuffer(Buffer.from(JSON.stringify(har)));
    return { entries: (o.log && o.log.entries) || [], pages: (o.log && o.log.pages) || [] };
}
function entry(method, url, extra = {}) {
    return {
        startedDateTime: '2026-01-01T00:00:00.000Z', time: 5,
        request: { method, url, httpVersion: 'HTTP/1.1', headers: extra.reqHeaders || [], queryString: extra.query || [], cookies: [], headersSize: -1, bodySize: 0, ...(extra.postData ? { postData: extra.postData } : {}) },
        response: { status: extra.status || 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [{ name: 'Content-Type', value: 'application/json' }], cookies: [], content: { size: 10, mimeType: 'application/json', text: extra.body || '{"ok":true}' }, redirectURL: '', headersSize: -1, bodySize: 10 },
        cache: {}, timings: { send: 1, wait: 3, receive: 1 },
    };
}
const har = (entries) => ({ log: { version: '1.2', creator: { name: 't', version: '1' }, entries } });

test('parameterization: user-input fields become a CSV Data Set + ${var} substitution', () => {
    const { entries, pages } = parse(har([
        entry('POST', 'https://app.test/login', {
            reqHeaders: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
            postData: { mimeType: 'application/x-www-form-urlencoded', text: 'username=alice&password=hunter2' },
        }),
    ]));
    const out = tmp();
    const gen = generate(entries, pages, out, 'login');
    assert.ok(gen.stats.parameterized >= 2, `expected >=2 params, got ${gen.stats.parameterized}`);
    assert.ok(gen.csvFile, 'a data CSV should be written');
    const csv = fs.readFileSync(path.join(out, gen.csvFile), 'utf8');
    assert.match(csv.split('\n')[0], /username/, 'CSV header should include username');
    const jmx = fs.readFileSync(gen.jmxPath, 'utf8');
    assert.match(jmx, /\$\{username\}/, 'JMX should substitute ${username}');
    assert.match(jmx, /CSVDataSet/, 'JMX should contain a CSV Data Set');
});

test('ghost sources: client-minted values are detected + reported', () => {
    const { entries, pages } = parse(har([
        entry('GET', 'https://app.test/api/items?_=1717000000000', {
            reqHeaders: [{ name: 'x-request-id', value: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }],
            query: [{ name: '_', value: '1717000000000' }],
        }),
    ]));
    const out = tmp();
    const gen = generate(entries, pages, out, 'ghost');
    assert.ok(gen.stats.clientSideGhosts >= 1, `expected >=1 ghost, got ${gen.stats.clientSideGhosts}`);
    assert.ok(fs.existsSync(path.join(out, 'ghost_ghosts.json')), 'ghosts.json should be written');
});

test('elastic polling: >=3 consecutive same-endpoint requests are detected', () => {
    const poll = (n) => entry('GET', `https://app.test/job/7/status?_=${n}`, { query: [{ name: '_', value: String(n) }] });
    const { entries, pages } = parse(har([
        entry('POST', 'https://app.test/job', { status: 202 }),
        poll(1), poll(2), poll(3),
    ]));
    const out = tmp();
    const gen = generate(entries, pages, out, 'poll');
    assert.strictEqual(gen.stats.pollingLoops, 1, 'one polling loop expected');
    assert.match(gen.polling[0].endpoint, /\/job\/7\/status/);
});

test('static request: no params, no ghosts, no polling', () => {
    const { entries, pages } = parse(har([entry('GET', 'https://example.com/')]));
    const out = tmp();
    const gen = generate(entries, pages, out, 'reach');
    assert.strictEqual(gen.stats.parameterized, 0);
    assert.strictEqual(gen.stats.pollingLoops, 0);
});

test('HTML report: standalone file with verdict badge + artifact links', () => {
    const { entries, pages } = parse(har([
        entry('POST', 'https://app.test/login', {
            reqHeaders: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
            postData: { mimeType: 'application/x-www-form-urlencoded', text: 'username=alice&password=hunter2' },
        }),
    ]));
    const out = tmp();
    const gen = generate(entries, pages, out, 'login');
    const reportPath = writeHtmlReport(out, 'login', { mode: 'generate only', verdict: 'generated', stats: gen.stats, samples: [] });
    const html = fs.readFileSync(reportPath, 'utf8');
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /badge/);
    assert.match(html, /login_data\.csv/, 'report should link the data CSV artifact');
});

test('HTML report: renders verified learning matches and learned lessons', () => {
    const out = tmp();
    fs.writeFileSync(path.join(out, 'learn_memory_matches.json'), '[]');
    fs.writeFileSync(path.join(out, 'learn_learned_lessons.json'), '[]');
    const reportPath = writeHtmlReport(out, 'learn', {
        mode: 'agent',
        verdict: 'GREEN',
        stats: {},
        samples: [{ label: 'GET /avatar/123', success: true, isTransaction: false }],
        memoryMatches: [{
            lessonId: 'vls_abc',
            confidence: 0.9,
            contextPattern: { samplerPattern: '/avatar/:num' },
            fix: { kind: 'setSamplerEnabled' },
        }],
        learnedLessons: {
            learned: [{
                id: 'vls_def',
                confidence: 0.9,
                contextPattern: { samplerPattern: '/orders/:num' },
                fix: { kind: 'addExtractor' },
            }],
        },
    });
    const html = fs.readFileSync(reportPath, 'utf8');
    assert.match(html, /Verified learning store/);
    assert.match(html, /vls_abc/);
    assert.match(html, /vls_def/);
    assert.match(html, /learn_memory_matches\.json/);
    assert.match(html, /learn_learned_lessons\.json/);
});

test('LLM escalation: clean no-op without a Gemini key', async () => {
    const out = tmp();
    const logs = [];
    await escalateToLlm({
        result: { samples: [{ label: 'GET /x', success: false, responseCode: '500', responseMessage: 'err', isTransaction: false }] },
        jmxPath: path.join(out, 'missing.jmx'), correlations: [], outDir: out, name: 't', onLog: (m) => logs.push(m),
    });
    assert.ok(logs.some(l => /skipped — no OpenAI\/Gemini key/.test(l)), 'should log a skip without a key');
    assert.ok(!fs.existsSync(path.join(out, 't_llm_suggestions.json')), 'no suggestions file without a key');
});

test('LLM escalation: unresolved protected failures are included even without failed samples', () => {
    const failures = runnerInternal.collectLlmFailures({
        samples: [],
        unresolvedFailures: [
            {
                samplerLabel: 'Step 05 - GET /u/login/identifier',
                issue: 'server_error_Non HTTP response code: java.net.URISyntaxException',
                responseCode: 'Non HTTP response code: java.net.URISyntaxException',
                manualFixHint: 'Compare the request body/params against the recording.',
            },
        ],
    });
    assert.strictEqual(failures.length, 1);
    assert.strictEqual(failures[0].samplerName, 'Step 05 - GET /u/login/identifier');
    assert.match(failures[0].failureMessage, /Compare the request body/);
});

test('AI fix prompt: senior performance engineer rules and safe patch schema only', () => {
    const built = runnerInternal.buildGeminiFixPrompt({
        failures: [{ samplerName: 'Step 01 - GET /me', responseCode: '401', failureMessage: 'Unauthorized' }],
        jmxContent: '<HTTPSamplerProxy testname="Step 01 - GET /me" enabled="true"></HTTPSamplerProxy><hashTree/>',
        correlations: [{ variableName: 'csrf', type: 'regex' }],
    });

    assert.match(built.systemInstruction, /senior performance/i);
    assert.match(built.systemInstruction, /Do not guess/i);
    assert.match(built.systemInstruction, /fold recorded redirect\/OIDC plumbing/i);
    assert.match(built.systemInstruction, /\/oauth\/token/i);
    assert.match(built.systemInstruction, /business action/i);
    assert.match(built.systemInstruction, /protected login\/auth\/business samplers did not execute/i);
    assert.match(built.systemInstruction, /ambiguous first-party sampler/i);
    assert.match(built.userPrompt, /addExtractor/);
    assert.match(built.userPrompt, /replaceValueWithVar/);
    assert.match(built.userPrompt, /setSamplerEnabled/);
    assert.match(built.userPrompt, /JSON object with exactly one top-level key: "fixes"/);
    assert.match(built.userPrompt, /Do not include .*currentValue.*proposedValue/);
    assert.doesNotMatch(built.userPrompt, /"currentValue"\s*:/);
    assert.doesNotMatch(built.userPrompt, /"proposedValue"\s*:/);
});

test('AI fix prompt: suppresses cascade failures and keeps root/business triage visible', () => {
    const failures = [
        { samplerName: 'Step 14 - POST /', responseCode: '422', category: 'http_error_422', failureMessage: 'Returned 422' },
        { samplerName: 'Step 19 - POST /authorization/', responseCode: '200', category: 'cascade_from_Step 14 - POST /', failureMessage: 'Downstream casualty' },
        { samplerName: 'Step 26 - POST /user/iam/save', responseCode: '200', category: 'cascade_from_Step 14 - POST /', failureMessage: 'Downstream casualty' },
        { category: 'business_verification_failed', failureMessage: 'protected business sampler(s) did not execute: Step 05 - GET /u/login/identifier' },
    ];
    const built = runnerInternal.buildGeminiFixPrompt({
        failures,
        jmxContent: '<HTTPSamplerProxy testname="Step 14 - POST /" enabled="true"></HTTPSamplerProxy><hashTree/>',
        correlations: [],
    });

    assert.match(built.userPrompt, /cascadeFailuresSuppressed": 2/);
    assert.match(built.userPrompt, /Step 14 - POST \//);
    assert.match(built.userPrompt, /business_verification_failed/);
    assert.doesNotMatch(built.userPrompt, /Step 26 - POST \/user\/iam\/save/);
});

test('AI fix prompt: flow-specific notes come from config, not hardcoded app names', () => {
    const base = {
        failures: [{ samplerName: 'Step 01 - GET /me', responseCode: '401', failureMessage: 'Unauthorized' }],
        jmxContent: '<HTTPSamplerProxy testname="Step 01 - GET /me" enabled="true"></HTTPSamplerProxy><hashTree/>',
        correlations: [],
    };
    const without = runnerInternal.buildGeminiFixPrompt(base);
    assert.doesNotMatch(without.systemInstruction, /WebPT/i, 'no customer name may be baked into the generic prompt');
    assert.doesNotMatch(without.systemInstruction, /llmFlowNotes/);
    const withNotes = runnerInternal.buildGeminiFixPrompt({
        ...base,
        flowNotes: ['For this flow, /oauth/token is not the genuine request path.'],
    });
    assert.match(withNotes.systemInstruction, /run\.llmFlowNotes/);
    assert.match(withNotes.systemInstruction, /\/oauth\/token is not the genuine request path/);
});

test('runner: empty engine samples are recovered from the JTL before business verification', () => {
    const out = tmp();
    const jtl = path.join(out, 'final.jtl');
    fs.writeFileSync(jtl, `<?xml version="1.0" encoding="UTF-8"?>
<testResults version="1.2">
<httpSample t="10" lb="Step 05 - GET /u/login/identifier" rc="200" s="true"/>
<httpSample t="10" lb="Step 05 - GET /u/login/identifier-0" rc="302" s="true"/>
<httpSample t="12" lb="Step 08 - POST /u/login/identifier" rc="200" s="true"/>
</testResults>`);
    const empty = { success: false, samples: [] };
    runnerInternal.recoverSamplesFromJtl(empty, jtl, out, () => {});
    assert.strictEqual(empty.samples.length, 2, 'redirect sub-sample folds into its parent');
    assert.deepStrictEqual(empty.samples.map(s => s.label), [
        'Step 05 - GET /u/login/identifier',
        'Step 08 - POST /u/login/identifier',
    ]);
    assert.strictEqual(empty.samplesRecoveredFromJtl, 'final.jtl');
    // A PARTIAL engine list gets the missing executed labels merged in (the
    // JTL is ground truth); labels the engine already has are not duplicated.
    const partial = { success: true, samples: [{ label: 'Step 05 - GET /u/login/identifier', success: true }] };
    runnerInternal.recoverSamplesFromJtl(partial, jtl, out, () => {});
    assert.strictEqual(partial.samples.length, 2);
    assert.deepStrictEqual(partial.samples.map(s => s.label).sort(), [
        'Step 05 - GET /u/login/identifier',
        'Step 08 - POST /u/login/identifier',
    ]);
    assert.strictEqual(partial.samplesRecoveredFromJtl, 'final.jtl');
    // The engine's label-shape heuristic mislabels GraphQL samplers as
    // transactions; the JTL <httpSample> tag corrects the flag.
    const jtl2 = path.join(out, 'gql.jtl');
    fs.writeFileSync(jtl2, `<?xml version="1.0" encoding="UTF-8"?>
<testResults version="1.2">
<httpSample t="10" lb="Step 34 - GraphQL mutation SSOEmrAuthenticate" rc="200" s="true"/>
<sample t="10" lb="login" rc="200" s="true"/>
</testResults>`);
    const misflagged = { success: true, samples: [
        { label: 'Step 34 - GraphQL mutation SSOEmrAuthenticate', success: true, isTransaction: true },
        { label: 'login', success: true, isTransaction: true },
    ] };
    runnerInternal.recoverSamplesFromJtl(misflagged, jtl2, out, () => {});
    assert.strictEqual(misflagged.samples[0].isTransaction, false, 'GraphQL sampler is a request');
    assert.strictEqual(misflagged.samples[1].isTransaction, true, 'transaction controller row stays a transaction');
});

test('form hidden-input correlation: CSS extractor after producer + ${var} at later consumers only', () => {
    const freshState = 'hKFoFRESHSTATEVALUE123456';
    const bridgeToken = 'aabbccddeeff00112233445566778899';
    const entries = [
        { request: { method: 'GET', url: 'https://idp.test/u/login/identifier?state=' + freshState, headers: [] },
          response: { status: 200, content: { text: `<html><form method="POST" action="/u/login/identifier?state=${freshState}"><input type="hidden" name="state" value="${freshState}"/></form></html>` } } },
        { request: { method: 'POST', url: 'https://idp.test/u/login/identifier?state=' + freshState, headers: [{ name: 'Referer', value: 'https://idp.test/u/login/identifier?state=' + freshState }], postData: { text: 'state=' + freshState + '&username=u' } },
          response: { status: 302, content: { text: '' } } },
        { request: { method: 'GET', url: 'https://app.test/redirect/', headers: [] },
          response: { status: 200, content: { text: `<html><form method="POST" action="https://sso.test/authorization/"><input type="hidden" name="token" value="${bridgeToken}"></form></html>` } } },
        { request: { method: 'POST', url: 'https://sso.test/authorization/', headers: [], postData: { text: 'token=' + bridgeToken } },
          response: { status: 302, content: { text: '' } } },
    ];
    const xml = `<jmeterTestPlan><hashTree>
  <HTTPSamplerProxy testname="Step 01 - GET /u/login/identifier" enabled="true">
    <stringProp name="HTTPSampler.path">/u/login/identifier?state=${freshState}</stringProp>
  </HTTPSamplerProxy><hashTree/>
  <HTTPSamplerProxy testname="Step 02 - POST /u/login/identifier" enabled="true">
    <stringProp name="HTTPSampler.path">/u/login/identifier?state=${freshState}</stringProp>
    <stringProp name="Argument.value">${freshState}</stringProp>
  </HTTPSamplerProxy><hashTree>
    <HeaderManager testname="Headers" enabled="true">
      <stringProp name="Header.value">https://idp.test/u/login/identifier?state=${freshState}</stringProp>
    </HeaderManager><hashTree/>
  </hashTree>
  <HTTPSamplerProxy testname="Step 03 - GET /redirect/" enabled="true">
    <stringProp name="HTTPSampler.path">/redirect/</stringProp>
  </HTTPSamplerProxy><hashTree/>
  <HTTPSamplerProxy testname="Step 04 - POST /authorization/" enabled="true">
    <stringProp name="HTTPSampler.path">/authorization/</stringProp>
    <stringProp name="Argument.value">${bridgeToken}</stringProp>
  </HTTPSamplerProxy><hashTree/>
</hashTree></jmeterTestPlan>`;

    const out = correlateFormHiddenInputs(xml, entries);
    assert.strictEqual(out.wired.length, 2, 'state + token both wired');
    const stateWire = out.wired.find(w => w.input === 'state');
    const tokenWire = out.wired.find(w => w.input === 'token');
    assert.ok(stateWire && tokenWire);
    assert.strictEqual(stateWire.producerSampler, 'Step 01 - GET /u/login/identifier');
    assert.strictEqual(tokenWire.producerSampler, 'Step 03 - GET /redirect/');
    // Extractors exist with CSS selector on the hidden input.
    assert.match(out.xml, /HtmlExtractor[^>]*testname="Extract state \(form hidden input\)"/);
    assert.match(out.xml, /input\[name=&quot;token&quot;\]/);
    // Consumers AFTER the producer use ${state}; the producer's own path keeps the recorded literal.
    assert.match(out.xml, /Step 02[^]*?\/u\/login\/identifier\?state=\$\{state\}/);
    assert.match(out.xml, /Header\.value">https:\/\/idp\.test\/u\/login\/identifier\?state=\$\{state\}/);
    assert.match(out.xml, /Step 01[^]*?\/u\/login\/identifier\?state=hKFoFRESHSTATEVALUE123456/);
    assert.match(out.xml, /Argument\.value">\$\{token\}/);
    // Idempotent: running again wires nothing new (literals are gone).
    const again = correlateFormHiddenInputs(out.xml, entries);
    assert.strictEqual(again.wired.length, 0);
});

test('dead-extractor repair: consumers of an extractor under a disabled sampler get the recorded literal back', () => {
    const { repairDeadExtractorConsumers } = require('../src/transforms');
    const entries = [
        { request: { method: 'GET', url: 'https://idp.test/authorize/resume?state=rs1', headers: [] }, response: { status: 302, content: { text: '' } } },
        { request: { method: 'GET', url: 'https://auth.test/iam/callback?attempt=1&code=RECORDEDCODE123&state=rs1', headers: [] }, response: { status: 302, content: { text: '' } } },
    ];
    const xml = `<jmeterTestPlan><hashTree>
  <HTTPSamplerProxy testname="Step 01 - GET /authorize/resume" enabled="false">
    <stringProp name="HTTPSampler.path">/authorize/resume?state=rs1</stringProp>
  </HTTPSamplerProxy><hashTree>
    <RegexExtractor testname="Extract code" enabled="true">
      <stringProp name="RegexExtractor.refname">code</stringProp>
      <stringProp name="RegexExtractor.regex">code=([^&amp;]+)</stringProp>
    </RegexExtractor><hashTree/>
  </hashTree>
  <HTTPSamplerProxy testname="Step 02 - GET /iam/callback" enabled="true">
    <stringProp name="HTTPSampler.path">/iam/callback?attempt=1&amp;code=\${code}&amp;state=rs1</stringProp>
  </HTTPSamplerProxy><hashTree/>
</hashTree></jmeterTestPlan>`;
    const out = repairDeadExtractorConsumers(xml, entries);
    assert.deepStrictEqual(out.dead, ['code']);
    assert.strictEqual(out.restored.length, 1);
    assert.match(out.xml, /code=RECORDEDCODE123&amp;state=rs1/);
    assert.doesNotMatch(out.xml, /\$\{code\}/);
    // A var also produced by an ENABLED extractor is left alone.
    const xmlLive = xml.replace('testname="Step 01 - GET /authorize/resume" enabled="false"', 'testname="Step 01 - GET /authorize/resume" enabled="true"');
    const out2 = repairDeadExtractorConsumers(xmlLive, entries);
    assert.strictEqual(out2.dead.length, 0);
    assert.match(out2.xml, /\$\{code\}/);
});

test('assertion miner: auto-submit bridge pages get no mined assertions', () => {
    const { _internal } = require('../src/transforms');
    const bridge = '<html><body onload="document.forms[0].submit()"><form method="POST" action="https://sso.test/authorization/"><input type="hidden" name="token" value="abc123def456"/></form></body></html>';
    assert.strictEqual(_internal.isAutoSubmitBridgePage(bridge), true);
    assert.strictEqual(_internal.isAutoSubmitBridgePage('<html><h1>Dashboard</h1><form method="POST"><input type="text" name="q"/></form></html>'), false);
});

test('AI provider label prefers OpenAI over Gemini when both are configured', () => {
    assert.strictEqual(runnerInternal.llmProviderLabel({ OPENAI_API_KEY: 'openai-key', GOOGLE_API_KEY: 'google-key' }), 'OpenAI');
    assert.strictEqual(runnerInternal.llmProviderLabel({ GOOGLE_API_KEY: 'google-key' }), 'Gemini');
    assert.strictEqual(runnerInternal.llmProviderLabel({}), 'none');
});

test('OpenAI escalation request: uses gpt-5.5 with max_completion_tokens', () => {
    const prev = process.env.OPENAI_MODEL;
    delete process.env.OPENAI_MODEL;
    const req = runnerInternal.buildOpenAiChatRequest({
        systemInstruction: 'sys',
        userPrompt: 'user',
    });
    assert.strictEqual(req.model, 'gpt-5.5');
    assert.strictEqual(req.max_completion_tokens, 2048);
    assert.ok(!Object.prototype.hasOwnProperty.call(req, 'max_tokens'));
    if (prev == null) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = prev;
});

test('Gemini fix normalizer only returns an array of fixes', () => {
    assert.deepStrictEqual(runnerInternal.normalizeGeminiFixes([{ kind: 'setSamplerEnabled' }]), [{ kind: 'setSamplerEnabled' }]);
    assert.deepStrictEqual(runnerInternal.normalizeGeminiFixes({ fixes: [{ kind: 'addExtractor' }] }), [{ kind: 'addExtractor' }]);
    assert.deepStrictEqual(runnerInternal.normalizeGeminiFixes({ diagnostics: [] }), []);
});

test('learning store: redacts secrets and normalizes volatile values', () => {
    const raw = 'https://app.test/patient/12345?token=abc123def456&email=alice@example.com';
    const redacted = learningStore.redactSensitive(raw);
    assert.doesNotMatch(redacted, /abc123def456/);
    assert.doesNotMatch(redacted, /alice@example.com/);

    const normalized = learningStore.normalizePattern(raw);
    assert.match(normalized, /\/patient\/:num/);
    assert.doesNotMatch(normalized, /token=/);
});

test('learning store: saves only verified safe lessons and finds matching failures', () => {
    const dir = tmp();
    const storePath = path.join(dir, 'verified-lessons.json');
    const failed = learningStore.learnFromRun({
        storePath,
        flowName: 'demo',
        sourceRun: 'failed-run',
        result: { success: false, samples: [] },
        fixes: [{ kind: 'setSamplerEnabled', sampler: 'Step 01 - GET /avatar/a3bd', enabled: false }],
    });
    assert.strictEqual(failed.learned.length, 0);
    assert.ok(!fs.existsSync(storePath), 'failed runs must not create lessons');

    const learned = learningStore.learnFromRun({
        storePath,
        flowName: 'demo',
        sourceRun: 'green-run',
        result: { success: true, samples: [{ isTransaction: false, success: true }] },
        fixes: [{ kind: 'setSamplerEnabled', sampler: 'Step 01 - GET /avatar/a3bd', enabled: false }],
    });
    assert.strictEqual(learned.learned.length, 1);
    const disk = fs.readFileSync(storePath, 'utf8');
    assert.doesNotMatch(disk, /abc123def456|Bearer|Cookie/i);

    const matches = learningStore.findMatchingLessons({
        storePath,
        failures: [{ samplerName: 'Step 99 - GET /avatar/other', responseCode: '404' }],
    });
    assert.strictEqual(matches.length, 1);
    assert.deepStrictEqual(matches[0].fix, { kind: 'setSamplerEnabled', sampler: 'Step 99 - GET /avatar/other', enabled: false });
});

test('learning store: exports and imports sanitized team bundles', () => {
    const dir = tmp();
    const storePath = path.join(dir, 'verified-lessons.json');
    const exportPath = path.join(dir, 'team-lessons.json');
    const importedPath = path.join(dir, 'imported-lessons.json');

    learningStore.learnFromRun({
        storePath,
        flowName: 'demo',
        sourceRun: 'green-run',
        result: { success: true, samples: [{ isTransaction: false, success: true }] },
        fixes: [{ kind: 'replaceValueWithVar', sampler: 'Step 02 - GET /me', value: 'abc123def456', variable: 'session_id' }],
    });

    const exported = learningStore.exportLessons({ storePath, exportPath });
    assert.strictEqual(exported.count, 1);
    const text = fs.readFileSync(exportPath, 'utf8');
    assert.doesNotMatch(text, /abc123def456/);

    const imported = learningStore.importLessons({ storePath: importedPath, importPath: exportPath });
    assert.strictEqual(imported.imported, 1);
    assert.strictEqual(learningStore.loadLessons(importedPath).length, 1);
});

test('runner learning config: defaults to local verified memory with confidence gate', () => {
    const cfg = runnerInternal.normalizeLearningCfg({});
    assert.strictEqual(cfg.enabled, true);
    assert.strictEqual(cfg.autoApplyMinConfidence, 0.85);
    assert.match(cfg.storePath.replace(/\\/g, '/'), /memory\/verified-lessons\.json$/);

    const disabled = runnerInternal.normalizeLearningCfg({
        enabled: false,
        autoApplyMinConfidence: 2,
        storePath: 'custom.json',
    });
    assert.strictEqual(disabled.enabled, false);
    assert.strictEqual(disabled.autoApplyMinConfidence, 0.99);
    assert.strictEqual(disabled.storePath, 'custom.json');
});

test('Gemini model resolver: defaults to 3.5 Flash and supports 3.1 Pro switch', () => {
    assert.strictEqual(resolveGeminiModel([], {}, {}), 'gemini-3.5-flash');
    assert.strictEqual(resolveGeminiModel(['--gemini-pro'], {}, {}), 'gemini-3.1-pro-preview');
    assert.strictEqual(resolveGeminiModel([], { gemini: { model: 'custom-flash' } }, {}), 'custom-flash');
    assert.strictEqual(resolveGeminiModel(['--gemini-pro'], { gemini: { proModel: 'custom-pro' } }, {}), 'custom-pro');
    assert.strictEqual(resolveGeminiModel(['--gemini-pro'], {}, { GOOGLE_MODEL: 'env-model' }), 'env-model');
});

test('input state: unchanged files are skipped after being processed once', () => {
    const dir = tmp();
    const statePath = path.join(dir, 'processed-inputs.json');
    const input = path.join(dir, 'login.jmx');
    fs.writeFileSync(input, 'first-version');

    const unit = { kind: 'single', primary: input };
    let state = inputState.loadProcessedState(statePath);
    assert.strictEqual(inputState.shouldProcessUnit(unit, state), true);

    inputState.markUnitProcessed(unit, state, statePath);
    state = inputState.loadProcessedState(statePath);
    assert.strictEqual(inputState.shouldProcessUnit(unit, state), false);

    fs.writeFileSync(input, 'second-version-with-different-size');
    state = inputState.loadProcessedState(statePath);
    assert.strictEqual(inputState.shouldProcessUnit(unit, state), true);
});

test('success archive: GREEN output folder is zipped while loose files stay readable', () => {
    const outputRoot = tmp();
    const outDir = path.join(outputRoot, 'flow');
    fs.mkdirSync(path.join(outDir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'flow_report.html'), '<html>GREEN</html>');
    fs.writeFileSync(path.join(outDir, 'nested', 'data.txt'), 'payload');

    const archived = archiveSuccessfulRun({ outputRoot, outDir, name: 'flow', keepOriginals: true });
    assert.ok(archived.ok, archived.error || 'archive should succeed');
    assert.ok(fs.existsSync(archived.zipPath), 'zip should be written');
    assert.ok(fs.existsSync(path.join(outDir, 'flow_report.html')), 'loose report remains readable');

    const zip = fs.readFileSync(archived.zipPath);
    assert.strictEqual(zip.subarray(0, 4).toString('binary'), 'PK\u0003\u0004');
    assert.ok(zip.includes(Buffer.from('flow_report.html')));
    assert.ok(zip.includes(Buffer.from('nested/data.txt')));
});

test('final artifact pointer: creates an obvious top-sorted JMX and instructions file', () => {
    const outDir = tmp();
    const finalJmx = path.join(outDir, 'final_validated.jmx');
    fs.writeFileSync(finalJmx, '<jmeterTestPlan/>');

    const result = writeFinalJmxPointer({
        outDir,
        name: 'createtask',
        finalJmxPath: finalJmx,
        verdict: 'GREEN',
        validated: true,
        businessVerified: false,
    });

    assert.ok(fs.existsSync(path.join(outDir, '00_USE_THIS_FINAL_VALIDATED_createtask.jmx')));
    assert.ok(fs.existsSync(path.join(outDir, '00_OPEN_THIS_FIRST.txt')));
    const guide = fs.readFileSync(result.guidePath, 'utf8');
    assert.match(guide, /USE THIS JMX/);
    assert.match(guide, /00_USE_THIS_FINAL_VALIDATED_createtask\.jmx/);
    assert.match(guide, /does not prove the business record was created/);
});

test('business guard: protects first-party mutating business samplers from disabling', () => {
    const xml = `<?xml version="1.0"?>
<jmeterTestPlan><hashTree>
  <HTTPSamplerProxy testname="Step 01 - POST /tasks" enabled="true">
    <stringProp name="HTTPSampler.domain">stage-gateway.webpt.com</stringProp>
    <stringProp name="HTTPSampler.path">/tasks</stringProp>
    <stringProp name="HTTPSampler.method">POST</stringProp>
  </HTTPSamplerProxy><hashTree/>
  <HTTPSamplerProxy testname="Step 02 - POST /domainreliability/upload" enabled="true">
    <stringProp name="HTTPSampler.domain">beacons.example.com</stringProp>
    <stringProp name="HTTPSampler.path">/domainreliability/upload</stringProp>
    <stringProp name="HTTPSampler.method">POST</stringProp>
  </HTTPSamplerProxy><hashTree/>
  <HTTPSamplerProxy testname="Step 03 - POST /s/interceptor/" enabled="false">
    <stringProp name="HTTPSampler.domain"></stringProp>
    <stringProp name="HTTPSampler.path">/s/interceptor/</stringProp>
    <stringProp name="HTTPSampler.method">POST</stringProp>
  </HTTPSamplerProxy><hashTree/>
  <HTTPSamplerProxy testname="Step 04 - POST /oauth/token" enabled="false">
    <stringProp name="HTTPSampler.domain">stglogin.webpt.com</stringProp>
    <stringProp name="HTTPSampler.path">/oauth/token</stringProp>
    <stringProp name="HTTPSampler.method">POST</stringProp>
  </HTTPSamplerProxy><hashTree/>
</hashTree></jmeterTestPlan>`;
    const guard = businessGuard.buildBusinessGuard({ xml, flowName: 'createtask' });
    assert.ok(!guard.protectedNames.has('Step 03 - POST /s/interceptor/'), 'redirect/interceptor plumbing should not block GREEN');
    assert.ok(!guard.protectedNames.has('Step 04 - POST /oauth/token'), 'SPA oauth/token plumbing should not block GREEN');
    const report = {
        samplersToDisable: [
            { samplerLabel: 'Step 01 - POST /tasks', reason: 'unfixable_after_retry', responseCode: '401' },
            { samplerLabel: 'Step 02 - POST /domainreliability/upload', reason: 'telemetry', responseCode: '404' },
        ],
    };
    const filtered = businessGuard.filterProtectedDisables(report, guard);
    assert.deepStrictEqual(filtered.report.samplersToDisable.map(s => s.samplerLabel), ['Step 02 - POST /domainreliability/upload']);
    assert.deepStrictEqual(filtered.blocked.map(s => s.samplerLabel), ['Step 01 - POST /tasks']);
});

test('LLM schema gate: rejects disabling ambiguous first-party root samplers', () => {
    const validation = {
        accepted: [
            { kind: 'setSamplerEnabled', sampler: 'Step 07 - POST /', enabled: false },
            { kind: 'setSamplerEnabled', sampler: 'Step 09 - POST /domainreliability/upload', enabled: false },
        ],
        rejected: [],
    };
    const filtered = runnerInternal.filterProtectedPatchDisables(validation, {
        enabled: true,
        protectedNames: new Set(),
    });

    assert.deepStrictEqual(filtered.accepted, [
        { kind: 'setSamplerEnabled', sampler: 'Step 09 - POST /domainreliability/upload', enabled: false },
    ]);
    assert.strictEqual(filtered.rejected[0].reason, 'ambiguous_root_sampler_disable');
});

test('business guard: fails GREEN when protected create-task sampler is disabled or missing', () => {
    const xml = `<?xml version="1.0"?>
<jmeterTestPlan><hashTree>
  <HTTPSamplerProxy testname="Step 01 - POST /tasks" enabled="false">
    <stringProp name="HTTPSampler.domain">stage-gateway.webpt.com</stringProp>
    <stringProp name="HTTPSampler.path">/tasks</stringProp>
    <stringProp name="HTTPSampler.method">POST</stringProp>
  </HTTPSamplerProxy><hashTree/>
</hashTree></jmeterTestPlan>`;
    const guard = businessGuard.buildBusinessGuard({ xml, flowName: 'createtask' });
    const result = { success: true, samples: [] };
    const evaluation = businessGuard.evaluateBusinessResult({ result, xml, guard });
    assert.strictEqual(evaluation.ok, false);
    assert.match(evaluation.reason, /disabled/);
});

test('agent config: --agent implies validate mode with safe bounded defaults', () => {
    const opts = resolveAgentOptions(['--agent'], {});
    assert.strictEqual(opts.doAgent, true);
    assert.strictEqual(opts.doRun, true);
    assert.strictEqual(opts.agent.enabled, true);
    assert.strictEqual(opts.agent.maxLlmRounds, 1);
    assert.strictEqual(opts.agent.javaSafeMode, true);
});

test('agent config: --agent overrides config false, --run is deterministic by default', () => {
    const forced = resolveAgentOptions(['--agent'], { agent: { enabled: false } });
    assert.strictEqual(forced.doRun, true);
    assert.strictEqual(forced.agent.enabled, true);

    const enabled = resolveAgentOptions(['--run'], {});
    assert.strictEqual(enabled.doRun, true);
    assert.strictEqual(enabled.agent.enabled, false);

    const configured = resolveAgentOptions(['--run'], { agent: { enabled: true } });
    assert.strictEqual(configured.doRun, true);
    assert.strictEqual(configured.agent.enabled, true);
});

test('agent config labels watch mode clearly', () => {
    assert.strictEqual(labelForAgentOptions(resolveAgentOptions([], {}), false), 'generate only');
    assert.strictEqual(labelForAgentOptions(resolveAgentOptions(['--run'], {}), true), 'generate + run/validate (watch)');
    assert.strictEqual(labelForAgentOptions(resolveAgentOptions(['--agent'], {}), true), 'agent validate (watch)');
});

test('UI run modes map to the expected CLI flags', () => {
    assert.deepStrictEqual(flagsForRunMode('generate'), []);
    assert.deepStrictEqual(flagsForRunMode('run'), ['--run']);
    assert.deepStrictEqual(flagsForRunMode('agent'), ['--agent']);
    assert.deepStrictEqual(flagsForRunMode('unexpected'), []);
});

test('java-safe JMX sanitizer strips JSR223 pre/post processors and reports them', () => {
    const xml = `<jmeterTestPlan><hashTree>
      <ThreadGroup testname="tg"></ThreadGroup><hashTree>
        <JSR223PreProcessor testname="bad pre" enabled="true">
          <stringProp name="scriptLanguage">groovy</stringProp>
        </JSR223PreProcessor>
        <hashTree/>
        <HTTPSamplerProxy testname="Step 01" enabled="true"></HTTPSamplerProxy><hashTree/>
        <JSR223PostProcessor testname="bad post" enabled="true">
          <stringProp name="scriptLanguage">groovy</stringProp>
        </JSR223PostProcessor>
        <hashTree/>
      </hashTree>
    </hashTree></jmeterTestPlan>`;
    const out = sanitizeJavaUnsafeJmx(xml);
    assert.strictEqual(out.changed, true);
    assert.strictEqual(out.removed.length, 2);
    assert.ok(!out.xml.includes('JSR223PreProcessor'));
    assert.ok(!out.xml.includes('JSR223PostProcessor'));
    assert.match(out.xml, /HTTPSamplerProxy/);
});

test('java-safe JMX sanitizer also strips JSR223 blocks with explicit empty hashTree', () => {
    const xml = `<jmeterTestPlan><hashTree>
        <JSR223PreProcessor testname="bad pre" enabled="true">
          <stringProp name="scriptLanguage">groovy</stringProp>
        </JSR223PreProcessor>
        <hashTree>
        </hashTree>
      </hashTree></jmeterTestPlan>`;
    const out = sanitizeJavaUnsafeJmx(xml);
    assert.strictEqual(out.changed, true);
    assert.strictEqual(out.removed.length, 1);
    assert.ok(!out.xml.includes('JSR223PreProcessor'));
});

test('generate: shipped JMX is Java-safe for manual JMeter runs', () => {
    const { entries, pages } = parse(har([
        entry('GET', 'https://app.test/api/items', {
            reqHeaders: [{ name: 'x-request-id', value: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }],
        }),
    ]));
    const out = tmp();
    const gen = generate(entries, pages, out, 'manualsafe');
    const xml = fs.readFileSync(gen.jmxPath, 'utf8');
    assert.strictEqual((xml.match(/<JSR223(?:PreProcessor|PostProcessor)\b/g) || []).length, 0);
    assert.ok(fs.existsSync(path.join(out, 'manualsafe_java_safe_generate.json')), 'should report stripped JSR223 blocks');
});

test('generate: GraphQL query text is not parameterized as test data', () => {
    const gql = 'query GetCurrentUser { currentUser { id name } }';
    const { entries, pages } = parse(har([
        entry('POST', 'https://app.test/graphql', {
            reqHeaders: [{ name: 'Content-Type', value: 'application/json' }],
            postData: { mimeType: 'application/json', text: JSON.stringify({ query: gql, variables: { username: 'alice' } }) },
        }),
    ]));
    const out = tmp();
    generate(entries, pages, out, 'gql');
    const paramsPath = path.join(out, 'gql_parameters.json');
    if (fs.existsSync(paramsPath)) {
        const params = JSON.parse(fs.readFileSync(paramsPath, 'utf8'));
        assert.ok(!params.some(p => p.name === 'query'), 'GraphQL query/mutation documents must not be CSV-parameterized');
    }
});

test('OAuth constants: response_type code is not correlated into protocol syntax', () => {
    const xml = `<jmeterTestPlan><hashTree>
      <HTTPSamplerProxy testname="authorize" enabled="true">
        <stringProp name="HTTPSampler.path">/authorize?response_type=\${response_type}</stringProp>
      </HTTPSamplerProxy>
      <hashTree>
        <HeaderManager enabled="true">
          <collectionProp name="HeaderManager.headers">
            <elementProp name="" elementType="Header">
              <stringProp name="Header.name">Content-Type</stringProp>
              <stringProp name="Header.value">application/x-www-form-urlen\${response_type}d</stringProp>
            </elementProp>
          </collectionProp>
        </HeaderManager>
      </hashTree>
      <HTTPSamplerProxy testname="callback" enabled="true">
        <stringProp name="HTTPSampler.path">/iam/callback?\${response_type}=\${code}</stringProp>
      </HTTPSamplerProxy>
      <hashTree/>
      <HTTPSamplerProxy testname="token" enabled="true">
        <stringProp name="Argument.value">authorization_\${response_type}</stringProp>
      </HTTPSamplerProxy>
      <hashTree/>
    </hashTree></jmeterTestPlan>`;
    const r = generateInternal.repairStaticOauthConstants(xml);
    assert.strictEqual(r.repaired, 1);
    assert.doesNotMatch(r.xml, /\$\{response_type\}/);
    assert.match(r.xml, /response_type=code/);
    assert.match(r.xml, /application\/x-www-form-urlencoded/);
    assert.match(r.xml, /\/iam\/callback\?code=\$\{code\}/);
    assert.match(r.xml, /authorization_code/);
});

test('OAuth manual rule: bare state and nonce are left recorded, not correlated', () => {
    const entries = [
        entry('GET', 'https://login.example.com/authorize?response_type=code&client_id=abc&redirect_uri=https%3A%2F%2Fapp%2Fcb&state=recordedState123&nonce=recordedNonce456'),
    ];
    const corrs = [
        { variableName: 'state', value: 'recordedState123' },
        { variableName: 'nonce', value: 'recordedNonce456' },
        { variableName: 'state', value: 'loginPageState789' },
        { variableName: 'state_4', value: 'serverIssuedLoginState789' },
    ];
    const filtered = generateInternal.filterBareOauthStateNonceCorrelations(corrs, entries);
    assert.deepStrictEqual(filtered.removed.map(c => c.variableName).sort(), ['nonce', 'state', 'state']);
    assert.deepStrictEqual(filtered.kept.map(c => c.variableName), ['state_4']);
});

test('generate: generic browser/OIDC noise is disabled by default; app-specific paths only via run.disableCalls', () => {
    const { entries, pages } = parse(har([
        entry('GET', 'https://www.gstatic.com/ohttp_gateway/hpke_public_keys/sbc_prod?key=AIzaSyFake'),
        entry('POST', 'https://ohttp-relay-safebrowsing-chrome.google.fastly-edge.com/'),
        entry('POST', 'https://beacons.example.com/domainreliability/upload'),
        entry('POST', 'https://login.example.com/'),
        entry('GET', 'https://auth-gateway.example.com/auth-gateway/rbac-public-key/prod'),
        entry('GET', 'https://login.example.com/authorize/resume?state=abc'),
        entry('GET', 'https://auth.example.com/iam/callback?code=abc&state=abc'),
        entry('POST', 'https://login.example.com/oauth/token'),
        entry('GET', 'https://app.test/tasks'),
    ]));
    // Default: only app-agnostic noise + standard OIDC plumbing is disabled.
    const outDefault = tmp();
    const genDefault = generate(entries, pages, outDefault, 'noise');
    const xmlDefault = fs.readFileSync(genDefault.jmxPath, 'utf8');
    assert.strictEqual(samplerEnabledForPath(xmlDefault, 'ohttp_gateway'), false);
    assert.strictEqual(samplerEnabledForDomain(xmlDefault, 'OHTTP_RELAY_SAFEBROWSING_CHROME_SERVER'), false);
    assert.strictEqual(samplerEnabledForPath(xmlDefault, 'domainreliability/upload'), false);
    assert.strictEqual(samplerEnabledForPath(xmlDefault, 'authorize/resume'), false);
    assert.strictEqual(samplerEnabledForPath(xmlDefault, 'oauth/token'), false);
    // App-specific paths are NOT disabled by default — they'd break other apps.
    assert.strictEqual(samplerEnabledForPath(xmlDefault, 'auth-gateway/rbac-public-key'), true);
    assert.strictEqual(samplerEnabledForPath(xmlDefault, 'iam/callback'), true);
    // With run.disableCalls, the app-specific paths are disabled too.
    const outCfg = tmp();
    const genCfg = generate(entries, pages, outCfg, 'noise-cfg', {
        runCfg: { disableCalls: ['/auth-gateway/rbac-public-key', '/iam/callback'] },
    });
    const xmlCfg = fs.readFileSync(genCfg.jmxPath, 'utf8');
    assert.strictEqual(samplerEnabledForPath(xmlCfg, 'auth-gateway/rbac-public-key'), false);
    assert.strictEqual(samplerEnabledForPath(xmlCfg, 'iam/callback'), false);
});

test('generate: step-named samplers are disabled via run.disableCalls, not by default', () => {
    const { entries, pages } = parse(har([
        entry('GET', 'https://app.test/p1'),
        entry('GET', 'https://app.test/p2'),
        entry('GET', 'https://app.test/p3'),
        entry('GET', 'https://app.test/p4'),
        entry('GET', 'https://app.test/p5'),
        entry('GET', 'https://app.test/p6'),
        entry('POST', 'https://login.example.com/'),
    ]));
    const outDefault = tmp();
    const genDefault = generate(entries, pages, outDefault, 'highlighted-noise');
    const xmlDefault = fs.readFileSync(genDefault.jmxPath, 'utf8');
    assert.strictEqual(samplerEnabledForName(xmlDefault, 'Step 07 - POST /'), true,
        'a step-numbered pattern from one recording must not be a global default');
    const outCfg = tmp();
    const genCfg = generate(entries, pages, outCfg, 'highlighted-noise-cfg', {
        runCfg: { disableCalls: ['Step 07 - POST /'] },
    });
    const xmlCfg = fs.readFileSync(genCfg.jmxPath, 'utf8');
    assert.strictEqual(samplerEnabledForName(xmlCfg, 'Step 07 - POST /'), false);
});

function samplerEnabledForPath(xml, pathPart) {
    for (const m of xml.matchAll(/<HTTPSamplerProxy\b([^>]*)>([\s\S]*?)<\/HTTPSamplerProxy>/g)) {
        if (!m[2].includes(pathPart)) continue;
        return /enabled="true"/.test(m[1]);
    }
    return null;
}

function samplerEnabledForDomain(xml, domainPart) {
    for (const m of xml.matchAll(/<HTTPSamplerProxy\b([^>]*)>([\s\S]*?)<\/HTTPSamplerProxy>/g)) {
        if (!m[2].includes(domainPart)) continue;
        return /enabled="true"/.test(m[1]);
    }
    return null;
}

function samplerEnabledForName(xml, samplerName) {
    for (const m of xml.matchAll(/<HTTPSamplerProxy\b([^>]*)>([\s\S]*?)<\/HTTPSamplerProxy>/g)) {
        if (!m[1].includes(`testname="${samplerName}"`)) continue;
        return /enabled="true"/.test(m[1]);
    }
    return null;
}

test('runner JMeter detection falls back to common local install homes', () => {
    const dir = tmp();
    const home = path.join(dir, 'apache-jmeter-5.6.3');
    fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
    const bin = path.join(home, process.platform === 'win32' ? 'bin/jmeter.bat' : 'bin/jmeter');
    fs.writeFileSync(bin, '');
    const resolved = runnerInternal.resolveJMeterBinPath({
        detector: { detect: () => ({ available: false }) },
        homes: [home],
    });
    assert.strictEqual(path.resolve(resolved), path.resolve(bin));
});

/* ─────────── New tests (ingest, extractors, transforms, scrubber, verifier) ─────────── */

test('ingest groups: dual-HAR pair + JMX+sidecar + single HAR', () => {
    const files = ['/in/foo__run1.har', '/in/foo__run2.har', '/in/login.jmx', '/in/login.recording.xml', '/in/standalone.har'];
    const units = groupInputs(files);
    const kinds = units.map(u => u.kind).sort();
    assert.deepStrictEqual(kinds, ['dual-har', 'har', 'jmx']);
    const jmx = units.find(u => u.kind === 'jmx');
    assert.strictEqual(jmx.secondary, '/in/login.recording.xml', 'JMX must be paired with its sidecar');
    const pair = units.find(u => u.kind === 'dual-har');
    assert.strictEqual(pair.primary, '/in/foo__run1.har');
    assert.strictEqual(pair.secondary, '/in/foo__run2.har');
});

test('orphan filtering: CSV-defined vars are not auto-repaired (no JSR223 dump)', () => {
    const { entries, pages } = parse(har([
        entry('POST', 'https://app.test/login', {
            reqHeaders: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
            postData: { mimeType: 'application/x-www-form-urlencoded', text: 'username=alice&password=hunter2' },
        }),
    ]));
    const out = tmp();
    const gen = generate(entries, pages, out, 'login');
    const xml = fs.readFileSync(gen.jmxPath, 'utf8');
    assert.strictEqual((xml.match(/<JSR223PostProcessor\b/g) || []).length, 0, 'no bogus auto-repair JSR223 blocks');
    assert.ok(gen.stats.falseOrphansFiltered >= 2, `expected >=2 false-orphans filtered, got ${gen.stats.falseOrphansFiltered}`);
});

test('extractor planner: locates value in earlier JSON response, emits JSONPostProcessor', () => {
    const e1 = entry('POST', 'https://app.test/auth', { body: '{"token":"abcdef123456"}' });
    const e2 = entry('GET', 'https://app.test/me', { reqHeaders: [{ name: 'X-Token', value: 'abcdef123456' }] });
    const flat = [e1, e2];
    const plan = planExtractor('myToken', [{ name: 'myToken', value: 'abcdef123456' }], flat, 1);
    assert.ok(plan, 'should return an extractor plan');
    assert.strictEqual(plan.type, 'json', 'JSON body → JSONPostProcessor');
    assert.match(plan.block, /JSONPostProcessor/);
    assert.match(plan.block, /\$\.token/);
});

test('extractor planner: Set-Cookie regex is proven against the actual cookie name before use', () => {
    const e1 = entry('POST', 'https://app.test/login');
    e1.response.headers = [{ name: 'Set-Cookie', value: 'stgapp_sess=abc123def456ghi789; Path=/; HttpOnly' }];
    const e2 = entry('POST', 'https://app.test/graphql', { body: '{"sessionId":"Token abc123def456ghi789"}' });

    const plan = planExtractor('sessionId', [{ name: 'sessionId', value: 'abc123def456ghi789' }], [e1, e2], 1);
    assert.ok(plan, 'a verified cookie regex should be planned');
    assert.strictEqual(plan.type, 'regex');
    assert.match(plan.block, /stgapp_sess=\(\[\^;\\r\\n\]\+\)/);
    assert.strictEqual(plan.extractedValue, 'abc123def456ghi789');
});

test('extractor planner: rejects regex plans that do not fetch the recorded value', () => {
    const badPlan = extractorsInternal.verifyRegexPlan({
        varName: 'sessionId',
        expr: '(?i)^Set-Cookie:\\s*sessionId=([^;\\r\\n]+)',
        useHeaders: true,
        body: '',
        headers: [{ name: 'Set-Cookie', value: 'other_cookie=abc123def456ghi789; Path=/' }],
        expectedValue: 'abc123def456ghi789',
    });

    assert.strictEqual(badPlan.ok, false);
    assert.strictEqual(badPlan.reason, 'no_match');
});

test('knownDefinedVars detects CSVDataSet columns even with a wide block', () => {
    const xml = `
        <CSVDataSet><stringProp name="delimiter">,</stringProp><stringProp name="fileEncoding">UTF-8</stringProp>
        <stringProp name="filename">data.csv</stringProp><boolProp name="ignoreFirstLine">true</boolProp>
        <boolProp name="quotedData">false</boolProp><boolProp name="recycle">true</boolProp>
        <stringProp name="shareMode">shareMode.all</stringProp><boolProp name="stopThread">false</boolProp>
        <stringProp name="variableNames">a,b,c</stringProp>
        </CSVDataSet>`;
    const def = knownDefinedVars(xml);
    assert.ok(def.has('a') && def.has('b') && def.has('c'), 'should detect CSV columns even when block is wider than 200 chars');
});

test('wrapPollingInWhileController: wraps consecutive same-endpoint samplers', () => {
    const fakeXml = `
        <HTTPSamplerProxy testname="Step 01 - POST /job"></HTTPSamplerProxy><hashTree/>
        <HTTPSamplerProxy testname="Step 02 - GET /status"></HTTPSamplerProxy><hashTree/>
        <HTTPSamplerProxy testname="Step 03 - GET /status"></HTTPSamplerProxy><hashTree/>
        <HTTPSamplerProxy testname="Step 04 - GET /status"></HTTPSamplerProxy><hashTree/>`;
    const out = wrapPollingInWhileController(fakeXml, [{ endpoint: 'GET /status', count: 3, startOrder: 1 }]);
    assert.strictEqual(out.wrapped, 1);
    assert.match(out.xml, /<WhileController/);
    assert.match(out.xml, /Polling: GET \/status/);
});

test('ghost synthesizer: refuses HMAC/signing-key fields (no fake generation)', () => {
    const fakeXml = `<ThreadGroup></ThreadGroup>\n<hashTree>\n</hashTree>`;
    const { refused } = injectGhostSynthesizers(fakeXml, [
        { paramName: 'x-signature-hmac', sampleValue: 'abc', kind: 'CLIENT_GUID' },
    ]);
    assert.ok(refused.length === 1, 'HMAC-named field should be refused');
    assert.match(refused[0].reason, /signing key/);
});

test('ghost synthesizer: emits per-thread JSR223 PreProcessor for x-request-id UUID', () => {
    const fakeXml = `<ThreadGroup></ThreadGroup>\n<hashTree>\n</hashTree>`;
    const { xml, injected } = injectGhostSynthesizers(fakeXml, [
        { paramName: 'x-request-id', sampleValue: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', kind: 'X_REQUEST_ID' },
    ]);
    assert.strictEqual(injected, 1);
    assert.match(xml, /JSR223PreProcessor/);
    assert.match(xml, /java\.util\.UUID\.randomUUID/);
});

test('assertion miner: emits ResponseAssertion when recording has stable text', () => {
    const fakeXml = `<HTTPSamplerProxy testname="GET /api/x"></HTTPSamplerProxy><hashTree/>`;
    const e = entry('GET', 'https://app.test/api/x', { body: '{"status":"OK","message":"Welcome back"}' });
    const out = injectAssertionsFromMined(fakeXml, [e]);
    assert.ok(out.injected >= 1, 'should inject at least one assertion');
    assert.match(out.xml, /<ResponseAssertion/);
});

test('Gaussian timers: derives mean+stdev from per-page HAR gaps', () => {
    const fakeXml = `<TransactionController testname="Login"></TransactionController>\n<hashTree>\n</hashTree>`;
    const entries = [
        { startedDateTime: '2026-01-01T00:00:00.000Z', time: 100, pageref: 'p1', request: { url: 'a', method: 'GET' }, response: {} },
        { startedDateTime: '2026-01-01T00:00:03.000Z', time: 100, pageref: 'p1', request: { url: 'b', method: 'GET' }, response: {} },
        { startedDateTime: '2026-01-01T00:00:06.000Z', time: 100, pageref: 'p1', request: { url: 'c', method: 'GET' }, response: {} },
    ];
    const out = injectGaussianTimers(fakeXml, entries, [{ id: 'p1', title: 'Login' }]);
    assert.strictEqual(out.injected, 1);
    assert.match(out.xml, /<GaussianRandomTimer/);
});

test('listener strip: disables GUI listeners + appends SimpleDataWriter', () => {
    const fakeXml = `<ResultCollector guiclass="ViewResultsFullVisualizer" enabled="true"></ResultCollector><ResultCollector guiclass="StatVisualizer" enabled="true"></ResultCollector>\n    </hashTree>\n  </hashTree>`;
    const out = stripGuiListenersForRun(fakeXml, 'C:/tmp/final.jtl');
    assert.strictEqual(out.disabled, 2);
    assert.match(out.xml, /SimpleDataWriter/);
    assert.ok(!/enabled="true"[^>]*>(?:[\s\S](?!SimpleDataWriter))*?ResultCollector/.test(out.xml.replace(/SimpleDataWriter[\s\S]*$/, '')), 'all GUI listeners disabled');
});

test('scrubber: redacts password, Authorization, api_key — keeps tokens intact', () => {
    const xml = `<samplerData>POST https://x/login
username=alice&amp;password=hunter2</samplerData>
<requestHeader>Authorization: Bearer eyJhbGciOiJIUzI1NiJ9</requestHeader>
<responseData>{"username":"alice","api_key":"sk_live_abc","session":"keep-me"}</responseData>`;
    const { xml: out, hits } = scrubRecordingXml(xml);
    assert.match(out, /password=\*\*\*REDACTED\*\*\*/);
    assert.match(out, /Authorization:\s*\*\*\*REDACTED\*\*\*/);
    assert.match(out, /"api_key"\s*:\s*"\*\*\*REDACTED\*\*\*"/);
    assert.doesNotMatch(out, /keep-me.*REDACTED/, '"session" is not in the secret list');
    assert.ok(hits.length >= 3, `expected >=3 redactions, got ${hits.length}`);
});

test('host rewrite: only the primary host is repointed, third-party hosts unchanged', () => {
    const xml = `<HTTPSamplerProxy><stringProp name="HTTPSampler.domain">prod.example.com</stringProp><stringProp name="HTTPSampler.protocol">https</stringProp><stringProp name="HTTPSampler.port"></stringProp></HTTPSamplerProxy>
<HTTPSamplerProxy><stringProp name="HTTPSampler.domain">cdn.thirdparty.com</stringProp><stringProp name="HTTPSampler.protocol">https</stringProp><stringProp name="HTTPSampler.port"></stringProp></HTTPSamplerProxy>`;
    const out = rewriteHost(xml, 'prod.example.com', 'https://staging.example.com');
    assert.strictEqual(out.count, 1);
    assert.match(out.xml, /staging\.example\.com/);
    assert.match(out.xml, /cdn\.thirdparty\.com/, 'third-party host must be left alone');
});

test('verifier shape diff: detects JSON-key-set divergence', () => {
    assert.strictEqual(verifierInternal.safeJsonShape('{"a":1,"b":2}'), 'a,b');
    assert.strictEqual(verifierInternal.safeJsonShape('{"b":2,"a":1}'), 'a,b', 'key order should not matter');
    assert.notStrictEqual(verifierInternal.safeJsonShape('{"a":1}'), verifierInternal.safeJsonShape('{"b":1}'));
});

test('fast-replay substituteVars: only replaces ${KNOWN} vars', () => {
    const out = replayInternal.substituteVars('hi ${name}, ts=${ts}, keep=${UNKNOWN}', { name: 'alice', ts: '42' });
    assert.strictEqual(out, 'hi alice, ts=42, keep=${UNKNOWN}');
});

test('fast-replay cookie jar: round-trips Set-Cookie within the same host', () => {
    const jar = new Map();
    replayInternal.rememberSetCookie(jar, 'app.test', 'SESSION=abc; Path=/');
    replayInternal.rememberSetCookie(jar, 'app.test', ['CSRF=xyz; HttpOnly']);
    const cookieHeader = replayInternal.joinCookies(jar, 'app.test');
    assert.match(cookieHeader, /SESSION=abc/);
    assert.match(cookieHeader, /CSRF=xyz/);
    assert.strictEqual(replayInternal.joinCookies(jar, 'other.test'), '', 'cookies are host-scoped');
});

test('reasoning trace: written as both .json and .md when steps were taken', () => {
    const { entries, pages } = parse(har([
        entry('POST', 'https://app.test/login', {
            reqHeaders: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
            postData: { mimeType: 'application/x-www-form-urlencoded', text: 'username=alice&password=hunter2' },
        }),
    ]));
    const out = tmp();
    generate(entries, pages, out, 'login');
    assert.ok(fs.existsSync(path.join(out, 'login_reasoning.json')), 'structured reasoning written');
    assert.ok(fs.existsSync(path.join(out, 'login_reasoning.md')), 'markdown reasoning written');
    const md = fs.readFileSync(path.join(out, 'login_reasoning.md'), 'utf8');
    assert.match(md, /# Reasoning trace/);
    assert.match(md, /Hypothesis/);
});

test('baseline diff: returns empty drift when no JTL is present', () => {
    const out = tmp();
    const r = diffRunAgainstRecording({ outDir: out, flatEntries: [] });
    assert.strictEqual(r.jtlPath, null);
    assert.strictEqual(r.drift.length, 0);
});

test('verifier fast JTL summary treats httpSample as a request even with a plain label', () => {
    const dir = tmp();
    const jtl = path.join(dir, 'results.jtl');
    fs.writeFileSync(jtl, `<?xml version="1.0" encoding="UTF-8"?>
<testResults>
  <sample lb="Login" rc="200" s="true"/>
  <httpSample lb="Submit Form" rc="500" s="false"/>
</testResults>`);

    const samples = summarizeJtlFast(jtl);

    assert.strictEqual(samples.find(s => s.label === 'Login').isTransaction, true);
    assert.strictEqual(samples.find(s => s.label === 'Submit Form').isTransaction, false);
});

/* ─────────── Fix-pass tests (dual-JMX, load profile, cookie domain, patcher) ─────────── */

test('ingest groups: dual-JMX pair (with sidecars) is detected as kind=dual-jmx', () => {
    const files = [
        '/in/foo__run1.jmx', '/in/foo__run1.recording.xml',
        '/in/foo__run2.jmx', '/in/foo__run2.recording.xml',
        '/in/standalone.har',
    ];
    const units = groupInputs(files);
    const kinds = units.map(u => u.kind).sort();
    assert.deepStrictEqual(kinds, ['dual-jmx', 'har'], `kinds should be dual-jmx + har, got ${kinds}`);
    const dj = units.find(u => u.kind === 'dual-jmx');
    assert.strictEqual(dj.primary, '/in/foo__run1.jmx');
    assert.strictEqual(dj.secondary, '/in/foo__run2.jmx');
    assert.strictEqual(dj.sidecars.primary, '/in/foo__run1.recording.xml');
    assert.strictEqual(dj.sidecars.secondary, '/in/foo__run2.recording.xml');
});

test('ingest groups: dual-JMX without sidecars still detected (sidecars optional)', () => {
    const files = ['/in/login__run1.jmx', '/in/login__run2.jmx'];
    const units = groupInputs(files);
    assert.strictEqual(units.length, 1);
    assert.strictEqual(units[0].kind, 'dual-jmx');
    assert.strictEqual(units[0].sidecars.primary, undefined);
    assert.strictEqual(units[0].sidecars.secondary, undefined);
});

test('load profile: rewrites num_threads + ramp_time on first ThreadGroup', () => {
    const xml = `
        <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="TG" enabled="true">
          <stringProp name="ThreadGroup.on_sample_error">continue</stringProp>
          <elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController" testname="Loop Controller" enabled="true">
            <boolProp name="LoopController.continue_forever">false</boolProp>
            <stringProp name="LoopController.loops">1</stringProp>
          </elementProp>
          <stringProp name="ThreadGroup.num_threads">1</stringProp>
          <stringProp name="ThreadGroup.ramp_time">1</stringProp>
          <boolProp name="ThreadGroup.scheduler">false</boolProp>
          <stringProp name="ThreadGroup.duration"></stringProp>
        </ThreadGroup>`;
    const r = applyLoadProfile(xml, { users: 50, rampUpSec: 60, loops: 10 });
    assert.match(r.xml, /num_threads">50</);
    assert.match(r.xml, /ramp_time">60</);
    assert.match(r.xml, /LoopController.loops">10</);
    assert.match(r.xml, /ThreadGroup.scheduler">false</);
    assert.strictEqual(r.applied.users, 50);
    assert.strictEqual(r.applied.loops, 10);
});

test('load profile: holdSec enables scheduler + forces infinite loops', () => {
    const xml = `
        <ThreadGroup>
          <elementProp name="ThreadGroup.main_controller" elementType="LoopController">
            <boolProp name="LoopController.continue_forever">false</boolProp>
            <stringProp name="LoopController.loops">1</stringProp>
          </elementProp>
          <stringProp name="ThreadGroup.num_threads">1</stringProp>
          <stringProp name="ThreadGroup.ramp_time">1</stringProp>
          <boolProp name="ThreadGroup.scheduler">false</boolProp>
          <stringProp name="ThreadGroup.duration"></stringProp>
        </ThreadGroup>`;
    const r = applyLoadProfile(xml, { users: 10, holdSec: 300, loops: 999 });
    assert.match(r.xml, /num_threads">10</);
    assert.match(r.xml, /ThreadGroup.duration">300</);
    assert.match(r.xml, /ThreadGroup.scheduler">true</);
    assert.match(r.xml, /LoopController.loops">-1</);
    assert.match(r.xml, /LoopController.continue_forever">true</);
    assert.strictEqual(r.applied.loops, undefined, 'loops should be ignored when holdSec is set');
});

test('load profile: applies to ALL Thread Groups, not just the first', () => {
    const tg = (n) => `
        <ThreadGroup testclass="ThreadGroup" testname="TG${n}" enabled="true">
          <stringProp name="ThreadGroup.num_threads">1</stringProp>
          <stringProp name="ThreadGroup.ramp_time">1</stringProp>
        </ThreadGroup>`;
    const xml = tg(1) + tg(2);
    const r = applyLoadProfile(xml, { users: 30, rampUpSec: 20 });
    assert.strictEqual((r.xml.match(/num_threads">30</g) || []).length, 2, 'both Thread Groups profiled');
    assert.strictEqual(r.applied.threadGroups, 2);
});

test('load profile: empty profile is a no-op (applied=null)', () => {
    const xml = `<ThreadGroup><stringProp name="ThreadGroup.num_threads">1</stringProp></ThreadGroup>`;
    const r = applyLoadProfile(xml, {});
    assert.strictEqual(r.applied, null);
    assert.strictEqual(r.xml, xml);
});

test('load profile: idempotent (re-applying the same profile yields same XML)', () => {
    const xml = `<ThreadGroup>
      <stringProp name="ThreadGroup.num_threads">1</stringProp>
      <stringProp name="ThreadGroup.ramp_time">1</stringProp>
    </ThreadGroup>`;
    const a = applyLoadProfile(xml, { users: 25, rampUpSec: 15 });
    const b = applyLoadProfile(a.xml, { users: 25, rampUpSec: 15 });
    assert.strictEqual(a.xml, b.xml);
});

test('cookie domain match: bank.com cookie is NOT sent to evilbank.com', () => {
    const { cookieDomainMatches } = replayInternal;
    assert.strictEqual(cookieDomainMatches('bank.com', 'bank.com'), true);
    assert.strictEqual(cookieDomainMatches('api.bank.com', 'bank.com'), true);
    assert.strictEqual(cookieDomainMatches('api.bank.com', '.bank.com'), true);
    assert.strictEqual(cookieDomainMatches('evilbank.com', 'bank.com'), false, 'suffix-confusion must be blocked');
    assert.strictEqual(cookieDomainMatches('bank.com.evil', 'bank.com'), false);
    assert.strictEqual(cookieDomainMatches('', 'bank.com'), false);
});

test('LLM patcher: addExtractor (JSON) inserts a JSONPostProcessor after the named sampler', () => {
    const xml = `<HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="Step 01 - POST /auth" enabled="true"></HTTPSamplerProxy>\n<hashTree/>`;
    const r = applyLlmPatches(xml, [{
        kind: 'addExtractor', sampler: 'Step 01 - POST /auth',
        variable: 'token', type: 'json', path: '$.token',
    }]);
    assert.strictEqual(r.applied.length, 1);
    assert.strictEqual(r.skipped.length, 0);
    assert.match(r.xml, /<JSONPostProcessor\b/);
    assert.match(r.xml, /JSONPostProcessor\.referenceNames">token</);
    assert.match(r.xml, /\$\.token/);
});

test('LLM patcher: replaceValueWithVar swaps literal inside stringProp content only', () => {
    const xml =
        `<HTTPSamplerProxy testname="Step 01 - GET /me" enabled="true">` +
        `<stringProp name="HTTPSampler.path">/users/abc123def</stringProp>` +
        `<stringProp name="HTTPSampler.method">GET</stringProp>` +
        `</HTTPSamplerProxy>`;
    const r = applyLlmPatches(xml, [{
        kind: 'replaceValueWithVar', sampler: 'Step 01 - GET /me',
        value: 'abc123def', variable: 'userId',
    }]);
    assert.strictEqual(r.applied.length, 1);
    assert.match(r.xml, /\/users\/\$\{userId\}/);
    assert.doesNotMatch(r.xml, /abc123def/);
});

test('LLM patcher: refuses short value (would shred XML)', () => {
    const xml = `<HTTPSamplerProxy testname="x" enabled="true"><stringProp name="x">abc</stringProp></HTTPSamplerProxy>`;
    const r = applyLlmPatches(xml, [{ kind: 'replaceValueWithVar', value: 'a', variable: 'v' }]);
    assert.strictEqual(r.applied.length, 0);
    assert.strictEqual(r.skipped[0].reason, 'value_too_short');
});

test('LLM patcher: setSamplerEnabled flips the enabled attribute on a named sampler', () => {
    const xml = `<HTTPSamplerProxy testname="Bad Step" enabled="true"></HTTPSamplerProxy>`;
    const r = applyLlmPatches(xml, [{ kind: 'setSamplerEnabled', sampler: 'Bad Step', enabled: false }]);
    assert.strictEqual(r.applied.length, 1);
    assert.match(r.xml, /testname="Bad Step" enabled="false"/);
});

test('LLM patcher: unknown kind is recorded as skipped (no silent drop)', () => {
    const xml = `<x/>`;
    const r = applyLlmPatches(xml, [{ kind: 'rewriteGroovyScript', script: 'whatever' }]);
    assert.strictEqual(r.applied.length, 0);
    assert.strictEqual(r.skipped[0].reason, 'unsupported_kind');
    assert.strictEqual(r.skipped[0].kind, 'rewriteGroovyScript');
});

test('LLM patcher: lenient input — `action`/`samplerName`/`refname` aliases are normalized', () => {
    const xml = `<HTTPSamplerProxy testname="Step 02" enabled="true"></HTTPSamplerProxy>\n<hashTree/>`;
    const r = applyLlmPatches(xml, [{
        action: 'addExtractor', samplerName: 'Step 02',
        refname: 'sessionId', type: 'json', jsonPath: '$.session.id',
    }]);
    assert.strictEqual(r.applied.length, 1, JSON.stringify(r.skipped));
    assert.match(r.xml, /sessionId/);
});

test('LLM patch validator: auto-apply accepts only exact safe patch schema', () => {
    const out = validateLlmPatches([
        { kind: 'addExtractor', sampler: 'Step 01', variable: 'token', type: 'json', path: '$.token' },
        { action: 'addExtractor', samplerName: 'Step 02', refname: 'sid', type: 'json', jsonPath: '$.session.id' },
        { kind: 'rewriteGroovyScript', script: 'vars.put("x", "y")' },
        { kind: 'setSamplerEnabled', sampler: 'Noise Step', enabled: false, script: 'extra' },
    ]);
    assert.strictEqual(out.accepted.length, 1);
    assert.strictEqual(out.accepted[0].kind, 'addExtractor');
    assert.strictEqual(out.rejected.length, 3);
    assert.deepStrictEqual(out.rejected.map(r => r.reason), ['unknown_field', 'unsupported_kind', 'unknown_field']);
});

test('LLM patch validator: rejects unsafe variable names before auto-apply', () => {
    const out = validateLlmPatches([
        { kind: 'replaceValueWithVar', value: 'abc123def', variable: '__groovy(vars.clear())' },
        { kind: 'addExtractor', sampler: 'Step 01', variable: '${__UUID}', type: 'json', path: '$.id' },
        { kind: 'addExtractor', sampler: 'Step 02', variable: 'safe_token_1', type: 'regex', regex: 'token=([^&]+)' },
    ]);
    assert.strictEqual(out.accepted.length, 1);
    assert.strictEqual(out.accepted[0].variable, 'safe_token_1');
    assert.deepStrictEqual(out.rejected.map(r => r.reason), ['invalid_variable', 'invalid_variable']);
});

test('HTML report: load profile + correlation table + dual-recording panel render when data is present', () => {
    const out = tmp();
    const reportPath = writeHtmlReportFn(out, 'demo', {
        mode: 'generate only (har)', verdict: 'generated',
        stats: { samplers: 2, correlations: 1 },
        samples: [],
        correlations: [{
            variableName: 'token', sourceUrl: 'POST /auth', targetUrl: 'GET /me',
            extractorType: 'json', confidence: 0.93,
        }],
        dualHar: {
            run2File: 'foo__run2.har', dynamicValueCount: 1,
            dynamicsByName: { csrf: [{ value1: 'aaaa', value2: 'bbbb', location: 'body', origin: { sampler: 'GET /', location: 'body' } }] },
        },
        loadProfile: { users: 25, rampUpSec: 30, holdSec: 120 },
        reasoning: [{ phase: 'extractors', hypothesis: 'token from POST /auth', action: 'emitted JSONPostProcessor' }],
    });
    const html = fs.readFileSync(reportPath, 'utf8');
    assert.match(html, /Load profile/);
    assert.match(html, /25 users/);
    assert.match(html, /ramp-up 30s/);
    assert.match(html, /hold 120s/);
    assert.match(html, /Correlations \(1\)/);
    assert.match(html, /token/);
    assert.match(html, /Dual-recording dynamics/);
    assert.match(html, /csrf/);
    assert.match(html, /Reasoning/);
});

test('assertion miner: stringProp names are stable (assert_0, assert_1) — no Math.random churn', () => {
    const fakeXml = `<HTTPSamplerProxy testname="GET /api/x" enabled="true"></HTTPSamplerProxy><hashTree/>`;
    const e = entry('GET', 'https://app.test/api/x', { body: '{"status":"OK","message":"Welcome back, Alice"}' });
    const r1 = injectAssertionsFromMined(fakeXml, [e]);
    const r2 = injectAssertionsFromMined(fakeXml, [e]);
    assert.strictEqual(r1.xml, r2.xml, 'two runs over the same input should produce identical XML');
    assert.match(r1.xml, /name="assert_0"/);
});

test('polling while: when terminator is provided, it overrides the counter condition', () => {
    const fakeXml = `
        <HTTPSamplerProxy testname="Step 01 - GET /s"></HTTPSamplerProxy><hashTree/>
        <HTTPSamplerProxy testname="Step 02 - GET /s"></HTTPSamplerProxy><hashTree/>
        <HTTPSamplerProxy testname="Step 03 - GET /s"></HTTPSamplerProxy><hashTree/>`;
    const terminator = '${__jexl3(vars.get("status") != "PENDING")}';
    const out = wrapPollingInWhileController(fakeXml, [{ endpoint: 'GET /s', count: 3, startOrder: 0, terminator }]);
    assert.strictEqual(out.wrapped, 1);
    assert.ok(out.xml.includes('vars.get(&quot;status&quot;)'), 'WhileController should use the terminator');
});

test('fast-replay E2E: replays against an embedded HTTP server and substitutes ${vars}', async () => {
    let received = null;
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            received = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, echoed: received.url }));
        });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
        const entries = [{
            startedDateTime: '2026-01-01T00:00:00.000Z', time: 5,
            request: {
                method: 'GET', url: `http://127.0.0.1:${port}/api/users/abc?token=$\{TOK\}`,
                headers: [{ name: 'X-Run', value: '${RUN}' }], queryString: [], cookies: [], headersSize: -1, bodySize: 0,
            },
            response: { status: 200, statusText: 'OK', headers: [], cookies: [], content: { size: 0, mimeType: 'application/json', text: '{"ok":true}' }, redirectURL: '', headersSize: -1, bodySize: 0 },
            cache: {}, timings: {},
        }];
        const r = await replayAll({ entries, vars: { TOK: 'real-token', RUN: '7' } });
        assert.strictEqual(r.samples.length, 1);
        assert.strictEqual(r.samples[0].status, 200);
        assert.match(received.url, /token=real-token/, 'var substitution applied to URL');
        assert.strictEqual(received.headers['x-run'], '7', 'var substitution applied to header');
    } finally {
        await new Promise(r => server.close(r));
    }
});

test('replay-correlate: absolute live redirects are replayed against the redirected host', async () => {
    let idpHits = 0;
    let appIdpPathHits = 0;
    const idp = http.createServer((req, res) => {
        idpHits++;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('idp-ok');
    });
    const idpPort = await listenLocal(idp);
    const app = http.createServer((req, res) => {
        if (req.url === '/start') {
            res.writeHead(302, { Location: `http://127.0.0.1:${idpPort}/idp` });
            res.end();
            return;
        }
        if (req.url === '/idp') appIdpPathHits++;
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('wrong-host');
    });
    const appPort = await listenLocal(app);
    try {
        const result = await correlateAndReplay({
            entries: [entry('GET', 'http://recorded.test/start', { body: 'idp-ok' })],
            targetBaseUrl: `http://127.0.0.1:${appPort}`,
        });

        assert.strictEqual(result.reachedEnd, true, JSON.stringify(result.failures));
        assert.strictEqual(idpHits, 1, 'absolute redirect should hit the IdP host once');
        assert.strictEqual(appIdpPathHits, 0, 'absolute redirect path must not be rewritten to the app host');
    } finally {
        await closeServer(app);
        await closeServer(idp);
    }
});

test('engine API contract: src/engine.js exports every member of the documented surface', () => {
    const E = require('../src/engine');
    for (const k of ['HarParser', 'orchestrator', 'jmeterDetector', 'recordingXml', 'stripListenerFilenames',
                     'paramAdvisor', 'dataSynth', 'clientSide', 'jmxSource', 'jtlParser', 'harComparator', 'assertionMiner']) {
        assert.ok(E[k], `engine surface missing: ${k}`);
    }
});

// ─── rewireClientMintedOauthVars ────────────────────────────────────
// Regression for the real-world Auth0 OAuth chain: the engine often adds
// a RegexExtractor for `state` / `nonce` (it sees the same value across
// two recordings and assumes it can be extracted from a response). But
// those values are client-minted CSRF tokens, so the extractor never
// fires and ${state} resolves to "". This transform strips the dud
// extractor and adds a JSR223 PreProcessor that mints fresh values.

function makeOauthJmx(extractorRefname = 'state', urlHasAuthorize = true) {
    // Realistic OAuth2 /authorize entry URL: has client_id + response_type +
    // redirect_uri alongside state/nonce. The transform requires those
    // hallmarks before treating the URL as an OAuth2 entry call.
    const path = urlHasAuthorize
        ? '/authorize?response_type=code&amp;client_id=abc&amp;redirect_uri=cb&amp;state=${state}&amp;nonce=${nonce}'
        : '/api/users?state=${state}';
    return `<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan version="1.2" properties="5.0">
  <hashTree>
    <TestPlan testname="t" enabled="true"><stringProp name="x">y</stringProp></TestPlan>
    <hashTree>
      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="Thread Group" enabled="true">
        <stringProp name="ThreadGroup.num_threads">1</stringProp>
      </ThreadGroup>
      <hashTree>
        <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="GET /authorize" enabled="true">
          <stringProp name="HTTPSampler.path">${path}</stringProp>
          <stringProp name="HTTPSampler.method">GET</stringProp>
        </HTTPSamplerProxy>
        <hashTree>
          <RegexExtractor guiclass="RegexExtractorGui" testclass="RegexExtractor" testname="ext ${extractorRefname}" enabled="true">
            <stringProp name="RegexExtractor.refname">${extractorRefname}</stringProp>
            <stringProp name="RegexExtractor.regex">noop()</stringProp>
            <stringProp name="RegexExtractor.template">$1$</stringProp>
          </RegexExtractor>
          <hashTree/>
        </hashTree>
      </hashTree>
    </hashTree>
  </hashTree>
</jmeterTestPlan>`;
}

test('OAuth rewire: strips dud state extractor + uses native Java-safe synthesizer', () => {
    const xml = makeOauthJmx('state', true);
    const r = rewireClientMintedOauthVars(xml);
    assert.ok(r.rewired.includes('state'), 'state should be rewired');
    assert.ok(r.rewired.includes('nonce'), 'nonce (used in URL) should also be synthesized');
    assert.doesNotMatch(r.xml, /<RegexExtractor[^>]*>[\s\S]*?refname">state</,
        'the dud state RegexExtractor must be gone');
    assert.doesNotMatch(r.xml, /JSR223PreProcessor|scriptLanguage">groovy/);
    assert.match(r.xml, /state=\$\{__RandomString\(32,abcdef0123456789,\)\}.*nonce=\$\{__RandomString\(32,abcdef0123456789,\)\}/,
        'URL vars use native JMeter functions');
});

test('OAuth rewire: no-op when state extractor exists but no /authorize URL uses it', () => {
    const xml = makeOauthJmx('state', /* urlHasAuthorize */ false);
    const r = rewireClientMintedOauthVars(xml);
    assert.strictEqual(r.rewired.length, 0, 'safety guard: must NOT touch non-OAuth state vars');
    assert.match(r.xml, /<RegexExtractor[^>]*>[\s\S]*?refname">state</,
        'extractor for unrelated state var must stay intact');
    assert.doesNotMatch(r.xml, /OAuth state\/nonce synthesizer/);
});

test('Auth0 login state repair: extracts suffixed state from Location header instead of hidden input', () => {
    const xml = `<jmeterTestPlan><hashTree>
      <HTTPSamplerProxy testname="Step 04 - GET /authorize" enabled="true">
        <stringProp name="HTTPSampler.path">/authorize?response_type=code&amp;state=\${state}&amp;nonce=\${nonce}</stringProp>
      </HTTPSamplerProxy>
      <hashTree>
        <HtmlExtractor guiclass="HtmlExtractorGui" testclass="HtmlExtractor" testname="Extract state_4 (CSS)" enabled="true">
          <stringProp name="HtmlExtractor.refname">state_4</stringProp>
          <stringProp name="HtmlExtractor.expr">input[name=&quot;state&quot;]</stringProp>
          <stringProp name="HtmlExtractor.attribute">value</stringProp>
          <stringProp name="HtmlExtractor.default">STATE_4_NOT_FOUND</stringProp>
          <stringProp name="HtmlExtractor.match_number">1</stringProp>
        </HtmlExtractor>
      </hashTree>
      <HTTPSamplerProxy testname="Step 05 - GET /u/login/identifier" enabled="true">
        <stringProp name="HTTPSampler.path">/u/login/identifier?state=\${state_4}</stringProp>
      </HTTPSamplerProxy>
      <hashTree/>
    </hashTree></jmeterTestPlan>`;
    const r = repairAuth0LoginStateExtractors(xml);
    assert.strictEqual(r.repaired, 1);
    assert.doesNotMatch(r.xml, /HtmlExtractor/);
    assert.match(r.xml, /RegexExtractor\.refname">state_4/);
    assert.match(r.xml, /Location:\\s\*\[\^\\r\\n\]\*\[\?&amp;\]state=/);
    assert.match(r.xml, /<stringProp name="Sample\.scope">all<\/stringProp>/);
});

test('OAuth rewire: idempotent (running twice does not double-inject)', () => {
    const once = rewireClientMintedOauthVars(makeOauthJmx('state', true)).xml;
    const twice = rewireClientMintedOauthVars(once).xml;
    assert.doesNotMatch(twice, /JSR223PreProcessor|scriptLanguage">groovy/);
    const nativeFns = (twice.match(/__RandomString\(32,abcdef0123456789,\)/g) || []).length;
    assert.strictEqual(nativeFns, 2, 'state and nonce should each have one native generator');
});

test('OAuth rewire: suffixed names (state_2, nonce_2) are LEFT ALONE — those are IdP session tokens needing extraction', () => {
    // Real-world: Auth0 universal login issues a JWT-style state in the
    // /authorize 302 Location header (state_2, state_3, …). It MUST be
    // extracted from the response, not client-minted. We deliberately
    // do not touch those — only the bare OAuth2 `state` / `nonce`.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan><hashTree>
  <TestPlan/>
  <hashTree>
    <ThreadGroup testname="tg" enabled="true"></ThreadGroup>
    <hashTree>
      <HTTPSamplerProxy testname="s1" enabled="true">
        <stringProp name="HTTPSampler.path">/authorize?response_type=code&amp;client_id=abc&amp;redirect_uri=x&amp;state=\${state_2}&amp;nonce=\${nonce_2}</stringProp>
      </HTTPSamplerProxy>
      <hashTree>
        <RegexExtractor enabled="true">
          <stringProp name="RegexExtractor.refname">state_2</stringProp>
        </RegexExtractor>
        <hashTree/>
        <RegexExtractor enabled="true">
          <stringProp name="RegexExtractor.refname">nonce_2</stringProp>
        </RegexExtractor>
        <hashTree/>
      </hashTree>
    </hashTree>
  </hashTree>
</hashTree></jmeterTestPlan>`;
    const r = rewireClientMintedOauthVars(xml);
    assert.deepStrictEqual(r.rewired, [], 'must NOT clobber suffixed IdP-session vars');
    assert.match(r.xml, /<stringProp name="RegexExtractor\.refname">state_2/,
        'state_2 extractor must remain so server-issued value can be captured');
    assert.match(r.xml, /<stringProp name="RegexExtractor\.refname">nonce_2/);
});

/* ─────────── auto-correlate convergence (body/session dynamics) ─────────── */
const { identifyDynamics, correlateBodyDynamics, _internal: acInternal } = require('../src/auto-correlate');

// Minimal recording entry in the HAR shape auto-correlate consumes. A POST body
// is stored in queryString[] (matching the JTL parser), a Set-Cookie in the
// response headers, so producers/consumers are discoverable.
function recEntry(method, url, { body, setCookie, respBody, reqHeaders } = {}) {
    return {
        request: {
            method, url, headers: reqHeaders || [], cookies: [],
            queryString: body ? [{ name: body, value: '' }] : [],
        },
        response: {
            status: 200,
            headers: setCookie ? [{ name: 'Set-Cookie', value: setCookie }] : [],
            content: { text: respBody || '' },
        },
    };
}
// Two recordings of the same flow with a different session value each run.
const sessionRun = (sess) => [
    recEntry('POST', 'https://app.test/login', { setCookie: `stgapp_sess=${sess}; Path=/; HttpOnly` }),
    recEntry('POST', 'https://app.test/graphql', { body: `{"operationName":"Auth","variables":{"data":{"sessionId":"Token ${sess}"}}}` }),
];

test('auto-correlate: identifyDynamics finds a session value carried in a request BODY (queryString)', () => {
    const dyn = identifyDynamics(sessionRun('a1b2c3d4e5f6g7h8i9j0k'), sessionRun('z9y8x7w6v5u4t3s2r1q0p'));
    assert.ok(dyn.some(d => d.value === 'a1b2c3d4e5f6g7h8i9j0k'),
        'the bare session token embedded in "Token <sess>" must be flagged dynamic');
});

test('auto-correlate: reqBody reads the POST body out of queryString[]', () => {
    const body = acInternal.reqBody(recEntry('POST', 'https://x/y', { body: '{"a":"b"}' }));
    assert.match(body, /"a":"b"/);
});

test('auto-correlate: correlateBodyDynamics substitutes session-in-body + wires a verified extractor', () => {
    const e1 = sessionRun('a1b2c3d4e5f6g7h8i9j0k'), e2 = sessionRun('z9y8x7w6v5u4t3s2r1q0p');
    const jmx = `<jmeterTestPlan><hashTree>
      <HTTPSamplerProxy testname="POST /login"><stringProp name="HTTPSampler.domain">app.test</stringProp><stringProp name="HTTPSampler.path">/login</stringProp></HTTPSamplerProxy>
      <hashTree/>
      <HTTPSamplerProxy testname="POST /graphql"><stringProp name="HTTPSampler.domain">app.test</stringProp><stringProp name="HTTPSampler.path">/graphql</stringProp><stringProp name="Argument.value">{"sessionId":"Token a1b2c3d4e5f6g7h8i9j0k"}</stringProp></HTTPSamplerProxy>
      <hashTree/>
    </hashTree></jmeterTestPlan>`;
    const r = correlateBodyDynamics(jmx, e1, e2);
    assert.ok(r.applied.length >= 1, `expected >=1 applied, got ${r.applied.length}`);
    assert.doesNotMatch(r.xml, /a1b2c3d4e5f6g7h8i9j0k/, 'the literal session value must be replaced');
    assert.match(r.xml, /\$\{[A-Za-z0-9_]+\}/, 'a ${var} must be substituted into the body');
    assert.match(r.xml, /RegexExtractor|JSONPostProcessor|HtmlExtractor/, 'a verified extractor is injected');
});

test('auto-correlate: body-only regex verification ignores response headers', () => {
    const producer = recEntry('GET', 'https://app.test/start', {
        respBody: '{"ok":true}',
    });
    producer.response.headers = [{ name: 'Location', value: '/next?token=abc123def456' }];
    const der = {
        producerUrl: 'https://app.test/start',
        kind: 'regex',
        useHeaders: false,
        refName: 'token',
        expr: 'token=([^&"\\s]+)',
    };

    assert.strictEqual(acInternal.verifyExtractor(der, 'abc123def456', [producer]), false);
    assert.strictEqual(acInternal.verifyExtractor({ ...der, useHeaders: true }, 'abc123def456', [producer]), true);
});

test('auto-correlate: does NOT clobber a value the engine already turned into ${var}', () => {
    const e1 = sessionRun('a1b2c3d4e5f6g7h8i9j0k'), e2 = sessionRun('z9y8x7w6v5u4t3s2r1q0p');
    // Value already correlated (no literal in the JMX) → consumed-gate skips it.
    const jmx = `<jmeterTestPlan><hashTree>
      <HTTPSamplerProxy testname="POST /graphql"><stringProp name="HTTPSampler.path">/graphql</stringProp><stringProp name="Argument.value">{"sessionId":"Token \${SESSION}"}</stringProp></HTTPSamplerProxy>
      <hashTree/>
    </hashTree></jmeterTestPlan>`;
    const r = correlateBodyDynamics(jmx, e1, e2);
    assert.strictEqual(r.applied.length, 0, 'nothing to do — value already a ${var}');
    assert.strictEqual(r.xml, jmx, 'JMX unchanged');
});

test('auto-correlate: no-op without a second recording', () => {
    const r = correlateBodyDynamics('<jmeterTestPlan/>', sessionRun('a1b2c3d4e5f6g7h8i9j0k'), []);
    assert.strictEqual(r.applied.length, 0);
    assert.strictEqual(r.xml, '<jmeterTestPlan/>');
});

test('OAuth rewire: only fires for /authorize URLs with OAuth2 hallmarks (client_id/response_type/redirect_uri)', () => {
    // A generic `/authorize?token=x` (e.g. an internal API endpoint that
    // happens to have "authorize" in the path) should NOT trigger.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan><hashTree>
  <TestPlan/>
  <hashTree>
    <ThreadGroup testname="tg" enabled="true"></ThreadGroup>
    <hashTree>
      <HTTPSamplerProxy testname="s1" enabled="true">
        <stringProp name="HTTPSampler.path">/api/authorize?state=\${state}&amp;token=x</stringProp>
      </HTTPSamplerProxy>
      <hashTree>
        <RegexExtractor enabled="true">
          <stringProp name="RegexExtractor.refname">state</stringProp>
        </RegexExtractor>
        <hashTree/>
      </hashTree>
    </hashTree>
  </hashTree>
</hashTree></jmeterTestPlan>`;
    const r = rewireClientMintedOauthVars(xml);
    assert.deepStrictEqual(r.rewired, [], 'safety: must not rewire on /authorize without OAuth2 query hallmarks');
});
