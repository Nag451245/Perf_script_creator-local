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
// A percentage on a tiny body is noise (10B -> 16B is +60% but meaningless).
// Only flag length drift when BOTH the percentage AND an absolute byte delta
// clear their floors, and only for bodies large enough to be a real payload.
const DEFAULT_MIN_DRIFT_BYTES = 256;
const MIN_COMPARABLE_BODY_BYTES = 64;

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
    // Newest by MTIME, not by iteration number: a 1-iteration run leaves the
    // previous run's iteration_3 on disk, and picking it by number fed the
    // gates STALE response bodies — the verdict then judged the previous run.
    const candidates = [];
    for (const d of fs.readdirSync(outDir, { withFileTypes: true })) {
        if (!d.isDirectory() || !/^iteration_\d+$/.test(d.name)) continue;
        const p = path.join(outDir, d.name, 'results.jtl');
        try { candidates.push({ p, mtime: fs.statSync(p).mtimeMs }); } catch { /* no jtl */ }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates.length ? candidates[0].p : null;
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
    // This evidence becomes the runner's currentEvidence (it supersedes the
    // attempt evidence), so it must carry bodies too — otherwise the body-based
    // gates (auth wall, soft failures) silently see nothing and pass.
    const bodySource = findLastJtl(outDir);
    if (bodySource && bodySource !== jtlPath) {
        runEvidence.backfillObservedBodies({ evidence, sourceJtlPath: bodySource });
    }
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
        if (recordedBodyLen >= MIN_COMPARABLE_BODY_BYTES && observedBodyLen > 0) {
            const absDelta = Math.abs(observedBodyLen - recordedBodyLen);
            const pct = absDelta / recordedBodyLen * 100;
            if (pct > thresholdPct && absDelta >= DEFAULT_MIN_DRIFT_BYTES) {
                issues.push({ kind: 'lengthDriftPct', pct: Math.round(pct), absDelta, recorded: recordedBodyLen, observed: observedBodyLen });
            }
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
