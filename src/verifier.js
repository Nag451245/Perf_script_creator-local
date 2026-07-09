'use strict';
/**
 * verifier.js — baseline-vs-test diff + JMeter HTML dashboard generation.
 *
 * "GREEN" today means "JMeter returned 200s." That's the classic false-green:
 * a backend can return 200 with a totally different body shape (login page
 * instead of dashboard, empty list instead of populated data, error
 * masquerading as success). This module compares the RUN's per-sampler
 * outcome to the RECORDING's per-sampler outcome and surfaces drift the
 * status-code-only verdict misses:
 *
 *   - statusDiff      : response code changed
 *   - lengthDiffPct   : response body length drifted > thresholdPct
 *   - shapeDiff       : JSON shape changed (top-level key set differs)
 *
 * Ponytail: reuses engine's jtl-parser. The dashboard generator just spawns
 * `jmeter -g <jtl> -o <dir>` and waits — no fancy progress UI.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { jtlParser } = require('./engine');

const DEFAULT_LENGTH_DRIFT_PCT = 30; // > +/- 30% body-length change worth flagging

function killProcessTree(pid) {
    if (!pid) return;
    if (process.platform === 'win32') {
        try {
            spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            return;
        } catch { /* fall through */ }
    }
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
}

function safeJsonShape(text) {
    if (!text || typeof text !== 'string') return null;
    let parsed;
    try { parsed = JSON.parse(text); } catch { return null; }
    if (parsed == null || typeof parsed !== 'object') return null;
    if (Array.isArray(parsed)) {
        return parsed.length === 0 ? '[]' : `[object?keys=${Object.keys(parsed[0] || {}).sort().join(',')}]`;
    }
    return Object.keys(parsed).sort().join(',');
}

function findLastJtl(outDir) {
    if (!fs.existsSync(outDir)) return null;
    const dirs = fs.readdirSync(outDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && /^iteration_\d+$/.test(d.name))
        .sort((a, b) => Number(b.name.split('_')[1]) - Number(a.name.split('_')[1]));
    for (const d of dirs) {
        const p = path.join(outDir, d.name, 'results.jtl');
        if (fs.existsSync(p)) return p;
    }
    return null;
}

/**
 * @param {Object} args
 * @param {string} args.outDir       feedback-loop output directory
 * @param {Array}  args.flatEntries  the canonical recording (post-filter)
 * @param {number} [args.thresholdPct=30]
 * @returns {{ jtlPath:string|null, samplesCompared:number, drift:Array }}
 */
function diffRunAgainstRecording({ outDir, flatEntries, thresholdPct = DEFAULT_LENGTH_DRIFT_PCT }) {
    const statusAnalysis = require('./status-analysis');
    const jtlPath = findLastJtl(outDir);
    if (!jtlPath) return { jtlPath: null, samplesCompared: 0, drift: [] };

    const xml = fs.readFileSync(jtlPath, 'utf8');
    const fastSamples = summarizeJtlFast(jtlPath).filter(s => !s.isTransaction);
    let parsedEntries = [];
    try {
        const jtl = jtlParser.parseJtlBuffer(Buffer.from(xml));
        parsedEntries = jtl.entries || [];
    } catch { /* fast status comparison still works on malformed saved bodies */ }

    // Pair JTL samples to recording entries in document order, only using
    // entries the engine kept (filtered) -- those are the ones JMeter ran.
    const drift = [];
    const folded = [];
    const recBy = (flatEntries || []).map(e => ({
        url: e.request?.url || '',
        method: (e.request?.method || 'GET').toUpperCase(),
        status: Number(e.response?.status || 0),
        bodyLen: Number(e.response?.content?.size || (e.response?.content?.text || '').length || 0),
        shape: safeJsonShape(e.response?.content?.text || ''),
    }));
    const pairs = alignRecordingSamples(flatEntries || [], fastSamples);
    for (const pair of pairs) {
        const i = pair.entryIndex;
        const r = recBy[i];
        if (!r) continue;
        const parsed = parsedEntries[pair.sampleIndex] || {};
        const jStatus = Number(pair.sample.responseCode || pair.sample.code || pair.sample.status || parsed.response?.status || 0);
        const jBodyLen = Number(parsed.response?.content?.size || (parsed.response?.content?.text || '').length || 0);
        const jShape = safeJsonShape(parsed.response?.content?.text || '');
        const issues = [];
        // Recorded 3xx that replays 2xx is not drift: the recording stored the
        // RAW redirect hop while JMeter (follow_redirects) reports the
        // post-redirect landing. Comparing the redirect stub's body length or
        // JSON shape against the landing page is equally meaningless — report
        // the sampler as folded and move on.
        if (r.status >= 300 && r.status < 400 && jStatus >= 200 && jStatus < 300) {
            folded.push({ index: i, sampler: `${r.method} ${r.url}`, recorded: r.status, observed: jStatus });
            continue;
        }
        if (r.status && jStatus && r.status !== jStatus) {
            const status = statusAnalysis.classifyStatusTransition(r.status, jStatus);
            issues.push({
                kind: 'statusDiff',
                recorded: r.status,
                observed: jStatus,
                category: status.category,
                relevance: status.relevance,
                repairHint: status.repairHint,
            });
        }
        if (r.bodyLen > 0 && jBodyLen > 0) {
            const pct = Math.abs(jBodyLen - r.bodyLen) / r.bodyLen * 100;
            if (pct > thresholdPct) issues.push({ kind: 'lengthDriftPct', pct: Math.round(pct), recorded: r.bodyLen, observed: jBodyLen });
        }
        if (r.shape && jShape && r.shape !== jShape) issues.push({ kind: 'shapeDiff', recorded: r.shape, observed: jShape });
        if (issues.length) drift.push({ index: i, sampler: `${r.method} ${r.url}`, issues });
    }
    const rootCause = statusAnalysis.traceStatusRootCause({
        entries: flatEntries,
        samples: fastSamples,
    });
    return { jtlPath, samplesCompared: pairs.length, drift, folded, rootCause };
}

