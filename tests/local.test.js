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
const os = require('os');
const path = require('path');

const { HarParser } = require('../src/engine');
const { generate } = require('../src/generate');
const { writeHtmlReport } = require('../src/report');
const { escalateToLlm } = require('../src/runner');
const { groupInputs } = require('../src/ingest');
const { knownDefinedVars, planExtractor, _internal: extractorsInternal } = require('../src/extractors');
const { wrapPollingInWhileController, injectGhostSynthesizers, injectAssertionsFromMined, injectGaussianTimers, applyLoadProfile, stripGuiListenersForRun, rewireClientMintedOauthVars } = require('../src/transforms');
const { scrubRecordingXml } = require('../src/scrubber');
const { rewriteHost } = require('../src/host-rewrite');
const { diffRunAgainstRecording, _internal: verifierInternal } = require('../src/verifier');
const { replayAll, _internal: replayInternal } = require('../src/fast-replay');
const { applyLlmPatches } = require('../src/llm-patcher');
const { writeHtmlReport: writeHtmlReportFn } = require('../src/report');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'psl-test-')); }
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

test('LLM escalation: clean no-op without a Gemini key', async () => {
    const out = tmp();
    const logs = [];
    await escalateToLlm({
        result: { samples: [{ label: 'GET /x', success: false, responseCode: '500', responseMessage: 'err', isTransaction: false }] },
        jmxPath: path.join(out, 'missing.jmx'), correlations: [], outDir: out, name: 't', onLog: (m) => logs.push(m),
    });
    assert.ok(logs.some(l => /skipped — no Gemini key/.test(l)), 'should log a skip without a key');
    assert.ok(!fs.existsSync(path.join(out, 't_llm_suggestions.json')), 'no suggestions file without a key');
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
    const http = require('http');
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

test('OAuth rewire: strips dud state extractor + injects per-iteration synthesizer', () => {
    const xml = makeOauthJmx('state', true);
    const r = rewireClientMintedOauthVars(xml);
    assert.ok(r.rewired.includes('state'), 'state should be rewired');
    assert.ok(r.rewired.includes('nonce'), 'nonce (used in URL) should also be synthesized');
    assert.doesNotMatch(r.xml, /<RegexExtractor[^>]*>[\s\S]*?refname">state</,
        'the dud state RegexExtractor must be gone');
    assert.match(r.xml, /OAuth state\/nonce synthesizer/, 'PreProcessor inserted');
    // script lives inside a <stringProp>, so " gets XML-encoded as &quot;
    assert.match(r.xml, /vars\.put\(&quot;state&quot;,\s*hex32\(\)\)/);
    assert.match(r.xml, /vars\.put\(&quot;nonce&quot;,\s*hex32\(\)\)/);
    assert.match(r.xml, /state=\$\{state\}.*nonce=\$\{nonce\}/, 'URL var-refs are preserved');
});

test('OAuth rewire: no-op when state extractor exists but no /authorize URL uses it', () => {
    const xml = makeOauthJmx('state', /* urlHasAuthorize */ false);
    const r = rewireClientMintedOauthVars(xml);
    assert.strictEqual(r.rewired.length, 0, 'safety guard: must NOT touch non-OAuth state vars');
    assert.match(r.xml, /<RegexExtractor[^>]*>[\s\S]*?refname">state</,
        'extractor for unrelated state var must stay intact');
    assert.doesNotMatch(r.xml, /OAuth state\/nonce synthesizer/);
});

test('OAuth rewire: idempotent (running twice does not double-inject)', () => {
    const once = rewireClientMintedOauthVars(makeOauthJmx('state', true)).xml;
    const twice = rewireClientMintedOauthVars(once).xml;
    const occurrences = (twice.match(/OAuth state\/nonce synthesizer/g) || []).length;
    assert.strictEqual(occurrences, 1, 'must not inject duplicate PreProcessor');
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
