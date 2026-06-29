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
    const jtlPath = findLastJtl(outDir);
    if (!jtlPath) return { jtlPath: null, samplesCompared: 0, drift: [] };

    let jtl;
    try { jtl = jtlParser.parseJtlBuffer(fs.readFileSync(jtlPath)); }
    catch { return { jtlPath, samplesCompared: 0, drift: [{ reason: 'jtl-parse-failed' }] }; }

    // Pair JTL samples to recording entries in document order, only using
    // entries the engine kept (filtered) -- those are the ones JMeter ran.
    const drift = [];
    const recBy = (flatEntries || []).map(e => ({
        url: e.request?.url || '',
        method: (e.request?.method || 'GET').toUpperCase(),
        status: Number(e.response?.status || 0),
        bodyLen: Number(e.response?.content?.size || (e.response?.content?.text || '').length || 0),
        shape: safeJsonShape(e.response?.content?.text || ''),
    }));
    const jtlEntries = jtl.entries || [];
    const compareLen = Math.min(recBy.length, jtlEntries.length);
    for (let i = 0; i < compareLen; i++) {
        const r = recBy[i];
        const j = jtlEntries[i];
        const jStatus = Number(j.response?.status || 0);
        const jBodyLen = Number(j.response?.content?.size || (j.response?.content?.text || '').length || 0);
        const jShape = safeJsonShape(j.response?.content?.text || '');
        const issues = [];
        if (r.status && jStatus && r.status !== jStatus) issues.push({ kind: 'statusDiff', recorded: r.status, observed: jStatus });
        if (r.bodyLen > 0 && jBodyLen > 0) {
            const pct = Math.abs(jBodyLen - r.bodyLen) / r.bodyLen * 100;
            if (pct > thresholdPct) issues.push({ kind: 'lengthDriftPct', pct: Math.round(pct), recorded: r.bodyLen, observed: jBodyLen });
        }
        if (r.shape && jShape && r.shape !== jShape) issues.push({ kind: 'shapeDiff', recorded: r.shape, observed: jShape });
        if (issues.length) drift.push({ index: i, sampler: `${r.method} ${r.url}`, issues });
    }
    return { jtlPath, samplesCompared: compareLen, drift };
}

/**
 * Generate JMeter's standard HTML dashboard. `jmeter -g <jtl> -o <dir>`.
 * Best-effort: if the dashboard generator fails (often because JMeter found
 * non-CSV JTL or missing plugins), we log and skip without breaking the run.
 *
 * @returns {Promise<{ ok:boolean, dir?:string, error?:string }>}
 */
function generateHtmlDashboard({ jmeterBinPath, jtlPath, outDir, onLog = () => {} }) {
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
        child.stderr.on('data', d => { stderr += String(d); });
        child.on('error', err => resolve({ ok: false, error: err.message }));
        child.on('exit', code => {
            if (code === 0 && fs.existsSync(path.join(dashDir, 'index.html'))) {
                onLog(`dashboard ready: dashboard/index.html`);
                resolve({ ok: true, dir: dashDir });
            } else {
                resolve({ ok: false, error: `jmeter -g exit ${code}: ${stderr.split('\n').slice(-3).join(' ')}` });
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
 * @returns {Array<{label,code,success,isTransaction}>}
 */
function summarizeJtlFast(jtlPath) {
    if (!jtlPath || !fs.existsSync(jtlPath)) return [];
    const xml = fs.readFileSync(jtlPath, 'utf8');
    const re = /<(?:httpSample|sample)\b([^>]*)>/g;
    const raw = [];
    const labels = new Set();
    let m;
    while ((m = re.exec(xml)) !== null) {
        const a = m[1];
        const lb = (a.match(/\blb="([^"]*)"/) || [])[1] || '';
        if (!lb) continue;
        const rc = (a.match(/\brc="([^"]*)"/) || [])[1] || '';
        const s = /\bs="true"/.test(a);
        raw.push({ lb, rc, s });
        labels.add(lb);
    }
    const out = [];
    for (const r of raw) {
        const sub = /^(.+)-\d+$/.exec(r.lb);
        if (sub && labels.has(sub[1])) continue; // fold redirect hops
        out.push({ label: r.lb, code: r.rc, success: r.s, isTransaction: !r.lb.includes('/') });
    }
    return out;
}

module.exports = { diffRunAgainstRecording, generateHtmlDashboard, findLastJtl, summarizeJtlFast, _internal: { safeJsonShape } };