function alignRecordingSamples(entries, samples) {
    const pairs = [];
    const usedSampleIndexes = new Set();
    const usedEntryIndexes = new Set();

    for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
        const sample = samples[sampleIndex] || {};
        const stepNumber = stepNumberFromLabel(sample.label || sample.name);
        if (!stepNumber) continue;
        const entryIndex = stepNumber - 1;
        if (entryIndex < 0 || entryIndex >= entries.length || usedEntryIndexes.has(entryIndex)) continue;
        pairs.push({ entryIndex, sampleIndex, sample });
        usedEntryIndexes.add(entryIndex);
        usedSampleIndexes.add(sampleIndex);
    }

    let fallbackEntryIndex = 0;
    for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
        if (usedSampleIndexes.has(sampleIndex)) continue;
        while (fallbackEntryIndex < entries.length && usedEntryIndexes.has(fallbackEntryIndex)) fallbackEntryIndex++;
        if (fallbackEntryIndex >= entries.length) break;
        pairs.push({ entryIndex: fallbackEntryIndex, sampleIndex, sample: samples[sampleIndex] || {} });
        usedEntryIndexes.add(fallbackEntryIndex);
        fallbackEntryIndex++;
    }

    return pairs.sort((a, b) => a.entryIndex - b.entryIndex || a.sampleIndex - b.sampleIndex);
}

function stepNumberFromLabel(label) {
    const match = /^Step\s+0*(\d+)\b/i.exec(String(label || '').trim());
    return match ? Number(match[1]) : 0;
}

/**
 * Generate JMeter's standard HTML dashboard. `jmeter -g <jtl> -o <dir>`.
 * Best-effort: if the dashboard generator fails (often because JMeter found
 * non-CSV JTL or missing plugins), we log and skip without breaking the run.
 *
 * @returns {Promise<{ ok:boolean, dir?:string, error?:string }>}
 */
