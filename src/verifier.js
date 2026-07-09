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
const runEvidence = require('./run-evidence');
const statusAnalysis = require('./status-analysis');

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
 * @param {string} [args.jtlPath]     exact JTL for this validation attempt
 * @param {number} [args.thresholdPct=30]
 * @returns {{ jtlPath:string|null, samplesCompared:number, drift:Array }}
 */
function diffRunAgainstRecording({ outDir, flatEntries, jtlPath: explicitJtlPath = null, thresholdPct = DEFAULT_LENGTH_DRIFT_PCT }) {
    const jtlPath = explicitJtlPath && fs.existsSync(explicitJtlPath) ? explicitJtlPath : findLastJtl(outDir);
    if (!jtlPath) return { jtlPath: null, samplesCompared: 0, drift: [] };

    const evidence = runEvidence.buildRunEvidence({ entries: flatEntries || [], jtlPath });
    const rows = evidence.rows.filter(r => !r.isTransaction);
    const drift = [];
    const folded = [];
    for (const row of rows) {
        const i = row.entryIndex;
        const recordedStatus = Number(row.recordedStatus || 0);
        const observedStatus = Number(row.observedStatus || 0);
        const recordedBodyLen = Number(row.recordedBodyLength || 0);
        const observedBodyLen = Number(row.observedBodyLength || 0);
        const recordedShape = safeJsonShape(row.recordedBody || '');
        const observedShape = safeJsonShape(row.observedBody || '');
        const issues = [];
        // Recorded 3xx that replays 2xx is not drift: the recording stored the
        // RAW redirect hop while JMeter (follow_redirects) reports the
        // post-redirect landing. Comparing the redirect stub's body length or
        // JSON shape against the landing page is equally meaningless — report
        // the sampler as folded and move on.
        if (recordedStatus >= 300 && recordedStatus < 400 && observedStatus >= 200 && observedStatus < 300) {
            folded.push({ index: i, sampler: `${row.method} ${row.recordedUrl}`, recorded: recordedStatus, observed: observedStatus });
            continue;
        }
        if (recordedStatus && observedStatus && recordedStatus !== observedStatus) {
            const status = statusAnalysis.classifyStatusTransition(recordedStatus, observedStatus);
            issues.push({
                kind: 'statusDiff',
                recorded: recordedStatus,
                observed: observedStatus,
                category: status.category,
                relevance: status.relevance,
                repairHint: status.repairHint,
            });
        }
        if (recordedBodyLen > 0 && observedBodyLen > 0) {
            const pct = Math.abs(observedBodyLen - recordedBodyLen) / recordedBodyLen * 100;
            if (pct > thresholdPct) issues.push({ kind: 'lengthDriftPct', pct: Math.round(pct), recorded: recordedBodyLen, observed: observedBodyLen });
        }
        if (recordedShape && observedShape && recordedShape !== observedShape) issues.push({ kind: 'shapeDiff', recorded: recordedShape, observed: observedShape });
        if (issues.length) drift.push({ index: i, sampler: `${row.method} ${row.recordedUrl}`, issues });
    }
    const rootCause = statusAnalysis.traceStatusRootCause({
        entries: flatEntries,
        samples: evidence.samples,
        evidence,
    });
    return { jtlPath, samplesCompared: rows.length, drift, folded, rootCause, evidence };
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

function summarizeJtlFast(jtlPath) {
    return runEvidence.summarizeJtlFast(jtlPath);
}

module.exports = { diffRunAgainstRecording, generateHtmlDashboard, findLastJtl, summarizeJtlFast, _internal: { safeJsonShape, killProcessTree } };
