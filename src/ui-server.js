'use strict';
/**
 * Local, dependency-free web UI over index.js. The UI server owns only
 * orchestration: input inventory, config edits, child process control, and
 * output links. Script generation and validation remain in index.js.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { flagsForRunRequest } = require('./ui-run-mode');
const { buildInputModel } = require('./ui-inputs');
const steering = require('./steering');
const { cancelChildProcess } = require('./ui-process-control');
const uiConfig = require('./ui-config');
const { PAGE } = require('./ui-page');

const ROOT = path.join(__dirname, '..');
const INPUT = path.join(ROOT, 'input');
const OUTPUT = path.join(ROOT, 'output');
const CONFIG_PATH = path.join(ROOT, 'perfscript.config.json');
const START_PORT = Number(process.env.PERFSCRIPT_UI_PORT) || 7070;
// Bind to loopback by default: this UI can spawn processes and read/write the
// input/output folders, so it must not be reachable from the LAN unless the
// operator deliberately opts in via PERFSCRIPT_UI_HOST=0.0.0.0.
const HOST = process.env.PERFSCRIPT_UI_HOST || '127.0.0.1';
const MAX_UPLOAD_BYTES = Number(process.env.PERFSCRIPT_UI_MAX_UPLOAD_BYTES) || 256 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
// Input-ingestion allowlist: recordings and test data only. An allowlist is
// safer than a blocklist for a local server that later executes these inputs.
const ALLOWED_UPLOAD_EXT_RE = /\.(har|jmx|xml|jtl|json|csv|txt|zip|saz|postman_collection)$/i;

fs.mkdirSync(INPUT, { recursive: true });
fs.mkdirSync(OUTPUT, { recursive: true });

const runs = new Map();
let runSeq = 0;
let activeChild = null;
let activeRunId = null;
let lastRun = null;

const THIRD_PARTY = /dynatrace|pendo|gvt2|beacons|googleapis|gstatic|safebrowsing|launchdarkly|newrelic|nr-data|ruxit|gravatar|\/bf\?|\/rb_|domainreliability|ohttp_gateway/i;

function readConfigForUi() {
    return uiConfig.readConfigForUiPath(CONFIG_PATH);
}

function writeConfigFromUi(body) {
    return uiConfig.writeConfigFromUiPath(CONFIG_PATH, body);
}

function listOutputs() {
    if (!fs.existsSync(OUTPUT)) return [];
    return fs.readdirSync(OUTPUT, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => outputSummary(d.name))
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime);
}

function outputSummary(name) {
    const dir = path.join(OUTPUT, name);
    const files = fs.readdirSync(dir);
    const report = files.find(f => /_report\.html$/i.test(f));
    const jmx = files.find(f => /^00_USE_THIS_.*\.jmx$/i.test(f))
        || files.find(f => /\.jmx$/i.test(f) && !/recording/i.test(f))
        || files.find(f => /\.jmx$/i.test(f));
    const summary = {
        name,
        report,
        jmx,
        verdict: '',
        kind: 'generated',
        mtime: fs.statSync(dir).mtimeMs,
    };
    const reportJson = files.find(f => /_report\.json$/i.test(f));
    if (!reportJson) return summary;
    try {
        const json = JSON.parse(fs.readFileSync(path.join(dir, reportJson), 'utf8'));
        if (Array.isArray(json.samples)) {
            const reqs = json.samples.filter(s => !s.isTransaction);
            const app = reqs.filter(s => !THIRD_PARTY.test(s.url || s.label || ''));
            summary.kind = 'validated';
            summary.total = app.length;
            summary.passed = app.filter(s => s.success === true).length;
            summary.failed = app.filter(s => s.success === false).length;
            summary.verdict = json.success === true ? 'GREEN' : 'needs attention';
            summary.failedTop = app.filter(s => s.success === false).slice(0, 12)
                .map(s => ({ label: (s.label || s.name || '').slice(0, 64), code: s.responseCode || '' }));
        } else {
            summary.verdict = 'generated';
            summary.samplers = json.samplers;
            summary.correlations = json.correlations;
            summary.bodyCorrelations = json.bodyCorrelations;
            summary.parameterized = json.parameterized;
        }
    } catch {
        summary.verdict = summary.verdict || 'generated';
    }
    return summary;
}

function buildState() {
    const input = buildInputModel(INPUT);
    const activeRun = activeRunId ? runs.get(activeRunId) : null;
    return {
        input,
        inputUnits: input.units,
        inputFiles: input.files,
        inputIssues: input.issues,
        // Backwards-compatible alias for the older page.
        inputs: input.files,
        outputs: listOutputs(),
        busy: !!activeChild,
        activeRun: activeRun ? summarizeRun(activeRun) : null,
        lastRun: lastRun ? summarizeRun(lastRun) : null,
    };
}

function summarizeRun(run) {
    return {
        id: run.id,
        mode: run.mode,
        selectedInputs: run.selectedInputs,
        force: run.force,
        flags: run.flags,
        done: run.done,
        code: run.code,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        cancelRequested: !!run.cancelRequested,
    };
}

function normalizeRunRequest(url, body = {}) {
    return {
        mode: body.mode || url.searchParams.get('mode') || 'generate',
        selectedInputs: normalizeStringList(body.selectedInputs || body.inputs),
        force: !!body.force,
        iterations: body.iterations,
        retryFailed: body.retryFailed,
        aiAssist: body.aiAssist || 'off',
        geminiPro: !!body.geminiPro,
        pair: !!body.pair,
    };
}

function normalizeStringList(values) {
    return Array.isArray(values)
        ? values.map(v => String(v || '').trim()).filter(Boolean)
        : [];
}

function startRun(request) {
    if (activeChild) return { error: 'A run is already in progress.' };
    const id = ++runSeq;
    const flags = flagsForRunRequest(request);
    const rec = {
        id,
        mode: request.mode || 'generate',
        selectedInputs: request.selectedInputs || [],
        force: !!request.force,
        flags,
        lines: [],
        done: false,
        code: null,
        startedAt: Date.now(),
        finishedAt: null,
    };
    runs.set(id, rec);
    activeRunId = id;
    // Per-run steering file: the chat panel appends operator messages here;
    // the agent child polls it at every decision checkpoint.
    rec.steeringFile = steering.steeringFileFor(ROOT, `ui-${id}-${Date.now()}`);
    const child = spawn(process.execPath, [path.join(ROOT, 'index.js'), ...flags], {
        cwd: ROOT,
        env: { ...process.env, PERFSCRIPT_STEERING: rec.steeringFile },
    });
    activeChild = child;
    const onData = (buf) => {
        String(buf).split(/\r?\n/).forEach(line => {
            if (line !== '') rec.lines.push(line);
        });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
        rec.done = true;
        rec.code = code;
        rec.finishedAt = Date.now();
        lastRun = rec;
        activeChild = null;
        activeRunId = null;
    });
    child.on('error', (e) => {
        rec.lines.push(`spawn error: ${e.message}`);
        rec.done = true;
        rec.code = -1;
        rec.finishedAt = Date.now();
        lastRun = rec;
        activeChild = null;
        activeRunId = null;
    });
    return { id, flags };
}

function rerun(body = {}) {
    const source = lastRun || {};
    const request = {
        mode: body.mode || source.mode || 'agent',
        selectedInputs: normalizeStringList(body.selectedInputs || source.selectedInputs),
        force: body.force !== false,
        iterations: body.iterations,
        retryFailed: body.retryFailed,
        geminiPro: !!body.geminiPro,
    };
    return startRun(request);
}

function send(res, code, body, headers = {}) {
    res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, headers));
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function serveOutputFile(res, rel) {
    const full = path.normalize(path.join(OUTPUT, rel));
    // Boundary-aware containment check: `output` must not also match a sibling
    // like `output-evil`, so require an exact match or a real path separator.
    if (full !== OUTPUT && !full.startsWith(OUTPUT + path.sep)) return send(res, 403, { error: 'forbidden' });
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return send(res, 404, { error: 'not found' });
    const ext = path.extname(full).toLowerCase();
    const type = ext === '.html' ? 'text/html'
        : ext === '.jmx' || ext === '.xml' ? 'application/xml'
            : ext === '.json' ? 'application/json'
                : 'text/plain';
    const disp = ext === '.jmx' ? { 'Content-Disposition': `attachment; filename="${path.basename(full)}"` } : {};
    res.writeHead(200, Object.assign({ 'Content-Type': `${type}; charset=utf-8` }, disp));
    fs.createReadStream(full).pipe(res);
}

function readBody(req, maxBytes = MAX_UPLOAD_BYTES) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', c => {
            size += c.length;
            if (size > maxBytes) {
                const err = new Error('payload too large');
                err.httpStatus = 413;
                req.destroy();
                reject(err);
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

async function readJsonBody(req) {
    const body = await readBody(req, MAX_JSON_BYTES);
    if (!body.length) return {};
    return JSON.parse(body.toString() || '{}');
}

function safeUploadName(name) {
    const base = path.basename(name || '');
    // Reject path components, and require a known input extension (allowlist).
    if (!base || base === '.' || base === '..' || base.includes('/') || base.includes('\\')) return '';
    if (!ALLOWED_UPLOAD_EXT_RE.test(base)) return '';
    return base;
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
        if (p === '/' && req.method === 'GET') return send(res, 200, PAGE, { 'Content-Type': 'text/html; charset=utf-8' });
        if (p === '/api/state' && req.method === 'GET') return send(res, 200, buildState());
        if (p === '/api/config' && req.method === 'GET') return send(res, 200, readConfigForUi());
        if (p === '/api/config' && req.method === 'POST') return send(res, 200, writeConfigFromUi(await readJsonBody(req)));
        if (p === '/api/run' && req.method === 'POST') {
            const result = startRun(normalizeRunRequest(url, await readJsonBody(req)));
            return send(res, result.error ? 409 : 200, result);
        }
        if (p === '/api/rerun' && req.method === 'POST') {
            const result = rerun(await readJsonBody(req));
            return send(res, result.error ? 409 : 200, result);
        }
        if (p === '/api/cancel' && req.method === 'POST') {
            const rec = activeRunId ? runs.get(activeRunId) : null;
            if (rec) {
                rec.cancelRequested = true;
                rec.lines.push('Cancellation requested from UI.');
            }
            return send(res, 200, cancelChildProcess(activeChild));
        }
        if (p === '/api/log' && req.method === 'GET') {
            const id = Number(url.searchParams.get('id'));
            const since = Number(url.searchParams.get('since')) || 0;
            const rec = runs.get(id);
            if (!rec) return send(res, 404, { error: 'no such run' });
            return send(res, 200, {
                lines: rec.lines.slice(since),
                total: rec.lines.length,
                done: rec.done,
                code: rec.code,
                run: summarizeRun(rec),
            });
        }
        if (p === '/api/steer' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const text = String(body.text || '').trim().slice(0, 2000);
            const rec = activeRunId ? runs.get(activeRunId) : null;
            if (!rec || rec.done) return send(res, 409, { error: 'No active run to steer.' });
            if (!text) return send(res, 400, { error: 'Empty message.' });
            steering.appendMessage(rec.steeringFile, { text });
            rec.lines.push(`[chat] you: ${text}`);
            return send(res, 200, { ok: true });
        }
        if (p === '/api/upload' && req.method === 'POST') {
            const name = safeUploadName(url.searchParams.get('name'));
            if (!name) return send(res, 400, { error: 'unsupported or unsafe file type' });
            const body = await readBody(req);
            fs.writeFileSync(path.join(INPUT, name), body);
            return send(res, 200, { ok: true, name, size: body.length });
        }
        if (p === '/api/input' && req.method === 'DELETE') {
            const name = path.basename(url.searchParams.get('name') || '');
            const file = path.join(INPUT, name);
            if (fs.existsSync(file)) fs.unlinkSync(file);
            return send(res, 200, { ok: true });
        }
        if (p.startsWith('/out/') && req.method === 'GET') return serveOutputFile(res, decodeURIComponent(p.slice('/out/'.length)));
        if (p === '/file' && req.method === 'GET') return serveOutputFile(res, url.searchParams.get('path') || '');
        return send(res, 404, { error: 'not found' });
    } catch (e) {
        return send(res, e.httpStatus || 500, { error: e.message });
    }
});

function listenWithFallback(port, attemptsLeft) {
    server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && attemptsLeft > 0) {
            process.stdout.write(`port ${port} in use, trying ${port + 1}\n`);
            listenWithFallback(port + 1, attemptsLeft - 1);
            return;
        }
        process.stderr.write(`UI server failed to start: ${e.message}\n`);
        process.exit(1);
    });
    server.listen(port, HOST, () => {
        process.stdout.write(`\nPerfScript Agent Launcher running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${port}\ninput: ${INPUT}\nbind: ${HOST}${HOST === '127.0.0.1' ? ' (loopback only — set PERFSCRIPT_UI_HOST=0.0.0.0 to expose)' : ''}\nClose this window to stop the UI.\n`);
    });
}

listenWithFallback(START_PORT, 10);