function generateHtmlDashboard({ jmeterBinPath, jtlPath, outDir, onLog = () => {}, timeoutMs = 60_000 }) {
    return new Promise(resolve => {
        if (!jmeterBinPath || !jtlPath || !fs.existsSync(jtlPath)) {
            return resolve({ ok: false, error: 'missing jmeter binary or JTL' });
        }
        const dashDir = path.join(outDir, 'dashboard');
        try { fs.rmSync(dashDir, { recursive: true, force: true }); } catch { /* ignore */ }
        // On Windows, jmeterBinPath is a .bat — spawn() without a shell throws
        // EINVAL. Use a shell there and quote args (paths may contain spaces).
        const useShell = process.platform === 'win32';
        const q = (s) => (useShell ? `"${s}"` : s);
        const cmd = useShell ? q(jmeterBinPath) : jmeterBinPath;
        const args = ['-g', q(jtlPath), '-o', q(dashDir)];
        const child = spawn(cmd, args, { windowsHide: true, shell: useShell });
        let stderr = '';
        let done = false;
        const finish = (result) => { if (done) return; done = true; clearTimeout(timer); resolve(result); };
        // HARD timeout: jmeter -g can hang on malformed or huge JTLs, or when
        // the bundled report templates miss a value. Without this the parent
        // node process sits forever (we hit this exact bug — the whole --run
        // looked "stuck" after a clean iteration finished).
        const timer = setTimeout(() => {
            killProcessTree(child.pid);
            onLog(`dashboard timed out after ${timeoutMs}ms; killed`);
            finish({ ok: false, error: `jmeter -g timed out after ${timeoutMs}ms` });
        }, timeoutMs);
        child.stderr.on('data', d => { stderr += String(d); });
        child.on('error', err => finish({ ok: false, error: err.message }));
        child.on('exit', code => {
            if (code === 0 && fs.existsSync(path.join(dashDir, 'index.html'))) {
                onLog(`dashboard ready: dashboard/index.html`);
                finish({ ok: true, dir: dashDir });
            } else {
                finish({ ok: false, error: `jmeter -g exit ${code}: ${stderr.split('\n').slice(-3).join(' ')}` });
            }
        });
    });
}

/**
 * Body-agnostic JTL summary. The engine's SAX parseJtl can STALL on a JTL that
 * embeds malformed response bodies (raw HTML in saved 401 pages breaks strict
 * XML SAX, and its resume() recovery deadlocks the stream). This reads only the
 * sample OPEN-TAG attributes (lb/rc/s) with a regex, so response-body content is
 * irrelevant — fast and unbreakable. Sub-sample (redirect) hops `<label>-N` are
 * folded into their parent, matching the engine's summarizeSamples shape.
 *
 * @returns {Array<{label,code,success,isTransaction,responseMessage?,failureMessage?}>}
 */
function summarizeJtlFast(jtlPath) {
    if (!jtlPath || !fs.existsSync(jtlPath)) return [];
    const xml = fs.readFileSync(jtlPath, 'utf8');
    const re = /<(httpSample|sample)\b([^>]*)>/g;
    const raw = [];
    const labels = new Set();
    let m;
    while ((m = re.exec(xml)) !== null) {
        const tag = m[1];
        const a = m[2];
        const lb = unescapeXml((a.match(/\blb="([^"]*)"/) || [])[1] || '');
        if (!lb) continue;
        const rc = unescapeXml((a.match(/\brc="([^"]*)"/) || [])[1] || '');
        const rm = unescapeXml((a.match(/\brm="([^"]*)"/) || [])[1] || '');
        const s = /\bs="true"/.test(a);
        const body = extractTagBody(xml, re.lastIndex, tag);
        const failureMessage = firstAssertionFailure(body);
        raw.push({ tag, lb, rc, rm, s, failureMessage });
        labels.add(lb);
    }
    const out = [];
    for (const r of raw) {
        const sub = /^(.+)-\d+$/.exec(r.lb);
        if (sub && labels.has(sub[1])) continue; // fold redirect hops
        out.push({
            label: r.lb,
            code: r.rc,
            responseCode: r.rc,
            success: r.s,
            isTransaction: r.tag === 'sample',
            responseMessage: r.failureMessage ? `JMeter assertion failed: ${r.failureMessage}` : r.rm,
            failureMessage: r.failureMessage,
        });
    }
    return out;
}

function extractTagBody(xml, offset, tag) {
    const token = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g');
    token.lastIndex = offset;
    let depth = 1;
    let match;
    while ((match = token.exec(xml)) !== null) {
        if (match[1]) {
            depth--;
            if (depth === 0) return xml.slice(offset, match.index);
        } else if (!/\/>$/.test(match[0])) {
            depth++;
        }
    }
    return '';
}

function firstAssertionFailure(body) {
    const assertionRe = /<assertionResult\b[^>]*>([\s\S]*?)<\/assertionResult>/g;
    let match;
    while ((match = assertionRe.exec(body || '')) !== null) {
        const block = match[1] || '';
        if (!/<(?:failure|error)>\s*true\s*<\/(?:failure|error)>/i.test(block)) continue;
        const message = (block.match(/<failureMessage>([\s\S]*?)<\/failureMessage>/i) || [])[1] || '';
        return unescapeXml(message.trim());
    }
    return '';
}

function unescapeXml(value) {
    return String(value || '')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

module.exports = { diffRunAgainstRecording, generateHtmlDashboard, findLastJtl, summarizeJtlFast, _internal: { safeJsonShape, killProcessTree } };
