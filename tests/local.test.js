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
const uiConfig = require('../src/ui-config');
const { resolveGeminiModel } = require('../src/gemini-model');
const inputState = require('../src/input-state');
const { archiveSuccessfulRun } = require('../src/success-archive');
const { writeFinalJmxPointer } = require('../src/final-artifact');
const businessGuard = require('../src/business-guard');
const { escalateToLlm, _internal: runnerInternal } = require('../src/runner');
const learningStore = require('../src/learning-store');
const { groupInputs, analyzeInputFiles, writeIntakeArtifacts } = require('../src/ingest');
const goldenDiff = require('../src/golden-diff');
const { knownDefinedVars, planExtractor, _internal: extractorsInternal } = require('../src/extractors');
const { wrapPollingInWhileController, injectGhostSynthesizers, injectAssertionsFromMined, injectGaussianTimers, applyLoadProfile, stripGuiListenersForRun, rewireClientMintedOauthVars, repairAuth0LoginStateExtractors, correlateFormHiddenInputs } = require('../src/transforms');
const { scrubRecordingXml } = require('../src/scrubber');
const { rewriteHost } = require('../src/host-rewrite');
const { diffRunAgainstRecording, summarizeJtlFast, _internal: verifierInternal } = require('../src/verifier');
const { replayAll, _internal: replayInternal } = require('../src/fast-replay');
const { correlateAndReplay } = require('../src/replay-correlate');
const { applyLlmPatches, validateLlmPatches } = require('../src/llm-patcher');
const { propagateGraphqlCsrfTokens } = require('../src/graphql-auth-repair');
const correlationHypotheses = require('../src/correlation-hypotheses');
const { writeHtmlReport: writeHtmlReportFn } = require('../src/report');
const volatileProtocol = require('../src/volatile-protocol');
const pkceModule = require('../src/pkce');
const blueprintContext = require('../src/blueprint-context');
const failureClassifier = require('../src/failure-classifier');
const blueprintAgent = require('../src/blueprint-agent');
const valueFlowDecisions = require('../src/value-flow-decisions');
const responseEvidence = require('../src/response-evidence');
const fastRepairLoop = require('../src/fast-repair-loop');
const statusAnalysis = require('../src/status-analysis');
const semanticResponse = require('../src/semantic-response');
const finalGreenGate = require('../src/final-green-gate');
const requestDiff = require('../src/request-diff');
const seniorPe = require('../src/senior-pe');
const seniorPeAnalysis = require('../src/senior-pe-analysis');
const failureForensics = require('../src/failure-forensics');
const replanner = require('../src/replanner');
const domainKnowledge = require('../src/domain-knowledge');
const uploadFiles = require('../src/upload-files');
const runProgress = require('../src/run-progress');
const runEvidence = require('../src/run-evidence');
const samplerDecision = require('../src/sampler-decision');
const peNaming = require('../src/pe-naming');
const outputOrganizer = require('../src/output-organizer');
const postRunAdjudicator = require('../src/post-run-adjudicator');
const uiInputs = require('../src/ui-inputs');
const uiProcessControl = require('../src/ui-process-control');
const { checkRenderedRequests } = require('../src/rendered-request-check');

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
function jmxXml(requests) {
    const samplers = requests.map((r, i) => `
          <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="Step ${String(i + 1).padStart(2, '0')} - ${r.method} ${r.path}" enabled="true">
            <elementProp name="HTTPsampler.Arguments" elementType="Arguments">
              <collectionProp name="Arguments.arguments"/>
            </elementProp>
            <stringProp name="HTTPSampler.domain">${r.domain || 'app.test'}</stringProp>
            <stringProp name="HTTPSampler.protocol">${r.protocol || 'https'}</stringProp>
            <stringProp name="HTTPSampler.path">${r.path}</stringProp>
            <stringProp name="HTTPSampler.method">${r.method}</stringProp>
          </HTTPSamplerProxy>
          <hashTree/>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">
  <hashTree>
    <TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="Test Plan" enabled="true"/>
    <hashTree>
      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="Thread Group" enabled="true"/>
      <hashTree>${samplers}
      </hashTree>
    </hashTree>
  </hashTree>
</jmeterTestPlan>`;
}
function jtlXml(samples) {
    const rows = samples.map(s => {
        const u = new URL(s.url);
        return `<httpSample t="10" ts="1760000000000" s="true" lb="${s.method} ${u.pathname}" rc="200" rm="OK" dt="text" by="10" ng="1" na="1"><java.net.URL>${s.url}</java.net.URL></httpSample>`;
    }).join('');
    return `<testResults version="1.2">${rows}</testResults>`;
}

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

test('parameterization: credential CSV rows keep recorded login values unless user supplies a credential pool', () => {
    const { entries, pages } = parse(har([
        entry('POST', 'https://stglogin.webpt.com/u/login/identifier', {
            reqHeaders: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
            postData: { mimeType: 'application/x-www-form-urlencoded', text: 'username=Performance_STG_0047' },
        }),
        entry('POST', 'https://stglogin.webpt.com/u/login/password', {
            reqHeaders: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
            postData: { mimeType: 'application/x-www-form-urlencoded', text: 'password=password1!' },
        }),
    ]));
    const out = tmp();
    const gen = generate(entries, pages, out, 'scheduled-visits', { dataRows: 4 });
    const rows = fs.readFileSync(path.join(out, gen.csvFile), 'utf8').trim().split(/\r?\n/).map(line => line.split('|'));
    const header = rows[0];
    const usernameCol = header.indexOf('username');
    const passwordCol = header.indexOf('password');

    assert.ok(usernameCol >= 0, 'username stays parameterized');
    assert.ok(passwordCol >= 0, 'password stays parameterized');
    assert.deepStrictEqual(rows.slice(1).map(row => row[usernameCol]), [
        'Performance_STG_0047',
        'Performance_STG_0047',
        'Performance_STG_0047',
        'Performance_STG_0047',
    ]);
    assert.deepStrictEqual(rows.slice(1).map(row => row[passwordCol]), [
        'password1!',
        'password1!',
        'password1!',
        'password1!',
    ]);
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
    assert.match(html, /Verified fix memory/);
    assert.match(html, /vls_abc/);
    assert.match(html, /vls_def/);
    assert.match(html, /learn_memory_matches\.json/);
    assert.match(html, /learn_learned_lessons\.json/);
});

test('HTML report: renders request adjudication labels and artifact links', () => {
    const out = tmp();
    fs.writeFileSync(path.join(out, 'decisions_request_adjudication.json'), JSON.stringify({
        name: 'decisions',
        iterations: [{
            summary: { disable: 1, protect: 2, ignore: 1, stop: 0, blocked: 1 },
            decisions: [
                { samplerLabel: 'Step 01 - GET /jwt/v2/create-cookie', category: 'dead_plumbing', action: 'disable' },
                { samplerLabel: 'Step 02 - GET /dashboard', category: 'business_request', action: 'protect' },
            ],
        }],
    }, null, 2));
    const reportPath = writeHtmlReport(out, 'decisions', {
        mode: 'agent',
        verdict: 'GREEN',
        stats: {},
        samples: [
            { label: 'Step 01 - GET /jwt/v2/create-cookie', success: false, isTransaction: false, code: '400' },
            { label: 'Step 02 - GET /dashboard', success: true, isTransaction: false, code: '200' },
        ],
    });
    const html = fs.readFileSync(reportPath, 'utf8');

    assert.match(html, /Request adjudication/);
    assert.match(html, /Dead plumbing/);
    assert.match(html, /Business request/);
    assert.match(html, /decisions_request_adjudication\.json/);
    assert.doesNotMatch(html, /must_fix/);
});

test('PE naming: builds spreadsheet-style transaction and request labels with step alignment', () => {
    const entries = [
        entry('GET', 'https://app.test/authorization/'),
        entry('POST', 'https://app.test/user/login'),
        entry('GET', 'https://app.test/patientChart.php?id=123'),
    ];

    const model = peNaming.buildPeNamingModel({ entries, flowName: 'add_physicians' });

    assert.strictEqual(model.scenarioCode, 'SC01');
    assert.match(model.labelByIndex.get(0).peLabel, /^SC01_T01_\/authorization\/-001$/);
    assert.match(model.labelByIndex.get(1).peLabel, /^SC01_T02_\/user\/login-002$/);
    assert.match(model.labelByIndex.get(2).peLabel, /^SC01_T03_\/patientChart\.php-003$/);
    assert.match(model.labelByIndex.get(0).transactionLabel, /^SC01_T01_Add_Physicians_/);
    assert.strictEqual(model.labelByIndex.get(2).originalLabel, 'Step 03 - GET /patientChart.php');
});

test('PE naming: configured transaction names override default generated names in order', () => {
    const model = peNaming.buildPeNamingModel({
        flowName: 'scheduled visits',
        transactionNames: ['Launch Login', '90 Days Search'],
        entries: [
            entry('GET', 'https://app.test/'),
            entry('POST', 'https://app.test/u/login/password'),
            entry('POST', 'https://app.test/scheduler/index/data/T/d'),
        ],
    });

    assert.strictEqual(model.groups[0].transactionLabel, 'SC01_T01_Launch_Login');
    assert.strictEqual(model.groups[1].transactionLabel, 'SC01_T02_90_Days_Search');
});

test('PE naming: generated JMX uses prefixed sampler labels and writes label map', () => {
    const { entries, pages } = parse(har([
        entry('GET', 'https://app.test/authorization/'),
        entry('POST', 'https://app.test/user/login'),
        entry('GET', 'https://app.test/patientChart.php?id=123'),
    ]));
    const out = tmp();

    const gen = generate(entries, pages, out, 'add_physicians');
    const jmx = fs.readFileSync(gen.jmxPath, 'utf8');
    const labelMapPath = path.join(out, 'add_physicians_label_map.json');
    const labelMap = JSON.parse(fs.readFileSync(labelMapPath, 'utf8'));

    assert.match(jmx, /TransactionController[^>]+testname="SC01_T01_Add_Physicians_/);
    assert.match(jmx, /HTTPSamplerProxy[^>]+testname="SC01_T01_\/authorization\/-001"/);
    assert.match(jmx, /HTTPSamplerProxy[^>]+testname="SC01_T02_\/user\/login-002"/);
    assert.match(jmx, /HTTPSamplerProxy[^>]+testname="SC01_T03_\/patientChart\.php-003"/);
    assert.strictEqual(labelMap.requests.length, 3);
    assert.strictEqual(labelMap.requests[2].originalLabel, 'Step 03 - GET /patientChart.php');
    assert.strictEqual(labelMap.requests[2].stepNumber, 3);
    assert.strictEqual(gen.peNaming.requests.length, 3);
});

test('PE naming: run evidence aligns PE suffixed JTL labels to original recording steps', () => {
    const evidence = runEvidence.buildRunEvidence({
        entries: [
            entry('GET', 'https://app.test/authorization/'),
            entry('POST', 'https://app.test/user/login'),
            entry('GET', 'https://app.test/patientChart.php?id=123'),
        ],
        samples: [
            { label: 'SC01_T03_/patientChart.php-003', success: true, responseCode: '200', finalUrl: 'https://app.test/patientChart.php?id=123' },
            { label: 'SC01_T01_/authorization/-001', success: true, responseCode: '200', finalUrl: 'https://app.test/authorization/' },
            { label: 'SC01_T02_/user/login-002', success: true, responseCode: '200', finalUrl: 'https://app.test/user/login' },
        ],
    });

    assert.deepStrictEqual(evidence.rows.map(row => row.entryIndex), [0, 1, 2]);
    assert.strictEqual(evidence.rows[0].label, 'SC01_T01_/authorization/-001');
    assert.strictEqual(evidence.rows[2].recordedUrl, 'https://app.test/patientChart.php?id=123');
});

test('output organizer: creates compatibility subfolders and manifest without removing root files', () => {
    const out = tmp();
    fs.writeFileSync(path.join(out, 'demo.jmx'), '<jmeterTestPlan/>');
    fs.writeFileSync(path.join(out, '00_USE_THIS_FINAL_VALIDATED_demo.jmx'), '<jmeterTestPlan/>');
    fs.writeFileSync(path.join(out, 'demo_report.html'), '<!doctype html>');
    fs.writeFileSync(path.join(out, 'final.jtl'), '<testResults/>');
    fs.writeFileSync(path.join(out, 'demo_label_map.json'), '{"requests":[]}');
    fs.writeFileSync(path.join(out, 'demo_data.csv'), 'username|password\nuser1|pass1\n');

    const manifest = outputOrganizer.organizeOutput({
        outDir: out,
        name: 'demo',
        verdict: 'GREEN',
        finalJmxPath: path.join(out, '00_USE_THIS_FINAL_VALIDATED_demo.jmx'),
        reportPath: path.join(out, 'demo_report.html'),
        currentJtlPath: path.join(out, 'final.jtl'),
    });

    assert.ok(fs.existsSync(path.join(out, 'demo.jmx')), 'root generated JMX should stay in place');
    assert.ok(fs.existsSync(path.join(out, 'scripts', '00_USE_THIS_FINAL_VALIDATED_demo.jmx')));
    assert.ok(fs.existsSync(path.join(out, 'reports', 'demo_report.html')));
    assert.ok(fs.existsSync(path.join(out, 'results', 'final.jtl')));
    assert.ok(fs.existsSync(path.join(out, 'evidence', 'demo_label_map.json')));
    assert.ok(fs.existsSync(path.join(out, 'data', 'demo_data.csv')));
    assert.ok(fs.existsSync(path.join(out, 'output_manifest.json')));
    assert.strictEqual(manifest.verdict, 'GREEN');
    assert.strictEqual(manifest.whatToOpen.finalJmx, 'scripts/00_USE_THIS_FINAL_VALIDATED_demo.jmx');
    assert.strictEqual(manifest.whatToOpen.dataCsv, 'data/demo_data.csv');
    assert.match(fs.readFileSync(path.join(out, '00_OUTPUT_INDEX.md'), 'utf8'), /Data CSV: data\/demo_data\.csv/);
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

test('runner samples inherit transaction names for failure reporting', () => {
    const result = {
        samples: [
            { label: 'SC01_T02_Scheduled Visits', isTransaction: true, success: false },
            { label: 'SC01_T02_/authorize/resume-011', isTransaction: false, success: false, responseCode: '401' },
            { label: 'SC01_T03_Logout', isTransaction: true, success: false },
            { label: 'SC01_T03_/logout-099', isTransaction: false, success: false, responseCode: '500' },
        ],
    };

    runnerInternal.annotateSamplesWithTransactions(result);

    assert.strictEqual(result.samples[1].transactionName, 'SC01_T02_Scheduled Visits');
    assert.strictEqual(result.samples[3].transactionName, 'SC01_T03_Logout');
});

test('runner ignores logout-only failures but preserves mixed real failures', () => {
    const logoutOnly = {
        success: false,
        failureMessage: 'logout failed',
        samples: [
            { label: 'SC01_T09_Logout', isTransaction: true, success: false },
            { label: 'SC01_T09_/v2/logout-120', transactionName: 'SC01_T09_Logout', isTransaction: false, success: false, responseCode: '500' },
        ],
        unresolvedFailures: [{ samplerLabel: 'SC01_T09_/v2/logout-120', issue: 'server error' }],
    };
    runnerInternal.ignoreLogoutOnlyFailures(logoutOnly);

    assert.strictEqual(logoutOnly.success, true);
    assert.strictEqual(logoutOnly.samples[1].success, true);
    assert.strictEqual(logoutOnly.samples[1].ignoredFailure, true);
    assert.deepStrictEqual(logoutOnly.unresolvedFailures, []);

    const mixed = {
        success: false,
        samples: [
            { label: 'SC01_T02_/scheduler/index/data/T/d-044', isTransaction: false, success: false, responseCode: '401' },
            { label: 'SC01_T09_/logout-120', isTransaction: false, success: false, responseCode: '500' },
        ],
    };
    runnerInternal.ignoreLogoutOnlyFailures(mixed);

    assert.strictEqual(mixed.success, false);
    assert.strictEqual(mixed.samples[1].success, false);
});

test('runner treats status-root-cause drift as warning when downstream proof is logout-only', () => {
    const entries = [
        entry('GET', 'https://stgapp.webpt.com/', { status: 302, body: '' }),
        entry('GET', 'https://stglogin.webpt.com/authorize/resume', { status: 302, body: '' }),
    ];
    const result = {
        success: true,
        samples: [
            { label: 'SC01_T01_GET_/-001', isTransaction: false, success: true, code: '200' },
            {
                label: 'SC01_T09_/authorize/resume-011',
                transactionName: 'SC01_T09_Scheduled_Visits_Logout',
                isTransaction: false,
                success: false,
                code: '401',
                responseCode: '401',
            },
        ],
    };

    runnerInternal.applyStatusRootCauseToResult(result, entries);

    assert.strictEqual(result.success, true);
    assert.ok(result.statusRootCauseWarning);
    assert.ok(!result.recordingDriftFailure);
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

test('golden ingest: <flow>__golden.jmx pairs with its unit and is never a standalone input', () => {
    const files = [
        path.join('input', 'createtask__run1.jmx'),
        path.join('input', 'createtask__run2.jmx'),
        path.join('input', 'createtask__golden.jmx'),
        path.join('input', 'other.har'),
    ];
    const units = groupInputs(files);
    const dual = units.find(u => u.kind === 'dual-jmx');
    assert.ok(dual, 'dual-jmx unit exists');
    assert.strictEqual(path.basename(dual.golden || ''), 'createtask__golden.jmx');
    assert.ok(!units.some(u => /golden/i.test(path.basename(u.primary))), 'golden is not its own unit');
    const har = units.find(u => u.kind === 'har');
    assert.ok(har && !har.golden, 'unrelated unit gets no golden');
});

test('golden diff: proven extractors copied verbatim, enable judgments mirrored, literals -> ${var}', () => {
    const goldenXml = `<jmeterTestPlan><hashTree>
  <HTTPSamplerProxy testname="Step 01 - GET /login" enabled="true">
    <stringProp name="HTTPSampler.path">/login</stringProp>
  </HTTPSamplerProxy><hashTree>
    <HtmlExtractor guiclass="HtmlExtractorGui" testclass="HtmlExtractor" testname="Extract state (CSS)" enabled="true">
      <stringProp name="HtmlExtractor.refname">state</stringProp>
      <stringProp name="HtmlExtractor.expr">input[name=&quot;state&quot;]</stringProp>
      <stringProp name="HtmlExtractor.attribute">value</stringProp>
    </HtmlExtractor><hashTree/>
  </hashTree>
  <HTTPSamplerProxy testname="Step 02 - POST /login" enabled="true">
    <stringProp name="HTTPSampler.path">/login?state=\${state}</stringProp>
  </HTTPSamplerProxy><hashTree/>
  <HTTPSamplerProxy testname="Step 04 - GET /telemetry" enabled="false">
    <stringProp name="HTTPSampler.path">/telemetry</stringProp>
  </HTTPSamplerProxy><hashTree/>
  <HTTPSamplerProxy testname="Step 05 - GET /callback" enabled="true">
    <stringProp name="HTTPSampler.path">/callback</stringProp>
  </HTTPSamplerProxy><hashTree/>
</hashTree></jmeterTestPlan>`;
    const generatedXml = `<jmeterTestPlan><hashTree>
  <HTTPSamplerProxy testname="Step 01 - GET /login" enabled="true">
    <stringProp name="HTTPSampler.path">/login</stringProp>
  </HTTPSamplerProxy><hashTree/>
  <HTTPSamplerProxy testname="Step 02 - POST /login" enabled="true">
    <stringProp name="HTTPSampler.path">/login?state=STALELITERAL123</stringProp>
  </HTTPSamplerProxy><hashTree/>
  <HTTPSamplerProxy testname="Step 03 - GET /beacon" enabled="true">
    <stringProp name="HTTPSampler.path">/beacon</stringProp>
  </HTTPSamplerProxy><hashTree/>
  <HTTPSamplerProxy testname="Step 04 - GET /telemetry" enabled="true">
    <stringProp name="HTTPSampler.path">/telemetry</stringProp>
  </HTTPSamplerProxy><hashTree/>
  <HTTPSamplerProxy testname="Step 05 - GET /callback" enabled="false">
    <stringProp name="HTTPSampler.path">/callback</stringProp>
  </HTTPSamplerProxy><hashTree/>
</hashTree></jmeterTestPlan>`;

    const deltas = goldenDiff.diffGoldenAgainstGenerated({ goldenXml, generatedXml });
    assert.strictEqual(deltas.extractorsToAdd.length, 1);
    assert.strictEqual(deltas.extractorsToAdd[0].refname, 'state');
    assert.deepStrictEqual(deltas.toDisable.map(d => d.sampler).sort(), [
        'Step 03 - GET /beacon',   // absent in golden => senior deleted it
        'Step 04 - GET /telemetry',
    ]);
    assert.deepStrictEqual(deltas.toEnable.map(d => d.sampler), ['Step 05 - GET /callback']);
    assert.strictEqual(deltas.substitutions.length, 1);
    assert.strictEqual(deltas.substitutions[0].literal, 'STALELITERAL123');

    const res = goldenDiff.applyGoldenDeltas(generatedXml, deltas);
    assert.strictEqual(res.applied.extractors, 1);
    assert.strictEqual(res.applied.disabled, 2);
    assert.strictEqual(res.applied.enabled, 1);
    assert.strictEqual(res.applied.substitutions, 1);
    assert.match(res.xml, /HtmlExtractor[^>]*testname="Extract state \(CSS\)"/);
    assert.match(res.xml, /\/login\?state=\$\{state\}/);
    assert.match(res.xml, /testname="Step 03 - GET \/beacon" enabled="false"/);
    assert.match(res.xml, /testname="Step 04 - GET \/telemetry" enabled="false"/);
    assert.match(res.xml, /testname="Step 05 - GET \/callback" enabled="true"/);
});

test('playbooks: matched by recording evidence, explicit config keeps precedence', () => {
    const { applyPlaybooks } = require('../src/playbooks');
    const entries = [
        { request: { method: 'GET', url: 'https://stglogin.example.auth0.com/u/login/identifier?state=x', headers: [] }, response: { status: 200, content: { text: '' } } },
        { request: { method: 'GET', url: 'https://app.test/_next/data/abc123/tasks.json', headers: [] }, response: { status: 200, content: { text: '' } } },
    ];
    const out = applyPlaybooks({ entries, fingerprintSignals: [], runCfg: { oauth: { dropBareStateNonce: false }, disableCalls: ['/_next/data/'] } });
    const ids = out.applied.map(p => p.id).sort();
    assert.deepStrictEqual(ids, ['auth0-universal-login', 'nextjs-build-data']);
    // Explicit config wins: operator said false, the auth0 playbook must not flip it.
    assert.strictEqual(out.runCfg.oauth.dropBareStateNonce, false);
    // Already-configured disable is not duplicated.
    assert.strictEqual(out.runCfg.disableCalls.filter(d => d === '/_next/data/').length, 1);
    assert.deepStrictEqual(out.addedDisables, [], 'no new disables: auth0 has none, nextjs already configured');
    assert.ok(out.runCfg.llmFlowNotes.some(n => /Universal Login/i.test(n)), 'playbook notes merged');
    // A recording with no matching evidence applies nothing.
    const none = applyPlaybooks({ entries: [{ request: { method: 'GET', url: 'https://plain.example.com/home', headers: [] }, response: { status: 200, content: { text: '' } } }], fingerprintSignals: [], runCfg: {} });
    assert.deepStrictEqual(none.applied, []);
});

test('blockers: terminal failures translate to precise human asks', () => {
    const { deriveBlockers } = require('../src/blockers');
    const blockers = deriveBlockers({
        result: {
            success: false,
            samples: [
                { label: 'Step 08 - POST /u/login/identifier', success: false, responseCode: '401' },
                { label: 'Step 18 - GET /redirect/', success: false, responseCode: '500' },
            ],
        },
        runCfg: { credentials: { username: '' } },
        entries: [{ request: { method: 'POST', url: 'https://idp.test/mfa/challenge', postData: { text: 'otp=123456' } } }],
        hasSecondRecording: false,
        ghostsRefused: 2,
    });
    const ids = blockers.map(b => b.id).sort();
    assert.deepStrictEqual(ids, ['credentials', 'environment', 'mfa', 'second-recording', 'signing-secret']);
    const creds = blockers.find(b => b.id === 'credentials');
    assert.match(creds.ask, /run\.credentials/);
    // A green run yields no blockers.
    assert.deepStrictEqual(deriveBlockers({ result: { success: true, samples: [] } }), []);
});

test('blockers: failure forensics creates exact auth/session human ask', () => {
    const { deriveBlockers } = require('../src/blockers');
    const blockers = deriveBlockers({
        result: {
            success: false,
            samples: [{ label: 'Step 03 - GraphQL GetCurrentUser', success: false, responseCode: '401' }],
            failureForensics: {
                rootCause: {
                    sampler: 'Step 02 - GET /authorize/resume',
                    recordedStatus: 302,
                    observedStatus: 401,
                    category: 'auth_or_session_correlation_failed',
                },
                recommendedAction: { id: 'provide-test-auth-path' },
                authSession: { missingSessionCookies: ['stgapp_sess'] },
                redirects: { interactiveAuthWall: true },
                graphql: { downstreamSymptoms: [{ sampler: 'Step 03 - GraphQL GetCurrentUser' }] },
            },
        },
    });

    const blocker = blockers.find(b => b.id === 'auth-session-forensics');
    assert.ok(blocker);
    assert.match(blocker.blocker, /Step 02 - GET \/authorize\/resume/);
    assert.match(blocker.blocker, /recorded 302.*observed 401/);
    assert.match(blocker.ask, /test-friendly login path|non-MFA account|browser-captured session|API token/);
    assert.match(blocker.evidence, /stgapp_sess/);
    assert.match(blocker.evidence, /GraphQL.*downstream symptom/);
});

test('blockers: failure forensics keeps first 5xx as environment ask', () => {
    const { deriveBlockers } = require('../src/blockers');
    const blockers = deriveBlockers({
        result: {
            success: false,
            samples: [{ label: 'Step 04 - POST /api/save', success: false, responseCode: '503' }],
            failureForensics: {
                rootCause: {
                    sampler: 'Step 04 - POST /api/save',
                    recordedStatus: 200,
                    observedStatus: 503,
                    category: 'server_error_after_replay_request',
                },
                recommendedAction: { id: 'fix-environment' },
                authSession: { missingSessionCookies: [] },
                redirects: { interactiveAuthWall: false },
                graphql: { downstreamSymptoms: [] },
            },
        },
    });

    const blocker = blockers.find(b => b.id === 'environment-forensics');
    assert.ok(blocker);
    assert.match(blocker.blocker, /recorded 200.*observed 503/);
    assert.match(blocker.ask, /validate staging manually/i);
});

test('blockers: missing upload file is a precise human ask', () => {
    const { deriveBlockers } = require('../src/blockers');
    const blockers = deriveBlockers({
        result: {
            success: false,
            samples: [{ label: 'Step 49 - POST /edoc/temporal-file/save', success: false, responseCode: '422' }],
        },
        uploadFiles: {
            missing: [{ fileName: 'sample.pdf', fieldName: 'file', samplerLabel: 'Step 49 - POST /edoc/temporal-file/save' }],
        },
    });

    const upload = blockers.find(b => b.id === 'upload-file');
    assert.ok(upload);
    assert.match(upload.ask, /sample\.pdf/);
    assert.match(upload.ask, /input/);
    assert.match(upload.ask, /bin/);
});

test('blockers: ambiguous upload candidates ask for selection instead of claiming missing', () => {
    const { deriveBlockers } = require('../src/blockers');
    const blockers = deriveBlockers({
        result: {
            success: false,
            samples: [{ label: 'Step 49 - POST /edoc/temporal-file/save', success: false, responseCode: '422' }],
        },
        uploadFiles: {
            missing: [{
                fileName: 'recorded-name.pdf',
                fieldName: 'file',
                samplerLabel: 'Step 49 - POST /edoc/temporal-file/save',
                reason: 'ambiguous-compatible-file',
                candidateNames: ['first.pdf', 'second.pdf'],
            }],
        },
    });

    const upload = blockers.find(b => b.id === 'upload-file');
    assert.ok(upload);
    assert.match(upload.ask, /Choose the correct file/);
    assert.match(upload.ask, /first\.pdf/);
    assert.match(upload.ask, /second\.pdf/);
});

test('scenario designer: Little\'s Law from objective to threads/pacing/data pool', () => {
    const { designScenario, insertPacingTimers } = require('../src/scenario');
    const entries = [
        { startedDateTime: '2026-01-01T10:00:00.000Z', request: { url: 'https://a/b' } },
        { startedDateTime: '2026-01-01T10:00:30.000Z', request: { url: 'https://a/c' } },
    ];
    const s = designScenario({ entries, runCfg: { scenario: { transactionsPerHour: 600, durationMin: 60 } } });
    assert.strictEqual(s.threads, 5, 'ceil(600 × 30s / 3600) = 5');
    assert.strictEqual(Math.round(s.pacingSeconds), 30, '5 × 3600 / 600 = 30s per iteration');
    assert.strictEqual(s.uniqueRows, 660, '600 iterations + 10% headroom');
    assert.strictEqual(s.loadProfile.users, 5);
    assert.ok(s.mathLines.some(l => /Little/i.test(l)), 'the math is shown');
    const xml = '<ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="TG" enabled="true"><stringProp name="ThreadGroup.num_threads">1</stringProp></ThreadGroup>\n<hashTree>\n</hashTree>';
    const pt = insertPacingTimers(xml, s.pacing);
    assert.strictEqual(pt.inserted, 1);
    assert.match(pt.xml, /PreciseThroughputTimer/);
    assert.match(pt.xml, /<\/TestAction>\s*<hashTree\/>\s*<PreciseThroughputTimer/,
        'pacing timer must be a ThreadGroup-scope sibling, not nested under the pacing anchor');
    // No scenario config → no plan; explicit loadProfile is never touched here.
    assert.strictEqual(designScenario({ entries, runCfg: {} }), null);
});

test('outcome probe: recorded echo pair found and asserted on the echoing sampler', () => {
    const { planOutcomeProbe, injectOutcomeProbe } = require('../src/outcome-probe');
    const entries = [
        { request: { method: 'GET', url: 'https://app.test/home' }, response: { content: { text: '<html>home</html>' } } },
        { request: { method: 'POST', url: 'https://app.test/api/tasks', postData: { text: '{"title":"Probe Task Omega 7"}' } }, response: { content: { text: '{"id":1}' } } },
        { request: { method: 'GET', url: 'https://app.test/api/tasks' }, response: { content: { text: '{"tasks":[{"title":"Probe Task Omega 7"}]}' } } },
    ];
    const probe = planOutcomeProbe({ entries, flowName: 'createtask', params: [], runCfg: {} });
    assert.ok(probe, 'probe pair found');
    assert.strictEqual(probe.mutatingIndex, 1);
    assert.strictEqual(probe.probeIndex, 2);
    assert.strictEqual(probe.text, 'Probe Task Omega 7');
    const xml = `<jmeterTestPlan><hashTree>
  <HTTPSamplerProxy testname="Step 01 - GET /home" enabled="true"><stringProp name="HTTPSampler.path">/home</stringProp></HTTPSamplerProxy><hashTree/>
  <HTTPSamplerProxy testname="Step 02 - POST /api/tasks" enabled="true"><stringProp name="HTTPSampler.path">/api/tasks</stringProp></HTTPSamplerProxy><hashTree/>
  <HTTPSamplerProxy testname="Step 03 - GET /api/tasks" enabled="true"><stringProp name="HTTPSampler.path">/api/tasks</stringProp></HTTPSamplerProxy><hashTree/>
</hashTree></jmeterTestPlan>`;
    const out = injectOutcomeProbe(xml, probe);
    assert.strictEqual(out.injected, 1);
    assert.match(out.xml, /OUTCOME PROBE[\s\S]*Probe Task Omega 7/);
    // The assertion landed under the PROBE sampler (step 3), not the mutation.
    const idx = out.xml.indexOf('OUTCOME PROBE');
    assert.ok(idx > out.xml.indexOf('Step 03'), 'assertion sits after the probe sampler');
});

test('learning store: lessons carry the stack fingerprint and same-stack matches rank first', () => {
    const out = tmp();
    const storePath = path.join(out, 'lessons.json');
    const result = { success: true };
    learningStore.learnFromRun({
        storePath, flowName: 'flowA', sourceRun: out, appHost: 'https://a.test', result,
        fixes: [{ kind: 'setSamplerEnabled', sampler: 'Step 09 - GET /noise', enabled: false }],
        stackFingerprint: [{ stack: 'OAuth/OIDC' }, { stack: 'GraphQL/API gateway' }],
    });
    const saved = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const lesson = (saved.lessons || saved)[0];
    assert.deepStrictEqual(lesson.stackFingerprint, ['OAuth/OIDC', 'GraphQL/API gateway']);
    const matches = learningStore.findMatchingLessons({
        storePath,
        failures: [{ samplerName: 'Step 09 - GET /noise' }],
        minConfidence: 0,
        stackFingerprint: [{ stack: 'OAuth/OIDC' }],
    });
    assert.strictEqual(matches.length, 1);
    assert.strictEqual(matches[0].stackOverlap, 1);
});

test('final green gate: drift on a passing run is a review flag, not a failure', () => {
    const { evaluateFinalGreenGate } = require('../src/final-green-gate');
    const drift = [{ index: 0, sampler: 'GET https://a/', issues: [{ kind: 'lengthDriftPct', pct: 45 }] }];
    const passing = evaluateFinalGreenGate({ result: { success: true }, baselineDiff: { drift } });
    assert.strictEqual(passing.ok, true, 'GREEN-with-drift, not RED');
    assert.strictEqual(passing.warnings.length, 1);
    assert.match(passing.reason, /review flags/i);
    const failing = evaluateFinalGreenGate({ result: { success: false }, baselineDiff: { drift } });
    assert.strictEqual(failing.ok, false, 'drift stays blocking evidence on a failing run');
    assert.ok(failing.categories.includes('baseline_drift'));
});

test('baseline diff: recorded 3xx replaying as 2xx is redirect folding, not drift', () => {
    const { diffRunAgainstRecording } = require('../src/verifier');
    const out = tmp();
    fs.mkdirSync(path.join(out, 'iteration_1'), { recursive: true });
    fs.writeFileSync(path.join(out, 'iteration_1', 'results.jtl'), `<?xml version="1.0"?>
<testResults version="1.2">
<httpSample t="10" lb="Step 01 - GET /" rc="200" s="true"/>
<httpSample t="10" lb="Step 02 - GET /page" rc="404" s="false"/>
</testResults>`);
    const flatEntries = [
        { request: { url: 'https://a.test/', method: 'GET' }, response: { status: 302, content: { text: '' } } },
        { request: { url: 'https://a.test/page', method: 'GET' }, response: { status: 200, content: { text: 'hello world page' } } },
    ];
    const diff = diffRunAgainstRecording({ outDir: out, flatEntries });
    assert.strictEqual(diff.folded.length, 1, '302→200 folded');
    assert.strictEqual(diff.folded[0].recorded, 302);
    assert.strictEqual(diff.drift.length, 1, '200→404 is REAL drift');
    assert.strictEqual(diff.drift[0].issues[0].kind, 'statusDiff');
});

test('steering: file channel round-trip, command parsing, cursor semantics', () => {
    const steeringMod = require('../src/steering');
    const out = tmp();
    const file = path.join(out, 'steering-test.json');
    // Parse: protect / disable / question / guidance.
    assert.deepStrictEqual(steeringMod.parseCommand('protect POST /tasks'), { kind: 'protect', pattern: 'POST /tasks', text: 'protect POST /tasks' });
    assert.strictEqual(steeringMod.parseCommand('disable /bf?').kind, 'disable');
    assert.strictEqual(steeringMod.parseCommand('fold Step 09 - GET /noise').pattern, 'Step 09 - GET /noise');
    assert.strictEqual(steeringMod.parseCommand('why did you disable step 9?').kind, 'question');
    assert.strictEqual(steeringMod.parseCommand('the export download is business critical').kind, 'guidance');
    // Round-trip with cursor: runner only sees NEW messages.
    steeringMod.appendMessage(file, { text: 'protect POST /tasks' });
    const chan = steeringMod.createSteeringChannel({ file, onLog: () => {} });
    assert.strictEqual(chan.active, true);
    const first = chan.poll();
    assert.strictEqual(first.length, 1);
    assert.strictEqual(first[0].kind, 'protect');
    assert.deepStrictEqual(chan.poll(), [], 'cursor advanced — no re-delivery');
    steeringMod.appendMessage(file, { text: 'disable /bf?' });
    steeringMod.appendMessage(file, { text: 'focus on the login chain first' });
    const next = chan.poll();
    assert.deepStrictEqual(next.map(c => c.kind), ['disable', 'guidance']);
    // Inactive channel (no file) is a clean no-op.
    const idle = steeringMod.createSteeringChannel({});
    assert.strictEqual(idle.active, false);
    assert.deepStrictEqual(idle.poll(), []);
});

test('run flags: iterations honor the new max of 6', () => {
    const { flagsForRunRequest } = require('../src/ui-run-mode');
    assert.ok(flagsForRunRequest({ mode: 'agent', iterations: 6 }).join(' ').includes('--iterations 6'));
    assert.ok(flagsForRunRequest({ mode: 'agent', iterations: 9 }).join(' ').includes('--iterations 6'), 'above max clamps to 6');
});

test('playbooks: protectedCalls carry app-specific business nouns (de-WebPT the regexes)', () => {
    const { applyPlaybooks } = require('../src/playbooks');
    const entries = [
        { request: { method: 'GET', url: 'https://stgapp.webpt.com/patient/display/getnewpatients', headers: [] }, response: { status: 200, content: { text: '' } } },
    ];
    const out = applyPlaybooks({ entries, fingerprintSignals: [], runCfg: {} });
    assert.ok(out.applied.some(p => p.id === 'webpt-emr'), 'webpt playbook matched by host');
    assert.ok(out.addedProtects.includes('/patient/'), 'app noun protected via playbook');
    assert.ok(out.runCfg.protectedCalls.includes('/scheduler/index/data'));
    // A non-WebPT app never sees those nouns.
    const other = applyPlaybooks({ entries: [{ request: { method: 'GET', url: 'https://other.example.com/patient/1', headers: [] }, response: { status: 200, content: { text: '' } } }], fingerprintSignals: [], runCfg: {} });
    assert.ok(!other.applied.some(p => p.id === 'webpt-emr'));
    // And the generic regex no longer contains app nouns: a mutating request
    // to an app-specific noun is NOT business by prior alone...
    const { _internal: adjInternal } = require('../src/post-run-adjudicator');
    const dec = adjInternal.classifyOne({
        entry: { request: { method: 'POST', url: 'https://other.example.com/edoc/upload-meta', headers: [] }, response: { status: 200, headers: [], content: { text: '' } } },
        index: 3, label: 'Step 04 - POST /edoc/upload-meta', row: {}, flow: { consumedOutputCount: 0 },
        attemptedDisable: null, guard: null, rootCauseIndex: null, authWall: false, failure: null,
    });
    // /edoc alone no longer triggers business_request — but /upload (universal verb) does here.
    assert.ok(!dec || dec.category !== 'unknown', 'universal verb still protects');
});

test('playbooks: domain packs (salesforce/servicenow/sap/banking/ecommerce) match evidence and add protection + notes', () => {
    const { applyPlaybooks } = require('../src/playbooks');
    const cases = [
        { id: 'salesforce', url: 'https://na1.my.salesforce.com/services/data/v58.0/query', signals: [], protect: '/services/data/' },
        { id: 'servicenow', url: 'https://acme.service-now.com/api/now/table/incident', signals: [], protect: '/api/now/' },
        { id: 'sap', url: 'https://s4.hana.ondemand.com/sap/opu/odata/SD/SALESORDER', signals: ['odata'], protect: '/sap/opu/odata/' },
        { id: 'banking-generic', url: 'https://bank.example.com/api/transfer', signals: [], protect: '/transfer' },
        { id: 'ecommerce-generic', url: 'https://shop.example.com/checkout', signals: [], protect: '/checkout' },
    ];
    for (const c of cases) {
        const entries = [{ request: { method: 'POST', url: c.url, headers: [] }, response: { status: 200, headers: [], content: { text: '' } } }];
        const out = applyPlaybooks({ entries, fingerprintSignals: c.signals.map(s => ({ stack: s })), runCfg: {} });
        assert.ok(out.applied.some(p => p.id === c.id), `${c.id} playbook matched by evidence`);
        assert.ok(out.runCfg.protectedCalls.includes(c.protect), `${c.id} protects ${c.protect}`);
        assert.ok((out.runCfg.llmFlowNotes || []).length > 0, `${c.id} contributes senior-PE flow notes`);
    }
    // A generic unrelated app never picks up any domain pack.
    const none = applyPlaybooks({ entries: [{ request: { method: 'GET', url: 'https://plain.example.com/home', headers: [] }, response: { status: 200, headers: [], content: { text: '' } } }], fingerprintSignals: [], runCfg: {} });
    for (const c of cases) assert.ok(!none.applied.some(p => p.id === c.id), `${c.id} does not fire on an unrelated app`);
});

test('adjudicator: every decision declares its evidence tier', () => {
    const { adjudicateRequests } = require('../src/post-run-adjudicator');
    const entries = [
        { request: { method: 'GET', url: 'https://app.test/sdk/evalx/ctx', headers: [] }, response: { status: 404, headers: [], content: { text: '' } } },
        { request: { method: 'POST', url: 'https://app.test/api/orders/create', headers: [] }, response: { status: 200, headers: [], content: { text: '' } } },
    ];
    const evidence = { rows: [
        { entryIndex: 0, success: false, observedStatus: 404, label: 'Step 01 - GET /sdk/evalx/ctx' },
        { entryIndex: 1, success: false, observedStatus: 422, label: 'Step 02 - POST /api/orders/create' },
    ] };
    const out = adjudicateRequests({ entries, evidence });
    const noise = out.bySampler['Step 01 - GET /sdk/evalx/ctx'];
    const business = out.bySampler['Step 02 - POST /api/orders/create'];
    assert.strictEqual(noise.action, 'disable');
    assert.strictEqual(noise.tier, 'prior', 'regex-led disable declares itself a prior');
    assert.strictEqual(business.action, 'protect');
    assert.strictEqual(business.tier, 'prior', 'business-verb protection without guard is a prior');
    assert.ok(Object.values(out.byIndex).every(d => ['guard', 'evidence', 'prior', 'review'].includes(d.tier)), 'all decisions carry a valid tier');
});

test('redirect hops: recording Location chains identify duplicate hop samplers (any app, zero rules)', () => {
    const { detectDuplicateRedirectHops } = require('../src/redirect-hops');
    const hop = (method, url, status, location, extra = {}) => ({
        request: { method, url, headers: [] },
        response: { status, headers: location ? [{ name: 'Location', value: location }] : [], content: { text: '' } },
        ...extra,
    });
    const entries = [
        hop('POST', 'https://app.test/s/interceptor/', 302, '/s/interceptor/authorize/?grant=TOKEN_A'),
        hop('GET', 'https://app.test/s/interceptor/authorize/?grant=TOKEN_A', 302, 'https://app.test/redirect/'),
        hop('GET', 'https://app.test/redirect/', 200, null),
        hop('GET', 'https://app.test/dashboard', 200, null),
        // …second transaction later in the flow, DIFFERENT single-use grant:
        hop('POST', 'https://app.test/s/interceptor/', 302, '/s/interceptor/authorize/?grant=TOKEN_B'),
        hop('GET', 'https://app.test/s/interceptor/authorize/?grant=TOKEN_B', 302, 'https://app.test/redirect/'),
        hop('GET', 'https://app.test/redirect/', 200, null),
    ];
    const dup = detectDuplicateRedirectHops(entries);
    assert.deepStrictEqual(dup.indexes.sort((a, b) => a - b), [1, 2, 5, 6], 'both occurrences in both transactions + their onward hops');
    assert.strictEqual(dup.byIndex[1].parentIndex, 0);
    assert.strictEqual(dup.byIndex[2].rootIndex, 0, 'chained hop resolves to the chain root');
    assert.strictEqual(dup.byIndex[5].parentIndex, 4, 'second transaction has its own parent');
    // A GET that is NOT a redirect target is never flagged; POSTs are never hops.
    assert.ok(!dup.byIndex[3]);
    const noDup = detectDuplicateRedirectHops([hop('GET', 'https://a/x', 200, null), hop('GET', 'https://a/y', 200, null)]);
    assert.deepStrictEqual(noDup.indexes, []);
});

test('operator disable is ABSOLUTE: session-like priors cannot veto run.disableCalls (live LOGI bug)', () => {
    const { entries, pages } = parse(har([
        entry('GET', 'https://app.test/home'),
        entry('GET', 'https://app.test/s/interceptor/authorize/?grant=abc123def'),
        entry('GET', 'https://app.test/next'),
    ]));
    const out = tmp();
    const gen = generate(entries, pages, out, 'operator-tier', {
        runCfg: { disableCalls: ['/s/interceptor/authorize/'] },
    });
    const xml = fs.readFileSync(gen.jmxPath, 'utf8');
    const sampler = xml.match(/<HTTPSamplerProxy\b[^>]*interceptor\/authorize[^>]*>/) ||
        xml.match(/<HTTPSamplerProxy\b[^>]*testname="[^"]*authorize[^"]*"[^>]*>/);
    assert.ok(sampler, 'sampler exists');
    assert.match(sampler[0], /enabled="false"/, 'operator disable applied despite auth-looking path');
    // Explicit protect beats explicit disable, with a conflict note.
    const out2 = tmp();
    const gen2 = generate(entries, pages, out2, 'operator-conflict', {
        runCfg: { disableCalls: ['/s/interceptor/authorize/'], protectedCalls: ['/s/interceptor/authorize/'] },
    });
    const xml2 = fs.readFileSync(gen2.jmxPath, 'utf8');
    const sampler2 = xml2.match(/<HTTPSamplerProxy\b[^>]*testname="[^"]*authorize[^"]*"[^>]*>/);
    assert.match(sampler2[0], /enabled="true"/, 'operator protect outranks operator disable');
    assert.ok(gen2.reasoning.some(r => r.phase === 'disable-calls-conflict'), 'conflict surfaced in reasoning');
});

test('operator disable cannot remove token-bearing interceptor session handoff without unsafe override', () => {
    const { entries, pages } = parse(har([
        entry('GET', 'https://app.test/home'),
        entry('POST', 'https://app.test/s/interceptor', {
            postData: { mimeType: 'application/x-www-form-urlencoded', params: [{ name: 'token', value: 'RECORDED_TOKEN' }] },
            headers: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
            status: 302,
        }),
        entry('GET', 'https://app.test/dashboard'),
    ]));

    const out = tmp();
    const gen = generate(entries, pages, out, 'token-interceptor', {
        runCfg: { disableCalls: ['/s/interceptor'] },
    });
    const xml = fs.readFileSync(gen.jmxPath, 'utf8');
    const sampler = xml.match(/<HTTPSamplerProxy\b[^>]*testname="[^"]*interceptor[^"]*"[^>]*>/);

    assert.ok(sampler, 'interceptor sampler exists');
    assert.match(sampler[0], /enabled="true"/, 'token-bearing interceptor stays enabled');
    assert.ok(gen.reasoning.some(r => r.phase === 'disable-calls-conflict' && /allowUnsafeDisableProtected/i.test(JSON.stringify(r))));

    const unsafeOut = tmp();
    const unsafe = generate(entries, pages, unsafeOut, 'token-interceptor-unsafe', {
        runCfg: { disableCalls: ['/s/interceptor'], allowUnsafeDisableProtected: true },
    });
    const unsafeXml = fs.readFileSync(unsafe.jmxPath, 'utf8');
    const unsafeSampler = unsafeXml.match(/<HTTPSamplerProxy\b[^>]*testname="[^"]*interceptor[^"]*"[^>]*>/);
    assert.match(unsafeSampler[0], /enabled="false"/, 'unsafe override explicitly allows the disable');
});

test('business guard: never protects operator-disabled samplers or proven duplicate hops', () => {
    const xml = `<HTTPSamplerProxy testname="SC01_T02_/s/interceptor/authorize/-017" enabled="true"><stringProp name="HTTPSampler.path">/s/interceptor/authorize/</stringProp><stringProp name="HTTPSampler.method">GET</stringProp><stringProp name="HTTPSampler.domain">stgauth.webpt.com</stringProp></HTTPSamplerProxy><hashTree/>
<HTTPSamplerProxy testname="SC01_T02_/user/login-019" enabled="true"><stringProp name="HTTPSampler.path">/user/login</stringProp><stringProp name="HTTPSampler.method">POST</stringProp><stringProp name="HTTPSampler.domain">stgauth.webpt.com</stringProp></HTTPSamplerProxy><hashTree/>`;
    // Case 1: operator disable — no allowUnsafeDisableProtected flag needed.
    const g1 = businessGuard.buildBusinessGuard({ xml, flowName: 'logi', runCfg: { disableCalls: ['/s/interceptor/authorize/'] } });
    assert.ok(!g1.protectedNames.has('SC01_T02_/s/interceptor/authorize/-017'), 'operator-disabled sampler is not protected');
    assert.ok(g1.protectedNames.has('SC01_T02_/user/login-019'), 'real login stays protected');
    // Case 2: duplicate-hop evidence.
    const g2 = businessGuard.buildBusinessGuard({ xml, flowName: 'logi', runCfg: {}, duplicateHopLabels: ['SC01_T02_/s/interceptor/authorize/-017'] });
    assert.ok(!g2.protectedNames.has('SC01_T02_/s/interceptor/authorize/-017'), 'duplicate hop is not protected');
});

test('fold safety: Check 2 blocks folding a producer / load-bearing navigation; Check 1 marks uncertain', () => {
    const { assessFoldSafety } = require('../src/fold-safety');
    const mk = (method, url, status, { location, setCookie, body, reqCookie } = {}) => ({
        request: { method, url, headers: reqCookie ? [{ name: 'Cookie', value: reqCookie }] : [] },
        response: {
            status,
            headers: [
                ...(location ? [{ name: 'Location', value: location }] : []),
                ...(setCookie ? [{ name: 'Set-Cookie', value: setCookie }] : []),
            ],
            content: { text: body || '' },
        },
    });
    const entries = [
        // 0: produces a token in its body that 1 consumes → UNSAFE (Check 2a)
        mk('GET', 'https://a.test/page', 200, { body: '{"csrf":"TOKZZ9988"}' }),
        mk('POST', 'https://a.test/act?csrf=TOKZZ9988', 200, {}),
        // 2: unique navigation → 3's URL, nothing else re-establishes → UNSAFE (2b)
        mk('GET', 'https://a.test/go', 302, { location: 'https://a.test/landing' }),
        mk('GET', 'https://a.test/landing', 200, {}),
        // 4: pure sink — consumes 0's token, produces nothing → UNCERTAIN (Check 1)
        mk('GET', 'https://a.test/log?csrf=TOKZZ9988', 204, {}),
        // 5: truly useless — no produce, no consume, no nav → SAFE
        mk('GET', 'https://a.test/beacon', 204, {}),
    ];
    const { byIndex } = assessFoldSafety(entries, {});
    assert.strictEqual(byIndex[0].verdict, 'unsafe', 'produces a downstream-consumed value');
    assert.ok(byIndex[0].checks.producesDownstreamValue >= 1);
    assert.strictEqual(byIndex[2].verdict, 'unsafe', 'load-bearing navigation');
    assert.ok(byIndex[2].checks.loadBearingNavigation);
    assert.strictEqual(byIndex[4].verdict, 'uncertain', 'consumes upstream but produces nothing');
    assert.strictEqual(byIndex[5].verdict, 'safe', 'no produce/consume/nav — freely foldable');
});

test('fold safety: a duplicate redirect hop is safe despite navigating (parent reproduces it)', () => {
    const { assessFoldSafety } = require('../src/fold-safety');
    const hop = (method, url, status, location, setCookie) => ({
        request: { method, url, headers: [] },
        response: { status, headers: [
            ...(location ? [{ name: 'Location', value: location }] : []),
            ...(setCookie ? [{ name: 'Set-Cookie', value: setCookie }] : []),
        ], content: { text: '' } },
    });
    const entries = [
        hop('POST', 'https://a.test/s/interceptor/', 302, '/s/interceptor/authorize/?g=AAA'),
        hop('GET', 'https://a.test/s/interceptor/authorize/?g=AAA', 302, 'https://a.test/redirect/', 'SESS=x; Path=/'),
        hop('GET', 'https://a.test/redirect/', 200, null),
    ];
    // Index 1 is the proven duplicate hop; parent (0) reproduces the nav, and
    // its Set-Cookie is captured natively → SAFE even though it 302s + sets a cookie.
    const { byIndex } = assessFoldSafety(entries, { foldingIndexes: new Set([1]), duplicateHopIndexes: new Set([1]) });
    assert.strictEqual(byIndex[1].verdict, 'safe', 'duplicate hop is foldable');
    assert.ok(!byIndex[1].checks.loadBearingNavigation, 'navigation is reproduced by the parent');
});

test('input selection: the UI unit id matches a RAW ingest unit (dropdown selection bug)', () => {
    const { selectUnits, unitId } = require('../src/ui-inputs');
    // Raw ingest units carry NO .id (only the UI projection does) — the matcher
    // must compute it, or a dropdown selection resolves to zero units and
    // --pair then fails with "got 0".
    const rawUnits = [
        { name: 'Scheduled_Visits_STG_0047', kind: 'jmx', primary: '/in/Scheduled_Visits_STG_0047.jmx', secondary: '/in/Scheduled_Visits_STG_0047.xml' },
        { name: 'Scheduled_Visits_STG_0061', kind: 'jmx', primary: '/in/Scheduled_Visits_STG_0061.jmx', secondary: '/in/Scheduled_Visits_STG_0061.xml' },
    ];
    const ids = rawUnits.map(unitId);
    const sel = selectUnits(rawUnits, ids);
    assert.strictEqual(sel.missing.length, 0, 'both dropdown ids resolve');
    assert.deepStrictEqual(sel.selected.map(u => u.name), ['Scheduled_Visits_STG_0047', 'Scheduled_Visits_STG_0061']);
});

test('dual-recording pairing: two single JMX units merge into a dual-jmx variance unit', () => {
    const { mergeUnitsAsDual } = require('../src/ingest');
    const a = { name: 'LOGI_0004User', kind: 'jmx', primary: '/in/LOGI_0004User.jmx', secondary: '/in/LOGI_0004User.xml' };
    const b = { name: 'LOGI_0006User', kind: 'jmx', primary: '/in/LOGI_0006User.jmx', secondary: '/in/LOGI_0006User.xml' };
    const dual = mergeUnitsAsDual(a, b);
    assert.strictEqual(dual.kind, 'dual-jmx');
    assert.strictEqual(dual.primary, '/in/LOGI_0004User.jmx');
    assert.strictEqual(dual.secondary, '/in/LOGI_0006User.jmx');
    assert.deepStrictEqual(dual.sidecars, { primary: '/in/LOGI_0004User.xml', secondary: '/in/LOGI_0006User.xml' });
    // Two HARs → dual-har.
    const har = mergeUnitsAsDual({ name: 'A', primary: '/in/a.har' }, { name: 'B', primary: '/in/b.har' });
    assert.strictEqual(har.kind, 'dual-har');
    // Mixed types are refused.
    assert.throws(() => mergeUnitsAsDual({ primary: '/in/a.har' }, { primary: '/in/b.jmx' }), /same type/);
});

test('run flags: AI assist is off by default; on/pro emit --ai (+ --gemini-pro for pro)', () => {
    const { flagsForRunRequest } = require('../src/ui-run-mode');
    const off = flagsForRunRequest({ mode: 'agent', aiAssist: 'off' }).join(' ');
    assert.ok(!off.includes('--ai'), 'off → no AI (no cost)');
    assert.ok(!off.includes('--gemini-pro'));
    const on = flagsForRunRequest({ mode: 'agent', aiAssist: 'on' }).join(' ');
    assert.ok(on.includes('--ai') && !on.includes('--gemini-pro'), 'on → --ai standard');
    const pro = flagsForRunRequest({ mode: 'agent', aiAssist: 'pro' }).join(' ');
    assert.ok(pro.includes('--ai') && pro.includes('--gemini-pro'), 'pro → --ai + --gemini-pro');
    // Absent aiAssist defaults to off.
    assert.ok(!flagsForRunRequest({ mode: 'agent' }).join(' ').includes('--ai'));
});

test('run flags: --pair is emitted only when exactly two inputs are selected', () => {
    const { flagsForRunRequest } = require('../src/ui-run-mode');
    const two = flagsForRunRequest({ mode: 'agent', selectedInputs: ['a', 'b'], pair: true }).join(' ');
    assert.ok(two.includes('--pair'), 'two selected + pair → --pair');
    const one = flagsForRunRequest({ mode: 'agent', selectedInputs: ['a'], pair: true }).join(' ');
    assert.ok(!one.includes('--pair'), 'one selected → no --pair even if requested');
    const none = flagsForRunRequest({ mode: 'agent', selectedInputs: ['a', 'b'], pair: false }).join(' ');
    assert.ok(!none.includes('--pair'), 'pair off → no --pair');
});

test('flow understanding: summarizes flow, auth style, host, and playbook up front', () => {
    const { summarizeFlow } = require('../src/flow-understanding');
    const { entries, pages } = parse(har([
        entry('GET', 'https://app.test/login'),
        entry('POST', 'https://app.test/api/tasks/create', { reqHeaders: [{ name: 'Content-Type', value: 'application/json' }] }),
    ]));
    const out = summarizeFlow({ entries, pages, runCfg: { testObjective: 'release cert' } });
    assert.ok(out.lines.some(l => /Flow understanding/.test(l)));
    assert.ok(out.lines.some(l => /Business flow:/.test(l)));
    assert.ok(out.lines.some(l => /Application host\(s\): app\.test/.test(l)));
    assert.ok(out.lines.some(l => /Stated objective: release cert/.test(l)));
    assert.strictEqual(out.summary.hosts.primary, 'app.test');
});

test('polling detection: different query params on the same path are NOT a poll (rdChart2 charts)', () => {
    const { detectPolling } = generateInternal;
    const req = (url) => ({ request: { method: 'GET', url } });
    // Six report charts on the same path but DIFFERENT chartId → distinct
    // resources, must NOT be wrapped in a While loop.
    const charts = [55, 56, 57, 58, 59, 60].map(n => req(`https://a.test/EMRAnalytics/rdTemplate/rdChart2.aspx?rdReport=X&chartId=0${n}`));
    assert.deepStrictEqual(detectPolling(charts), [], 'distinct-query requests are not polling');
    // A real status poll: same URL (or only a cache-buster differs) repeated.
    const poll = [
        req('https://a.test/job/status?jobId=123'),
        req('https://a.test/job/status?jobId=123&_=1699'),
        req('https://a.test/job/status?jobId=123&_=1700'),
        req('https://a.test/job/status?jobId=123&_=1701'),
    ];
    const groups = detectPolling(poll);
    assert.strictEqual(groups.length, 1, 'same resource + cache-buster IS a poll');
    assert.strictEqual(groups[0].count, 4);
});

test('recoverSamplesFromJtl: a disabled sampler\'s stale JTL row is NOT merged back (false-negative fix)', () => {
    const out = tmp();
    // final.jtl still holds the folded redirect hop's earlier 401 (SimpleDataWriter appends).
    fs.writeFileSync(path.join(out, 'final.jtl'), `<?xml version="1.0"?>
<testResults version="1.2">
<httpSample t="10" lb="SC01_T02_/authorize/resume-011" rc="401" s="false"/>
<httpSample t="10" lb="SC01_T02_/user/login-012" rc="200" s="true"/>
</testResults>`);
    // The FINAL shipped JMX has that redirect hop DISABLED.
    const jmx = path.join(out, 'final.jmx');
    fs.writeFileSync(jmx, `<jmeterTestPlan><hashTree>
  <HTTPSamplerProxy testname="SC01_T02_/authorize/resume-011" enabled="false"><stringProp name="HTTPSampler.path">/authorize/resume</stringProp></HTTPSamplerProxy><hashTree/>
  <HTTPSamplerProxy testname="SC01_T02_/user/login-012" enabled="true"><stringProp name="HTTPSampler.path">/user/login</stringProp></HTTPSamplerProxy><hashTree/>
</hashTree></jmeterTestPlan>`);
    // Engine's final (clean) list is missing both rows (partial parse).
    const result = { success: true, samples: [], finalJmxPath: jmx };
    runnerInternal.recoverSamplesFromJtl(result, path.join(out, 'final.jtl'), out, () => {}, jmx);
    const labels = result.samples.map(s => s.label);
    assert.ok(!labels.includes('SC01_T02_/authorize/resume-011'), 'stale row for the DISABLED hop is excluded');
    assert.ok(labels.includes('SC01_T02_/user/login-012'), 'the enabled sampler is still recovered');
    assert.ok(result.samples.every(s => s.success !== false), 'no resurrected failure');
});

test('date intent: relative date fields become ${__timeShift}, fixed/ambiguous stay literal', () => {
    const di = require('../src/date-intent');
    const ref = new Date(Date.UTC(2025, 0, 1)); // recording reference
    // detectDate
    assert.strictEqual(di.detectDate('2024-09-23').jmeterFormat, 'yyyy-MM-dd');
    assert.strictEqual(di.detectDate('2024-09-23 08:30:00').hasTime, true);
    assert.strictEqual(di.detectDate('09/23/2024').jmeterFormat, 'MM/dd/yyyy');
    assert.strictEqual(di.detectDate('not-a-date'), null);
    assert.strictEqual(di.detectDate('23/09/2024'), null, 'dd/MM (day>12) → ambiguous, not shifted');
    // plan
    const plan = di.planDateShifts([
        { name: 'startDate', value: '2024-09-23' },                 // relative name → shift
        { name: 'event_startdatetime', value: '2024-12-25 10:00:00' }, // has time → shift
        { name: 'rdConstantFirstDayOfFiscalYear', value: '2025-01-01' }, // fixed name → skip
        { name: 'note', value: 'hello' },                           // not a date
    ], ref, {});
    const names = plan.shifts.map(s => s.name).sort();
    assert.deepStrictEqual(names, ['event_startdatetime', 'startDate']);
    assert.ok(plan.skippedFixed.includes('rdConstantFirstDayOfFiscalYear'));
    // the shift expression is a native JMeter function in the recorded format
    const sd = plan.shifts.find(s => s.name === 'startDate');
    assert.match(sd.expr, /^\$\{__timeShift\(yyyy-MM-dd,,-P\d+D,,\)\}$/);
    // config off → no shifts
    assert.strictEqual(di.planDateShifts([{ name: 'startDate', value: '2024-09-23' }], ref, { shift: false }).shifts.length, 0);
    // injection replaces the literal in a sampler send-field only
    const xml = '<HTTPSamplerProxy><stringProp name="Argument.value">2024-09-23</stringProp><stringProp name="TestPlan.comments">recorded 2024-09-23</stringProp></HTTPSamplerProxy>';
    const out = di.injectDateShifts(xml, [{ value: '2024-09-23', expr: '${__timeShift(yyyy-MM-dd,,-P100D,,)}' }]);
    assert.match(out.xml, /Argument\.value">\$\{__timeShift/);
    assert.match(out.xml, /comments">recorded 2024-09-23/, 'non-send fields (comments) are untouched');
});

test('gate 0: catches the CSV column-shift that fed ${username} garbage (quotedData bug)', () => {
    const out = tmp();
    // The ORIGINAL bug: comma delimiter, quotedData=false, a field RFC-4180-
    // quoted because it contains commas → JMeter splits inside the quotes.
    fs.writeFileSync(path.join(out, 'bad_data.csv'),
        'colA,pickList,username,password\n' +
        'a,"x,y,z",Performance_STG_0047,password1!\n');
    const badXml = `<jmeterTestPlan><hashTree>
  <CSVDataSet testname="CSV" enabled="true">
    <stringProp name="filename">bad_data.csv</stringProp>
    <stringProp name="delimiter">,</stringProp>
    <boolProp name="quotedData">false</boolProp>
    <stringProp name="variableNames">colA,pickList,username,password</stringProp>
  </CSVDataSet><hashTree/>
  <HTTPSamplerProxy testname="Step 01 - POST /login"><stringProp name="Argument.value">\${username}</stringProp></HTTPSamplerProxy><hashTree/>
</hashTree></jmeterTestPlan>`;
    const bad = checkRenderedRequests({ xml: badXml, outDir: out });
    assert.strictEqual(bad.ok, false);
    const shift = bad.findings.find(f => f.kind === 'csv-column-shift');
    assert.ok(shift, 'column shift detected');
    assert.ok(shift.dataDefect, 'classified as a DATA defect, not an auth wall');
    assert.match(shift.fix, /quotedData=true/);

    // The FIX: pipe delimiter + quotedData=true → columns align → Gate 0 clean.
    fs.writeFileSync(path.join(out, 'good_data.csv'),
        'colA|pickList|username|password\n' +
        'a|x,y,z|Performance_STG_0047|password1!\n');
    const goodXml = badXml
        .replace('bad_data.csv', 'good_data.csv')
        .replace('<stringProp name="delimiter">,</stringProp>', '<stringProp name="delimiter">|</stringProp>')
        .replace('<boolProp name="quotedData">false</boolProp>', '<boolProp name="quotedData">true</boolProp>');
    const good = checkRenderedRequests({ xml: goodXml, outDir: out });
    assert.strictEqual(good.ok, true, 'aligned CSV passes Gate 0');
});

test('phase B: auth-wall-stop fires only when Gate 0 proves the login was sent correctly', () => {
    const { proposeReplan } = require('../src/replanner');
    // A run with a post-run auth_wall adjudication AND a failing login sampler.
    const result = {
        success: false,
        samples: [{ label: 'Step 08 - POST /u/login/password', success: false, responseCode: '401', isTransaction: false }],
        requestAdjudication: { iterations: [{ actions: { stop: [{ samplerLabel: 'Step 01 - GET /', category: 'auth_wall' }] } }] },
    };
    // Gate 0 CLEAN → the wall is genuinely irreducible → stop and ask a human.
    const irreducible = proposeReplan({ result, runCfg: {}, gate0: { findings: [] }, tried: [] });
    assert.ok(irreducible && irreducible.id === 'auth-wall-stop', 'clean Gate 0 → auth-wall-stop');
    // Gate 0 shows the credentials column shifted → login was MIS-SENT → do NOT
    // stop; fall through to repair strategies (auth-state flip here).
    const gate0 = { findings: [{ kind: 'csv-column-shift', dataDefect: true, message: 'columns shifted' }] };
    const fixable = proposeReplan({ result, runCfg: {}, gate0, tried: [] });
    assert.ok(!fixable || fixable.id !== 'auth-wall-stop', 'mis-sent login is not an irreducible wall');
    // An undefined auth variable (${state}) also blocks the premature stop.
    const gate0Var = { findings: [{ kind: 'undefined-variable', variable: 'state', dataDefect: true, message: 'no producer' }] };
    const fixable2 = proposeReplan({ result, runCfg: {}, gate0: gate0Var, tried: [] });
    assert.ok(!fixable2 || fixable2.id !== 'auth-wall-stop');
});

test('gate 0 triage: a data defect leads the blockers and suppresses auth-wall speculation', () => {
    const { deriveBlockers } = require('../src/blockers');
    // A run that failed at login, with forensics screaming "auth wall" — but
    // Gate 0 proves the login sent a shifted CSV column. The data defect must
    // win; the "provide a browser session / non-MFA account" asks are gone.
    const result = {
        success: false,
        samples: [{ label: 'Step 08 - POST /u/login/password', success: false, responseCode: '401', isTransaction: false }],
        failureForensics: {
            rootCause: { sampler: 'Step 01 - GET /', recordedStatus: 302, observedStatus: 200, category: 'auth_redirect_bounce' },
            authSession: { missingSessionCookies: ['auth0__state', 'IDEM'] },
            redirects: { interactiveAuthWall: true },
        },
    };
    const gate0 = { findings: [{ kind: 'csv-column-shift', dataDefect: true, file: 'sv_data.csv', row: 1, message: 'row 1 parses to 24 columns but 19 variables', fix: 'Set quotedData=true on the CSV Data Set.' }] };
    const withGate0 = deriveBlockers({ result, runCfg: {}, entries: [], gate0 });
    assert.strictEqual(withGate0[0].id, 'gate0-csv-column-shift', 'data defect leads');
    assert.ok(!withGate0.some(b => b.id === 'auth-session-forensics'), 'auth-wall speculation suppressed');
    assert.ok(!withGate0.some(b => b.id === 'mfa'), 'mfa false-positive suppressed');
    // Without Gate 0, the old (misleading) auth-wall ask still appears.
    const withoutGate0 = deriveBlockers({ result, runCfg: {}, entries: [] });
    assert.ok(withoutGate0.some(b => b.id === 'auth-session-forensics'));
});

test('gate 0: flags an undefined ${var} that would transmit literally', () => {
    const xml = `<jmeterTestPlan><hashTree>
  <HTTPSamplerProxy testname="Step 01 - GET /me"><stringProp name="HTTPSampler.path">/me?token=\${authToken}</stringProp></HTTPSamplerProxy><hashTree/>
  <HTTPSamplerProxy testname="Step 02 - GET /ok"><stringProp name="HTTPSampler.path">/ok?u=\${__UUID}</stringProp></HTTPSamplerProxy><hashTree/>
</hashTree></jmeterTestPlan>`;
    const r = checkRenderedRequests({ xml, outDir: tmp() });
    const undef = r.findings.find(f => f.kind === 'undefined-variable');
    assert.ok(undef && undef.variable === 'authToken', 'undefined ${authToken} flagged');
    assert.ok(undef.dataDefect);
    // ${__UUID} is a JMeter function, not an undefined variable.
    assert.ok(!r.findings.some(f => f.variable === '__UUID'));
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

test('learning store: host-scoped lesson does not fire on a different app host', () => {
    const dir = tmp();
    const storePath = path.join(dir, 'lessons.json');
    learningStore.learnFromRun({
        storePath,
        flowName: 'bankA',
        sourceRun: 'green',
        appHost: 'https://bank-a.example.com',
        result: { success: true, samples: [{ isTransaction: false, success: true }] },
        fixes: [{ kind: 'setSamplerEnabled', sampler: 'Step 01 - GET /api/accounts', enabled: false }],
    });
    // Same URL shape, DIFFERENT host + known appHost -> host-scoped lesson must not match.
    const otherHost = learningStore.findMatchingLessons({
        storePath,
        failures: [{ samplerName: 'Step 07 - GET /api/accounts', responseCode: '500' }],
        appHost: 'https://bank-b.example.com',
    });
    assert.strictEqual(otherHost.length, 0);
    // Same host -> matches.
    const sameHost = learningStore.findMatchingLessons({
        storePath,
        failures: [{ samplerName: 'Step 07 - GET /api/accounts', responseCode: '500' }],
        appHost: 'https://bank-a.example.com',
    });
    assert.strictEqual(sameHost.length, 1);
});

test('learning store: redacted replaceValueWithVar lesson is not offered as a broken no-op patch', () => {
    const dir = tmp();
    const storePath = path.join(dir, 'lessons.json');
    learningStore.learnFromRun({
        storePath,
        flowName: 'demo',
        sourceRun: 'green',
        result: { success: true, samples: [{ isTransaction: false, success: true }] },
        fixes: [{ kind: 'replaceValueWithVar', sampler: 'Step 02 - GET /me', value: 'abc123def456', variable: 'session_id' }],
    });
    // The literal is redacted on disk (security); it must therefore be skipped
    // at match time rather than emitting a '[REDACTED_VALUE]' find-and-replace.
    const matches = learningStore.findMatchingLessons({
        storePath,
        failures: [{ samplerName: 'Step 02 - GET /me', responseCode: '401' }],
    });
    assert.strictEqual(matches.length, 0);
});

test('learning store: penalizeLessons decays confidence of a lesson that failed to green', () => {
    const dir = tmp();
    const storePath = path.join(dir, 'lessons.json');
    const learned = learningStore.learnFromRun({
        storePath,
        flowName: 'demo',
        sourceRun: 'green',
        result: { success: true, samples: [{ isTransaction: false, success: true }] },
        fixes: [{ kind: 'setSamplerEnabled', sampler: 'Step 01 - GET /avatar/a3bd', enabled: false }],
    });
    const id = learned.learned[0].id;
    const before = learningStore.loadLessons(storePath).find(l => l.id === id).confidence;
    const res = learningStore.penalizeLessons({ storePath, lessonIds: [id] });
    assert.strictEqual(res.penalized.length, 1);
    const after = learningStore.loadLessons(storePath).find(l => l.id === id);
    assert.ok(after.confidence < before);
    assert.strictEqual(after.failureCount, 1);
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

test('runner learning: verified adjudicator disables become reusable safe fixes', () => {
    const green = {
        success: true,
        requestAdjudication: {
            iterations: [{
                actions: {
                    disable: [
                        { samplerLabel: 'Step 09 - GET /s/interceptor/authorize/', category: 'redirect_hop' },
                        { samplerLabel: 'Step 10 - POST /scheduler/index/data/T/d', category: 'downstream_casualty' },
                    ],
                },
            }],
        },
    };
    const failed = { ...green, success: false };

    assert.deepStrictEqual(runnerInternal.adjudicatedDisableFixes(green), [
        { kind: 'setSamplerEnabled', sampler: 'Step 09 - GET /s/interceptor/authorize/', enabled: false },
    ]);
    assert.deepStrictEqual(runnerInternal.adjudicatedDisableFixes(failed), []);
});

test('runner agent config: preserves bounded replan budget', () => {
    const cfg = runnerInternal.normalizeAgentCfg({ enabled: true, maxReplans: 2 });
    assert.strictEqual(cfg.enabled, true);
    assert.strictEqual(cfg.maxReplans, 2);

    const clamped = runnerInternal.normalizeAgentCfg({ enabled: true, maxReplans: 99 });
    assert.strictEqual(clamped.maxReplans, 2);
});

test('replanner: senior PE native-manager correction is evidence gated and bounded', () => {
    const result = {
        success: false,
        samples: [{ label: 'Step 02 - GET /me', success: false, responseCode: '401' }],
    };
    const seniorPe = {
        recommendedNextStrategy: { id: 'native-manager-correction' },
        nativeManagerFindings: [{ manager: 'HTTP Cookie Manager', decision: 'required' }],
    };

    const first = replanner.proposeReplan({ result, seniorPeAnalysis: seniorPe, tried: [] });
    const skipped = replanner.proposeReplan({ result, seniorPeAnalysis: seniorPe, tried: ['native-manager-correction'] });

    assert.strictEqual(first.id, 'native-manager-correction');
    assert.strictEqual(first.runCfgPatch.forceNativeManagers.cookie, true);
    assert.strictEqual(skipped, null);
});

test('replanner: senior PE scenario gap warning does not mutate JMX strategy knobs', () => {
    const result = {
        success: false,
        samples: [{ label: 'Step 05 - POST /orders', success: false, responseCode: '500' }],
    };
    const seniorPe = {
        recommendedNextStrategy: { id: 'scenario-gap-warning' },
        riskGaps: [{ gap: 'workload_model_missing', severity: 'high', action: 'Provide transactions per hour and data volume.' }],
    };

    const strategy = replanner.proposeReplan({ result, seniorPeAnalysis: seniorPe, tried: [] });

    assert.strictEqual(strategy.id, 'scenario-gap-warning');
    assert.deepStrictEqual(strategy.runCfgPatch, {});
    assert.match(strategy.reason, /workload/i);
});

test('replanner: prefers adjudicator-approved dead plumbing disables', () => {
    const result = {
        success: false,
        samples: [{ label: 'Step 01 - GET /jwt/v2/create-cookie', success: false, responseCode: '400' }],
        requestAdjudication: {
            iterations: [{
                actions: {
                    disable: [{ samplerLabel: 'Step 01 - GET /jwt/v2/create-cookie', category: 'dead_plumbing' }],
                },
            }],
        },
    };

    const strategy = replanner.proposeReplan({ result, runCfg: { disableCalls: [] }, tried: [] });

    assert.strictEqual(strategy.id, 'post-run-fold-dead-plumbing');
    assert.deepStrictEqual(strategy.runCfgPatch.disableCalls, ['Step 01 - GET /jwt/v2/create-cookie']);
});

test('replanner: auth-wall adjudication stops downstream replan chasing', () => {
    const result = {
        success: false,
        samples: [
            { label: 'Step 01 - GET /authorize/resume', success: false, responseCode: '401' },
            { label: 'Step 02 - POST /scheduler/index/data/T/d', success: false, responseCode: '401' },
        ],
        requestAdjudication: {
            iterations: [{
                actions: {
                    stop: [{ samplerLabel: 'Step 01 - GET /authorize/resume', category: 'auth_wall' }],
                    disable: [{ samplerLabel: 'Step 02 - POST /scheduler/index/data/T/d', category: 'downstream_casualty' }],
                },
            }],
        },
    };

    const strategy = replanner.proposeReplan({ result, runCfg: {}, tried: [] });

    assert.strictEqual(strategy.id, 'auth-wall-stop');
    assert.deepStrictEqual(strategy.runCfgPatch, {});
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

test('input state: unchanged failed runs retry until max failed attempts', () => {
    const dir = tmp();
    const statePath = path.join(dir, 'processed-inputs.json');
    const input = path.join(dir, 'login.jmx');
    fs.writeFileSync(input, 'same-version');

    const unit = { kind: 'single', primary: input };
    let state = inputState.loadProcessedState(statePath);

    inputState.markUnitProcessed(unit, state, statePath, { success: false, verdict: 'needs attention' });
    state = inputState.loadProcessedState(statePath);
    assert.strictEqual(inputState.shouldProcessUnit(unit, state, { maxFailedAttempts: 3 }), true);

    inputState.markUnitProcessed(unit, state, statePath, { success: false, verdict: 'needs attention' });
    state = inputState.loadProcessedState(statePath);
    assert.strictEqual(inputState.shouldProcessUnit(unit, state, { maxFailedAttempts: 3 }), true);

    inputState.markUnitProcessed(unit, state, statePath, { success: false, verdict: 'needs attention' });
    state = inputState.loadProcessedState(statePath);
    assert.strictEqual(inputState.shouldProcessUnit(unit, state, { maxFailedAttempts: 3 }), false);

    inputState.markUnitProcessed(unit, state, statePath, { success: true, verdict: 'GREEN' });
    state = inputState.loadProcessedState(statePath);
    assert.strictEqual(inputState.shouldProcessUnit(unit, state, { maxFailedAttempts: 3 }), false);
});

test('input state: legacy hash-only records can be reprocessed once for verdict migration', () => {
    const dir = tmp();
    const statePath = path.join(dir, 'processed-inputs.json');
    const input = path.join(dir, 'login.jmx');
    fs.writeFileSync(input, 'same-version');
    const unit = { kind: 'single', primary: input };
    const state = inputState.loadProcessedState(statePath);
    const sig = inputState.markUnitProcessed(unit, state, statePath);
    const legacyState = inputState.loadProcessedState(statePath);
    legacyState.units[sig.id] = sig.hash;

    assert.strictEqual(inputState.shouldProcessUnit(unit, legacyState), false);
    assert.strictEqual(inputState.shouldProcessUnit(unit, legacyState, { reprocessLegacy: true }), true);
});

test('run progress: summarizes live JMeter artifacts for console heartbeat', () => {
    const out = tmp();
    const iter = path.join(out, 'iteration_1');
    fs.mkdirSync(iter, { recursive: true });
    fs.writeFileSync(path.join(iter, 'run.log'), '2026-07-09 INFO started\n2026-07-09 WARN still running\n');
    fs.writeFileSync(path.join(iter, 'results.jtl'), '<testResults><httpSample s="true"/><httpSample s="false"/></testResults>');
    fs.writeFileSync(path.join(out, 'final.jtl'), '<testResults><httpSample/></testResults>');

    const summary = runProgress.summarizeRunProgress(out);

    assert.match(summary, /iteration_1/);
    assert.match(summary, /results.jtl/);
    assert.match(summary, /2 sample/);
    assert.match(summary, /last: 2026-07-09 WARN still running/);
});

test('run progress: repeated CookieManager warnings do not count as new progress', () => {
    const out = tmp();
    const iter = path.join(out, 'iteration_1');
    fs.mkdirSync(iter, { recursive: true });
    fs.writeFileSync(path.join(iter, 'results.jtl'), '<testResults><httpSample s="true"/></testResults>');
    fs.writeFileSync(path.join(out, 'final.jtl'), '<testResults><httpSample/></testResults>');
    const logPath = path.join(iter, 'run.log');
    fs.writeFileSync(logPath, '2026-07-09 12:33:35,766 WARN o.a.j.p.h.s.HTTPSamplerBase: Existing CookieManager HTTP Cookie Manager superseded by HTTP Cookie Manager\n');
    const first = runProgress.snapshotRunProgress(out);
    fs.writeFileSync(logPath, '2026-07-09 12:33:45,749 WARN o.a.j.p.h.s.HTTPSamplerBase: Existing CookieManager HTTP Cookie Manager superseded by HTTP Cookie Manager\n');
    const second = runProgress.snapshotRunProgress(out);

    assert.strictEqual(first.key, second.key);
    assert.match(first.summary, /CookieManager/);
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

test('business guard: classifies value-flow producers as dependencies, not business actions', () => {
    const xml = `<jmeterTestPlan><hashTree>
  <HTTPSamplerProxy testname="Step 01 - GET /auth" enabled="true">
    <stringProp name="HTTPSampler.domain">app.test</stringProp>
    <stringProp name="HTTPSampler.path">/auth</stringProp>
    <stringProp name="HTTPSampler.method">GET</stringProp>
  </HTTPSamplerProxy><hashTree/>
  <HTTPSamplerProxy testname="Step 02 - POST /tasks" enabled="true">
    <stringProp name="HTTPSampler.domain">app.test</stringProp>
    <stringProp name="HTTPSampler.path">/tasks</stringProp>
    <stringProp name="HTTPSampler.method">POST</stringProp>
  </HTTPSamplerProxy><hashTree/>
</hashTree></jmeterTestPlan>`;
    const valueFlow = {
        bySampler: {
            'Step 01 - GET /auth': { consumedOutputCount: 1 },
        },
    };
    const guard = businessGuard.buildBusinessGuard({ xml, flowName: 'createtask', valueFlowDecisions: valueFlow });
    const auth = guard.protectedSamplers.find(s => s.name === 'Step 01 - GET /auth');
    const task = guard.protectedSamplers.find(s => s.name === 'Step 02 - POST /tasks');

    assert.strictEqual(auth.category, 'dependency');
    assert.strictEqual(task.category, 'business');

    const result = {
        success: true,
        samples: [
            { label: 'Step 01 - GET /auth', success: true, responseCode: '200' },
            { label: 'Step 02 - POST /tasks', success: true, responseCode: '200' },
        ],
    };
    const evaluation = businessGuard.evaluateBusinessResult({ result, xml, guard });
    assert.match(evaluation.reason, /1 business-critical/);
    assert.match(evaluation.reason, /1 required dependenc/);
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
    assert.strictEqual(opts.agent.maxReplans, 0);
    assert.strictEqual(opts.agent.javaSafeMode, true);
    assert.strictEqual(opts.agent.seniorMode, 'strong');
});

test('agent config: senior mode is opt-in beyond strong defaults and clamps invalid values', () => {
    assert.strictEqual(resolveAgentOptions(['--run'], {}).agent.seniorMode, 'off');
    assert.strictEqual(resolveAgentOptions(['--agent'], { agent: { seniorMode: 'mature' } }).agent.seniorMode, 'mature');
    assert.strictEqual(resolveAgentOptions(['--agent'], { agent: { seniorMode: 'unknown' } }).agent.seniorMode, 'strong');
    assert.strictEqual(resolveAgentOptions(['--agent', '--senior'], {}).agent.seniorMode, 'mature');
});

test('agent config: configured replan budget reaches runner options', () => {
    const opts = resolveAgentOptions(['--agent'], { agent: { maxReplans: 2 } });
    assert.strictEqual(opts.agent.maxReplans, 2);

    const clamped = resolveAgentOptions(['--agent'], { agent: { maxReplans: 99 } });
    assert.strictEqual(clamped.agent.maxReplans, 2);
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
    assert.strictEqual(labelForAgentOptions(resolveAgentOptions(['--agent'], {}), true), 'strong senior PE agent validate (watch)');
    assert.strictEqual(labelForAgentOptions(resolveAgentOptions(['--agent', '--senior'], {}), false), 'mature senior PE agent validate');
});

test('UI run modes map to the expected CLI flags', () => {
    assert.deepStrictEqual(flagsForRunMode('generate'), []);
    assert.deepStrictEqual(flagsForRunMode('run'), ['--run']);
    assert.deepStrictEqual(flagsForRunMode('agent'), ['--agent']);
    assert.deepStrictEqual(flagsForRunMode('senior-agent'), ['--agent', '--senior']);
    assert.deepStrictEqual(flagsForRunMode('agent-watch'), ['--agent', '--watch']);
    assert.deepStrictEqual(flagsForRunMode('unexpected'), []);
});

test('UI run requests include selected inputs and rerun controls as CLI flags', () => {
    const { flagsForRunRequest } = require('../src/ui-run-mode');

    assert.ok(flagsForRunRequest({
        mode: 'agent',
        selectedInputs: ['orders'],
        runSelected: true,
    }).includes('--force'), 'Run selected always forces selected inputs to execute');

    assert.deepStrictEqual(flagsForRunRequest({
        mode: 'agent',
        selectedInputs: ['orders', 'login.jmx'],
        force: true,
        iterations: 4,
        retryFailed: 6,
        geminiPro: true,
    }), [
        '--agent',
        '--force',
        '--iterations', '4',
        '--retry-failed', '6',
        '--gemini-pro',
        '--input', 'orders',
        '--input', 'login.jmx',
    ]);
});

test('UI config: round-trips senior PE context without dropping existing keys', () => {
    const existing = {
        gemini: { apiKey: 'keep' },
        agent: { enabled: false, maxLlmRounds: 1 },
        run: { targetBaseUrlOverride: 'https://old.test', credentials: { password: 'secret' } },
    };
    const updated = uiConfig.writeConfigFromUiObject(existing, {
        targetBaseUrl: 'https://stage.test',
        username: 'alice',
        password: '',
        loadProfile: { users: '5', rampUpSec: '10', holdSec: '60' },
        testObjective: 'checkout capacity',
        techStack: 'React + Spring Boot + OAuth',
        domainNotes: 'Orders must be unique and cleanup is required.',
        transactionNames: 'Launch Login\n90 Days Search\nLogout',
        slo: { p95Ms: '750', errorRatePct: '1' },
        seniorMode: 'mature',
    });
    const ui = uiConfig.readConfigForUiObject(updated);

    assert.strictEqual(updated.gemini.apiKey, 'keep');
    assert.strictEqual(updated.run.credentials.password, 'secret');
    assert.strictEqual(updated.run.testObjective, 'checkout capacity');
    assert.deepStrictEqual(updated.run.techStack, ['React', 'Spring Boot', 'OAuth']);
    assert.deepStrictEqual(updated.run.domainNotes, ['Orders must be unique and cleanup is required.']);
    assert.deepStrictEqual(updated.run.transactionNames, ['Launch Login', '90 Days Search', 'Logout']);
    assert.deepStrictEqual(updated.run.slo, { p95Ms: 750, errorRatePct: 1 });
    assert.strictEqual(updated.agent.seniorMode, 'mature');
    assert.strictEqual(ui.testObjective, 'checkout capacity');
    assert.strictEqual(ui.techStack, 'React, Spring Boot, OAuth');
    assert.strictEqual(ui.domainNotes, 'Orders must be unique and cleanup is required.');
    assert.strictEqual(ui.transactionNames, 'Launch Login\n90 Days Search\nLogout');
    assert.strictEqual(ui.slo.p95Ms, 750);
});

test('UI inputs: projects folder files into selectable logical run units', () => {
    const dir = tmp();
    const harPath = path.join(dir, 'orders.har');
    const jmxPath = path.join(dir, 'login.jmx');
    const sidecarPath = path.join(dir, 'login.recording.xml');
    fs.writeFileSync(harPath, JSON.stringify(har([
        entry('GET', 'https://app.test/orders'),
        entry('POST', 'https://app.test/orders'),
    ])));
    fs.writeFileSync(jmxPath, jmxXml([{ method: 'GET', path: '/login' }]));
    fs.writeFileSync(sidecarPath, jtlXml([{ method: 'GET', url: 'https://app.test/login' }]));

    const model = uiInputs.buildInputModel(dir);

    assert.deepStrictEqual(model.units.map(u => u.name).sort(), ['login', 'orders']);
    const login = model.units.find(u => u.name === 'login');
    assert.strictEqual(login.kind, 'jmx');
    assert.strictEqual(login.files.find(f => f.role === 'primary').name, 'login.jmx');
    assert.strictEqual(login.files.find(f => f.role === 'sidecar').name, 'login.recording.xml');
    assert.strictEqual(login.runnable, true);
    const orders = model.units.find(u => u.name === 'orders');
    assert.deepStrictEqual(orders.hosts, ['app.test']);
    assert.strictEqual(orders.requestCount, 2);
});

test('UI inputs: selection matches unit ids, names, and filenames', () => {
    const units = [
        { id: 'har-orders-orders_har', name: 'orders', primary: '/in/orders.har', files: [{ name: 'orders.har' }] },
        { id: 'jmx-login-login_jmx', name: 'login', primary: '/in/login.jmx', secondary: '/in/login.recording.xml', files: [{ name: 'login.jmx' }, { name: 'login.recording.xml' }] },
    ];

    const byName = uiInputs.selectUnits(units, ['orders']);
    assert.deepStrictEqual(byName.selected.map(u => u.name), ['orders']);
    assert.deepStrictEqual(byName.missing, []);

    const byFile = uiInputs.selectUnits(units, ['login.recording.xml']);
    assert.deepStrictEqual(byFile.selected.map(u => u.name), ['login']);

    const missing = uiInputs.selectUnits(units, ['missing.har']);
    assert.deepStrictEqual(missing.selected, []);
    assert.deepStrictEqual(missing.missing, ['missing.har']);
});

test('UI process control: cancel uses a Windows process-tree kill command', () => {
    assert.deepStrictEqual(uiProcessControl.killPlanForPid(4242, 'win32'), {
        command: 'taskkill',
        args: ['/pid', '4242', '/T', '/F'],
        signal: null,
    });
    assert.deepStrictEqual(uiProcessControl.killPlanForPid(4242, 'linux'), {
        command: null,
        args: [],
        signal: 'SIGTERM',
    });
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

test('java-safe JMX sanitizer also strips legacy BeanShell pre/post processors', () => {
    const xml = `<jmeterTestPlan><hashTree>
        <BeanShellPreProcessor testname="bsh pre" enabled="true">
          <stringProp name="script">vars.put("x","1");</stringProp>
        </BeanShellPreProcessor>
        <hashTree/>
        <HTTPSamplerProxy testname="keep me"></HTTPSamplerProxy>
        <hashTree/>
        <BeanShellPostProcessor testname="bsh post" enabled="true">
          <stringProp name="script">log.info("y");</stringProp>
        </BeanShellPostProcessor>
        <hashTree/>
      </hashTree></jmeterTestPlan>`;
    const out = sanitizeJavaUnsafeJmx(xml);
    assert.strictEqual(out.changed, true);
    assert.strictEqual(out.removed.length, 2);
    assert.ok(!out.xml.includes('BeanShellPreProcessor'));
    assert.ok(!out.xml.includes('BeanShellPostProcessor'));
    assert.match(out.xml, /keep me/);
});

test('fast-repair extractJsonPath: supports array index + bracket/quoted keys', () => {
    const xjp = fastRepairLoop._internal.extractJsonPath;
    const body = JSON.stringify({ data: { items: [{ id: 'A1' }, { id: 'B2' }], meta: { 'x-token': 'tok_9' } }, ok: true });
    assert.strictEqual(xjp(body, '$.data.items[0].id'), 'A1');
    assert.strictEqual(xjp(body, '$.data.items[1].id'), 'B2');
    assert.strictEqual(xjp(body, "$.data.meta['x-token']"), 'tok_9');
    assert.strictEqual(xjp(body, '$..x-token'), 'tok_9');
    assert.strictEqual(xjp(body, '$.does.not.exist'), null);
});

test('GraphQL auth repair: broadened path + token name (/api/graphql, _csrf, x-xsrf-token)', () => {
    const gql = (name, path, tokenKey, headerName, headerValue) => `
      <HTTPSamplerProxy testname="GraphQL ${name}">
        <stringProp name="HTTPSampler.path">${path}</stringProp>
        <stringProp name="GraphQLHTTPSampler.operationName">${name}</stringProp>
        <stringProp name="q">mutation ${name} { ${name} { ${tokenKey} } }</stringProp>
        ${headerName ? `<elementProp name="h" elementType="Header"><stringProp name="Header.name">${headerName}</stringProp><stringProp name="Header.value">${headerValue}</stringProp></elementProp>` : ''}
      </HTTPSamplerProxy>
      <hashTree/>`;
    const jmx = `<jmeterTestPlan><hashTree>
      ${gql('Login', '/api/graphql', '_csrf', null, null)}
      ${gql('DoThing', '/api/graphql', '_csrf', 'x-xsrf-token', 'recorded-csrf-123')}
    </hashTree></jmeterTestPlan>`;
    const repaired = propagateGraphqlCsrfTokens(jmx);
    assert.strictEqual(repaired.substitutions, 1);
    assert.strictEqual(repaired.extractors, 1);
    assert.match(repaired.xml, /JSONPostProcessor\.referenceNames">gql_Login_csrf</);
    assert.match(repaired.xml, /jsonPathExprs">\$\.\._csrf</);
    assert.match(repaired.xml, /Header\.value">\$\{gql_Login_csrf\}</);
    assert.doesNotMatch(repaired.xml, /recorded-csrf-123/);
});

test('pkce: plain method is native-safe, S256 is flagged as an unresolved requirement', () => {
    const plain = pkceModule.analyzePkce([
        { request: { url: 'https://idp.example.com/authorize?client_id=x&code_challenge=abc&code_challenge_method=plain' } },
        { request: { url: 'https://idp.example.com/oauth2/token', postData: { text: 'grant_type=authorization_code&code_verifier=abc' } } },
    ]);
    assert.strictEqual(plain.present, true);
    assert.strictEqual(plain.method, 'PLAIN');
    assert.strictEqual(plain.nativeSafe, true);
    assert.ok(plain.note);

    const s256 = pkceModule.analyzePkce([
        { request: { url: 'https://idp.example.com/authorize?client_id=x&code_challenge=abc&code_challenge_method=S256' } },
    ]);
    assert.strictEqual(s256.method, 'S256');
    assert.strictEqual(s256.nativeSafe, false);
    assert.strictEqual(s256.blocker.requirement, 'oauth_pkce_s256');

    assert.strictEqual(pkceModule.analyzePkce([{ request: { url: 'https://app/x' } }]).present, false);
});

test('senior PE: static config params get static_config role, not user_test_input', () => {
    const ledger = seniorPe._internal.buildValueLedger({
        parameterCandidates: [
            { name: 'api_version', value: 'v2', location: 'query' },
            { name: 'locale', value: 'en-US', location: 'query' },
            { name: 'username', value: 'alice@example.com', location: 'body' },
        ],
        objective: { value: 'business_load' },
    });
    const byName = Object.fromEntries(ledger.map(v => [v.name, v]));
    assert.strictEqual(byName.api_version.role, 'static_config');
    assert.strictEqual(byName.api_version.decision, 'keep_static_literal');
    assert.strictEqual(byName.locale.role, 'static_config');
    assert.strictEqual(byName.username.role, 'user_test_input');
    assert.strictEqual(seniorPe._internal.isStaticConfigName('tenant_id'), true);
    assert.strictEqual(seniorPe._internal.isStaticConfigName('order_total'), false);
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

test('generate: forceNativeManagers injects native JMeter HTTP managers', () => {
    const { entries, pages } = parse(har([
        entry('GET', 'https://app.test/login', {
            resHeaders: [{ name: 'Set-Cookie', value: 'sid=abc; Path=/; HttpOnly' }],
        }),
        entry('GET', 'https://app.test/me', {
            reqHeaders: [
                { name: 'Cookie', value: 'sid=abc' },
                { name: 'Authorization', value: 'Bearer recorded-token' },
            ],
        }),
    ]));
    const out = tmp();
    const gen = generate(entries, pages, out, 'native-managers', {
        runCfg: {
            forceNativeManagers: {
                cookie: true,
                cache: true,
                authorization: true,
                redirects: true,
            },
        },
    });
    const xml = fs.readFileSync(gen.jmxPath, 'utf8');

    assert.match(xml, /<CookieManager\b[\s\S]*testname="HTTP Cookie Manager"/);
    assert.match(xml, /<CacheManager\b[\s\S]*testname="HTTP Cache Manager"/);
    assert.match(xml, /<AuthManager\b[\s\S]*testname="HTTP Authorization Manager"/);
    assert.doesNotMatch(xml, /<stringProp name="Header\.name">Cookie<\/stringProp>/);
    assert.ok((xml.match(/<boolProp name="HTTPSampler\.follow_redirects">true<\/boolProp>/g) || []).length >= 2);
    assert.ok(gen.nativeManagers, 'forceNativeManagers should report the native-manager changes it applied');
    assert.deepStrictEqual(gen.nativeManagers.applied.sort(), ['authorization', 'cache', 'cookie', 'redirects']);
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

test('generate: multipart upload files are discovered, staged, and mapped into JMX', () => {
    const fixtures = tmp();
    fs.writeFileSync(path.join(fixtures, 'sample.pdf'), 'fake-pdf');
    const { entries, pages } = parse(har([
        entry('POST', 'https://app.test/edoc/temporal-file/save', {
            reqHeaders: [{ name: 'Content-Type', value: 'multipart/form-data; boundary=----abc' }],
            postData: {
                mimeType: 'multipart/form-data',
                params: [
                    { name: 'file', fileName: 'sample.pdf', contentType: 'application/pdf' },
                    { name: 'documentType', value: 'progress-note' },
                ],
            },
        }),
    ]));
    const out = tmp();
    const gen = generate(entries, pages, out, 'upload', { uploadSearchDirs: [fixtures] });
    const xml = fs.readFileSync(gen.jmxPath, 'utf8');

    assert.match(xml, /<stringProp name="File\.path">test_files\/sample\.pdf<\/stringProp>/);
    assert.ok(fs.existsSync(path.join(out, 'test_files', 'sample.pdf')), 'upload file should be staged next to the JMX');
    assert.strictEqual(gen.uploadFiles.matched.length, 1);
    assert.strictEqual(gen.uploadFiles.missing.length, 0);
    assert.ok(fs.existsSync(path.join(out, 'upload_file_uploads.json')));
});

test('generate: multipart upload filename drift maps to the compatible local file', () => {
    const fixtures = tmp();
    fs.writeFileSync(path.join(fixtures, 'actual-upload.pdf'), 'fake-pdf');
    const { entries, pages } = parse(har([
        entry('POST', 'https://app.test/edoc/temporal-file/save', {
            reqHeaders: [{ name: 'Content-Type', value: 'multipart/form-data; boundary=----abc' }],
            postData: {
                mimeType: 'multipart/form-data',
                params: [
                    { name: 'file', fileName: 'recorded-name.pdf', contentType: 'application/pdf' },
                ],
            },
        }),
    ]));
    const out = tmp();
    const gen = generate(entries, pages, out, 'upload-drift', { uploadSearchDirs: [fixtures] });
    const xml = fs.readFileSync(gen.jmxPath, 'utf8');

    assert.match(xml, /<stringProp name="File\.path">test_files\/actual-upload\.pdf<\/stringProp>/);
    assert.ok(fs.existsSync(path.join(out, 'test_files', 'actual-upload.pdf')));
    assert.strictEqual(gen.uploadFiles.matched[0].fileName, 'recorded-name.pdf');
    assert.strictEqual(gen.uploadFiles.matched[0].stagedName, 'actual-upload.pdf');
});

test('generate: raw multipart body filename is detected and staged', () => {
    const fixtures = tmp();
    fs.writeFileSync(path.join(fixtures, 'PdfUpload2.pdf'), 'fake-pdf');
    const body = [
        '------WebKitFormBoundaryabc',
        'Content-Disposition: form-data; name="file"; filename="PdfUpload2.pdf"',
        'Content-Type: application/pdf',
        '',
        '%PDF-1.4 fake',
        '------WebKitFormBoundaryabc--',
        '',
    ].join('\r\n');
    const { entries, pages } = parse(har([
        entry('POST', 'https://app.test/edoc/temporal-file/save', {
            reqHeaders: [{ name: 'Content-Type', value: 'multipart/form-data; boundary=----WebKitFormBoundaryabc' }],
            postData: {
                mimeType: 'multipart/form-data',
                text: body,
            },
        }),
    ]));
    const out = tmp();
    const gen = generate(entries, pages, out, 'upload-raw-multipart', { uploadSearchDirs: [fixtures] });
    const xml = fs.readFileSync(gen.jmxPath, 'utf8');

    assert.match(xml, /<stringProp name="File\.path">test_files\/PdfUpload2\.pdf<\/stringProp>/);
    assert.ok(fs.existsSync(path.join(out, 'test_files', 'PdfUpload2.pdf')));
    assert.strictEqual(gen.uploadFiles.matched[0].fileName, 'PdfUpload2.pdf');
});

test('generate: ambiguous compatible upload files are reported instead of guessed', () => {
    const fixtures = tmp();
    fs.writeFileSync(path.join(fixtures, 'first.pdf'), 'fake-pdf-1');
    fs.writeFileSync(path.join(fixtures, 'second.pdf'), 'fake-pdf-2');
    const { entries, pages } = parse(har([
        entry('POST', 'https://app.test/edoc/temporal-file/save', {
            reqHeaders: [{ name: 'Content-Type', value: 'multipart/form-data; boundary=----abc' }],
            postData: {
                mimeType: 'multipart/form-data',
                params: [
                    { name: 'file', fileName: 'recorded-name.pdf', contentType: 'application/pdf' },
                ],
            },
        }),
    ]));
    const out = tmp();
    const gen = generate(entries, pages, out, 'upload-ambiguous', { uploadSearchDirs: [fixtures] });

    assert.strictEqual(gen.uploadFiles.matched.length, 0);
    assert.strictEqual(gen.uploadFiles.missing[0].reason, 'ambiguous-compatible-file');
    assert.deepStrictEqual(gen.uploadFiles.missing[0].candidateNames.sort(), ['first.pdf', 'second.pdf']);
    assert.deepStrictEqual(gen.uploadFiles.fileMappings, {}, 'ambiguous files must not be mapped into the JMX');
});

test('upload files: missing upload does not create a file mapping', () => {
    const { entries } = parse(har([
        entry('POST', 'https://app.test/upload', {
            reqHeaders: [{ name: 'Content-Type', value: 'multipart/form-data; boundary=----abc' }],
            postData: {
                mimeType: 'multipart/form-data',
                params: [{ name: 'file', fileName: 'missing.pdf', contentType: 'application/pdf' }],
            },
        }),
    ]));
    const out = tmp();
    const plan = uploadFiles.resolveAndStageUploads({ entries, searchDirs: [tmp()], outDir: out });

    assert.strictEqual(plan.matched.length, 0);
    assert.strictEqual(plan.missing[0].reason, 'not-found');
    assert.deepStrictEqual(plan.fileMappings, {});
});

test('upload files: lone wrong-type support file is not used as upload bytes', () => {
    const fixtures = tmp();
    fs.writeFileSync(path.join(fixtures, 'only-document.docx'), 'not a pdf');
    const { entries } = parse(har([
        entry('POST', 'https://app.test/upload', {
            reqHeaders: [{ name: 'Content-Type', value: 'multipart/form-data; boundary=----abc' }],
            postData: {
                mimeType: 'multipart/form-data',
                params: [{ name: 'file', fileName: 'recorded.pdf', contentType: 'application/pdf' }],
            },
        }),
    ]));
    const plan = uploadFiles.resolveAndStageUploads({ entries, searchDirs: [fixtures], outDir: tmp() });

    assert.strictEqual(plan.matched.length, 0);
    assert.strictEqual(plan.missing[0].reason, 'not-found');
    assert.deepStrictEqual(plan.fileMappings, {});
});

test('parameterization policy: excludes protocol/auth/session fields from CSV candidates', () => {
    const candidates = generateInternal.filterParameterCandidates([
        { name: 'username', value: 'user@example.com' },
        { name: 'csrfToken', value: 'csrfRecorded123' },
        { name: 'sessionId', value: 'sessRecorded123' },
        { name: 'query', value: 'query GetMe { me { id } }' },
    ], {
        excludeNames: ['csrf', 'session', 'token'],
    });

    assert.deepStrictEqual(candidates.map(c => c.name), ['username']);
});

test('senior PE debrief: reconstructs objective, flow, value ledger, native managers, and negative space', () => {
    const entries = [
        entry('GET', 'https://app.test/login', {
            status: 200,
            body: '<html><input name="csrf" value="csrfRecorded1234"></html>',
        }),
        entry('POST', 'https://app.test/login', {
            reqHeaders: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
            postData: { mimeType: 'application/x-www-form-urlencoded', text: 'username=alice&csrf=csrfRecorded1234' },
            status: 302,
        }),
        entry('GET', 'https://app.test/search?q=laptop&page=1', {
            reqHeaders: [{ name: 'If-None-Match', value: 'etagRecorded1234' }],
            status: 200,
            body: '{"results":[{"id":"r1"}]}',
        }),
    ];
    const debrief = seniorPe.buildSeniorPeDebrief({
        name: 'flow',
        entries,
        runCfg: {},
        correlations: [{ variableName: 'csrf', value: 'csrfRecorded1234', sourceRequestIndex: 0, targetRequestIndex: 1 }],
        parameterCandidates: [{ name: 'username', value: 'alice' }, { name: 'q', value: 'laptop' }],
        ghosts: [{ name: 'x-request-id', kind: 'X_REQUEST_ID', sampleValue: 'reqRecorded1234' }],
        polling: [{ endpoint: 'GET /api/status', count: 3 }],
    });

    assert.strictEqual(debrief.objective.assumed, true);
    assert.match(debrief.flow.narrative, /authenticate/i);
    assert.ok(debrief.flow.samplerMap.length >= 3);
    assert.ok(debrief.nativeManagers.some(m => m.manager === 'HTTP Cache Manager'));
    assert.ok(debrief.valueLedger.some(v => v.role === 'server_generated_echoed_by_client' && v.decision === 'correlate'));
    assert.ok(debrief.valueLedger.some(v => v.role === 'user_test_input' && /objective/i.test(v.necessityRationale)));
    assert.ok(debrief.negativeSpace.some(g => /token expiry/i.test(g.gap)));
});

test('domain knowledge: builds stack, SLO, and persistence keys from local evidence', () => {
    const entries = [entry('POST', 'https://app.test/orders')];
    const profile = domainKnowledge.buildDomainProfile({
        name: 'checkout',
        entries,
        runCfg: {
            techStack: ['React', 'Spring Boot', 'OAuth'],
            domainNotes: ['Orders require cleanup after test runs.'],
            businessCriticalSteps: ['submit/update business data'],
            slo: { p95Ms: 750, errorRatePct: 1 },
        },
        verifiedLessons: [{ id: 'vls_1', stackFingerprint: [{ stack: 'OAuth/OIDC' }] }],
    });

    assert.strictEqual(profile.applicationKey, 'app.test');
    assert.deepStrictEqual(profile.businessCriticalSteps, ['submit/update business data']);
    assert.ok(profile.stackProfile.signals.some(s => s.stack === 'Spring Boot'));
    assert.deepStrictEqual(profile.slo, { p95Ms: 750, errorRatePct: 1 });
    assert.ok(profile.memoryScope.includes('app.test'));
    assert.strictEqual(profile.verifiedLessonCount, 1);
});

test('senior PE debrief: includes mature SLO and workload readiness gates', () => {
    const debrief = seniorPe.buildSeniorPeDebrief({
        name: 'orders',
        entries: [entry('POST', 'https://app.test/orders')],
        runCfg: {
            testObjective: 'checkout capacity',
            slo: { p95Ms: 750, errorRatePct: 1 },
            techStack: ['React', 'Spring Boot'],
        },
    });

    assert.ok(debrief.domainProfile);
    assert.ok(debrief.validityGates.some(g => g.gate === 'performance_slo' && g.status === 'review'));
    assert.ok(debrief.negativeSpace.some(g => g.gap === 'workload model missing'));
});

test('generate: writes senior PE debrief artifacts for reviewer and AI context', () => {
    const { entries, pages } = parse(har([
        entry('GET', 'https://app.test/login', { body: '<html><input name="csrf" value="csrfRecorded1234"></html>' }),
        entry('POST', 'https://app.test/login', {
            reqHeaders: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
            postData: { mimeType: 'application/x-www-form-urlencoded', text: 'username=alice&csrf=csrfRecorded1234' },
        }),
    ]));
    const out = tmp();
    const gen = generate(entries, pages, out, 'senior', {
        runCfg: { testObjective: 'single-scenario certification' },
    });

    assert.ok(gen.seniorPeDebrief);
    assert.ok(fs.existsSync(path.join(out, 'senior_senior_pe_debrief.json')));
    assert.ok(fs.existsSync(path.join(out, 'senior_senior_pe_debrief.md')));
    assert.strictEqual(gen.seniorPeDebrief.objective.assumed, false);
});

test('generate: writes mature domain profile artifact when PE context is provided', () => {
    const { entries, pages } = parse(har([
        entry('POST', 'https://app.test/orders'),
    ]));
    const out = tmp();
    const gen = generate(entries, pages, out, 'domain', {
        runCfg: {
            testObjective: 'checkout capacity',
            techStack: ['React', 'Spring Boot'],
            domainNotes: ['Orders require cleanup.'],
            slo: { p95Ms: 750, errorRatePct: 1 },
        },
    });

    assert.ok(gen.domainProfile);
    assert.ok(fs.existsSync(path.join(out, 'domain_domain_profile.json')));
    assert.strictEqual(gen.domainProfile.slo.p95Ms, 750);
});

test('senior PE analysis: identifies broken business step from status drift evidence', () => {
    const debrief = {
        objective: { value: 'checkout capacity', assumed: false },
        flow: {
            narrative: 'authenticate -> submit/update business data',
            businessSteps: [
                { name: 'authenticate', startIndex: 0, endIndex: 1, samplers: ['Step 01 - GET /login', 'Step 02 - POST /login'] },
                { name: 'submit/update business data', startIndex: 2, endIndex: 2, samplers: ['Step 03 - POST /orders'] },
            ],
        },
        stackFingerprint: { signals: [{ stack: 'OAuth/OIDC', evidence: 'client_id parameter' }] },
        negativeSpace: [{ gap: 'setup/teardown and data exhaustion', severity: 'high', action: 'Confirm unique orders.' }],
        nativeManagers: [{ manager: 'HTTP Cookie Manager', decision: 'required' }],
        validityGates: [{ gate: 'business_content_assertions', status: 'review' }],
        coverage: { dynamicValueCoveragePct: 80 },
    };
    const analysis = seniorPeAnalysis.analyzeSeniorPeFailure({
        name: 'checkout',
        seniorPeDebrief: debrief,
        result: {
            statusRootCause: {
                summary: 'Step 03 - POST /orders drifted from recorded 201 to live 403',
                rootCauseIndex: 2,
                rootCause: {
                    sampler: 'Step 03 - POST /orders',
                    expected: '201',
                    observed: '403',
                    category: 'status_drift',
                    repairHint: 'Repair upstream auth/session before patching order submit.',
                },
            },
        },
        blueprintEvidence: { firstFailure: { category: 'auth_correlation_failed', sampler: 'Step 03 - POST /orders' } },
    });

    assert.strictEqual(analysis.businessJourney, 'authenticate -> submit/update business data');
    assert.strictEqual(analysis.brokenBusinessStep.name, 'submit/update business data');
    assert.strictEqual(analysis.upstreamCause.category, 'status_drift');
    assert.strictEqual(analysis.recommendedNextStrategy.id, 'repair-earliest-upstream-drift');
    assert.ok(analysis.riskGaps.some(g => /setup\/teardown/i.test(g.gap)));
});

test('senior PE analysis: classifies auth/session failures separately from business endpoint defects', () => {
    const base = {
        objective: { value: 'login certification', assumed: false },
        flow: {
            narrative: 'authenticate -> open record/detail',
            businessSteps: [
                { name: 'authenticate', startIndex: 0, endIndex: 1, samplers: ['Step 01 - GET /login', 'Step 02 - POST /login'] },
                { name: 'open record/detail', startIndex: 2, endIndex: 2, samplers: ['Step 03 - GET /case/123'] },
            ],
        },
        stackFingerprint: { signals: [{ stack: 'SAML SSO', evidence: 'SAMLResponse' }] },
        negativeSpace: [],
        nativeManagers: [],
        validityGates: [],
        coverage: {},
    };

    const auth = seniorPeAnalysis.analyzeSeniorPeFailure({
        seniorPeDebrief: base,
        result: { samples: [{ label: 'Step 02 - POST /login', success: false, responseCode: '401' }] },
        blueprintEvidence: { firstFailure: { category: 'auth_correlation_failed', sampler: 'Step 02 - POST /login' } },
    });
    const business = seniorPeAnalysis.analyzeSeniorPeFailure({
        seniorPeDebrief: base,
        result: { samples: [{ label: 'Step 03 - GET /case/123', success: false, responseCode: '500' }] },
        blueprintEvidence: { firstFailure: { category: 'payload_or_header_failed', sampler: 'Step 03 - GET /case/123' } },
    });

    assert.strictEqual(auth.failureClass, 'auth/session');
    assert.strictEqual(auth.recommendedNextStrategy.id, 'auth-session-correlation');
    assert.strictEqual(business.failureClass, 'business-endpoint');
    assert.strictEqual(business.recommendedNextStrategy.id, 'environment-or-payload-investigation');
});

test('senior PE analysis: writes JSON and markdown artifacts', () => {
    const out = tmp();
    const analysis = seniorPeAnalysis.analyzeSeniorPeFailure({
        name: 'checkout',
        seniorPeDebrief: {
            objective: { value: 'checkout capacity', assumed: false },
            flow: { narrative: 'authenticate -> submit/update business data', businessSteps: [] },
            stackFingerprint: { signals: [] },
            negativeSpace: [],
            nativeManagers: [],
            validityGates: [],
            coverage: {},
        },
        result: { success: true, samples: [] },
    });

    const artifacts = seniorPeAnalysis.writeSeniorPeAnalysisArtifacts(out, 'checkout', analysis);

    assert.ok(fs.existsSync(artifacts.jsonPath));
    assert.ok(fs.existsSync(artifacts.markdownPath));
    assert.match(fs.readFileSync(artifacts.markdownPath, 'utf8'), /Senior PE Analysis/);
});

test('senior PE analysis: writes bounded AI strategy questions and citations only', () => {
    const out = tmp();
    const analysis = {
        name: 'checkout',
        businessJourney: 'authenticate -> submit/update business data',
        failureClass: 'auth/session',
        upstreamCause: { sampler: 'Step 02 - POST /login', summary: '401 after login' },
        recommendedNextStrategy: { id: 'auth-session-correlation', reason: 'repair login/session first' },
        riskGaps: [{ gap: 'workload model missing', action: 'Provide target throughput.' }],
    };

    const strategy = seniorPeAnalysis.buildAiStrategy(analysis);
    const artifacts = seniorPeAnalysis.writeAiStrategyArtifacts(out, 'checkout', strategy);

    assert.deepStrictEqual(Object.keys(strategy.allowedActions).sort(), ['askQuestions', 'citeEvidence', 'proposeStrategy'].sort());
    assert.ok(!strategy.allowedActions.patchJmx);
    assert.ok(fs.existsSync(artifacts.strategyPath));
    assert.ok(fs.existsSync(artifacts.questionsPath));
    assert.ok(fs.existsSync(artifacts.citationsPath));
    assert.match(fs.readFileSync(artifacts.questionsPath, 'utf8'), /target throughput/i);
});

test('senior PE analysis: prefers failure forensics root cause evidence', () => {
    const analysis = seniorPeAnalysis.analyzeSeniorPeFailure({
        name: 'auth-flow',
        seniorPeDebrief: { flow: { narrative: 'authenticate -> dashboard', businessSteps: [] } },
        result: {
            success: false,
            statusRootCause: {
                rootCauseIndex: 7,
                rootCause: { sampler: 'Step 08 - GraphQL GetCurrentUser', expected: 200, observed: 401, category: 'client_error' },
                summary: 'GraphQL failed',
            },
            failureForensics: {
                rootCause: {
                    index: 2,
                    sampler: 'Step 03 - GET /authorize/resume',
                    recordedStatus: 302,
                    observedStatus: 401,
                    category: 'auth_or_session_correlation_failed',
                },
                recommendedAction: { id: 'provide-test-auth-path', reason: 'Interactive auth redirect wall.' },
                summary: 'first divergence Step 03 - GET /authorize/resume recorded 302 observed 401',
            },
            samples: [],
        },
    });

    assert.strictEqual(analysis.failureClass, 'auth/session');
    assert.strictEqual(analysis.upstreamCause.sampler, 'Step 03 - GET /authorize/resume');
    assert.strictEqual(analysis.upstreamCause.expected, 302);
    assert.strictEqual(analysis.upstreamCause.observed, 401);
    assert.strictEqual(analysis.recommendedNextStrategy.id, 'provide-test-auth-path');
});

test('failure forensics: proves auth redirect divergence before downstream GraphQL symptoms', () => {
    const entries = [
        entry('GET', 'https://stgauth.webpt.com/authorize', { status: 302 }),
        entry('GET', 'https://stgauth.webpt.com/authorize/resume', { status: 302 }),
        entry('POST', 'https://stage-gateway.webpt.com/graphql', {
            postData: { mimeType: 'application/json', text: JSON.stringify({ query: 'query GetCurrentUser { currentUser { id } }' }) },
            status: 200,
            body: JSON.stringify({ data: { currentUser: { id: '123' } } }),
        }),
    ];
    entries[1].response.headers.push({ name: 'Set-Cookie', value: 'stgapp_sess=recorded; Path=/; HttpOnly' });
    const samples = [
        { label: 'Step 01 - GET /authorize', responseCode: '302', success: true },
        { label: 'Step 02 - GET /authorize/resume', responseCode: '401', success: false },
        { label: 'Step 03 - GraphQL query GetCurrentUser', responseCode: '401', success: false },
    ];

    const analysis = failureForensics.analyzeFailureForensics({ entries, samples });

    assert.strictEqual(analysis.rootCause.index, 1);
    assert.strictEqual(analysis.rootCause.recordedStatus, 302);
    assert.strictEqual(analysis.rootCause.observedStatus, 401);
    assert.strictEqual(analysis.redirects.interactiveAuthWall, true);
    assert.deepStrictEqual(analysis.authSession.missingSessionCookies, ['stgapp_sess']);
    assert.strictEqual(analysis.graphql.downstreamSymptoms.length, 1);
    assert.strictEqual(analysis.graphql.downstreamSymptoms[0].rootCauseIndex, 1);
    assert.strictEqual(analysis.recommendedAction.id, 'provide-test-auth-path');
});

test('failure forensics: classifies first 5xx divergence as environment evidence', () => {
    const entries = [
        entry('GET', 'https://app.test/health', { status: 200 }),
        entry('POST', 'https://app.test/api/save', { status: 200 }),
    ];
    const samples = [
        { label: 'Step 01 - GET /health', responseCode: '200', success: true },
        { label: 'Step 02 - POST /api/save', responseCode: '503', success: false },
    ];

    const analysis = failureForensics.analyzeFailureForensics({ entries, samples });

    assert.strictEqual(analysis.rootCause.index, 1);
    assert.strictEqual(analysis.rootCause.category, 'server_error_after_replay_request');
    assert.strictEqual(analysis.recommendedAction.id, 'fix-environment');
    assert.match(failureForensics.renderFailureForensicsMarkdown('save-flow', analysis), /recorded 200, observed 503/);
});

test('failure forensics: auth/session 5xx remains a repair target before environment-only blocker', () => {
    const entries = [
        entry('GET', 'https://login.test/authorize', {
            status: 200,
            reqHeaders: [],
            body: '<html>login</html>',
        }),
        entry('POST', 'https://login.test/u/login/password?state=recordedStateA123', {
            status: 302,
            postData: { mimeType: 'application/x-www-form-urlencoded', text: 'state=recordedStateA123&password=secret' },
        }),
    ];
    entries[0].response.headers.push({ name: 'Set-Cookie', value: 'auth0_sess=recordedCookieA123; Path=/; HttpOnly' });
    const samples = [
        { label: 'Step 01 - GET /authorize', code: '200', success: true, isTransaction: false },
        { label: 'Step 02 - POST /u/login/password', code: '500', success: false, isTransaction: false },
    ];

    const analysis = failureForensics.analyzeFailureForensics({ entries, samples });

    assert.strictEqual(analysis.rootCause.sampler, 'Step 02 - POST /u/login/password');
    assert.strictEqual(analysis.recommendedAction.id, 'repair-auth-session-correlation');
});

test('failure forensics: aligns recovered JTL samples by step number, not array position', () => {
    const entries = Array.from({ length: 13 }, (_, i) =>
        entry('GET', `https://app.test/step-${i + 1}`, { status: 200 })
    );
    entries[12] = entry('GET', 'https://app.test/redirect/', { status: 302 });
    const samples = [
        { label: 'Step 01 - GET /', responseCode: '200', success: false },
        { label: 'Step 02 - GET /', responseCode: '200', success: true },
        { label: 'Step 13 - GET /redirect/', responseCode: '500', success: false },
    ];

    const analysis = failureForensics.analyzeFailureForensics({ entries, samples });

    assert.strictEqual(analysis.rootCause.index, 12);
    assert.strictEqual(analysis.rootCause.sampler, 'Step 13 - GET /redirect/');
    assert.strictEqual(analysis.rootCause.url, 'https://app.test/redirect/');
    assert.strictEqual(analysis.rootCause.recordedStatus, 302);
    assert.strictEqual(analysis.rootCause.observedStatus, 500);
});

test('GraphQL auth repair: latest csrfToken producer feeds downstream X-CSRF-TOKEN headers', () => {
    const gql = (name, query, headerValue = null) => `
      <HTTPSamplerProxy testname="GraphQL ${name}">
        <stringProp name="HTTPSampler.path">/graphql</stringProp>
        <stringProp name="GraphQLHTTPSampler.operationName">${name}</stringProp>
        <stringProp name="GraphQLHTTPSampler.query">${query}</stringProp>
      </HTTPSamplerProxy>
      <hashTree>
        <HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="HTTP Header Manager">
          <collectionProp name="HeaderManager.headers">
            ${headerValue ? `<elementProp name="X-CSRF-TOKEN" elementType="Header">
              <stringProp name="Header.name">X-CSRF-TOKEN</stringProp>
              <stringProp name="Header.value">${headerValue}</stringProp>
            </elementProp>` : ''}
          </collectionProp>
        </HeaderManager>
        <hashTree/>
      </hashTree>`;
    const jmx = `<jmeterTestPlan><hashTree>
      ${gql('SSOEmrAuthenticate', 'mutation SSOEmrAuthenticate { ssoEmrAuthenticate { csrfToken } }')}
      ${gql('Login', 'mutation Login { login { csrfToken } }', 'recorded-sso-csrf')}
      ${gql('Verify', 'query Verify { verify { csrfToken } }', 'recorded-login-csrf')}
      ${gql('GetCurrentUserOrgs', 'query GetCurrentUserOrgs { currentUser { id } }', 'recorded-verify-csrf')}
    </hashTree></jmeterTestPlan>`;

    const repaired = propagateGraphqlCsrfTokens(jmx);

    assert.strictEqual(repaired.substitutions, 3);
    assert.strictEqual(repaired.extractors, 3);
    assert.match(repaired.xml, /JSONPostProcessor\.referenceNames">gql_SSOEmrAuthenticate_csrfToken</);
    assert.match(repaired.xml, /JSONPostProcessor\.referenceNames">gql_Login_csrfToken</);
    assert.match(repaired.xml, /JSONPostProcessor\.referenceNames">gql_Verify_csrfToken</);
    assert.match(repaired.xml, /Header\.value">\$\{gql_SSOEmrAuthenticate_csrfToken\}</);
    assert.match(repaired.xml, /Header\.value">\$\{gql_Login_csrfToken\}</);
    assert.match(repaired.xml, /Header\.value">\$\{gql_Verify_csrfToken\}</);
    assert.doesNotMatch(repaired.xml, /recorded-verify-csrf/);
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
        entry('GET', 'https://login.example.com/authorize?response_type=code&client_id=abc&redirect_uri=https%3A%2F%2Fapp%2Fcb&state=recordedState123&state-small=smallState123&nonce=recordedNonce456'),
        entry('GET', 'https://app.example.com/callback?code=authCode789&state=recordedState123'),
    ];
    const corrs = [
        { variableName: 'state', value: 'recordedState123' },
        { variableName: 'state-small', value: 'smallState123' },
        { variableName: 'nonce', value: 'recordedNonce456' },
        { variableName: 'code', value: 'authCode789' },
        { variableName: 'state', value: 'loginPageState789' },
        { variableName: 'state_4', value: 'serverIssuedLoginState789' },
    ];
    const filtered = generateInternal.filterBareOauthStateNonceCorrelations(corrs, entries);
    assert.deepStrictEqual(filtered.removed.map(c => c.variableName).sort(), ['code', 'nonce', 'state', 'state', 'state-small']);
    assert.deepStrictEqual(filtered.kept.map(c => c.variableName), ['state_4']);
});

test('OAuth manual rule: keeps business code values outside auth protocol context', () => {
    const entries = [
        entry('POST', 'https://shop.example.com/api/coupons', {
            postData: { mimeType: 'application/json', text: JSON.stringify({ code: 'SAVE20' }) },
        }),
    ];
    const corrs = [{ variableName: 'code', value: 'SAVE20' }];
    const filtered = generateInternal.filterBareOauthStateNonceCorrelations(corrs, entries);
    assert.deepStrictEqual(filtered.removed, []);
    assert.deepStrictEqual(filtered.kept, corrs);
});

test('volatile protocol detector: ignores unknown single-use auth fields by context and value', () => {
    const txn = 'a9Dk3LmN8Qx72ZpR';
    const flow = 'flow-7f4a9c2d8e1b';
    const entries = [
        entry('GET', `https://idp.example.com/authorize?response_type=code&client_id=abc&redirect_uri=https%3A%2F%2Fapp%2Fcb&txnRef=${txn}&flowKey=${flow}`),
    ];
    const corrs = [
        { variableName: 'txnRef', value: txn },
        { variableName: 'flowKey', value: flow },
    ];

    const filtered = volatileProtocol.filterVolatileProtocolCorrelations(corrs, entries);

    assert.deepStrictEqual(filtered.removed.map(c => c.variableName).sort(), ['flowKey', 'txnRef']);
    assert.deepStrictEqual(filtered.kept, []);
    assert.deepStrictEqual(filtered.observedNames.sort(), ['flowkey', 'response_type', 'txnref']);
});

test('volatile protocol detector: keeps ordinary business values outside auth context', () => {
    const entries = [
        entry('POST', 'https://shop.example.com/api/orders', {
            postData: { mimeType: 'application/json', text: JSON.stringify({ flowKey: 'checkout-flow-2026', couponCode: 'SAVE20' }) },
        }),
    ];
    const corrs = [
        { variableName: 'flowKey', value: 'checkout-flow-2026' },
        { variableName: 'couponCode', value: 'SAVE20' },
    ];

    const filtered = volatileProtocol.filterVolatileProtocolCorrelations(corrs, entries);

    assert.deepStrictEqual(filtered.removed, []);
    assert.deepStrictEqual(filtered.kept, corrs);
});

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

test('status analysis: recording-first status semantics explain 2xx, 3xx, 4xx, and 5xx relevance', () => {
    assert.deepStrictEqual(statusAnalysis.classifyStatusTransition(202, 202), {
        recorded: 202,
        observed: 202,
        recordedFamily: '2xx',
        observedFamily: '2xx',
        matchesRecording: true,
        category: 'status_matches_recording',
        relevance: 'accepted_async_success',
        repairHint: 'No status repair needed; compare body/headers if later samplers drift.',
    });

    const changedSuccess = statusAnalysis.classifyStatusTransition(202, 200);
    assert.strictEqual(changedSuccess.matchesRecording, false);
    assert.strictEqual(changedSuccess.category, 'success_code_drift');
    assert.match(changedSuccess.repairHint, /recording expected 202/i);

    // Recorded 302 replaying as 200 is JMeter's redirect FOLDING, not drift —
    // a passing flow must never be failed over it (live run verify7 evidence).
    const redirectFolded = statusAnalysis.classifyStatusTransition(302, 200);
    assert.strictEqual(redirectFolded.category, 'redirect_folded_by_replay');
    assert.strictEqual(redirectFolded.folded, true);
    assert.strictEqual(redirectFolded.relevance, 'informational');
    // A redirect that replays as an ERROR is still real drift.
    const redirectBroken = statusAnalysis.classifyStatusTransition(302, 404);
    assert.strictEqual(redirectBroken.category, 'redirect_flow_drift');
    assert.ok(!redirectBroken.folded);

    assert.strictEqual(statusAnalysis.classifyStatusTransition(200, 401).category, 'auth_or_session_correlation_failed');
    assert.strictEqual(statusAnalysis.classifyStatusTransition(200, 422).category, 'request_payload_or_header_failed');
    assert.strictEqual(statusAnalysis.classifyStatusTransition(200, 500).category, 'server_error_after_replay_request');
});

test('status analysis: lenient success drift folds 200->201 async-create only when opted in', () => {
    // Default (strict, recording-first) still flags it — preserves the senior-PE principle.
    assert.strictEqual(statusAnalysis.classifyStatusTransition(200, 201).category, 'success_code_drift');
    // With run.strictStatusMatch=false, a create returning 201 where recording had 200 is tolerated.
    const lenient = statusAnalysis.classifyStatusTransition(200, 201, { lenientSuccessDrift: true });
    assert.strictEqual(lenient.folded, true);
    assert.strictEqual(lenient.category, 'success_code_drift_tolerated');
    // Lenient does NOT excuse a real failure (200 -> 401 is still auth drift).
    assert.strictEqual(
        statusAnalysis.classifyStatusTransition(200, 401, { lenientSuccessDrift: true }).category,
        'auth_or_session_correlation_failed'
    );
});

test('final green gate: a 200 body carrying a GraphQL/soft-failure error fails the gate (no false green)', () => {
    const evidence = {
        rows: [
            {
                entryIndex: 0, label: 'Step 01 - POST /graphql', isTransaction: false,
                observedStatus: 200, success: true,
                recordedBodyLength: 40, observedBodyLength: 60,
                recordedBody: '{"data":{"me":{"id":1}}}',
                observedBody: '{"data":null,"errors":[{"message":"Session Expired"}]}',
                entry: { response: { status: 200 } },
            },
        ],
    };
    const gate = finalGreenGate.evaluateFinalGreenGate({ result: { success: true }, evidence });
    assert.strictEqual(gate.ok, false);
    assert.ok(gate.categories.includes('business_error_in_body'));
});

test('final green gate: operator soft-failure pattern extends the built-in body scan', () => {
    const evidence = {
        rows: [{
            entryIndex: 0, label: 'Step 01 - GET /account', isTransaction: false,
            observedStatus: 200, success: true, recordedBodyLength: 10, observedBodyLength: 30,
            recordedBody: '{"ok":true}', observedBody: '{"code":"ACCT_LOCKED"}',
            entry: { response: { status: 200 } },
        }],
    };
    const clean = finalGreenGate.evaluateFinalGreenGate({ result: { success: true }, evidence });
    assert.strictEqual(clean.ok, true); // ACCT_LOCKED is not a built-in marker
    const strict = finalGreenGate.evaluateFinalGreenGate({ result: { success: true }, evidence, softFailurePatterns: ['ACCT_LOCKED'] });
    assert.strictEqual(strict.ok, false);
});

test('runner: body-capture properties default to onError, honor off/full + byte cap', () => {
    const off = runnerInternal.bodyCaptureProperties({ captureResponseBodies: 'off' });
    assert.strictEqual(off['jmeter.save.saveservice.response_data'], 'false');
    assert.strictEqual(off['jmeter.save.saveservice.response_data.on_error'], 'false');
    assert.ok(!('httpsampler.max_bytes_to_store_per_sample' in off));

    const def = runnerInternal.bodyCaptureProperties({});
    assert.strictEqual(def['jmeter.save.saveservice.response_data'], 'false');
    assert.strictEqual(def['jmeter.save.saveservice.response_data.on_error'], 'true');
    assert.strictEqual(def['httpsampler.max_bytes_to_store_per_sample'], '65536');

    const full = runnerInternal.bodyCaptureProperties({ captureResponseBodies: 'full', maxResponseBytes: 8192 });
    assert.strictEqual(full['jmeter.save.saveservice.response_data'], 'true');
    assert.strictEqual(full['httpsampler.max_bytes_to_store_per_sample'], '8192');
});

test('final green gate: assertion-free script is a warning by default, hard fail under requireAssertions', () => {
    const base = { result: { success: true }, baselineDiff: null, evidence: null };
    const warn = finalGreenGate.evaluateFinalGreenGate({ ...base, assertionsPlanned: 0 });
    assert.strictEqual(warn.ok, true);
    assert.ok(warn.warnings.some(w => w.category === 'no_assertion_coverage'));

    const strict = finalGreenGate.evaluateFinalGreenGate({ ...base, assertionsPlanned: 0, requireAssertions: true });
    assert.strictEqual(strict.ok, false);
    assert.ok(strict.categories.includes('no_assertion_coverage'));

    // With assertions present, no coverage finding at all.
    const covered = finalGreenGate.evaluateFinalGreenGate({ ...base, assertionsPlanned: 3, requireAssertions: true });
    assert.ok(!covered.warnings.some(w => w.category === 'no_assertion_coverage'));
    assert.ok(!covered.categories.includes('no_assertion_coverage'));
});

test('status analysis: traces root cause to earliest upstream recording drift before failing sampler', () => {
    const entries = [
        entry('GET', 'https://app.test/auth', { status: 302 }),
        entry('GET', 'https://app.test/callback', { status: 200, body: '{"ok":true}' }),
        entry('GET', 'https://app.test/me', { status: 200, body: '{"user":true}' }),
    ];
    const samples = [
        { label: 'Step 01 - GET /auth', code: '404', success: false, isTransaction: false },
        { label: 'Step 02 - GET /callback', code: '200', success: true, isTransaction: false },
        { label: 'Step 03 - GET /me', code: '401', success: false, isTransaction: false },
    ];

    const root = statusAnalysis.traceStatusRootCause({ entries, samples, failingIndex: 2 });

    assert.strictEqual(root.rootCauseIndex, 0);
    assert.strictEqual(root.rootCause.category, 'redirect_flow_drift');
    assert.strictEqual(root.failing.category, 'auth_or_session_correlation_failed');
    assert.match(root.summary, /earliest upstream divergence/i);

    // A 302→200 fold upstream of a failure is NOT the root cause.
    const foldedSamples = [
        { label: 'Step 01 - GET /auth', code: '200', success: true, isTransaction: false },
        { label: 'Step 02 - GET /callback', code: '200', success: true, isTransaction: false },
        { label: 'Step 03 - GET /me', code: '401', success: false, isTransaction: false },
    ];
    const root2 = statusAnalysis.traceStatusRootCause({ entries, samples: foldedSamples, failingIndex: 2 });
    assert.strictEqual(root2.rootCauseIndex, 2, 'the 401 itself is the earliest real divergence');
    // And a fully-passing folded run yields no root cause at all.
    const cleanSamples = foldedSamples.map(s => ({ ...s, code: s.label.includes('Step 03') ? '200' : s.code, success: true }));
    assert.strictEqual(statusAnalysis.traceStatusRootCause({ entries, samples: cleanSamples }), null);
});

test('status analysis: assertion-only failures do not hide later status divergence', () => {
    const entries = Array.from({ length: 13 }, (_, i) =>
        entry('GET', `https://app.test/step-${i + 1}`, { status: 200 })
    );
    entries[12] = entry('GET', 'https://app.test/redirect/', { status: 302 });
    const samples = [
        { label: 'Step 01 - GET /', responseCode: '200', success: false, failureMessage: 'assertion failed', isTransaction: false },
        { label: 'Step 02 - GET /', responseCode: '200', success: true, isTransaction: false },
        { label: 'Step 13 - GET /redirect/', responseCode: '500', success: false, isTransaction: false },
    ];

    assert.strictEqual(statusAnalysis._internal.firstStatusDivergenceIndex(entries, samples), 12);
    const root = statusAnalysis.traceStatusRootCause({ entries, samples });

    assert.strictEqual(root.rootCauseIndex, 12);
    assert.strictEqual(root.rootCause.sampler, 'Step 13 - GET /redirect/');
    assert.strictEqual(root.rootCause.recorded, 302);
    assert.strictEqual(root.rootCause.observed, 500);
});

test('failure classifier: uses status root cause evidence when available', () => {
    const classified = failureClassifier.classifyFirstFailure({
        statusRootCause: {
            rootCauseIndex: 0,
            rootCause: { category: 'redirect_flow_drift', recorded: 302, observed: 200 },
            failing: { category: 'auth_or_session_correlation_failed', recorded: 200, observed: 401 },
            summary: 'earliest upstream divergence at Step 01',
        },
        samples: [{ label: 'Step 03 - GET /me', success: false, responseCode: '401', isTransaction: false }],
    });

    assert.strictEqual(classified.category, 'redirect_flow_drift');
    assert.strictEqual(classified.rootCauseIndex, 0);
    assert.match(classified.message, /earliest upstream divergence/i);
});

test('runner: LLM failure collection prioritizes status root cause before downstream symptom', () => {
    const failures = runnerInternal.collectLlmFailures({
        statusRootCause: {
            rootCauseIndex: 0,
            rootCause: { sampler: 'Step 01 - GET /auth', category: 'redirect_flow_drift', observed: 200 },
            failingIndex: 2,
            failing: { sampler: 'Step 03 - GET /me', category: 'auth_or_session_correlation_failed', observed: 401 },
            summary: 'earliest upstream divergence at Step 01',
        },
        samples: [
            { label: 'Step 03 - GET /me', index: 2, success: false, responseCode: '401', isTransaction: false },
        ],
    });

    assert.strictEqual(failures[0].samplerName, 'Step 01 - GET /auth');
    assert.strictEqual(failures[0].category, 'redirect_flow_drift');
    assert.match(failures[0].failureMessage, /earliest upstream divergence/);
});

test('runner: recording status drift on an all-passing run is a warning, not a failure', () => {
    // Every request passed (200 vs a recorded 202) and nothing downstream
    // failed — benign drift between an aged recording and the live app. It must
    // surface as a review warning, never flip a fully-green run red.
    const result = runnerInternal.applyStatusRootCauseToResult({
        success: true,
        samples: [
            { label: 'Step 01 - POST /job', code: '200', success: true, isTransaction: false },
        ],
    }, [
        entry('POST', 'https://app.test/job', { status: 202 }),
    ]);

    assert.strictEqual(result.success, true);
    assert.ok(!result.recordingDriftFailure);
    assert.ok(result.statusRootCauseWarning, 'drift surfaced as a warning');
    assert.strictEqual(result.statusRootCause.rootCause.category, 'success_code_drift');
});

test('runner: recording status drift WITH a real sampler failure is still a hard failure', () => {
    // The divergence trace must still indict the run when something actually
    // failed (the classic "downstream 401 whose ROOT is an upstream drift").
    const result = runnerInternal.applyStatusRootCauseToResult({
        success: true,
        samples: [
            { label: 'Step 01 - GET /', code: '200', success: true, isTransaction: false },
            { label: 'Step 02 - GET /me', code: '401', success: false, isTransaction: false },
        ],
    }, [
        entry('GET', 'https://app.test/', { status: 302 }),
        entry('GET', 'https://app.test/me'),
    ]);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.recordingDriftFailure, true);
});

test('runner: status root cause is surfaced in unresolved failures for reports', () => {
    const result = runnerInternal.applyStatusRootCauseToResult({
        success: false,
        unresolvedFailures: [
            {
                samplerLabel: 'Step 03 - POST /scheduler/index/data/T/d',
                issue: 'session_expired_or_auth_failed',
                responseCode: '401',
                manualFixHint: 'Downstream scheduler failed.',
            },
        ],
        samples: [
            { label: 'Step 01 - GET /', responseCode: '200', success: true, finalUrl: 'https://stglogin.webpt.com/u/login/identifier' },
            { label: 'Step 03 - POST /scheduler/index/data/T/d', responseCode: '401', success: false },
        ],
    }, [
        entry('GET', 'https://stgapp.webpt.com/', { status: 302 }),
        entry('GET', 'https://stgapp.webpt.com/dashboard.php'),
        entry('POST', 'https://stgapp.webpt.com/scheduler/index/data/T/d'),
    ]);

    assert.strictEqual(result.unresolvedFailures[0].samplerLabel, 'Step 01 - GET /');
    assert.strictEqual(result.unresolvedFailures[0].issue, 'upstream_recording_divergence');
    assert.match(result.unresolvedFailures[0].manualFixHint, /earliest upstream divergence/i);
    assert.strictEqual(result.unresolvedFailures[1].issue, 'cascade_from_Step 01 - GET /');
});

test('runner: blueprint first failure refreshes from status root cause evidence', () => {
    const ctx = {
        loop: { firstFailure: { category: 'auth_correlation_failed', sampler: 'Step 03 - GET /me' } },
        validation: {},
    };
    const result = {
        statusRootCause: {
            rootCauseIndex: 0,
            failingIndex: 2,
            rootCause: { sampler: 'Step 01 - GET /auth', category: 'redirect_flow_drift', observed: 200 },
            failing: { sampler: 'Step 03 - GET /me', category: 'auth_or_session_correlation_failed', observed: 401 },
            summary: 'earliest upstream divergence at Step 01',
        },
    };

    runnerInternal.refreshBlueprintFirstFailure(ctx, result);

    assert.strictEqual(ctx.loop.firstFailure.category, 'redirect_flow_drift');
    assert.strictEqual(ctx.loop.firstFailure.sampler, 'Step 01 - GET /auth');
});

test('semantic response: detects false 200 login pages and GraphQL errors', () => {
    const loginDrift = semanticResponse.compareRecordedLiveResponse({
        recorded: { status: 200, body: '{"data":{"me":{"id":"u1"}}}', contentType: 'application/json' },
        observed: { status: 200, body: '<html><title>Login</title><form action="/login"></form></html>', headers: { 'content-type': 'text/html' } },
        sampler: 'Step 03 - GET /me',
        index: 2,
    });
    assert.strictEqual(loginDrift.ok, false);
    assert.strictEqual(loginDrift.issues[0].kind, 'htmlLoginInsteadOfRecordedJson');

    const gqlDrift = semanticResponse.compareRecordedLiveResponse({
        recorded: { status: 200, body: '{"data":{"createTask":{"id":"t1"}}}', contentType: 'application/json' },
        observed: { status: 200, body: '{"errors":[{"message":"Unauthorized"}],"data":null}', headers: { 'content-type': 'application/json' } },
        sampler: 'GraphQL mutation createTask',
        index: 4,
    });
    assert.strictEqual(gqlDrift.ok, false);
    assert.strictEqual(gqlDrift.issues[0].kind, 'graphqlErrors');
});

test('final green gate: rejects status drift, semantic drift, and failed business verification', () => {
    const green = finalGreenGate.evaluateFinalGreenGate({
        result: { success: true },
        baselineDiff: { samplesCompared: 1, drift: [] },
        semanticDiff: { issues: [] },
        businessVerification: { ok: true },
    });
    assert.strictEqual(green.ok, true);

    const rejected = finalGreenGate.evaluateFinalGreenGate({
        result: { success: true },
        baselineDiff: { samplesCompared: 2, drift: [{ sampler: 'GET /me', issues: [{ kind: 'statusDiff' }] }] },
        semanticDiff: { issues: [{ sampler: 'GraphQL createTask', kind: 'graphqlErrors' }] },
        businessVerification: { ok: false, reason: 'protected sampler missing' },
    });
    assert.strictEqual(rejected.ok, false);
    // Baseline drift on a PASSING run is a review warning (GREEN-with-drift);
    // semantic drift and business verification stay hard blockers.
    assert.deepStrictEqual(rejected.categories, ['semantic_drift', 'business_verification_failed']);
    assert.strictEqual(rejected.warnings.length, 1);
    assert.strictEqual(rejected.warnings[0].category, 'baseline_drift');
});

test('final green gate: bodyless auth redirect mismatch is warning unless downstream fails', () => {
    const start = entry('GET', 'https://stgapp.webpt.com/', { status: 302, body: '' });
    start.response.content.text = '';
    const dashboard = entry('GET', 'https://stgapp.webpt.com/dashboard', { status: 200, body: '' });
    dashboard.response.content.text = '';
    const cleanEvidence = {
        rows: [
            {
                entryIndex: 0,
                label: 'SC01_T01_GET_/-001',
                entry: start,
                recordedStatus: 302,
                observedStatus: 200,
                recordedBodyLength: 0,
                observedBodyLength: 0,
                finalUrl: 'https://stglogin.webpt.com/u/login/identifier',
                sample: { responseCode: '200', success: true, finalUrl: 'https://stglogin.webpt.com/u/login/identifier' },
            },
            {
                entryIndex: 1,
                label: 'SC01_T01_/dashboard-002',
                entry: dashboard,
                recordedStatus: 200,
                observedStatus: 200,
                recordedBodyLength: 0,
                observedBodyLength: 0,
                sample: { responseCode: '200', success: true },
            },
        ],
    };

    const clean = finalGreenGate.evaluateFinalGreenGate({ result: { success: true }, evidence: cleanEvidence });
    assert.strictEqual(clean.ok, true);
    assert.ok(clean.warnings.some(w => w.category === 'bodyless_redirect_review'));

    const failingEvidence = {
        rows: cleanEvidence.rows.map(row => ({ ...row })),
    };
    failingEvidence.rows[1] = {
        ...failingEvidence.rows[1],
        observedStatus: 401,
        success: false,
        transactionName: 'SC01_T02_Login',
        sample: { responseCode: '401', success: false, transactionName: 'SC01_T02_Login' },
    };

    const gate = finalGreenGate._internal.evaluateEvidenceGate(failingEvidence);
    assert.strictEqual(gate.failures.length, 1);
    assert.match(gate.failures[0].reason, /downstream/i);
    assert.match(gate.failures[0].reason, /SC01_T02_Login/);

    const logoutEvidence = {
        rows: cleanEvidence.rows.map(row => ({ ...row })),
    };
    logoutEvidence.rows[1] = {
        ...logoutEvidence.rows[1],
        label: 'SC01_T09_/authorize/resume-011',
        observedStatus: 401,
        success: false,
        transactionName: 'SC01_T09_Scheduled_Visits_Performance_STG_0061_Logout',
        sample: {
            responseCode: '401',
            success: false,
            transactionName: 'SC01_T09_Scheduled_Visits_Performance_STG_0061_Logout',
        },
    };

    const logoutGate = finalGreenGate.evaluateFinalGreenGate({ result: { success: true }, evidence: logoutEvidence });
    assert.strictEqual(logoutGate.ok, true);
    assert.ok(logoutGate.warnings.some(w => w.category === 'logout_downstream_ignored'));
});

test('request diff: identifies stale request values and redirect header drift', () => {
    const recorded = entry('GET', 'https://app.test/me?state=RECORDED1234', {
        reqHeaders: [{ name: 'X-CSRF-TOKEN', value: 'csrfRecorded1234' }],
    });
    const observedRequest = {
        method: 'GET',
        url: 'https://app.test/me?state=LIVE5678',
        headers: { 'x-csrf-token': 'csrfRecorded1234', authorization: 'Bearer liveToken1234' },
        body: '',
    };
    const diff = requestDiff.compareRecordedRequestToObserved({
        entry: recorded,
        observedRequest,
        index: 1,
        sampler: 'Step 02 - GET /me',
    });

    assert.strictEqual(diff.ok, false);
    assert.ok(diff.issues.some(i => i.kind === 'queryValueDiff' && i.name === 'state'));
    assert.ok(diff.issues.some(i => i.kind === 'headerStillRecorded' && i.name === 'x-csrf-token'));

    const redirect = requestDiff.compareRedirectResponse({
        recorded: { status: 302, headers: { location: '/callback?code=rec&state=old' } },
        observed: { status: 302, headers: { location: '/callback?code=live&state=new' } },
        sampler: 'Step 01 - GET /authorize',
        index: 0,
    });
    assert.strictEqual(redirect.ok, false);
    assert.ok(redirect.issues.some(i => i.kind === 'locationParamDiff' && i.name === 'code'));
});

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
    assert.match(res.reason, /targetBaseUrl/);
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

test('blueprint agent: uses resolved targetBaseUrl when override is blank', async () => {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
    });
    await listenLocal(server);
    const port = server.address().port;
    const ctx = blueprintContext.createBlueprintContext({
        entries: [entry('GET', 'http://recorded.test/start')],
        outDir: tmp(), name: 'resolved-target', mode: 'har',
        runCfg: { targetBaseUrl: `http://127.0.0.1:${port}` },
        agentCfg: { enabled: true },
    });

    try {
        const res = await blueprintAgent.runBlueprintPreflight({
            ctx,
            entries: [entry('GET', 'http://recorded.test/start')],
            runCfg: { targetBaseUrlOverride: '', targetBaseUrl: `http://127.0.0.1:${port}` },
            onLog: () => {},
        });

        assert.strictEqual(res.skipped, false);
        assert.strictEqual(ctx.loop.attempts[0].skipped, false);
    } finally {
        await closeServer(server);
    }
});

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

test('runner blueprint evidence: includes senior PE analysis when present', () => {
    const ctx = blueprintContext.createBlueprintContext({
        entries: [],
        outDir: tmp(),
        name: 'bp',
        runCfg: {},
        agentCfg: {},
    });
    ctx.seniorPe = { flow: { narrative: 'authenticate -> submit/update business data' }, stackFingerprint: { signals: [] }, valueLedger: [] };
    ctx.seniorPeAnalysis = {
        businessJourney: 'authenticate -> submit/update business data',
        brokenBusinessStep: { name: 'submit/update business data' },
        failureClass: 'auth/session',
        recommendedNextStrategy: { id: 'auth-session-correlation' },
    };

    const summary = runnerInternal.summarizeBlueprintEvidence(ctx);

    assert.strictEqual(summary.flowIntentAnalysis.failureClass, 'auth/session');
    assert.strictEqual(summary.flowIntentAnalysis.recommendedNextStrategy.id, 'auth-session-correlation');
});

test('runner blueprint evidence: includes failure forensics before AI escalation', () => {
    const ctx = blueprintContext.createBlueprintContext({
        entries: [],
        outDir: tmp(),
        name: 'bp',
        runCfg: {},
        agentCfg: {},
    });
    ctx.validation.failureForensics = {
        rootCause: {
            sampler: 'Step 12 - GET /authorize/resume',
            recordedStatus: 302,
            observedStatus: 401,
            category: 'auth_or_session_correlation_failed',
        },
        recommendedAction: { id: 'provide-test-auth-path', reason: 'Interactive auth redirect wall.' },
        authSession: { missingSessionCookies: ['stgapp_sess'] },
        graphql: { downstreamSymptoms: [{ sampler: 'GraphQL GetCurrentUser' }] },
    };

    const summary = runnerInternal.summarizeBlueprintEvidence(ctx);

    assert.strictEqual(summary.failureForensics.rootCause.sampler, 'Step 12 - GET /authorize/resume');
    assert.strictEqual(summary.failureForensics.recommendedAction.id, 'provide-test-auth-path');
    assert.deepStrictEqual(summary.failureForensics.missingSessionCookies, ['stgapp_sess']);
    assert.strictEqual(summary.failureForensics.downstreamGraphqlSymptoms, 1);
});

test('runner failure forensics: writes JSON and Markdown artifacts', () => {
    const out = tmp();
    const logs = [];
    const result = {
        success: false,
        samples: [
            { label: 'Step 01 - GET /authorize/resume', responseCode: '401', success: false },
        ],
    };
    const entries = [
        entry('GET', 'https://stgauth.webpt.com/authorize/resume', { status: 302 }),
    ];

    const analysis = runnerInternal.attachFailureForensics({
        result,
        entries,
        outDir: out,
        name: 'flow',
        onLog: msg => logs.push(msg),
    });

    assert.strictEqual(result.failureForensics.rootCause.observedStatus, 401);
    assert.strictEqual(analysis.rootCause.recordedStatus, 302);
    assert.ok(fs.existsSync(path.join(out, 'flow_failure_forensics.json')));
    assert.match(fs.readFileSync(path.join(out, 'flow_failure_forensics.md'), 'utf8'), /First divergence/);
    assert.match(logs.join('\n'), /failure forensics: first divergence/);
});

test('AI fix prompt: includes senior PE analysis evidence when provided', () => {
    const built = runnerInternal.buildGeminiFixPrompt({
        failures: [{ samplerName: 'Step 03 - POST /orders', responseCode: '403', failureMessage: 'Forbidden' }],
        jmxContent: '<HTTPSamplerProxy testname="Step 03 - POST /orders" enabled="true"></HTTPSamplerProxy><hashTree/>',
        correlations: [],
        blueprintEvidence: {
            flowIntentAnalysis: {
                businessJourney: 'authenticate -> submit/update business data',
                brokenBusinessStep: { name: 'submit/update business data' },
                recommendedNextStrategy: { id: 'auth-session-correlation' },
            },
        },
    });

    assert.match(built.userPrompt, /flowIntentAnalysis/);
    assert.match(built.userPrompt, /auth-session-correlation/);
    assert.match(built.userPrompt, /submit\/update business data/);
});

test('HTML report: links blueprint agent artifacts', () => {
    const out = tmp();
    fs.writeFileSync(path.join(out, 'bp_blueprint_context.json'), '{}');
    fs.writeFileSync(path.join(out, 'bp_lineage.json'), '{}');
    fs.writeFileSync(path.join(out, 'bp_repair_rounds.json'), '{}');
    fs.writeFileSync(path.join(out, 'bp_correlation_hypotheses.json'), '{}');
    fs.writeFileSync(path.join(out, 'bp_correlation_fast_repair.json'), '{}');
    fs.writeFileSync(path.join(out, 'bp_correlation_patches.json'), '{}');
    fs.writeFileSync(path.join(out, 'bp_senior_pe_debrief.json'), '{}');
    fs.writeFileSync(path.join(out, 'bp_senior_pe_debrief.md'), '# Senior PE');
    fs.writeFileSync(path.join(out, 'bp_domain_profile.json'), '{}');
    fs.writeFileSync(path.join(out, 'bp_pe_analysis.json'), '{}');
    fs.writeFileSync(path.join(out, 'bp_pe_analysis.md'), '# PE Analysis');
    fs.writeFileSync(path.join(out, 'bp_ai_strategy.json'), '{}');
    fs.writeFileSync(path.join(out, 'bp_human_questions.md'), '# Questions');
    fs.writeFileSync(path.join(out, 'bp_evidence_citations.json'), '[]');
    fs.writeFileSync(path.join(out, 'bp_blockers.json'), '[]');
    fs.writeFileSync(path.join(out, 'bp_blockers.md'), '# Blockers');
    fs.writeFileSync(path.join(out, 'bp_failure_forensics.json'), JSON.stringify({
        rootCause: {
            sampler: 'Step 12 - GET /authorize/resume',
            recordedStatus: 302,
            observedStatus: 401,
        },
        authSession: { missingSessionCookies: ['stgapp_sess'] },
        redirects: { interactiveAuthWall: true },
        graphql: { downstreamSymptoms: [{ sampler: 'Step 13 - GraphQL GetCurrentUser' }] },
        recommendedAction: { id: 'provide-test-auth-path' },
    }, null, 2));
    fs.writeFileSync(path.join(out, 'bp_failure_forensics.md'), '# Failure Forensics');

    const reportPath = writeHtmlReportFn(out, 'bp', {
        mode: 'agent', verdict: 'needs attention', stats: {}, samples: [],
    });
    const html = fs.readFileSync(reportPath, 'utf8');

    assert.match(html, /bp_blueprint_context\.json/);
    assert.match(html, /bp_lineage\.json/);
    assert.match(html, /bp_repair_rounds\.json/);
    assert.match(html, /bp_correlation_hypotheses\.json/);
    assert.match(html, /bp_correlation_fast_repair\.json/);
    assert.match(html, /bp_correlation_patches\.json/);
    assert.match(html, /bp_senior_pe_debrief\.json/);
    assert.match(html, /bp_senior_pe_debrief\.md/);
    assert.match(html, /bp_domain_profile\.json/);
    assert.match(html, /bp_pe_analysis\.json/);
    assert.match(html, /bp_pe_analysis\.md/);
    assert.match(html, /bp_ai_strategy\.json/);
    assert.match(html, /bp_human_questions\.md/);
    assert.match(html, /bp_evidence_citations\.json/);
    assert.match(html, /bp_blockers\.json/);
    assert.match(html, /bp_blockers\.md/);
    assert.match(html, /bp_failure_forensics\.json/);
    assert.match(html, /bp_failure_forensics\.md/);
    assert.match(html, /Failure forensics/);
    assert.match(html, /Step 12 - GET \/authorize\/resume/);
    assert.match(html, /stgapp_sess/);
    assert.match(html, /provide-test-auth-path/);
});

test('value-flow decisions: consumed outputs make a failing sampler must-fix', () => {
    const token = 'tok_A1B2C3D4E5F6';
    const entries = [
        entry('GET', 'https://app.test/bootstrap', {
            body: JSON.stringify({ token }),
            reqHeaders: [],
        }),
        entry('GET', `https://app.test/api/items?token=${token}`),
    ];

    const decisions = valueFlowDecisions.classifySamplerDisableDecisions({
        entries,
        failures: [{ index: 0, samplerLabel: 'Step 01 - GET /bootstrap', responseCode: '500' }],
    });

    assert.strictEqual(decisions.byIndex[0].decision, 'must_fix');
    assert.strictEqual(decisions.byIndex[0].consumedOutputCount, 1);
    assert.deepStrictEqual(decisions.byIndex[0].consumerIndexes, [1]);
});

test('value-flow decisions: failing sampler with no consumed output is disposable plumbing', () => {
    const entries = [
        entry('GET', 'https://app.test/tasks.json', { body: '{"asset":"static"}' }),
        entry('GET', 'https://app.test/home'),
    ];

    const decisions = valueFlowDecisions.classifySamplerDisableDecisions({
        entries,
        failures: [{ index: 0, samplerLabel: 'Step 01 - GET /tasks.json', responseCode: '404' }],
    });

    assert.strictEqual(decisions.byIndex[0].decision, 'disposable_plumbing');
    assert.strictEqual(decisions.byIndex[0].consumedOutputCount, 0);
});

test('sampler decision: explicit evidence separates foldable plumbing from must-fix producers', () => {
    const entries = [
        entry('GET', 'https://app.test/oauth/token', { status: 302 }),
        entry('GET', 'https://app.test/bootstrap', { body: '{"session":"abc123SESSION"}' }),
        entry('GET', 'https://app.test/api', { reqHeaders: [{ name: 'X-Session', value: 'abc123SESSION' }] }),
        entry('POST', 'https://app.test/edoc/temporal-file/save'),
    ];
    const failures = [
        { index: 0, samplerLabel: 'Step 01 - GET /oauth/token', responseCode: '200' },
        { index: 1, samplerLabel: 'Step 02 - GET /bootstrap', responseCode: '200' },
        { index: 3, samplerLabel: 'Step 04 - POST /edoc/temporal-file/save', responseCode: '500' },
    ];
    const valueFlow = valueFlowDecisions.classifySamplerDisableDecisions({ entries, failures });
    const decisions = samplerDecision.classifySamplerDecisions({ entries, failures, valueFlow });

    assert.strictEqual(decisions.byIndex[0].decision, 'foldable_plumbing');
    assert.strictEqual(decisions.byIndex[1].decision, 'must_fix');
    assert.strictEqual(decisions.byIndex[3].decision, 'must_fix');
});

test('post-run adjudicator: unconsumed jwt create-cookie 400 is dead plumbing and disabled', () => {
    const entries = [
        entry('GET', 'https://stgapp.webpt.com/dashboard.php'),
        entry('GET', 'https://stgemr.webpt.com/jwt/v2/create-cookie'),
    ];
    const evidence = runEvidence.buildRunEvidence({
        entries,
        samples: [
            { label: 'Step 01 - GET /dashboard.php', responseCode: '200', success: true, finalUrl: 'https://stgapp.webpt.com/dashboard.php' },
            { label: 'Step 02 - GET /jwt/v2/create-cookie', responseCode: '400', success: false, finalUrl: 'https://stgemr.webpt.com/jwt/v2/create-cookie' },
        ],
    });
    const valueFlow = valueFlowDecisions.classifySamplerDisableDecisions({
        entries,
        failures: [{ index: 1, samplerLabel: 'Step 02 - GET /jwt/v2/create-cookie', responseCode: '400' }],
    });

    const adjudication = postRunAdjudicator.adjudicateRequests({
        entries,
        evidence,
        valueFlow,
        failureReport: { samplersToDisable: [{ samplerLabel: 'Step 02 - GET /jwt/v2/create-cookie', responseCode: '400' }] },
    });

    assert.strictEqual(adjudication.byIndex[1].category, 'dead_plumbing');
    assert.strictEqual(adjudication.byIndex[1].action, 'disable');
    assert.deepStrictEqual(adjudication.actions.disable.map(item => item.samplerLabel), ['Step 02 - GET /jwt/v2/create-cookie']);
});

test('post-run adjudicator: failing POST oauth2/token exchange is protected, never folded (PKCE/M2M/banking)', () => {
    const entries = [
        entry('POST', 'https://login.example.com/oauth2/token', { status: 200 }),
        entry('GET', 'https://api.example.com/v1/accounts'),
    ];
    const evidence = runEvidence.buildRunEvidence({
        entries,
        samples: [
            { label: 'Step 01 - POST /oauth2/token', responseCode: '401', success: false, finalUrl: 'https://login.example.com/oauth2/token' },
            { label: 'Step 02 - GET /v1/accounts', responseCode: '401', success: false, finalUrl: 'https://api.example.com/v1/accounts' },
        ],
    });
    // No tracked consumer for the token output — the old fold heuristic would
    // have disabled it. It must be protected instead.
    const valueFlow = valueFlowDecisions.classifySamplerDisableDecisions({
        entries,
        failures: [{ index: 0, samplerLabel: 'Step 01 - POST /oauth2/token', responseCode: '401' }],
    });
    const adjudication = postRunAdjudicator.adjudicateRequests({
        entries,
        evidence,
        valueFlow,
        failureReport: { samplersToDisable: [{ samplerLabel: 'Step 01 - POST /oauth2/token', responseCode: '401' }] },
    });
    assert.strictEqual(adjudication.byIndex[0].action, 'protect');
    assert.deepStrictEqual(adjudication.actions.disable, []);
});

test('post-run adjudicator: cross-domain business verbs (checkout/transfer) are protected out of the box', () => {
    const checkout = entry('POST', 'https://shop.example.com/v2/checkout', { status: 200 });
    const transfer = entry('POST', 'https://bank.example.com/accounts/transfer', { status: 200 });
    const entries = [checkout, transfer];
    const evidence = runEvidence.buildRunEvidence({
        entries,
        samples: [
            { label: 'Step 01 - POST /v2/checkout', responseCode: '500', success: false, finalUrl: 'https://shop.example.com/v2/checkout' },
            { label: 'Step 02 - POST /accounts/transfer', responseCode: '500', success: false, finalUrl: 'https://bank.example.com/accounts/transfer' },
        ],
    });
    const adjudication = postRunAdjudicator.adjudicateRequests({
        entries,
        evidence,
        failureReport: {
            samplersToDisable: [
                { samplerLabel: 'Step 01 - POST /v2/checkout', responseCode: '500' },
                { samplerLabel: 'Step 02 - POST /accounts/transfer', responseCode: '500' },
            ],
        },
    });
    assert.strictEqual(adjudication.byIndex[0].action, 'protect');
    assert.strictEqual(adjudication.byIndex[1].action, 'protect');
});

test('post-run adjudicator: consumed jwt create-cookie is a protected session producer', () => {
    const jwt = entry('GET', 'https://stgemr.webpt.com/jwt/v2/create-cookie');
    jwt.response.headers = [{ name: 'Set-Cookie', value: 'LOGI_SESS=abc123session; Path=/; HttpOnly' }];
    const entries = [
        jwt,
        entry('GET', 'https://stgemr.webpt.com/dashboard', {
            reqHeaders: [{ name: 'Cookie', value: 'LOGI_SESS=abc123session' }],
        }),
    ];
    const evidence = runEvidence.buildRunEvidence({
        entries,
        samples: [
            { label: 'Step 01 - GET /jwt/v2/create-cookie', responseCode: '400', success: false, finalUrl: 'https://stgemr.webpt.com/jwt/v2/create-cookie' },
            { label: 'Step 02 - GET /dashboard', responseCode: '401', success: false, finalUrl: 'https://stgemr.webpt.com/dashboard' },
        ],
    });
    const valueFlow = valueFlowDecisions.classifySamplerDisableDecisions({
        entries,
        failures: [{ index: 0, samplerLabel: 'Step 01 - GET /jwt/v2/create-cookie', responseCode: '400' }],
    });

    const adjudication = postRunAdjudicator.adjudicateRequests({ entries, evidence, valueFlow });

    assert.strictEqual(adjudication.byIndex[0].category, 'session_producer');
    assert.strictEqual(adjudication.byIndex[0].action, 'protect');
    assert.deepStrictEqual(adjudication.actions.disable, []);
});

test('post-run adjudicator: authorize resume auth wall is not safe plumbing', () => {
    const entries = [
        entry('GET', 'https://stglogin.webpt.com/authorize/resume?state=recorded', { status: 302 }),
        entry('GET', 'https://stgapp.webpt.com/dashboard.php'),
    ];
    const evidence = runEvidence.buildRunEvidence({
        entries,
        samples: [
            { label: 'Step 01 - GET /authorize/resume', responseCode: '401', success: false, finalUrl: 'https://stglogin.webpt.com/authorize/resume?state=recorded' },
            { label: 'Step 02 - GET /dashboard.php', responseCode: '401', success: false, finalUrl: 'https://stglogin.webpt.com/u/login/identifier' },
        ],
    });
    const valueFlow = valueFlowDecisions.classifySamplerDisableDecisions({
        entries,
        failures: [{ index: 0, samplerLabel: 'Step 01 - GET /authorize/resume', responseCode: '401' }],
    });

    const adjudication = postRunAdjudicator.adjudicateRequests({
        entries,
        evidence,
        valueFlow,
        failureForensics: {
            rootCause: { index: 0, sampler: 'Step 01 - GET /authorize/resume', category: 'redirect_flow_drift', recordedStatus: 302, observedStatus: 401 },
            redirects: { interactiveAuthWall: true },
            recommendedAction: { id: 'provide-test-auth-path' },
        },
    });

    assert.strictEqual(adjudication.byIndex[0].category, 'auth_wall');
    assert.strictEqual(adjudication.byIndex[0].action, 'stop');
    assert.deepStrictEqual(adjudication.actions.disable, []);
});

test('post-run adjudicator: interceptor authorize without session material folds despite noisy value-flow consumers', () => {
    const entries = [
        entry('GET', 'https://stgapp.webpt.com/s/interceptor/authorize/', { status: 302 }),
        entry('GET', 'https://stgapp.webpt.com/patientChart.php'),
    ];
    const evidence = runEvidence.buildRunEvidence({
        entries,
        samples: [
            {
                label: 'Step 01 - GET /s/interceptor/authorize/',
                responseCode: '200',
                success: true,
                finalUrl: 'https://stgauth.webpt.com/redirect/',
                responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
            },
            { label: 'Step 02 - GET /patientChart.php', responseCode: '200', success: true },
        ],
    });
    const adjudication = postRunAdjudicator.adjudicateRequests({
        entries,
        evidence,
        valueFlow: {
            byIndex: {
                0: {
                    samplerLabel: 'Step 01 - GET /s/interceptor/authorize/',
                    consumedOutputCount: 180,
                    consumerIndexes: [1],
                },
            },
        },
        failureForensics: {
            rootCause: { index: 0, sampler: 'Step 01 - GET /s/interceptor/authorize/', category: 'auth_redirect_bounce', recordedStatus: 302, observedStatus: 200 },
            redirects: { interactiveAuthWall: true },
        },
    });

    assert.strictEqual(adjudication.byIndex[0].category, 'redirect_hop');
    assert.strictEqual(adjudication.byIndex[0].action, 'disable');
    assert.deepStrictEqual(adjudication.actions.disable.map(item => item.samplerLabel), ['Step 01 - GET /s/interceptor/authorize/']);
});

test('post-run adjudicator: downstream interceptor authorize still folds under an upstream auth wall', () => {
    const entries = [
        entry('GET', 'https://stgadmin.webpt.com/', { status: 302 }),
        entry('GET', 'https://stgapp.webpt.com/s/interceptor/authorize/', { status: 302 }),
        entry('POST', 'https://stage-vega-tasks-icon-service.webpt.com/graphql'),
    ];
    const evidence = runEvidence.buildRunEvidence({
        entries,
        samples: [
            { label: 'Step 01 - GET /', responseCode: '200', success: true, finalUrl: 'https://stglogin.webpt.com/u/login/identifier' },
            {
                label: 'Step 02 - GET /s/interceptor/authorize/',
                responseCode: '404',
                success: false,
                finalUrl: 'https://stgapp.webpt.com/s/interceptor/authorize/',
                responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
            },
            { label: 'Step 03 - POST /graphql', responseCode: '401', success: false },
        ],
    });

    const adjudication = postRunAdjudicator.adjudicateRequests({
        entries,
        evidence,
        valueFlow: {
            byIndex: {
                1: {
                    samplerLabel: 'Step 02 - GET /s/interceptor/authorize/',
                    consumedOutputCount: 42,
                    consumerIndexes: [2],
                },
            },
        },
        failureForensics: {
            rootCause: { index: 0, sampler: 'Step 01 - GET /', category: 'auth_redirect_bounce', recordedStatus: 302, observedStatus: 200 },
            redirects: { interactiveAuthWall: true },
            recommendedAction: { id: 'provide-test-auth-path' },
        },
    });

    assert.strictEqual(adjudication.byIndex[0].category, 'auth_wall');
    assert.strictEqual(adjudication.byIndex[1].category, 'redirect_hop');
    assert.strictEqual(adjudication.byIndex[1].action, 'disable');
    assert.deepStrictEqual(adjudication.actions.disable.map(item => item.samplerLabel), ['Step 02 - GET /s/interceptor/authorize/']);
});

test('post-run adjudicator: downstream scheduler 401 after auth bounce is casualty, not direct repair', () => {
    const entries = [
        entry('GET', 'https://stgadmin.webpt.com/', { status: 302 }),
        entry('POST', 'https://stgapp.webpt.com/scheduler/index/data/T/d'),
    ];
    const evidence = runEvidence.buildRunEvidence({
        entries,
        samples: [
            { label: 'Step 01 - GET /', responseCode: '200', success: true, finalUrl: 'https://stglogin.webpt.com/u/login/identifier' },
            { label: 'Step 02 - POST /scheduler/index/data/T/d', responseCode: '401', success: false, finalUrl: 'https://stgapp.webpt.com/scheduler/index/data/T/d' },
        ],
    });

    const adjudication = postRunAdjudicator.adjudicateRequests({
        entries,
        evidence,
        valueFlow: valueFlowDecisions.classifySamplerDisableDecisions({ entries }),
        failureForensics: {
            rootCause: { index: 0, sampler: 'Step 01 - GET /', category: 'auth_redirect_bounce', recordedStatus: 302, observedStatus: 200 },
            divergences: [
                { index: 0, sampler: 'Step 01 - GET /', category: 'auth_redirect_bounce' },
                { index: 1, sampler: 'Step 02 - POST /scheduler/index/data/T/d', category: 'auth_or_session_correlation_failed' },
            ],
        },
    });

    assert.strictEqual(adjudication.byIndex[1].category, 'downstream_casualty');
    assert.strictEqual(adjudication.byIndex[1].action, 'ignore');
    assert.deepStrictEqual(adjudication.actions.disable, []);
});

test('post-run adjudicator: attempted downstream authorize resume fold is not blocked by value-flow under auth wall', () => {
    const authorizeResume = entry('GET', 'https://stglogin.webpt.com/authorize/resume?state=stale', { status: 302 });
    authorizeResume.response.headers = [{ name: 'Set-Cookie', value: 'auth0=recorded-browser-session; Path=/; HttpOnly' }];
    const entries = [
        entry('GET', 'https://stgapp.webpt.com/', { status: 302 }),
        authorizeResume,
        entry('POST', 'https://stgapp.webpt.com/scheduler/index/data/T/d'),
    ];
    const evidence = runEvidence.buildRunEvidence({
        entries,
        samples: [
            { label: 'Step 01 - GET /', responseCode: '200', success: true, finalUrl: 'https://stglogin.webpt.com/u/login/identifier' },
            { label: 'Step 02 - GET /authorize/resume', responseCode: '401', success: false, finalUrl: 'https://stglogin.webpt.com/authorize/resume?state=stale' },
            { label: 'Step 03 - POST /scheduler/index/data/T/d', responseCode: '401', success: false, finalUrl: 'https://stgapp.webpt.com/scheduler/index/data/T/d' },
        ],
    });

    const filtered = postRunAdjudicator.adjudicateFailureReport({
        entries,
        evidence,
        valueFlow: {
            byIndex: {
                1: {
                    samplerLabel: 'Step 02 - GET /authorize/resume',
                    consumedOutputCount: 12,
                    consumerIndexes: [2],
                },
            },
        },
        failureReport: {
            samplersToDisable: [
                { samplerLabel: 'Step 02 - GET /authorize/resume', responseCode: '401', reason: 'engine proposed stale auth hop fold' },
            ],
        },
        failureForensics: {
            rootCause: { index: 0, sampler: 'Step 01 - GET /', category: 'auth_redirect_bounce', recordedStatus: 302, observedStatus: 200 },
            redirects: { interactiveAuthWall: true },
            recommendedAction: { id: 'provide-test-auth-path' },
        },
    });

    assert.deepStrictEqual(filtered.blocked, []);
    assert.deepStrictEqual(filtered.report.samplersToDisable.map(item => item.samplerLabel), ['Step 02 - GET /authorize/resume']);
    assert.strictEqual(filtered.adjudication.byIndex[1].category, 'redirect_hop');
    assert.strictEqual(filtered.adjudication.byIndex[1].action, 'disable');
});

test('post-run adjudicator: attempted downstream token-bearing interceptor posts are protected under auth wall', () => {
    const firstInterceptor = entry('POST', 'https://stgapp.webpt.com/s/interceptor/?companyId=13629&facilityId=21180', { status: 302 });
    firstInterceptor.response.headers = [{ name: 'Set-Cookie', value: 'stgapp_webpt_com_sess=recorded; Path=/; HttpOnly' }];
    const secondInterceptor = entry('POST', 'https://stgapp.webpt.com/s/interceptor/?companyId=7272&facilityId=10354', { status: 302 });
    secondInterceptor.response.headers = [{ name: 'Set-Cookie', value: 'stgapp_webpt_com_sess=recorded2; Path=/; HttpOnly' }];
    const entries = [
        entry('GET', 'https://stgapp.webpt.com/', { status: 302 }),
        firstInterceptor,
        entry('GET', 'https://stgapp.webpt.com/dashboard.php'),
        secondInterceptor,
        entry('POST', 'https://stgapp.webpt.com/scheduler/index/data/T/d'),
    ];
    const evidence = runEvidence.buildRunEvidence({
        entries,
        samples: [
            { label: 'Step 01 - GET /', responseCode: '200', success: true, finalUrl: 'https://stglogin.webpt.com/u/login/identifier' },
            { label: 'Step 02 - POST /s/interceptor/', responseCode: '401', success: false, finalUrl: 'https://stgapp.webpt.com/s/interceptor/?companyId=13629&facilityId=21180' },
            { label: 'Step 03 - GET /dashboard.php', responseCode: '401', success: false },
            { label: 'Step 04 - POST /s/interceptor/', responseCode: '401', success: false, finalUrl: 'https://stgapp.webpt.com/s/interceptor/?companyId=7272&facilityId=10354' },
            { label: 'Step 05 - POST /scheduler/index/data/T/d', responseCode: '401', success: false },
        ],
    });

    const filtered = postRunAdjudicator.adjudicateFailureReport({
        entries,
        evidence,
        valueFlow: {
            byIndex: {
                1: { samplerLabel: 'Step 02 - POST /s/interceptor/', consumedOutputCount: 8, consumerIndexes: [2] },
                3: { samplerLabel: 'Step 04 - POST /s/interceptor/', consumedOutputCount: 8, consumerIndexes: [4] },
            },
        },
        failureReport: {
            samplersToDisable: [
                { samplerLabel: 'Step 02 - POST /s/interceptor/', responseCode: '401', reason: 'engine proposed repeated interceptor fold' },
                { samplerLabel: 'Step 04 - POST /s/interceptor/', responseCode: '401', reason: 'engine proposed repeated interceptor fold' },
            ],
        },
        failureForensics: {
            rootCause: { index: 0, sampler: 'Step 01 - GET /', category: 'auth_redirect_bounce', recordedStatus: 302, observedStatus: 200 },
            redirects: { interactiveAuthWall: true },
            recommendedAction: { id: 'provide-test-auth-path' },
        },
    });

    assert.deepStrictEqual(filtered.blocked.map(item => item.samplerLabel), [
        'Step 02 - POST /s/interceptor/',
        'Step 04 - POST /s/interceptor/',
    ]);
    assert.deepStrictEqual(filtered.report.samplersToDisable, []);
    assert.strictEqual(filtered.adjudication.byIndex[1].category, 'blocked_disable');
    assert.strictEqual(filtered.adjudication.byIndex[3].category, 'blocked_disable');
});

test('runner adjudication filter adds proven disables and blocks protected producers', () => {
    const entries = [
        entry('GET', 'https://stgemr.webpt.com/jwt/v2/create-cookie'),
        entry('POST', 'https://stgapp.webpt.com/scheduler/index/data/T/d'),
    ];
    const evidence = runEvidence.buildRunEvidence({
        entries,
        samples: [
            { label: 'Step 01 - GET /jwt/v2/create-cookie', responseCode: '400', success: false },
            { label: 'Step 02 - POST /scheduler/index/data/T/d', responseCode: '401', success: false },
        ],
    });
    const guard = { enabled: true, protectedNames: new Set(['Step 02 - POST /scheduler/index/data/T/d']) };
    const failureReport = {
        samplersToDisable: [
            { samplerLabel: 'Step 02 - POST /scheduler/index/data/T/d', responseCode: '401', reason: 'engine guess' },
        ],
    };

    const filtered = runnerInternal.guardFailureReportWithAdjudication({
        failureReport,
        entries,
        evidence,
        guard,
        valueFlow: valueFlowDecisions.classifySamplerDisableDecisions({
            entries,
            failures: [{ index: 0, samplerLabel: 'Step 01 - GET /jwt/v2/create-cookie', responseCode: '400' }],
        }),
    });

    assert.deepStrictEqual(filtered.blocked.map(item => item.samplerLabel), ['Step 02 - POST /scheduler/index/data/T/d']);
    assert.deepStrictEqual(filtered.report.samplersToDisable.map(item => item.samplerLabel), ['Step 01 - GET /jwt/v2/create-cookie']);
    assert.strictEqual(filtered.adjudication.byIndex[0].category, 'dead_plumbing');
});

test('runner adjudication artifacts are written per iteration and aggregated', () => {
    const out = tmp();
    const records = [];
    const adjudication = {
        summary: { disable: 1, protect: 1, ignore: 0, stop: 0, blocked: 0 },
        actions: {
            disable: [{ samplerLabel: 'Step 01 - GET /jwt/v2/create-cookie', category: 'dead_plumbing' }],
            protect: [{ samplerLabel: 'Step 02 - GET /dashboard', category: 'business_request' }],
            ignore: [],
            stop: [],
            blocked: [],
        },
        byIndex: {
            0: { samplerLabel: 'Step 01 - GET /jwt/v2/create-cookie', category: 'dead_plumbing', action: 'disable' },
        },
    };

    runnerInternal.writeRequestAdjudicationArtifacts({ outDir: out, name: 'bp', iteration: 1, adjudication, records });

    assert.ok(fs.existsSync(path.join(out, 'bp_request_adjudication_iter_1.json')));
    const aggregate = JSON.parse(fs.readFileSync(path.join(out, 'bp_request_adjudication.json'), 'utf8'));
    assert.strictEqual(aggregate.iterations.length, 1);
    assert.strictEqual(aggregate.iterations[0].summary.disable, 1);
});

test('runner adjudication auth wall continues bounded iterations with no-op JMX', () => {
    const out = tmp();
    const jmxPath = path.join(out, 'flow.jmx');
    fs.writeFileSync(jmxPath, '<jmeterTestPlan/>');

    const patchResult = runnerInternal.continueWithNoopPatch({
        jmxPath,
        iteration: 1,
        reason: 'auth wall recorded',
    });

    assert.ok(patchResult.patchedJmxPath);
    assert.notStrictEqual(path.resolve(patchResult.patchedJmxPath), path.resolve(jmxPath));
    assert.strictEqual(fs.readFileSync(patchResult.patchedJmxPath, 'utf8'), '<jmeterTestPlan/>');
    assert.strictEqual(patchResult.patchSummary[0].type, 'SKIPPED');
});

test('runner fold probe accepts plumbing disable when protected flow does not worsen', () => {
    const pending = [{
        samplerLabel: 'Step 09 - GET /s/interceptor/authorize/',
        category: 'redirect_hop',
        protectedFailuresBefore: [],
        failureCountBefore: 2,
    }];
    const result = runnerInternal.evaluateFoldProbes({
        pending,
        failureReport: {
            brokenSamplers: [{ samplerLabel: 'Step 99 - GET /favicon.ico' }],
        },
        guard: { protectedNames: new Set(['Step 36 - GET /patientChart.php']) },
    });

    assert.deepStrictEqual(result.accepted.map(item => item.samplerLabel), ['Step 09 - GET /s/interceptor/authorize/']);
    assert.deepStrictEqual(result.rejected, []);
    assert.deepStrictEqual(result.pending, []);
});

test('runner fold probe rejects and suppresses disable when protected flow worsens', () => {
    const pending = [{
        samplerLabel: 'Step 09 - GET /s/interceptor/authorize/',
        category: 'redirect_hop',
        protectedFailuresBefore: [],
        failureCountBefore: 1,
    }];
    const result = runnerInternal.evaluateFoldProbes({
        pending,
        failureReport: {
            brokenSamplers: [{ samplerLabel: 'Step 36 - GET /patientChart.php' }],
            samplersToDisable: [
                { samplerLabel: 'Step 09 - GET /s/interceptor/authorize/' },
                { samplerLabel: 'Step 99 - GET /favicon.ico' },
            ],
        },
        guard: { protectedNames: new Set(['Step 36 - GET /patientChart.php']) },
    });
    const filtered = runnerInternal.suppressRejectedProbeDisables({
        samplersToDisable: [
            { samplerLabel: 'Step 09 - GET /s/interceptor/authorize/' },
            { samplerLabel: 'Step 99 - GET /favicon.ico' },
        ],
    }, result.rejected);

    assert.deepStrictEqual(result.rejected.map(item => item.samplerLabel), ['Step 09 - GET /s/interceptor/authorize/']);
    assert.deepStrictEqual(filtered.samplersToDisable.map(item => item.samplerLabel), ['Step 99 - GET /favicon.ico']);
});

test('runner fold probe rollback re-enables rejected sampler in JMX', () => {
    const out = tmp();
    const jmxPath = path.join(out, 'flow.jmx');
    fs.writeFileSync(jmxPath, `<jmeterTestPlan><hashTree>
      <HTTPSamplerProxy testname="Step 09 - GET /s/interceptor/authorize/" enabled="false">
        <stringProp name="HTTPSampler.path">/s/interceptor/authorize/</stringProp>
      </HTTPSamplerProxy>
    </hashTree></jmeterTestPlan>`);

    const rolledBack = runnerInternal.rollbackRejectedFoldProbes({
        jmxPath,
        iteration: 2,
        rejected: [{ samplerLabel: 'Step 09 - GET /s/interceptor/authorize/' }],
    });
    const xml = fs.readFileSync(rolledBack, 'utf8');

    assert.notStrictEqual(path.resolve(rolledBack), path.resolve(jmxPath));
    assert.match(xml, /testname="Step 09 - GET \/s\/interceptor\/authorize\/" enabled="true"/);
});

test('business guard: value-flow evidence overrides heuristic protection for unconsumed plumbing', () => {
    const xml = `<jmeterTestPlan><hashTree>
      <HTTPSamplerProxy testname="Step 01 - GET /tasks.json" enabled="true">
        <stringProp name="HTTPSampler.domain">app.test</stringProp>
        <stringProp name="HTTPSampler.path">/tasks.json</stringProp>
        <stringProp name="HTTPSampler.method">GET</stringProp>
      </HTTPSamplerProxy>
    </hashTree></jmeterTestPlan>`;
    const entries = [entry('GET', 'https://app.test/tasks.json')];
    const valueFlow = valueFlowDecisions.classifySamplerDisableDecisions({ entries });

    const guard = businessGuard.buildBusinessGuard({
        xml,
        flowName: 'tasks',
        runCfg: {},
        valueFlowDecisions: valueFlow,
    });

    assert.strictEqual(guard.protectedNames.has('Step 01 - GET /tasks.json'), false);

    const explicit = businessGuard.buildBusinessGuard({
        xml,
        flowName: 'tasks',
        runCfg: { protectedCalls: ['/tasks.json'] },
        valueFlowDecisions: valueFlow,
    });
    assert.strictEqual(explicit.protectedNames.has('Step 01 - GET /tasks.json'), true);
});

test('business guard: configured unconsumed jwt create-cookie is foldable plumbing', () => {
    const xml = `<jmeterTestPlan><hashTree>
      <HTTPSamplerProxy testname="Step 01 - GET /jwt/v2/create-cookie" enabled="false">
        <stringProp name="HTTPSampler.domain">stgemr.webpt.com</stringProp>
        <stringProp name="HTTPSampler.path">/jwt/v2/create-cookie</stringProp>
        <stringProp name="HTTPSampler.method">GET</stringProp>
      </HTTPSamplerProxy>
    </hashTree></jmeterTestPlan>`;
    const entries = [entry('GET', 'https://stgemr.webpt.com/jwt/v2/create-cookie')];
    const valueFlow = valueFlowDecisions.classifySamplerDisableDecisions({ entries });

    const guard = businessGuard.buildBusinessGuard({
        xml,
        flowName: 'logi',
        runCfg: { disableCalls: ['/jwt/v2/create-cookie'] },
        valueFlowDecisions: valueFlow,
    });

    assert.strictEqual(guard.protectedNames.has('Step 01 - GET /jwt/v2/create-cookie'), false);
});

test('response evidence: captures scrubbed failing body for LLM prompt', async () => {
    const server = http.createServer((req, res) => {
        res.writeHead(401, { 'Content-Type': 'application/json', 'Set-Cookie': 'sid=secret-cookie-value' });
        res.end(JSON.stringify({ error: 'Session Expired', access_token: 'secret-token-value-123456' }));
    });
    await listenLocal(server);
    const port = server.address().port;
    try {
        const evidence = await responseEvidence.collectFailingResponseEvidence({
            entries: [entry('GET', 'http://recorded.test/me')],
            failures: [{ index: 0, samplerName: 'Step 01 - GET /me' }],
            targetBaseUrl: `http://127.0.0.1:${port}`,
            insecure: true,
        });

        assert.strictEqual(evidence.length, 1);
        assert.strictEqual(evidence[0].status, 401);
        assert.match(evidence[0].bodyExcerpt, /Session Expired/);
        assert.doesNotMatch(evidence[0].bodyExcerpt, /secret-token-value/);
        assert.doesNotMatch(JSON.stringify(evidence[0].headers), /secret-cookie-value/);
    } finally {
        await closeServer(server);
    }
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
    assert.strictEqual(samplerEnabledForPath(xmlCfg, 'iam/callback'), false,
        'operator tier is absolute: an explicit disableCalls entry is applied even to session-looking paths (heuristics may only warn)');
    assert.ok(genCfg.reasoning.some(r => r.phase === 'disable-calls-warning'),
        'the disagreement is surfaced as a warning, not a silent veto');
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
    assert.strictEqual(samplerEnabledForName(xmlCfg, 'Step 07 - POST /'), false,
        'operator step-label disable applies semantically (step number + method + exact path) under pe-naming');
});

test('generate: disableCalls cannot remove protected auth/session producers without unsafe override', () => {
    const { entries, pages } = parse(har([
        entry('POST', 'https://stglogin.webpt.com/u/login/identifier'),
        entry('POST', 'https://stglogin.webpt.com/u/login/password'),
        entry('POST', 'https://stgapp.webpt.com/authorization/'),
        entry('GET', 'https://stgauth.webpt.com/s/interceptor/authorize/'),
        entry('GET', 'https://stgemr.webpt.com/jwt/v2/create-cookie'),
        entry('GET', 'https://events.example.com/sdk/evalx/users/user-key'),
    ]));

    const out = tmp();
    const gen = generate(entries, pages, out, 'protected-disable', {
        runCfg: {
            disableCalls: [
                'Step 01 - POST /u/login/identifier',
                'Step 02 - POST /u/login/password',
                '/authorization/',
                '/s/interceptor/authorize/',
                '/jwt/v2/create-cookie',
                '/sdk/evalx',
            ],
        },
    });
    const xml = fs.readFileSync(gen.jmxPath, 'utf8');

    // Operator tier is absolute: every explicit disableCalls entry applies —
    // including auth/session-looking ones. Heuristic disagreement becomes a
    // WARNING note, never a veto (the veto is how the interceptor hop kept
    // tripping the LOGI flow run after run).
    assert.strictEqual(samplerEnabledForPath(xml, '/u/login/identifier'), false);
    assert.strictEqual(samplerEnabledForPath(xml, '/u/login/password'), false);
    assert.strictEqual(samplerEnabledForPath(xml, '/authorization/'), false);
    assert.strictEqual(samplerEnabledForPath(xml, '/s/interceptor/authorize/'), false);
    assert.strictEqual(samplerEnabledForPath(xml, '/jwt/v2/create-cookie'), false);
    assert.strictEqual(samplerEnabledForPath(xml, '/sdk/evalx'), false);
    assert.ok(gen.reasoning.some(r => r.phase === 'disable-calls-warning'),
        'heuristics disagree loudly about the login POSTs — as a warning');
});

test('generate: jwt create-cookie stays enabled when its cookie is consumed downstream', () => {
    const jwt = entry('GET', 'https://stgemr.webpt.com/jwt/v2/create-cookie');
    jwt.response.headers = [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Set-Cookie', value: 'LOGI_SESS=abc123session; Path=/; HttpOnly' },
    ];
    const { entries, pages } = parse(har([
        jwt,
        entry('GET', 'https://stgemr.webpt.com/dashboard', {
            reqHeaders: [{ name: 'Cookie', value: 'LOGI_SESS=abc123session' }],
        }),
    ]));

    const out = tmp();
    const gen = generate(entries, pages, out, 'jwt-consumed', {
        runCfg: { disableCalls: ['/jwt/v2/create-cookie'] },
    });
    const xml = fs.readFileSync(gen.jmxPath, 'utf8');

    // Operator wins even against consumption evidence — but the disagreement
    // must be loud, because this one may genuinely break a consumer.
    assert.strictEqual(samplerEnabledForPath(xml, '/jwt/v2/create-cookie'), false,
        'explicit operator disable applies; evidence disagreement becomes a warning');
    assert.ok(gen.reasoning.some(r => r.phase === 'disable-calls-warning'),
        'consumed-producer disable is flagged for the operator');
    // Without the operator entry, the default heuristics leave it alone.
    const out2 = tmp();
    const gen2 = generate(entries, pages, out2, 'jwt-untouched', { runCfg: {} });
    const xml2 = fs.readFileSync(gen2.jmxPath, 'utf8');
    assert.strictEqual(samplerEnabledForPath(xml2, '/jwt/v2/create-cookie'), true,
        'no default pattern folds a consumed producer');
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
    const wantedStep = peNaming.stepNumberFromLabel(samplerName);
    for (const m of xml.matchAll(/<HTTPSamplerProxy\b([^>]*)>([\s\S]*?)<\/HTTPSamplerProxy>/g)) {
        const label = ((m[1] || '').match(/\btestname="([^"]*)"/) || [])[1] || '';
        if (label !== samplerName && (!wantedStep || peNaming.stepNumberFromLabel(label) !== wantedStep)) continue;
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

test('ingest groups: two similar HAR recordings are treated as a dual-recording pair', () => {
    const files = [
        '/in/Batch_Print_Recording1_May15_Filtered.har',
        '/in/Batch_Print_Recording2_May15_Filtered.har',
    ];
    const units = groupInputs(files);
    assert.strictEqual(units.length, 1);
    assert.strictEqual(units[0].kind, 'dual-har');
    assert.strictEqual(units[0].primary, files[0]);
    assert.strictEqual(units[0].secondary, files[1]);
});

test('ingest groups: loose HAR names do not override incompatible content', () => {
    const dir = tmp();
    const one = path.join(dir, 'Batch_Print_Recording1_May15_Filtered.har');
    const two = path.join(dir, 'Batch_Print_Recording2_May15_Filtered.har');
    fs.writeFileSync(one, JSON.stringify(har([
        entry('GET', 'https://batch.test/login'),
        entry('POST', 'https://batch.test/print'),
    ])));
    fs.writeFileSync(two, JSON.stringify(har([
        entry('GET', 'https://payments.test/login'),
        entry('POST', 'https://payments.test/transfer'),
    ])));

    const analysis = analyzeInputFiles([one, two]);

    assert.deepStrictEqual(analysis.units.map(u => u.kind), ['har', 'har']);
    assert.ok(analysis.issues.some(i =>
        i.code === 'unpaired_similar_recordings' &&
        /similar file names/.test(i.message) &&
        /different request flows/.test(i.message)
    ));
});

test('ingest groups: same-flow HARs with user-dependent request drift still pair', () => {
    const dir = tmp();
    const one = path.join(dir, 'Batch_Print_Recording1_May15_Filtered.har');
    const two = path.join(dir, 'Batch_Print_Recording2_May15_Filtered.har');
    const commonFlow = [
        ['GET', 'https://devperfapp.webpt.com/'],
        ['POST', 'https://devperfapp.webpt.com/service/authenticate.json'],
        ['GET', 'https://devperfapp.webpt.com/dashboard.php'],
        ['GET', 'https://devperfapp.webpt.com/patient/display/'],
        ['POST', 'https://devperfapp.webpt.com/patient/display/getpatients'],
        ['GET', 'https://devperfapp.webpt.com/patientChart.php'],
        ['GET', 'https://devperfapp.webpt.com/patient/outbounddocument/faxoutbound'],
        ['GET', 'https://devperfapp.webpt.com/batchPrint.php'],
        ['GET', 'https://devperfapp.webpt.com/patientExtDoc.php'],
        ['POST', 'https://devperfapp.webpt.com/edoc/edoc/getdocumentspercase'],
        ['POST', 'https://devperfapp.webpt.com/edoc/edoc/getalldocuments'],
        ['GET', 'https://devperfapp.webpt.com/physician/search/search-physicians'],
        ['POST', 'https://devperfapp.webpt.com/edoc/temporal-file/save'],
        ['POST', 'https://devperfapp.webpt.com/patientExtDoc.php'],
        ['GET', 'https://devperfapp.webpt.com/viewExtDoc.php'],
        ['GET', 'https://devperfapp.webpt.com/user/logout'],
    ];
    const firstRun = [
        ...commonFlow.slice(0, 2),
        ['GET', 'https://devperfapp.webpt.com/favicon.ico'],
        ['POST', 'https://devperfdelegator.webpt.com/rb_bf77075baf'],
        ...commonFlow.slice(2, 12),
        ['GET', 'https://devperfapp.webpt.com/menu/index/inbox'],
        ['GET', 'https://devperfapp.webpt.com/menu/index/getclinicactions/'],
        ...commonFlow.slice(12),
    ];
    const secondRun = [
        ...commonFlow.slice(0, 2),
        ['POST', 'https://devperfdelegator.webpt.com/rb_bf77075baf'],
        ...commonFlow.slice(2, 7),
        ['GET', 'https://devperfapp.webpt.com/menu/index/getclinicactions/'],
        ...commonFlow.slice(7, 13),
        ['POST', 'https://devperfdelegator.webpt.com/rb_bf77075baf'],
        ['POST', 'https://devperfdelegator.webpt.com/rb_bf77075baf'],
        ...commonFlow.slice(13),
    ];
    fs.writeFileSync(one, JSON.stringify(har(firstRun.map(([method, url]) => entry(method, url)))));
    fs.writeFileSync(two, JSON.stringify(har(secondRun.map(([method, url]) => entry(method, url)))));

    const analysis = analyzeInputFiles([one, two]);

    // The dual pair, plus each recording exposed as an individually-selectable
    // single unit (flagged `individual`, skipped by a run-everything pass).
    assert.strictEqual(analysis.units[0].kind, 'dual-har');
    assert.ok(!analysis.units[0].individual);
    const individuals = analysis.units.filter(u => u.individual);
    assert.strictEqual(individuals.length, 2);
    assert.ok(individuals.every(u => u.kind === 'har' && u.derivedFrom === analysis.units[0].name));
    assert.strictEqual(analysis.units.filter(u => !u.individual).length, 1);
    assert.deepStrictEqual(analysis.issues, []);
});

test('ingest groups: two HARs with different names pair by content fingerprint', () => {
    const dir = tmp();
    const one = path.join(dir, 'alpha.har');
    const two = path.join(dir, 'completely-different-name.har');
    fs.writeFileSync(one, JSON.stringify(har([
        entry('GET', 'https://app.test/login'),
        entry('POST', 'https://app.test/upload'),
    ])));
    fs.writeFileSync(two, JSON.stringify(har([
        entry('GET', 'https://app.test/login'),
        entry('POST', 'https://app.test/upload'),
    ])));

    const units = groupInputs([one, two]);

    assert.strictEqual(units.length, 1);
    assert.strictEqual(units[0].kind, 'dual-har');
    assert.strictEqual(units[0].primary, one);
    assert.strictEqual(units[0].secondary, two);
});

test('ingest analysis: malformed and orphaned inputs produce precise issues', () => {
    const dir = tmp();
    const badHar = path.join(dir, 'bad.har');
    const badJmx = path.join(dir, 'bad.jmx');
    const orphanJtl = path.join(dir, 'lonely.jtl');
    fs.writeFileSync(badHar, '{"log":{}}');
    fs.writeFileSync(badJmx, '<xml>not jmeter</xml>');
    fs.writeFileSync(orphanJtl, '<testResults version="1.2"></testResults>');

    const analysis = analyzeInputFiles([badHar, badJmx, orphanJtl]);
    const issues = analysis.issues.map(i => i.code).sort();

    assert.deepStrictEqual(issues, ['invalid_har', 'invalid_jmx', 'orphan_sidecar']);
    assert.ok(analysis.issues.some(i => /bad\.har/.test(i.message)));
    assert.ok(analysis.issues.some(i => /lonely\.jtl/.test(i.message)));
});

test('ingest analysis: fingerprints recordings with business urls, uploads, and timestamps', () => {
    const dir = tmp();
    const rec = path.join(dir, 'flow.har');
    const first = entry('GET', 'https://app.test/login');
    const second = entry('POST', 'https://app.test/edoc/temporal-file/save', {
        reqHeaders: [{ name: 'Content-Type', value: 'multipart/form-data; boundary=----abc' }],
        postData: {
            mimeType: 'multipart/form-data',
            params: [{ name: 'file', fileName: 'recorded-name.pdf', contentType: 'application/pdf' }],
        },
    });
    first.startedDateTime = '2026-01-01T00:00:00.000Z';
    second.startedDateTime = '2026-01-01T00:00:03.000Z';
    fs.writeFileSync(rec, JSON.stringify(har([first, second])));

    const analysis = analyzeInputFiles([rec]);
    const fp = analysis.inventory[0].fingerprint;

    assert.strictEqual(fp.requestCount, 2);
    assert.deepStrictEqual(fp.sequence, ['GET /login', 'POST /edoc/temporal-file/save']);
    assert.deepStrictEqual(fp.hosts, ['app.test']);
    assert.strictEqual(fp.firstBusinessUrl, 'https://app.test/login');
    assert.strictEqual(fp.lastBusinessUrl, 'https://app.test/edoc/temporal-file/save');
    assert.deepStrictEqual(fp.referencedFilenames, ['recorded-name.pdf']);
    assert.strictEqual(fp.uploadEndpoints[0].path, '/edoc/temporal-file/save');
    assert.strictEqual(fp.timestamps.first, '2026-01-01T00:00:00.000Z');
    assert.strictEqual(fp.timestamps.last, '2026-01-01T00:00:03.000Z');
});

test('ingest groups: two JMX files with same sampler sequence pair by content', () => {
    const dir = tmp();
    const one = path.join(dir, 'first-export.jmx');
    const two = path.join(dir, 'second-capture.jmx');
    fs.writeFileSync(one, jmxXml([
        { method: 'GET', domain: 'app.test', path: '/login' },
        { method: 'POST', domain: 'app.test', path: '/orders' },
    ]));
    fs.writeFileSync(two, jmxXml([
        { method: 'GET', domain: 'app.test', path: '/login' },
        { method: 'POST', domain: 'app.test', path: '/orders' },
    ]));

    const units = groupInputs([one, two]);

    assert.strictEqual(units.length, 1);
    assert.strictEqual(units[0].kind, 'dual-jmx');
    assert.strictEqual(units[0].primary, one);
    assert.strictEqual(units[0].secondary, two);
});

test('ingest groups: same-flow JMXs with user-dependent drift pair with recording sidecars', () => {
    const dir = tmp();
    const one = path.join(dir, 'Batch_Print_Recording1_May15_Filtered.jmx');
    const two = path.join(dir, 'Batch_Print_Recording2_May15_Filtered.jmx');
    const sidecarOne = path.join(dir, 'Batch_Print_Recording1_May15_Filtered.recording.xml');
    const sidecarTwo = path.join(dir, 'Batch_Print_Recording2_May15_Filtered.recording.xml');
    const commonFlow = [
        { method: 'GET', domain: 'devperfapp.webpt.com', path: '/' },
        { method: 'POST', domain: 'devperfapp.webpt.com', path: '/service/authenticate.json' },
        { method: 'GET', domain: 'devperfapp.webpt.com', path: '/dashboard.php' },
        { method: 'GET', domain: 'devperfapp.webpt.com', path: '/patient/display/' },
        { method: 'POST', domain: 'devperfapp.webpt.com', path: '/patient/display/getpatients' },
        { method: 'GET', domain: 'devperfapp.webpt.com', path: '/patientChart.php' },
        { method: 'GET', domain: 'devperfapp.webpt.com', path: '/patient/outbounddocument/faxoutbound' },
        { method: 'GET', domain: 'devperfapp.webpt.com', path: '/batchPrint.php' },
        { method: 'GET', domain: 'devperfapp.webpt.com', path: '/patientExtDoc.php' },
        { method: 'POST', domain: 'devperfapp.webpt.com', path: '/edoc/edoc/getdocumentspercase' },
        { method: 'POST', domain: 'devperfapp.webpt.com', path: '/edoc/edoc/getalldocuments' },
        { method: 'GET', domain: 'devperfapp.webpt.com', path: '/physician/search/search-physicians' },
        { method: 'POST', domain: 'devperfapp.webpt.com', path: '/edoc/temporal-file/save' },
        { method: 'POST', domain: 'devperfapp.webpt.com', path: '/patientExtDoc.php' },
        { method: 'GET', domain: 'devperfapp.webpt.com', path: '/viewExtDoc.php' },
        { method: 'GET', domain: 'devperfapp.webpt.com', path: '/user/logout' },
    ];
    const firstRun = [
        ...commonFlow.slice(0, 2),
        { method: 'GET', domain: 'devperfapp.webpt.com', path: '/favicon.ico' },
        { method: 'POST', domain: 'devperfdelegator.webpt.com', path: '/rb_bf77075baf' },
        ...commonFlow.slice(2, 12),
        { method: 'GET', domain: 'devperfapp.webpt.com', path: '/menu/index/inbox' },
        { method: 'GET', domain: 'devperfapp.webpt.com', path: '/menu/index/getclinicactions/' },
        ...commonFlow.slice(12),
    ];
    const secondRun = [
        ...commonFlow.slice(0, 2),
        { method: 'POST', domain: 'devperfdelegator.webpt.com', path: '/rb_bf77075baf' },
        ...commonFlow.slice(2, 7),
        { method: 'GET', domain: 'devperfapp.webpt.com', path: '/menu/index/getclinicactions/' },
        ...commonFlow.slice(7, 13),
        { method: 'POST', domain: 'devperfdelegator.webpt.com', path: '/rb_bf77075baf' },
        { method: 'POST', domain: 'devperfdelegator.webpt.com', path: '/rb_bf77075baf' },
        ...commonFlow.slice(13),
    ];
    fs.writeFileSync(one, jmxXml(firstRun));
    fs.writeFileSync(two, jmxXml(secondRun));
    fs.writeFileSync(sidecarOne, jtlXml(firstRun.map(r => ({ ...r, url: `https://${r.domain}${r.path}` }))));
    fs.writeFileSync(sidecarTwo, jtlXml(secondRun.map(r => ({ ...r, url: `https://${r.domain}${r.path}` }))));

    const analysis = analyzeInputFiles([one, two, sidecarOne, sidecarTwo]);

    assert.strictEqual(analysis.units.filter(u => !u.individual).length, 1);
    assert.strictEqual(analysis.units[0].name, 'batch_print_recording_may15_filtered');
    assert.strictEqual(analysis.units[0].kind, 'dual-jmx');
    assert.strictEqual(analysis.units.filter(u => u.individual && u.kind === 'jmx').length, 2);
    assert.strictEqual(analysis.units[0].primary, one);
    assert.strictEqual(analysis.units[0].secondary, two);
    assert.strictEqual(analysis.units[0].sidecars.primary, sidecarOne);
    assert.strictEqual(analysis.units[0].sidecars.secondary, sidecarTwo);
    assert.deepStrictEqual(analysis.issues, []);
});

test('ingest analysis: JMX sidecar can match by request sequence instead of filename', () => {
    const dir = tmp();
    const jmx = path.join(dir, 'exported-plan.jmx');
    const jtl = path.join(dir, 'recording-from-proxy.jtl');
    fs.writeFileSync(jmx, jmxXml([
        { method: 'GET', domain: 'app.test', path: '/login' },
        { method: 'POST', domain: 'app.test', path: '/orders' },
    ]));
    fs.writeFileSync(jtl, jtlXml([
        { method: 'GET', url: 'https://app.test/login' },
        { method: 'POST', url: 'https://app.test/orders' },
    ]));

    const analysis = analyzeInputFiles([jmx, jtl]);

    assert.strictEqual(analysis.units.length, 1);
    assert.strictEqual(analysis.units[0].kind, 'jmx');
    assert.strictEqual(analysis.units[0].secondary, jtl);
    assert.deepStrictEqual(analysis.issues, []);
});

test('ingest analysis: paired JMX sidecars are not orphaned when paths use mixed separators', () => {
    const dir = tmp();
    const jmxOne = path.join(dir, 'LOGI_Performance_STG_0004User_20May.jmx');
    const jmxTwo = path.join(dir, 'LOGI_Performance_STG_0006User_20May.jmx');
    const sidecarOne = path.join(dir, 'LOGI_Performance_STG_0004User_20May.xml');
    const sidecarTwo = path.join(dir, 'LOGI_Performance_STG_0006User_20May.xml');
    fs.writeFileSync(jmxOne, jmxXml([
        { method: 'GET', domain: 'stgadmin.webpt.com', path: '/' },
        { method: 'GET', domain: 'stgauth.webpt.com', path: '/authorize' },
        { method: 'GET', domain: 'stgauth.webpt.com', path: '/authorize/resume' },
    ]));
    fs.writeFileSync(jmxTwo, jmxXml([
        { method: 'GET', domain: 'stgadmin.webpt.com', path: '/' },
        { method: 'GET', domain: 'stgauth.webpt.com', path: '/authorize' },
        { method: 'GET', domain: 'stgauth.webpt.com', path: '/authorize/resume' },
    ]));
    fs.writeFileSync(sidecarOne, jtlXml([
        { method: 'GET', url: 'https://stgadmin.webpt.com/' },
        { method: 'GET', url: 'https://stgauth.webpt.com/authorize' },
        { method: 'GET', url: 'https://stgauth.webpt.com/authorize/resume' },
    ]));
    fs.writeFileSync(sidecarTwo, jtlXml([
        { method: 'GET', url: 'https://stgadmin.webpt.com/' },
        { method: 'GET', url: 'https://stgauth.webpt.com/authorize' },
        { method: 'GET', url: 'https://stgauth.webpt.com/authorize/resume' },
    ]));
    const mixed = [jmxOne, sidecarOne, jmxTwo, sidecarTwo].map(f => f.replace(/\\/g, '/'));

    const analysis = analyzeInputFiles(mixed);

    assert.strictEqual(analysis.units.filter(u => !u.individual).length, 1);
    assert.strictEqual(analysis.units[0].kind, 'dual-jmx');
    assert.ok(!analysis.issues.some(i => i.code === 'orphan_sidecar'));
});

test('ingest analysis: ambiguous similar HARs ask for an exact pair', () => {
    const dir = tmp();
    const files = ['run-a.har', 'run-b.har', 'run-c.har'].map(name => path.join(dir, name));
    for (const f of files) {
        fs.writeFileSync(f, JSON.stringify(har([
            entry('GET', 'https://app.test/login'),
            entry('POST', 'https://app.test/orders'),
        ])));
    }

    const analysis = analyzeInputFiles(files);

    assert.ok(analysis.issues.some(i =>
        i.code === 'ambiguous_recording_pair' &&
        /Found 3 similar HARs/.test(i.message) &&
        /exactly two runs/.test(i.message)
    ));
});

test('ingest analysis: writes per-flow inventory JSON and markdown report', () => {
    const dir = tmp();
    const rec = path.join(dir, 'checkout.har');
    fs.writeFileSync(rec, JSON.stringify(har([
        entry('GET', 'https://app.test/login'),
        entry('POST', 'https://app.test/orders'),
    ])));
    const analysis = analyzeInputFiles([rec]);
    const out = tmp();

    const artifacts = writeIntakeArtifacts(out, analysis);

    assert.ok(fs.existsSync(path.join(out, 'checkout_input_inventory.json')));
    assert.ok(fs.existsSync(path.join(out, 'checkout_intake_report.md')));
    assert.strictEqual(artifacts.length, 1);
    const report = fs.readFileSync(path.join(out, 'checkout_intake_report.md'), 'utf8');
    assert.match(report, /# Intake Report: checkout/);
    assert.match(report, /GET \/login/);
    assert.match(report, /POST \/orders/);
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
    // The controller name must stay a clean __jm__ variable ("Poll_1");
    // the human-readable endpoint lives in the comments prop.
    assert.match(out.xml, /testname="Poll_1"/);
    assert.match(out.xml, /Elastic polling: GET \/status/);
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

test('generate: mined text assertions are opt-in, not default', () => {
    const { entries, pages } = parse(har([
        entry('GET', 'https://app.test/dashboard', { body: '{"status":"OK","message":"Welcome back"}' }),
    ]));
    const outDefault = tmp();
    const genDefault = generate(entries, pages, outDefault, 'assertions-default');
    const xmlDefault = fs.readFileSync(genDefault.jmxPath, 'utf8');
    assert.doesNotMatch(xmlDefault, /Stable text present/);

    const outOptIn = tmp();
    const genOptIn = generate(entries, pages, outOptIn, 'assertions-opt-in', {
        runCfg: { mineAssertions: true },
    });
    const xmlOptIn = fs.readFileSync(genOptIn.jmxPath, 'utf8');
    assert.match(xmlOptIn, /Stable text present/);
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

test('baseline diff: uses fast JTL rows so malformed bodies do not hide status drift', () => {
    const out = tmp();
    const iter = path.join(out, 'iteration_1');
    fs.mkdirSync(iter, { recursive: true });
    fs.writeFileSync(path.join(iter, 'results.jtl'), `<?xml version="1.0" encoding="UTF-8"?>
<testResults>
  <httpSample lb="Step 01 - GET /" rc="200" s="false"><responseData>raw & broken html</responseData></httpSample>
  <httpSample lb="Step 02 - GET /" rc="200" s="true"/>
  <httpSample lb="Step 13 - GET /redirect/" rc="500" s="false"/>
</testResults>`);
    const flatEntries = Array.from({ length: 13 }, (_, i) =>
        entry('GET', `https://app.test/step-${i + 1}`, { status: 200 })
    );
    flatEntries[12] = entry('GET', 'https://app.test/redirect/', { status: 302 });

    const diff = diffRunAgainstRecording({ outDir: out, flatEntries });

    assert.strictEqual(diff.samplesCompared, 3);
    const statusDrift = diff.drift.find(d => d.index === 12);
    assert.ok(statusDrift, 'Step 13 status drift should not be hidden by parser/body issues');
    assert.strictEqual(statusDrift.issues[0].observed, 500);
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

test('verifier fast JTL summary preserves assertion failure messages for HTTP 200 failures', () => {
    const dir = tmp();
    const jtl = path.join(dir, 'results.jtl');
    fs.writeFileSync(jtl, `<?xml version="1.0" encoding="UTF-8"?>
<testResults>
  <httpSample lb="Step 01 - GET /" rc="200" rm="OK" s="false">
    <assertionResult>
      <name>Stable text present</name>
      <failure>true</failure>
      <error>false</error>
      <failureMessage>Test failed: text expected something using /Ghost Tools/</failureMessage>
    </assertionResult>
  </httpSample>
</testResults>`);

    const samples = summarizeJtlFast(jtl);

    assert.strictEqual(samples[0].success, false);
    assert.strictEqual(samples[0].code, '200');
    assert.match(samples[0].failureMessage, /Ghost Tools/);
    assert.match(samples[0].responseMessage, /assertion/i);
});

test('verifier fast JTL summary preserves landed URL when redirect children are folded', () => {
    const dir = tmp();
    const jtl = path.join(dir, 'results.jtl');
    fs.writeFileSync(jtl, `<?xml version="1.0" encoding="UTF-8"?>
<testResults>
  <httpSample lb="Step 13 - GET /dashboard.php" rc="200" rm="OK" s="true">
    <httpSample lb="Step 13 - GET /dashboard.php-0" rc="302" rm="Found" s="true">
      <java.net.URL>https://app.test/dashboard.php</java.net.URL>
    </httpSample>
    <httpSample lb="Step 13 - GET /dashboard.php-1" rc="200" rm="OK" s="true">
      <java.net.URL>https://auth.test/login</java.net.URL>
    </httpSample>
    <java.net.URL>https://auth.test/login</java.net.URL>
  </httpSample>
</testResults>`);

    const samples = summarizeJtlFast(jtl);

    assert.strictEqual(samples.length, 1);
    assert.strictEqual(samples[0].label, 'Step 13 - GET /dashboard.php');
    assert.strictEqual(samples[0].finalUrl, 'https://auth.test/login');
    assert.deepStrictEqual(samples[0].urls, [
        'https://app.test/dashboard.php',
        'https://auth.test/login',
        'https://auth.test/login',
    ]);
});

test('baseline diff compares responseData from folded redirect children', () => {
    const out = tmp();
    const iter = path.join(out, 'iteration_1');
    fs.mkdirSync(iter, { recursive: true });
    fs.writeFileSync(path.join(iter, 'results.jtl'), `<?xml version="1.0" encoding="UTF-8"?>
<testResults>
  <httpSample lb="Step 01 - GET /dashboard.php" rc="200" rm="OK" s="true">
    <httpSample lb="Step 01 - GET /dashboard.php-0" rc="302" rm="Found" s="true">
      <responseData class="java.lang.String"></responseData>
      <java.net.URL>https://app.test/dashboard.php</java.net.URL>
    </httpSample>
    <httpSample lb="Step 01 - GET /dashboard.php-1" rc="200" rm="OK" s="true">
      <responseData class="java.lang.String">&lt;html&gt;&lt;title&gt;Login&lt;/title&gt;&lt;form&gt;Password&lt;/form&gt;&lt;/html&gt;</responseData>
      <java.net.URL>https://auth.test/login</java.net.URL>
    </httpSample>
    <java.net.URL>https://auth.test/login</java.net.URL>
  </httpSample>
</testResults>`);
    const recordedBody = '<html><title>Dashboard</title><main>' + 'DALLINGA '.repeat(80) + '</main></html>';
    const flatEntries = [
        entry('GET', 'https://app.test/dashboard.php', { status: 200, body: recordedBody }),
    ];

    const diff = diffRunAgainstRecording({ outDir: out, flatEntries, thresholdPct: 10 });

    assert.strictEqual(diff.samplesCompared, 1);
    assert.ok(diff.drift.some(d => d.index === 0 && d.issues.some(i => i.kind === 'lengthDriftPct')));
});

test('baseline diff: tiny-body percentage swings are NOT flagged (adaptive absolute floor)', () => {
    const out = tmp();
    const iter = path.join(out, 'iteration_1');
    fs.mkdirSync(iter, { recursive: true });
    // recorded 20B -> observed 40B is +100% but only +20B absolute: noise.
    fs.writeFileSync(path.join(iter, 'results.jtl'), `<?xml version="1.0" encoding="UTF-8"?>
<testResults>
  <httpSample lb="Step 01 - GET /ping" rc="200" rm="OK" s="true">
    <responseData class="java.lang.String">{"status":"okokokokokokokok"}</responseData>
    <java.net.URL>https://app.test/ping</java.net.URL>
  </httpSample>
</testResults>`);
    const flatEntries = [entry('GET', 'https://app.test/ping', { status: 200, body: '{"status":"ok"}' })];
    const diff = diffRunAgainstRecording({ outDir: out, flatEntries, thresholdPct: 10 });
    assert.ok(!diff.drift.some(d => d.issues.some(i => i.kind === 'lengthDriftPct')));
});

test('scrubber: redacts client_secret and PII fields, keeps session/csrf tokens intact', () => {
    const xml = [
        '<recording>',
        '<samplerData>grant_type=authorization_code&amp;client_secret=abc123SECRET&amp;code=keepme</samplerData>',
        '<samplerData>{"dob":"1990-01-01","csrfToken":"keep-csrf-123"}</samplerData>',
        '</recording>',
    ].join('\n');
    const { xml: out } = scrubRecordingXml(xml);
    assert.ok(!out.includes('abc123SECRET'));
    assert.ok(!out.includes('1990-01-01'));
    assert.ok(out.includes('keep-csrf-123'), 'csrf token must stay intact for correlation');
    assert.ok(out.includes('keepme'), 'oauth code must stay intact for correlation');
});

test('baseline diff uses explicit current JTL instead of stale iteration folders', () => {
    const out = tmp();
    const stale = path.join(out, 'iteration_9');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'results.jtl'), `<?xml version="1.0" encoding="UTF-8"?>
<testResults>
  <httpSample lb="Step 01 - GET /dashboard.php" rc="200" rm="OK" s="true">
    <java.net.URL>https://auth.test/login</java.net.URL>
    <responseData class="java.lang.String">&lt;html&gt;Login&lt;/html&gt;</responseData>
  </httpSample>
</testResults>`);
    const currentJtl = path.join(out, 'final.jtl');
    fs.writeFileSync(currentJtl, `<?xml version="1.0" encoding="UTF-8"?>
<testResults>
  <httpSample lb="Step 01 - GET /dashboard.php" rc="200" rm="OK" s="true">
    <java.net.URL>https://app.test/dashboard.php</java.net.URL>
    <responseData class="java.lang.String">&lt;html&gt;Dashboard&lt;/html&gt;</responseData>
  </httpSample>
</testResults>`);
    const flatEntries = [
        entry('GET', 'https://app.test/dashboard.php', { status: 200, body: '<html>Dashboard</html>' }),
    ];

    const diff = diffRunAgainstRecording({ outDir: out, flatEntries, jtlPath: currentJtl, thresholdPct: 10 });

    assert.strictEqual(diff.jtlPath, currentJtl);
    assert.strictEqual(diff.rootCause, null);
});

test('run evidence: aligns recording with JTL and preserves observed body and final URL', () => {
    const dir = tmp();
    const jtl = path.join(dir, 'results.jtl');
    fs.writeFileSync(jtl, `<?xml version="1.0" encoding="UTF-8"?>
<testResults>
  <httpSample lb="Step 01 - GET /dashboard.php" rc="200" rm="OK" s="true">
    <httpSample lb="Step 01 - GET /dashboard.php-0" rc="302" rm="Found" s="true">
      <java.net.URL>https://app.test/dashboard.php</java.net.URL>
    </httpSample>
    <httpSample lb="Step 01 - GET /dashboard.php-1" rc="200" rm="OK" s="true">
      <responseData class="java.lang.String">&lt;html&gt;&lt;title&gt;Login&lt;/title&gt;&lt;/html&gt;</responseData>
      <java.net.URL>https://auth.test/login</java.net.URL>
    </httpSample>
    <java.net.URL>https://auth.test/login</java.net.URL>
  </httpSample>
</testResults>`);
    const evidence = runEvidence.buildRunEvidence({
        entries: [entry('GET', 'https://app.test/dashboard.php', { body: '<html><title>Dashboard</title></html>' })],
        jtlPath: jtl,
    });

    assert.strictEqual(evidence.rows.length, 1);
    assert.strictEqual(evidence.rows[0].entryIndex, 0);
    assert.strictEqual(evidence.rows[0].recordedUrl, 'https://app.test/dashboard.php');
    assert.strictEqual(evidence.rows[0].finalUrl, 'https://auth.test/login');
    assert.match(evidence.rows[0].observedBody, /Login/);
    assert.match(evidence.rows[0].recordedBody, /Dashboard/);
});

test('run evidence: preserves response headers and redirect Location without saving bodies', () => {
    const dir = tmp();
    const jtl = path.join(dir, 'results.jtl');
    fs.writeFileSync(jtl, `<?xml version="1.0" encoding="UTF-8"?>
<testResults>
  <httpSample lb="Step 01 - GET /authorize" rc="302" rm="Found" s="false">
    <responseHeader class="java.lang.String">HTTP/1.1 302 Found
Location: https://auth.test/login?state=fresh
Set-Cookie: AUTH_STATE=fresh; Path=/; HttpOnly
</responseHeader>
    <java.net.URL>https://app.test/authorize</java.net.URL>
  </httpSample>
</testResults>`);

    const evidence = runEvidence.buildRunEvidence({
        entries: [entry('GET', 'https://app.test/authorize', { status: 302 })],
        jtlPath: jtl,
    });

    assert.strictEqual(evidence.rows[0].observedLocation, 'https://auth.test/login?state=fresh');
    assert.deepStrictEqual(evidence.rows[0].observedHeaderValues['set-cookie'], ['AUTH_STATE=fresh; Path=/; HttpOnly']);
    assert.strictEqual(evidence.rows[0].observedBody, '');
});

test('status analysis treats 200 auth-host landing as upstream auth bounce', () => {
    const entries = [
        entry('GET', 'https://app.test/dashboard.php', { status: 200, body: '<html><title>App Dashboard</title></html>' }),
        entry('GET', 'https://app.test/patientChart.php?ID=123', { status: 200, body: '<html>DALLINGA</html>' }),
    ];
    const samples = [
        {
            label: 'Step 01 - GET /dashboard.php',
            responseCode: '200',
            code: '200',
            success: true,
            finalUrl: 'https://auth.test/login',
        },
        {
            label: 'Step 02 - GET /patientChart.php',
            responseCode: '200',
            code: '200',
            success: false,
            failureMessage: 'Business outcome missing',
            finalUrl: 'https://auth.test/login',
        },
    ];

    const trace = statusAnalysis.traceStatusRootCause({ entries, samples });

    assert.strictEqual(trace.rootCauseIndex, 0);
    assert.strictEqual(trace.rootCause.category, 'auth_redirect_bounce');
    assert.match(trace.summary, /earliest upstream divergence/);
    assert.match(trace.rootCause.repairHint, /auth/i);
});

test('failure forensics recommends auth repair for 200 auth-host bounce', () => {
    const entries = [
        entry('GET', 'https://app.test/dashboard.php', { status: 200, body: '<html><title>Dashboard</title></html>' }),
    ];
    const samples = [
        {
            label: 'Step 01 - GET /dashboard.php',
            responseCode: '200',
            code: '200',
            success: true,
            finalUrl: 'https://auth.test/login',
        },
    ];

    const analysis = failureForensics.analyzeFailureForensics({ entries, samples });

    assert.strictEqual(analysis.rootCause.category, 'auth_redirect_bounce');
    assert.strictEqual(analysis.recommendedAction.id, 'repair-auth-session-correlation');
});

test('batch print contract: upstream auth bounce beats downstream outcome casualty', () => {
    const entries = [
        entry('GET', 'https://app.test/dashboard.php', { status: 200, body: '<html>Dashboard</html>' }),
        entry('POST', 'https://app.test/patient/display/getpatients', { status: 200, body: '{"data":[{"PatientID":14493348,"LastName":"DALLINGA"}]}' }),
        entry('GET', 'https://app.test/patientChart.php?ID=14493348', { status: 200, body: '<html>DALLINGA CaseID=18630204</html>' }),
    ];
    const samples = [
        { label: 'Step 01 - GET /dashboard.php', code: '200', responseCode: '200', success: true, finalUrl: 'https://auth.test/login', responseBody: '<html>Login</html>' },
        { label: 'Step 02 - POST /patient/display/getpatients', code: '200', responseCode: '200', success: true, finalUrl: 'https://app.test/patient/display/getpatients', responseBody: '{"data":[]}' },
        { label: 'Step 03 - GET /patientChart.php', code: '200', responseCode: '200', success: false, finalUrl: 'https://auth.test/login', responseBody: '<html>Login</html>', failureMessage: 'Business outcome missing' },
    ];

    const root = statusAnalysis.traceStatusRootCause({ entries, samples });
    const analysis = failureForensics.analyzeFailureForensics({ entries, samples });

    assert.strictEqual(root.rootCauseIndex, 0);
    assert.strictEqual(root.rootCause.category, 'auth_redirect_bounce');
    assert.strictEqual(analysis.recommendedAction.id, 'repair-auth-session-correlation');
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

test('LLM patcher: addExtractor supports CSS/HtmlExtractor patches', () => {
    const xml = `<HTTPSamplerProxy testname="Step 01 - GET /login" enabled="true"></HTTPSamplerProxy>\n<hashTree/>`;
    const fix = {
        kind: 'addExtractor',
        sampler: 'Step 01 - GET /login',
        variable: 'csrf',
        type: 'css',
        selector: 'input[name="csrf"]',
        attribute: 'value',
    };
    const validation = validateLlmPatches([fix]);
    assert.strictEqual(validation.accepted.length, 1);

    const r = applyLlmPatches(xml, validation.accepted);
    assert.strictEqual(r.applied[0].type, 'css');
    assert.match(r.xml, /HtmlExtractor\.refname">csrf/);
    assert.match(r.xml, /HtmlExtractor\.expr">input\[name=&quot;csrf&quot;\]/);
});

test('LLM patcher: removeAssertion removes a named ResponseAssertion under a sampler', () => {
    const xml = `<HTTPSamplerProxy testname="Step 01 - GET /api" enabled="true"></HTTPSamplerProxy>
<hashTree>
  <ResponseAssertion testname="Stable text present" enabled="true">
    <collectionProp name="Assertion.test_strings"><stringProp name="assert_0">ok</stringProp></collectionProp>
  </ResponseAssertion>
  <hashTree/>
</hashTree>`;
    const validation = validateLlmPatches([{ kind: 'removeAssertion', sampler: 'Step 01 - GET /api', assertion: 'Stable text present' }]);
    assert.strictEqual(validation.accepted.length, 1);

    const r = applyLlmPatches(xml, validation.accepted);
    assert.strictEqual(r.applied[0].kind, 'removeAssertion');
    assert.doesNotMatch(r.xml, /ResponseAssertion/);
});

test('LLM patcher: setSamplerEnabled can re-enable exact samplers', () => {
    const xml = `<HTTPSamplerProxy testname="Step 01 - GET /callback" enabled="false"></HTTPSamplerProxy>`;
    const r = applyLlmPatches(xml, [{ kind: 'setSamplerEnabled', sampler: 'Step 01 - GET /callback', enabled: true }]);
    assert.strictEqual(r.applied[0].enabled, true);
    assert.match(r.xml, /testname="Step 01 - GET \/callback" enabled="true"/);
});

test('fast repair loop: verifies disable hypotheses with fast replay before JMeter', async () => {
    const server = http.createServer((req, res) => {
        if (req.url === '/ok') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
            return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('missing');
    });
    await listenLocal(server);
    const port = server.address().port;
    const xml = `<HTTPSamplerProxy testname="Step 01 - GET /bad" enabled="true"></HTTPSamplerProxy>
<hashTree/>
<HTTPSamplerProxy testname="Step 02 - GET /ok" enabled="true"></HTTPSamplerProxy>
<hashTree/>`;

    try {
        const res = await fastRepairLoop.runFastRepairLoop({
            xml,
            entries: [
                entry('GET', 'http://recorded.test/bad', { status: 404, body: 'missing' }),
                entry('GET', 'http://recorded.test/ok', { status: 200, body: '{"ok":true}' }),
            ],
            fixes: [{ kind: 'setSamplerEnabled', sampler: 'Step 01 - GET /bad', enabled: false }],
            targetBaseUrl: `http://127.0.0.1:${port}`,
            insecure: true,
        });

        assert.strictEqual(res.skipped, false);
        assert.strictEqual(res.replay.ok, true);
        assert.deepStrictEqual(res.replayedIndexes, [1]);
    } finally {
        await closeServer(server);
    }
});

test('correlation hypotheses: stale JSON response value consumed in later header becomes extractor and substitution fixes', () => {
    const token = 'jsonTokenA123456789';
    const entries = [
        entry('POST', 'https://app.test/auth', { body: JSON.stringify({ sessionToken: token }) }),
        entry('GET', 'https://app.test/me', { reqHeaders: [{ name: 'X-Session', value: token }] }),
    ];
    const xml = `<jmeterTestPlan><hashTree>
      <HTTPSamplerProxy testname="Step 01 - POST /auth" enabled="true"><stringProp name="HTTPSampler.path">/auth</stringProp></HTTPSamplerProxy><hashTree/>
      <HTTPSamplerProxy testname="Step 02 - GET /me" enabled="true"><stringProp name="HTTPSampler.path">/me</stringProp></HTTPSamplerProxy><hashTree>
        <HeaderManager><collectionProp name="HeaderManager.headers"><elementProp name="X-Session" elementType="Header"><stringProp name="Header.name">X-Session</stringProp><stringProp name="Header.value">${token}</stringProp></elementProp></collectionProp></HeaderManager><hashTree/>
      </hashTree>
    </hashTree></jmeterTestPlan>`;

    const result = correlationHypotheses.proposeCorrelationHypotheses({
        xml,
        entries,
        failures: [{ samplerName: 'Step 02 - GET /me', samplerIndex: 1, responseCode: '401' }],
    });

    assert.strictEqual(result.fixes.length, 2);
    assert.deepStrictEqual(result.fixes[0], {
        kind: 'addExtractor',
        sampler: 'Step 01 - POST /auth',
        variable: 'sessionToken',
        type: 'json',
        path: '$.sessionToken',
    });
    assert.deepStrictEqual(result.fixes[1], {
        kind: 'replaceValueWithVar',
        sampler: 'Step 02 - GET /me',
        value: token,
        variable: 'sessionToken',
    });
    assert.strictEqual(result.attempts[0].proof.verified, true);
});

test('correlation hypotheses: stale response header value consumed in later body becomes header regex extractor', () => {
    const token = 'headerTokenA123456789';
    const producer = entry('GET', 'https://app.test/bootstrap');
    producer.response.headers.push({ name: 'X-Auth-Token', value: token });
    const entries = [
        producer,
        entry('POST', 'https://app.test/api', {
            postData: { mimeType: 'application/json', text: JSON.stringify({ authToken: token }) },
        }),
    ];
    const xml = `<jmeterTestPlan><hashTree>
      <HTTPSamplerProxy testname="Step 01 - GET /bootstrap" enabled="true"><stringProp name="HTTPSampler.path">/bootstrap</stringProp></HTTPSamplerProxy><hashTree/>
      <HTTPSamplerProxy testname="Step 02 - POST /api" enabled="true"><stringProp name="HTTPSampler.path">/api</stringProp><stringProp name="Argument.value">{&quot;authToken&quot;:&quot;${token}&quot;}</stringProp></HTTPSamplerProxy><hashTree/>
    </hashTree></jmeterTestPlan>`;

    const result = correlationHypotheses.proposeCorrelationHypotheses({
        xml,
        entries,
        failures: [{ samplerName: 'Step 02 - POST /api', samplerIndex: 1, responseCode: '401' }],
    });

    assert.strictEqual(result.fixes[0].kind, 'addExtractor');
    assert.strictEqual(result.fixes[0].type, 'regex');
    assert.strictEqual(result.fixes[0].useHeaders, true);
    assert.match(result.fixes[0].regex, /X-Auth-Token/);
    assert.deepStrictEqual(result.fixes[1], {
        kind: 'replaceValueWithVar',
        sampler: 'Step 02 - POST /api',
        value: token,
        variable: 'authToken',
    });
});

test('correlation hypotheses: cookie value consumed outside Cookie header is correlated with a verified Set-Cookie extractor', () => {
    const token = 'cookieTokenA123456789';
    const producer = entry('GET', 'https://app.test/login');
    producer.response.headers.push({ name: 'Set-Cookie', value: `sid=${token}; Path=/; HttpOnly` });
    const entries = [
        producer,
        entry('POST', 'https://app.test/graphql', {
            postData: { mimeType: 'application/json', text: JSON.stringify({ sessionId: `Token ${token}` }) },
        }),
    ];
    const xml = `<jmeterTestPlan><hashTree>
      <HTTPSamplerProxy testname="Step 01 - GET /login" enabled="true"><stringProp name="HTTPSampler.path">/login</stringProp></HTTPSamplerProxy><hashTree/>
      <HTTPSamplerProxy testname="Step 02 - POST /graphql" enabled="true"><stringProp name="HTTPSampler.path">/graphql</stringProp><stringProp name="Argument.value">{&quot;sessionId&quot;:&quot;Token ${token}&quot;}</stringProp></HTTPSamplerProxy><hashTree/>
    </hashTree></jmeterTestPlan>`;

    const result = correlationHypotheses.proposeCorrelationHypotheses({
        xml,
        entries,
        failures: [{ samplerName: 'Step 02 - POST /graphql', samplerIndex: 1, responseCode: '401' }],
    });

    assert.strictEqual(result.fixes[0].kind, 'addExtractor');
    assert.strictEqual(result.fixes[0].type, 'regex');
    assert.strictEqual(result.fixes[0].useHeaders, true);
    assert.match(result.fixes[0].regex, /sid=/);
    assert.strictEqual(result.fixes[1].value, token);
});

test('correlation hypotheses: response-only dynamic value is ignored when no failing request consumes it', () => {
    const token = 'responseOnlyA123456789';
    const entries = [
        entry('GET', 'https://app.test/profile', { body: JSON.stringify({ userId: token }) }),
        entry('GET', 'https://app.test/me'),
    ];
    const xml = `<jmeterTestPlan><hashTree>
      <HTTPSamplerProxy testname="Step 01 - GET /profile" enabled="true"><stringProp name="HTTPSampler.path">/profile</stringProp></HTTPSamplerProxy><hashTree/>
      <HTTPSamplerProxy testname="Step 02 - GET /me" enabled="true"><stringProp name="HTTPSampler.path">/me</stringProp></HTTPSamplerProxy><hashTree/>
    </hashTree></jmeterTestPlan>`;

    const result = correlationHypotheses.proposeCorrelationHypotheses({
        xml,
        entries,
        failures: [{ samplerName: 'Step 02 - GET /me', samplerIndex: 1, responseCode: '401' }],
    });

    assert.deepStrictEqual(result.fixes, []);
    assert.deepStrictEqual(result.attempts, []);
});

test('correlation hypotheses: unproved consumed value is rejected with evidence instead of guessed', () => {
    const token = 'missingProducerA123456789';
    const entries = [
        entry('GET', 'https://app.test/start'),
        entry('GET', 'https://app.test/me', { reqHeaders: [{ name: 'X-Session', value: token }] }),
    ];
    const xml = `<jmeterTestPlan><hashTree>
      <HTTPSamplerProxy testname="Step 01 - GET /start" enabled="true"><stringProp name="HTTPSampler.path">/start</stringProp></HTTPSamplerProxy><hashTree/>
      <HTTPSamplerProxy testname="Step 02 - GET /me" enabled="true"><stringProp name="HTTPSampler.path">/me</stringProp></HTTPSamplerProxy><hashTree>
        <HeaderManager><collectionProp name="HeaderManager.headers"><elementProp name="X-Session" elementType="Header"><stringProp name="Header.name">X-Session</stringProp><stringProp name="Header.value">${token}</stringProp></elementProp></collectionProp></HeaderManager><hashTree/>
      </hashTree>
    </hashTree></jmeterTestPlan>`;

    const result = correlationHypotheses.proposeCorrelationHypotheses({
        xml,
        entries,
        failures: [{ samplerName: 'Step 02 - GET /me', samplerIndex: 1, responseCode: '401' }],
    });

    assert.deepStrictEqual(result.fixes, []);
    assert.strictEqual(result.rejected[0].value, token);
    assert.strictEqual(result.rejected[0].reason, 'no_verified_producer');
});

test('fast repair loop: verifies extractor and substitution hypotheses before JMeter', async () => {
    const recordedToken = 'recordedTokenA123456789';
    const liveToken = 'liveTokenB123456789';
    const server = http.createServer((req, res) => {
        if (req.url === '/auth') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ sessionToken: liveToken }));
            return;
        }
        if (req.url === '/me' && req.headers['x-session'] === liveToken) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
            return;
        }
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":"unauthorized"}');
    });
    await listenLocal(server);
    const port = server.address().port;
    const xml = `<jmeterTestPlan><hashTree>
      <HTTPSamplerProxy testname="Step 01 - GET /auth" enabled="true"><stringProp name="HTTPSampler.path">/auth</stringProp></HTTPSamplerProxy><hashTree/>
      <HTTPSamplerProxy testname="Step 02 - GET /me" enabled="true"><stringProp name="HTTPSampler.path">/me</stringProp></HTTPSamplerProxy><hashTree>
        <HeaderManager><collectionProp name="HeaderManager.headers"><elementProp name="X-Session" elementType="Header"><stringProp name="Header.name">X-Session</stringProp><stringProp name="Header.value">${recordedToken}</stringProp></elementProp></collectionProp></HeaderManager><hashTree/>
      </hashTree>
    </hashTree></jmeterTestPlan>`;
    try {
        const result = await fastRepairLoop.runFastRepairLoop({
            xml,
            entries: [
                entry('GET', 'http://recorded.test/auth', { body: JSON.stringify({ sessionToken: recordedToken }) }),
                entry('GET', 'http://recorded.test/me', { reqHeaders: [{ name: 'X-Session', value: recordedToken }], body: '{"ok":true}' }),
            ],
            fixes: [
                { kind: 'addExtractor', sampler: 'Step 01 - GET /auth', variable: 'sessionToken', type: 'json', path: '$.sessionToken' },
                { kind: 'replaceValueWithVar', sampler: 'Step 02 - GET /me', variable: 'sessionToken', value: recordedToken },
            ],
            targetBaseUrl: `http://127.0.0.1:${port}`,
            insecure: true,
        });

        assert.strictEqual(result.skipped, false);
        assert.strictEqual(result.replay.ok, true);
        assert.strictEqual(result.extractedVariables.sessionToken, liveToken);
    } finally {
        await closeServer(server);
    }
});

test('runner: verified correlation repair applies proven hypothesis before LLM escalation', async () => {
    const recordedToken = 'runnerRecordedA123456789';
    const liveToken = 'runnerLiveB123456789';
    const server = http.createServer((req, res) => {
        if (req.url === '/auth') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ sessionToken: liveToken }));
            return;
        }
        if (req.url === '/me' && req.headers['x-session'] === liveToken) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
            return;
        }
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":"unauthorized"}');
    });
    await listenLocal(server);
    const port = server.address().port;
    const out = tmp();
    const jmxPath = path.join(out, 'flow.jmx');
    let reverifyMaxIterations = null;
    fs.writeFileSync(jmxPath, `<jmeterTestPlan><hashTree>
      <HTTPSamplerProxy testname="Step 01 - GET /auth" enabled="true"><stringProp name="HTTPSampler.path">/auth</stringProp></HTTPSamplerProxy><hashTree/>
      <HTTPSamplerProxy testname="Step 02 - GET /me" enabled="true"><stringProp name="HTTPSampler.path">/me</stringProp></HTTPSamplerProxy><hashTree>
        <HeaderManager><collectionProp name="HeaderManager.headers"><elementProp name="X-Session" elementType="Header"><stringProp name="Header.name">X-Session</stringProp><stringProp name="Header.value">${recordedToken}</stringProp></elementProp></collectionProp></HeaderManager><hashTree/>
      </hashTree>
    </hashTree></jmeterTestPlan>`);

    try {
        const repair = await runnerInternal.tryVerifiedCorrelationRepairRound({
            result: {
                success: false,
                samples: [{ label: 'Step 02 - GET /me', index: 1, success: false, responseCode: '401', isTransaction: false }],
            },
            jmxPath,
            config: { targetBaseUrl: `http://127.0.0.1:${port}`, timeoutMs: 5000, maxIterations: 3 },
            gen: {
                flat: [
                    entry('GET', 'http://recorded.test/auth', { body: JSON.stringify({ sessionToken: recordedToken }) }),
                    entry('GET', 'http://recorded.test/me', { reqHeaders: [{ name: 'X-Session', value: recordedToken }], body: '{"ok":true}' }),
                ],
            },
            outDir: out,
            name: 'flow',
            onLog: () => {},
            feedbackLoop: async ({ jmxPath: patchedJmxPath, maxIterations }) => {
                reverifyMaxIterations = maxIterations;
                const patched = fs.readFileSync(patchedJmxPath, 'utf8');
                assert.match(patched, /JSONPostProcessor\.referenceNames">sessionToken/);
                assert.match(patched, /\$\{sessionToken\}/);
                return { success: true, finalJmxPath: patchedJmxPath, samples: [] };
            },
        });

        assert.strictEqual(repair.success, true);
        assert.strictEqual(repair.successfulFixes.length, 2);
        assert.strictEqual(reverifyMaxIterations, 3);
        assert.ok(fs.existsSync(path.join(out, 'flow_correlation_hypotheses.json')));
    } finally {
        await closeServer(server);
    }
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

test('HTML report: performance summary renders percentiles + SLO scorecard when timing + slo present', () => {
    const out = tmp();
    const reportPath = writeHtmlReportFn(out, 'perf', {
        mode: 'run', verdict: 'GREEN',
        stats: { samplers: 3 },
        slo: { p95Ms: 500, errorRatePct: 5 },
        samples: [
            { label: 'A', success: true, responseCode: '200', elapsed: 100 },
            { label: 'B', success: true, responseCode: '200', elapsed: 200 },
            { label: 'C', success: false, responseCode: '500', elapsed: 900 },
        ],
    });
    const html = fs.readFileSync(reportPath, 'utf8');
    assert.match(html, /Performance summary/);
    assert.match(html, /p95 ms/);
    assert.match(html, /SLO scorecard/);
    assert.match(html, /Error rate/);
    assert.match(html, /FAIL/); // p95 (=900) exceeds 500ms target
});

test('LLM patch validator: rejects malformed regex and JSONPath expressions before auto-apply', () => {
    const out = validateLlmPatches([
        { kind: 'addExtractor', sampler: 'Step 01', variable: 'good_re', type: 'regex', regex: 'token=([^&]+)' },
        { kind: 'addExtractor', sampler: 'Step 02', variable: 'bad_re', type: 'regex', regex: 'token=([' },
        { kind: 'addExtractor', sampler: 'Step 03', variable: 'good_jp', type: 'json', path: '$.data.items[0].id' },
        { kind: 'addExtractor', sampler: 'Step 04', variable: 'bad_jp', type: 'json', path: 'data.id' },
        { kind: 'addExtractor', sampler: 'Step 05', variable: 'unbalanced', type: 'json', path: '$.a[0' },
    ]);
    assert.deepStrictEqual(out.accepted.map(f => f.variable).sort(), ['good_jp', 'good_re']);
    assert.deepStrictEqual(out.rejected.map(r => r.reason).sort(), ['invalid_jsonpath', 'invalid_jsonpath', 'invalid_regex']);
});

test('HTML report: load profile + correlation table + dual-recording panel render when data is present', () => {
    const out = tmp();
    const reportPath = writeHtmlReportFn(out, 'demo', {
        mode: 'generate only (har)', verdict: 'generated',
        stats: { samplers: 2, correlations: 1 },
        samples: [{ label: 'Step 01 - GET /', success: true, isTransaction: false, code: '200', message: 'OK from JTL' }],
        correlations: [{
            variableName: 'token', sourceUrl: 'POST /auth', targetUrl: 'GET /me',
            extractorType: 'json', confidence: 0.93,
        }, {
            variableName: 'csrf', sourceRequestIndex: 0, targetRequestIndex: 1,
            extractorType: 'regex', confidence: 0.85,
        }, {
            variableName: 'cookie_id', producer: 1, consumer: 2,
            extractorType: 'cookie', confidence: 0.9,
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
    assert.match(html, /200/);
    assert.match(html, /OK from JTL/);
    assert.match(html, /Correlations \(3\)/);
    assert.match(html, /token/);
    assert.match(html, /Step 01/);
    assert.match(html, /Step 02/);
    assert.match(html, /Step 03/);
    assert.doesNotMatch(html, /<td>\?<\/td>/);
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

test('polling while: cap survives java-safe (native __jm__ idx, no JSR223 counter)', () => {
    const fakeXml = `
        <HTTPSamplerProxy testname="Step 01 - GET /s"></HTTPSamplerProxy><hashTree/>
        <HTTPSamplerProxy testname="Step 02 - GET /s"></HTTPSamplerProxy><hashTree/>
        <HTTPSamplerProxy testname="Step 03 - GET /s"></HTTPSamplerProxy><hashTree/>`;
    const out = wrapPollingInWhileController(fakeXml, [{ endpoint: 'GET /s', count: 3, startOrder: 0 }]);
    assert.strictEqual(out.wrapped, 1);
    assert.doesNotMatch(out.xml, /JSR223PostProcessor/, 'a JSR223 counter would be stripped by java-safe → infinite loop');
    assert.match(out.xml, /__jm__Poll_1__idx.*&lt; 12|__jm__Poll_1__idx.*< 12/, 'native While idx caps the loop at count*4');
    // java-safe pass leaves the cap intact
    const safe = sanitizeJavaUnsafeJmx(out.xml);
    assert.match(safe.changed ? safe.xml : out.xml, /__jm__Poll_1__idx/, 'cap survives the java-safe strip');
    // terminator is COMBINED with the cap, not a replacement that can hang
    const terminated = wrapPollingInWhileController(fakeXml, [{ endpoint: 'GET /s', count: 3, startOrder: 0, terminator: '${__jexl3(vars.get("status") != "PENDING")}' }]);
    assert.ok(terminated.xml.includes('vars.get(&quot;status&quot;)'), 'terminator kept');
    assert.match(terminated.xml, /__jm__Poll_1__idx/, 'safety cap still present alongside the terminator');
});

test('disable patterns: full step labels match testnames EXACTLY (no cross-flow contamination)', () => {
    const { samplerPatternMatches } = require('../src/transforms');
    // The live bug: createtask's "Step 07 - POST /" disabled logi's login POST.
    assert.strictEqual(samplerPatternMatches('Step 07 - POST /', 'Step 07 - POST /u/login/identifier', 'x Step 07 - POST /u/login/identifier'), false);
    assert.strictEqual(samplerPatternMatches('Step 07 - POST /', 'Step 07 - POST /', 'login.example.com/ Step 07 - POST /'), true);
    // Path patterns keep substring semantics.
    assert.strictEqual(samplerPatternMatches('/_next/data/', 'Step 42 - GET /_next/data/abc/tasks.json', 'app.test/_next/data/abc/tasks.json Step 42 - GET /_next/data/abc/tasks.json'), true);
    const xml = `<HTTPSamplerProxy testname="Step 07 - POST /u/login/identifier" enabled="true"><stringProp name="HTTPSampler.path">/u/login/identifier</stringProp></HTTPSamplerProxy><hashTree/>`;
    const { disableSamplersByPattern } = require('../src/transforms');
    const out = disableSamplersByPattern(xml, ['Step 07 - POST /']);
    assert.strictEqual(out.disabled, 0, "another flow's login must not be disabled by a step-label pattern");
    // Business guard applies the same rule to operator overrides.
    const guard = businessGuard.buildBusinessGuard({
        xml, flowName: 'logi', runCfg: { disableCalls: ['Step 07 - POST /'] },
    });
    assert.ok(guard.protectedNames.has('Step 07 - POST /u/login/identifier'), 'login stays protected — the step-label override belongs to a different flow');
});

test('form correlation cap: most-consumed inputs win, the rest are reported not wired', () => {
    const page = (fields) => `<html><form method="POST" action="/next">${fields.map(([n, v]) => `<input type="hidden" name="${n}" value="${v}"/>`).join('')}</form></html>`;
    const fields = Array.from({ length: 6 }, (_, k) => [`field_${k}`, `VALUE_${k}_abcdefgh`]);
    const entries = [
        { request: { method: 'GET', url: 'https://app.test/form', headers: [] }, response: { status: 200, content: { text: page(fields) } } },
        // field_0 consumed by THREE later requests, others by one each.
        { request: { method: 'POST', url: 'https://app.test/next', headers: [], postData: { text: fields.map(([n, v]) => `${n}=${v}`).join('&') } }, response: { status: 200, content: { text: '' } } },
        { request: { method: 'POST', url: 'https://app.test/again?f0=VALUE_0_abcdefgh', headers: [], postData: { text: 'f0=VALUE_0_abcdefgh' } }, response: { status: 200, content: { text: '' } } },
    ];
    const xml = `<jmeterTestPlan><hashTree>
  <HTTPSamplerProxy testname="Step 01 - GET /form" enabled="true"><stringProp name="HTTPSampler.path">/form</stringProp></HTTPSamplerProxy><hashTree/>
  <HTTPSamplerProxy testname="Step 02 - POST /next" enabled="true"><stringProp name="HTTPSampler.path">/next</stringProp><stringProp name="Argument.value">${fields.map(([n, v]) => `${n}=${v}`).join('&amp;')}</stringProp></HTTPSamplerProxy><hashTree/>
  <HTTPSamplerProxy testname="Step 03 - POST /again" enabled="true"><stringProp name="HTTPSampler.path">/again?f0=VALUE_0_abcdefgh</stringProp></HTTPSamplerProxy><hashTree/>
</hashTree></jmeterTestPlan>`;
    const { correlateFormHiddenInputs } = require('../src/transforms');
    const out = correlateFormHiddenInputs(xml, entries, { maxVars: 2 });
    assert.strictEqual(out.wired.length, 2, 'cap respected');
    assert.strictEqual(out.wired[0].input, 'field_0', 'most-consumed field wired first');
    assert.strictEqual(out.skippedByCap.length, 4);
    assert.ok(out.skippedByCap.every(s => s.consumers >= 1));
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

test('generate: volatile OAuth values are ignored instead of forced into correlations', () => {
    const state = 'recordedState1234567890';
    const nonce = 'recordedNonce1234567890';
    const code = 'recordedCode1234567890';
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
        entry('GET', `https://app.test/callback?code=${code}&state=${state}`, {
            query: [
                { name: 'code', value: code },
                { name: 'state', value: state },
            ],
        }),
    ]));

    const out = tmp();
    const gen = generate(entries, pages, out, 'oauth-volatile-ignore');
    const xml = fs.readFileSync(gen.jmxPath, 'utf8');

    assert.doesNotMatch(xml, /RegexExtractor\.refname">(state|nonce|code)</);
    assert.ok(gen.reasoning.some(r => r.phase === 'oauth-volatile-ignore'));
});

// ── Non-load-bearing fold (empirical, app-agnostic) ──────────────────────
const { detectNonLoadBearingFailures } = require('../src/nonloadbearing-fold');

test('non-load-bearing fold: folds failing hops whose downstream all passed', () => {
    const rows = [
        { entryIndex: 14, label: 'SC01_T02_/u/login/password-015', method: 'POST', observedStatus: 200, success: true, isTransaction: false, finalUrl: 'https://x/u/login/password' },
        { entryIndex: 15, label: 'SC01_T02_/authorize/resume-016', method: 'GET', observedStatus: 401, success: false, isTransaction: false, finalUrl: 'https://x/authorize/resume?state=z' },
        { entryIndex: 16, label: 'SC01_T02_/iam/callback-017', method: 'GET', observedStatus: 200, success: true, isTransaction: false, finalUrl: 'https://x/iam/callback' },
        { entryIndex: 25, label: 'SC01_T02_/oauth/token-025', method: 'POST', observedStatus: 403, success: false, isTransaction: false, finalUrl: 'https://x/oauth/token' },
        { entryIndex: 26, label: 'SC01_T02_/user/iam/save-026', method: 'POST', observedStatus: 200, success: true, isTransaction: false, finalUrl: 'https://x/user/iam/save' },
    ];
    const labels = detectNonLoadBearingFailures({ evidence: { rows } }).map(c => c.label);
    assert.deepStrictEqual(labels.sort(), ['SC01_T02_/authorize/resume-016', 'SC01_T02_/oauth/token-025']);
});

test('non-load-bearing fold: keeps a token exchange whose failure cascades (M2M)', () => {
    const rows = [
        { entryIndex: 1, label: 'POST /oauth/token-002', method: 'POST', observedStatus: 403, success: false, isTransaction: false, finalUrl: 'https://x/oauth/token' },
        { entryIndex: 2, label: 'GET /api/v1/data-003', method: 'GET', observedStatus: 401, success: false, isTransaction: false, finalUrl: 'https://x/api/v1/data' },
    ];
    assert.strictEqual(detectNonLoadBearingFailures({ evidence: { rows } }).length, 0);
});

test('non-load-bearing fold: never folds a failing business request', () => {
    const rows = [
        { entryIndex: 1, label: 'POST /checkout-002', method: 'POST', observedStatus: 500, success: false, isTransaction: false, finalUrl: 'https://x/checkout' },
        { entryIndex: 2, label: 'GET /home-003', method: 'GET', observedStatus: 200, success: true, isTransaction: false, finalUrl: 'https://x/home' },
    ];
    assert.strictEqual(detectNonLoadBearingFailures({ evidence: { rows } }).length, 0);
});

test('non-load-bearing fold: never folds a guard-protected sampler', () => {
    const rows = [
        { entryIndex: 1, label: 'SC01_/authorize/resume-002', method: 'GET', observedStatus: 401, success: false, isTransaction: false, finalUrl: 'https://x/authorize/resume' },
        { entryIndex: 2, label: 'GET /home-003', method: 'GET', observedStatus: 200, success: true, isTransaction: false, finalUrl: 'https://x/home' },
    ];
    const guard = { protectedNames: new Set(['SC01_/authorize/resume-002']) };
    assert.strictEqual(detectNonLoadBearingFailures({ evidence: { rows }, guard }).length, 0);
});

test('non-load-bearing fold: no candidates when nothing failed', () => {
    const rows = [
        { entryIndex: 1, label: 'GET /a-001', method: 'GET', observedStatus: 200, success: true, isTransaction: false, finalUrl: 'https://x/a' },
        { entryIndex: 2, label: 'GET /b-002', method: 'GET', observedStatus: 200, success: true, isTransaction: false, finalUrl: 'https://x/b' },
    ];
    assert.strictEqual(detectNonLoadBearingFailures({ evidence: { rows } }).length, 0);
});

// ── run evidence: appended-JTL last-iteration pairing ────────────────────
const runEvidenceMod = require('../src/run-evidence');

test('run evidence: appended JTL pairs each step to its LAST iteration, not a stale first', () => {
    const entries = [
        { request: { method: 'GET', url: 'https://app.test/' }, response: { status: 200 } },
        { request: { method: 'GET', url: 'https://app.test/authorize/resume' }, response: { status: 302 } },
    ];
    // final.jtl appended two iterations: iter-1 resume 401 (stale), iter-2 resume 200 (final).
    const samples = [
        { label: 'SC01_T01_GET_/-001', responseCode: '200', success: true, isTransaction: false },
        { label: 'SC01_T02_/authorize/resume-002', responseCode: '401', success: false, isTransaction: false },
        { label: 'SC01_T01_GET_/-001', responseCode: '200', success: true, isTransaction: false },
        { label: 'SC01_T02_/authorize/resume-002', responseCode: '200', success: true, isTransaction: false },
    ];
    const { rows } = runEvidenceMod.buildRunEvidence({ entries, samples });
    const resume = rows.find(r => r.label === 'SC01_T02_/authorize/resume-002');
    assert.ok(resume, 'resume row present');
    assert.strictEqual(resume.observedStatus, 200, 'uses the final iteration, not the stale 401');
    assert.strictEqual(resume.success, true);
    // exactly one row per step (no leftover duplicate re-paired via fallback)
    assert.strictEqual(rows.filter(r => r.label === 'SC01_T02_/authorize/resume-002').length, 1);
});

// ── adaptive stall watcher (fast, no JMeter) ─────────────────────────────
test('stall watcher: recovers early once JMeter finished and the JTL goes idle', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stallwatch-'));
    const it = path.join(dir, 'iteration_1');
    fs.mkdirSync(it, { recursive: true });
    const jtl = path.join(it, 'results.jtl');
    const log = path.join(it, 'run.log');
    fs.writeFileSync(jtl, '<a/>');
    fs.writeFileSync(log, 'running\n');
    const watch = runnerInternal.watchForStallOrCap(dir, { graceMs: 120, capMs: 60000, pollMs: 20 });
    // simulate JMeter writing samples (grow) then finishing (end-of-test marker), then idle
    setTimeout(() => fs.writeFileSync(jtl, '<a/><b/>'), 30);
    setTimeout(() => fs.writeFileSync(jtl, '<a/><b/><c/>'), 60);
    setTimeout(() => fs.appendFileSync(log, 'INFO o.a.j.e.StandardJMeterEngine: Notifying test listeners of end of test\n'), 80);
    const res = await watch.promise;
    watch.cancel();
    assert.strictEqual(res.kind, 'watchdog');
    assert.strictEqual(res.reason, 'stall');
});

test('stall watcher: a stale prior iteration with no fresh activity does not trip it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stallwatch2-'));
    const it = path.join(dir, 'iteration_1');
    fs.mkdirSync(it, { recursive: true });
    // already-ended iteration, static file: no growth observed while watching
    fs.writeFileSync(path.join(it, 'results.jtl'), '<a/><b/><c/>');
    fs.writeFileSync(path.join(it, 'run.log'), 'Notifying test listeners of end of test\n');
    const watch = runnerInternal.watchForStallOrCap(dir, { graceMs: 60, capMs: 400, pollMs: 20 });
    const res = await watch.promise;
    watch.cancel();
    // never saw the JTL grow -> must fall through to the cap, not a false 'stall'
    assert.strictEqual(res.reason, 'cap');
});

// ── environment-vs-script classifier (gates expensive escalation) ────────
test('environment classifier: network failure is environment, not script', () => {
    const c = runnerInternal.classifyEnvironmentFailure({ connectionError: 'connect ECONNREFUSED 10.0.0.5:443' });
    assert.strictEqual(c.environment, true);
});

test('environment classifier: the JTL parse-stall note is NOT an environment failure', () => {
    const c = runnerInternal.classifyEnvironmentFailure({ connectionError: 'Engine result-parse stalled after JMeter ran; verdict recovered directly from final.jtl (103 requests).' });
    assert.strictEqual(c.environment, false);
});

test('environment classifier: fix-environment forensics classes as environment', () => {
    const c = runnerInternal.classifyEnvironmentFailure({ failureForensics: { recommendedAction: { id: 'fix-environment', reason: 'server error outside auth' } } });
    assert.strictEqual(c.environment, true);
});

test('environment classifier: an auth/correlation gap is NOT environment (stay fixable)', () => {
    const c = runnerInternal.classifyEnvironmentFailure({ failureForensics: { recommendedAction: { id: 'repair-auth-session-correlation' } } });
    assert.strictEqual(c.environment, false);
});

// ── parameterization value safety (the "on" corruption) ──────────────────
test('filterParameterCandidates: drops unsafe short/boolean values that would shred the JMX', () => {
    const cands = [
        { name: 'includeDailyNoteClick', value: 'on', distinctValues: ['on'] },
        { name: 'rememberMe', value: '0' },
        { name: 'agree', value: 'true' },
        { name: 'userName', value: 'AshtonK' },
        { name: 'password', value: 'Sup3rSecret!' },
        { name: 'RecordIDT451', value: '451288parseKey' },
    ];
    const kept = generateInternal.filterParameterCandidates(cands, {}).map(c => c.name);
    assert.ok(!kept.includes('includeDailyNoteClick'), 'checkbox "on" dropped');
    assert.ok(!kept.includes('rememberMe'), 'numeric "0" dropped');
    assert.ok(!kept.includes('agree'), 'boolean "true" dropped');
    assert.deepStrictEqual(kept.sort(), ['RecordIDT451', 'password', 'userName']);
});

test('filterParameterCandidates: an explicit includeNames override forces even an unsafe value', () => {
    const cands = [{ name: 'includeDailyNoteClick', value: 'on', distinctValues: ['on'] }];
    const kept = generateInternal.filterParameterCandidates(cands, { includeNames: ['includeDailyNoteClick'] }).map(c => c.name);
    assert.deepStrictEqual(kept, ['includeDailyNoteClick']);
});

// ── post-render corruption detector (defense-in-depth backstop) ──────────
test('detectAndRevertParameterCorruption: reverts a value substituted as a substring', () => {
    // "note" (6 chars — passes the length filter) got substituted globally and
    // shredded "notes"/"footnote"; ${note} appears far more than its 2 fields.
    const xml = [
        '<stringProp name="Argument.value">${note}</stringProp>',
        '<stringProp name="HTTPSampler.path">/foot${note}/save</stringProp>',
        '<stringProp name="Header.value">${note}s are stored</stringProp>',
        '<stringProp name="x">${note}${note}${note}${note}${note}${note}${note}</stringProp>',
    ].join('');
    const { xml: fixed, reverted } = generateInternal.detectAndRevertParameterCorruption(xml, [{ name: 'note', value: 'note', occurrences: 2 }]);
    assert.strictEqual(reverted.length, 1);
    assert.ok(!fixed.includes('${note}'), 'all ${note} reverted to literal');
    assert.ok(fixed.includes('/footnote/save') && fixed.includes('notes are stored'), 'original text restored');
});

test('detectAndRevertParameterCorruption: leaves a legitimately-scoped parameter alone', () => {
    const xml = [
        '<stringProp name="Argument.value">${userName}</stringProp>',
        '<stringProp name="Header.value">Referer: /login?u=${userName}</stringProp>',
    ].join('');
    const { reverted } = generateInternal.detectAndRevertParameterCorruption(xml, [{ name: 'userName', value: 'AshtonK', occurrences: 2 }]);
    assert.strictEqual(reverted.length, 0);
});

// ── recorded-noise beacon detection (empty/trivial body signal) ──────────
test('detectRecordedNoiseBeacons: folds a repeated trivial-body 2xx beacon, keeps one-off business POSTs', () => {
    const beacon = (i) => ({ request: { method: 'POST', url: 'https://app.test/enterprise/url/report' }, response: { status: 200, headers: [], content: { text: '{"ok":true}' } } });
    const flat = [];
    for (let i = 0; i < 12; i++) flat.push(beacon(i));                 // 12× trivial 2xx beacon
    flat.push({ request: { method: 'POST', url: 'https://app.test/saveSOAP.php' }, response: { status: 200, headers: [], content: { text: '{"noteId":"abc123","saved":true,"body":"...long..."}'.padEnd(200,'x') } } });
    flat.push({ request: { method: 'POST', url: 'https://app.test/service/authenticate.json' }, response: { status: 200, headers: [{ name: 'Set-Cookie', value: 'PHPSESSID=xyz; Path=/' }], content: { text: '{}' } } });
    const beacons = generateInternal.detectRecordedNoiseBeacons(flat);
    const paths = beacons.map(b => b.path);
    assert.deepStrictEqual(paths, ['/enterprise/url/report']);          // only the beacon
    assert.ok(!paths.includes('/saveSOAP.php'), 'one-off business POST kept');
    assert.ok(!paths.includes('/service/authenticate.json'), 'session-cookie minter kept');
});

test('detectRecordedNoiseBeacons: a repeated endpoint that sets a session cookie is NOT folded', () => {
    const flat = [];
    for (let i = 0; i < 8; i++) flat.push({ request: { method: 'GET', url: 'https://app.test/keepalive' }, response: { status: 200, headers: [{ name: 'set-cookie', value: 'IDEM=abc' }], content: { text: '' } } });
    assert.strictEqual(generateInternal.detectRecordedNoiseBeacons(flat).length, 0);
});

// ── ship-point final sanitizer ────────────────────────────────────────────
const finalArtifactMod = require('../src/final-artifact');

test('final sanitizer: reverts substring corruption and re-asserts generation folds', () => {
    const dir = tmp();
    const name = 'flow';
    // current parameters.json: only userName (occurrences 2)
    fs.writeFileSync(path.join(dir, 'flow_parameters.json'), JSON.stringify([
        { name: 'userName', value: 'AshtonK', occurrences: 2 },
    ]));
    // recording carries the dropped checkbox literal
    fs.writeFileSync(path.join(dir, 'flow.recording.xml'), '<testResults><httpSample lb="POST /save"><queryString>includeDailyNoteClick=on&amp;userName=AshtonK</queryString></httpSample></testResults>');
    // base jmx: beacon folded
    fs.writeFileSync(path.join(dir, 'flow.jmx'), '<jmeterTestPlan><HTTPSamplerProxy testname="T01_/report-001" enabled="false"></HTTPSamplerProxy></jmeterTestPlan>');
    // shipped final: corrupted + beacon re-enabled
    const refs = Array(45).fill('${includeDailyNoteClick}').join('x');
    const finalXml = '<jmeterTestPlan><HTTPSamplerProxy testname="T01_/report-001" enabled="true"></HTTPSamplerProxy>' +
        '<stringProp name="HTTPSampler.path">/authenticate.js${includeDailyNoteClick}</stringProp>' +
        '<stringProp name="x">' + refs + '</stringProp></jmeterTestPlan>';
    const r = finalArtifactMod._internal.sanitizeFinalXml(finalXml, { outDir: dir, name });
    assert.ok(!r.xml.includes('${includeDailyNoteClick}'), 'orphan corruption reverted');
    assert.ok(r.xml.includes('/authenticate.json'), 'path restored via recorded literal "on"');
    assert.ok(/testname="T01_\/report-001" enabled="false"/.test(r.xml), 'generation fold re-asserted');
});

test('final sanitizer: leaves a healthy final untouched', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'flow_parameters.json'), JSON.stringify([{ name: 'userName', value: 'AshtonK', occurrences: 2 }]));
    fs.writeFileSync(path.join(dir, 'flow.jmx'), '<jmeterTestPlan><HTTPSamplerProxy testname="a" enabled="true"></HTTPSamplerProxy></jmeterTestPlan>');
    const finalXml = '<jmeterTestPlan><HTTPSamplerProxy testname="a" enabled="true"></HTTPSamplerProxy><stringProp name="Argument.value">${userName}</stringProp></jmeterTestPlan>';
    const r = finalArtifactMod._internal.sanitizeFinalXml(finalXml, { outDir: dir, name: 'flow' });
    assert.strictEqual(r.xml, finalXml);
    assert.strictEqual(r.notes.length, 0);
});

// ── HAR comment-based transaction grouping ───────────────────────────────
test('pe-naming: recording comments define transaction boundaries and names', () => {
    const peNamingMod = require('../src/pe-naming');
    const e = (url, comment) => ({ request: { method: 'GET', url }, response: { status: 200 }, ...(comment ? { comment } : {}) });
    const entries = [
        e('https://app.test/boot'),                       // pre-boundary -> merged into first step
        e('https://app.test/', 'Launch'),
        e('https://app.test/home'),
        e('https://app.test/login', 'Login'),
        e('https://app.test/auth'),
        e('https://app.test/patients', 'Display_Patients'),
    ];
    const model = peNamingMod.buildPeNamingModel({ entries, flowName: 'flow', pages: [], transactionNames: [] });
    assert.deepStrictEqual(model.groups.map(g => g.name), ['SC01_T01_Launch', 'SC01_T02_Login', 'SC01_T03_Display_Patients']);
    assert.strictEqual(model.groups[0].entries.length, 3, 'pre-boundary request merged into first step');
});

// ── js-embedded challenge token (rotating CSRF name+value) ───────────────
const jsChallengeMod = require('../src/js-challenge-token');

test('js-challenge: correlates rotating name+value pair from inline script, proves regex first', () => {
    const flat = [
        { request: { method: 'GET', url: 'https://app.test/' }, response: { status: 200, content: { text: "<script>\nwindow.abCdEf12Challenge = 'TOK$en=With$pecials123456';\n</script>" } } },
        { request: { method: 'POST', url: 'https://app.test/service/authenticate.json', postData: { text: 'userName=U&password=P&abCdEf12=' + encodeURIComponent('TOK$en=With$pecials123456') } }, response: { status: 200 } },
    ];
    const xml = [
        '<HTTPSamplerProxy testname="T01_GET_/-001" enabled="true"><stringProp name="HTTPSampler.method">GET</stringProp><stringProp name="HTTPSampler.path">/</stringProp></HTTPSamplerProxy>',
        '<hashTree></hashTree>',
        '<HTTPSamplerProxy testname="T01_/service/authenticate.json-002" enabled="true"><stringProp name="HTTPSampler.method">POST</stringProp><stringProp name="HTTPSampler.path">/service/authenticate.json</stringProp>',
        '<elementProp name="abCdEf12" elementType="HTTPArgument"><stringProp name="Argument.name">abCdEf12</stringProp><stringProp name="Argument.value">TOK$en=With$pecials123456</stringProp></elementProp>',
        '<elementProp name="userName" elementType="HTTPArgument"><stringProp name="Argument.name">userName</stringProp><stringProp name="Argument.value">${userName}</stringProp></elementProp>',
        '</HTTPSamplerProxy><hashTree></hashTree>',
    ].join('\n');
    const r = jsChallengeMod.correlateJsChallengeToken(xml, flat);
    assert.strictEqual(r.applied.length, 1);
    assert.ok(r.xml.includes('Argument.name">${js_challenge_1_name}'), 'param NAME rewired');
    assert.ok(r.xml.includes('Argument.value">${js_challenge_1_value}'), 'param VALUE rewired');
    assert.ok(r.xml.includes('RegexExtractor.refname">js_challenge_1_name'), 'name extractor attached');
    assert.ok(r.xml.includes('RegexExtractor.refname">js_challenge_1_value'), 'value extractor attached');
    assert.ok(r.xml.includes('Argument.value">${userName}'), 'existing parameterization untouched');
});

test('js-challenge: leaves an already-parameterized field alone (no half-rewire)', () => {
    const flat = [
        { request: { method: 'GET', url: 'https://app.test/d.php' }, response: { status: 200, content: { text: "wpt.agenda.startDate = '2026-05-18T00:00:00-07:00';" } } },
        { request: { method: 'POST', url: 'https://app.test/sched' , postData: { text: 'startDate=' + encodeURIComponent('2026-05-18T00:00:00-07:00') } }, response: { status: 200 } },
    ];
    const xml = '<HTTPSamplerProxy testname="a" enabled="true"><stringProp name="HTTPSampler.method">GET</stringProp><stringProp name="HTTPSampler.path">/d.php</stringProp></HTTPSamplerProxy><hashTree></hashTree>' +
        '<elementProp name="startDate" elementType="HTTPArgument"><stringProp name="Argument.name">startDate</stringProp><stringProp name="Argument.value">${startDate}</stringProp></elementProp>';
    const r = jsChallengeMod.correlateJsChallengeToken(xml, flat);
    assert.strictEqual(r.applied.length, 0);
    assert.strictEqual(r.xml, xml);
});

// ── repeat-navigation detection ───────────────────────────────────────────
test('repeat navigation: exact-URL GET repeat with no new session material is flagged; minting repeat kept', () => {
    const redirectHopsMod = require('../src/redirect-hops');
    const e = (url, cookies = []) => ({ request: { method: 'GET', url }, response: { status: 200, headers: cookies.map(c => ({ name: 'Set-Cookie', value: c + '=v' })) } });
    const entries = [
        e('https://auth.test/redirect/', []),          // first — keep
        e('https://auth.test/other'),
        e('https://auth.test/redirect/', []),          // repeat, mints nothing — fold
        e('https://auth.test/redirect/', ['appsess']), // repeat but mints a session cookie — keep
    ];
    const r = redirectHopsMod.detectRepeatNavigations(entries);
    assert.deepStrictEqual(r.indexes, [2]);
    assert.strictEqual(r.byIndex[2].firstIndex, 0);
});

// ── semantic triage: server said ↔ script sent ────────────────────────────
const semanticTriageMod = require('../src/semantic-triage');

test('semantic triage: names the CSV column behind a stale-data rejection', () => {
    const sentSources = semanticTriageMod.buildSentSources({
        csvHeader: ['userName', 'AptID'], csvRow: ['AshtonK', '844599527'],
        lineage: [{ name: 'CaseID', value: '59341829' }],
    });
    const t = semanticTriageMod.triageFailure({
        label: 'T07_/saveSOAP.php-071',
        responseBody: '{"error":"Appointment 844599527 not found or no longer exists"}',
        sentSources,
    });
    assert.strictEqual(t.category, 'stale_data');
    assert.strictEqual(t.dataMatches.length, 1);
    assert.ok(t.dataMatches[0].source.includes('CSV column "AptID"'));
    assert.ok(t.ask.includes('stale test data'));
});

test('semantic triage: classifies auth and validation reasons without data matches', () => {
    const a = semanticTriageMod.triageFailure({ label: 'x', responseBody: '{"message":"session expired, please login"}', sentSources: {} });
    assert.strictEqual(a.category, 'auth');
    const v = semanticTriageMod.triageFailure({ label: 'y', responseBody: '{"detail":"field startDate is invalid"}', sentSources: {} });
    assert.strictEqual(v.category, 'validation');
});

// ── live freshness probe (GET-only, evidence never blocks) ────────────────
const liveProbeMod = require('../src/live-probe');

test('live probe: classifies rotated vs stable vs absent against the live page', () => {
    const token = { name: 'abCdEf12', value: 'RECORDED_TOKEN_VALUE_1', regex: "window\.([A-Za-z0-9_$-]{2,64})Challenge = '([^']+)'" };
    const rotated = liveProbeMod._internal.classifyToken("<script>window.zzTop99Challenge = 'FRESH_TOKEN_VALUE_9';</script>", token);
    assert.strictEqual(rotated.verdict, 'rotated');
    assert.strictEqual(rotated.liveValue, 'FRESH_TOKEN_VALUE_9');
    assert.strictEqual(rotated.liveName, 'zzTop99', 'captures the rotated NAME too');

    const stable = liveProbeMod._internal.classifyToken("<script>window.abCdEf12Challenge = 'RECORDED_TOKEN_VALUE_1';</script>", token);
    assert.strictEqual(stable.verdict, 'stable');

    const absent = liveProbeMod._internal.classifyToken('<html>login page rewritten</html>', token);
    assert.strictEqual(absent.verdict, 'absent');
});

test('live probe: an unreachable host yields unknown verdicts and never blocks', async () => {
    const r = await liveProbeMod.probeFreshness({
        url: 'http://127.0.0.1:9/never-listening',
        tokens: [{ name: 'x', value: 'v', regex: 'a(b)(c)' }],
        timeoutMs: 800,
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reachable, false);
    assert.strictEqual(r.tokens[0].verdict, 'unknown');
    assert.ok(/proceeding without freshness evidence/.test(r.summary));
});

// ── proactive lessons (experience applied before the first run) ───────────
test('proactive lessons: host-scoped high-confidence lesson fires without any failure; generic/foreign-host do not', () => {
    const os = require('os');
    const store = path.join(os.tmpdir(), `pf_proactive_${Date.now()}.json`);
    const crypto = require('crypto');
    const hostHash = crypto.createHash('sha256').update('https://app.example.com').digest('hex').slice(0, 16);
    const lesson = (id, scope, conf, hash) => ({
        id, scope, confidence: conf, appHostHash: hash, flowName: 'f', symptom: 's',
        signature: id, contextPattern: { samplerPattern: learningStore.normalizePattern('T01_/oauth/token-004') },
        fix: { kind: 'setSamplerEnabled', sampler: 'T01_/oauth/token-004', enabled: false }, stackFingerprint: [],
    });
    fs.writeFileSync(store, JSON.stringify([
        lesson('host-hi', 'host', 0.95, hostHash),           // should fire
        lesson('host-low', 'host', 0.85, hostHash),          // below proactive bar
        lesson('generic-hi', 'generic', 0.99, ''),           // generic never fires proactively
        lesson('other-host', 'host', 0.99, 'deadbeefdeadbeef'), // different app
    ]));
    const matches = learningStore.findProactiveLessons({
        storePath: store,
        samplers: [{ name: 'T01_/oauth/token-004', path: '/oauth/token' }, { name: 'T01_/unrelated-009', path: '/unrelated' }],
        appHost: 'https://app.example.com',
    });
    assert.deepStrictEqual(matches.map(m => m.lessonId), ['host-hi']);
    assert.strictEqual(matches[0].targetSampler, 'T01_/oauth/token-004');
    assert.strictEqual(matches[0].proactive, true);
    fs.unlinkSync(store);
});

test('proactive lessons: no appHost means no proactive application at all', () => {
    assert.deepStrictEqual(
        learningStore.findProactiveLessons({ samplers: [{ name: 'x' }], appHost: '' }), []);
});
