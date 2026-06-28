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
