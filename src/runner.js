'use strict';
/**
 * runner.js — Phase 2 thin LOCAL runner.
 *
 * The engine's runAgent() derives the target from the recording and takes no
 * credentials, so it can't drive an unattended run with login. Rather than
 * change the engine (which would disturb the current app), this wraps the
 * reused pieces directly — generateCorrelatedJmx + runFeedbackLoop — and adds
 * only the local concerns: credentials, data files, target, JMeter discovery.
 * Deliberately small (ponytail: reuse, don't rewrite).
 */
const fs = require('fs');
const path = require('path');
const { orchestrator, jmeterDetector, ENGINE_ROOT } = require('./engine');
const { runFeedbackLoop } = require(path.join(ENGINE_ROOT, 'src/execution/feedbackLoop'));

function deriveBaseUrl(entries) {
    for (const e of entries || []) {
        try { const u = new URL(e.request.url); return `${u.protocol}//${u.host}`; } catch { /* next */ }
    }
    return null;
}

/**
 * Generate + run the bounded feedback loop against a live target.
 * @returns {Promise<{ok, error?, result?, jmxPath?, stats?}>}
 */
async function runValidate({ entries, pages, outDir, name, runCfg = {}, maxIterations = 3, onLog = () => {} }) {
    // 1. Generate the correlated JMX (reused engine). Writes into outDir; a
    //    relative CSV in the JMX resolves against the JMX's directory = outDir.
    const gen = orchestrator.generateCorrelatedJmx(entries, pages, outDir, name);
    onLog(`generated ${path.basename(gen.jmxPath)} — ${gen.stats.samplers} samplers, ${gen.stats.correlations} correlations`);

    // 2. Stage data files next to the JMX so CSV Data Sets resolve.
    for (const src of (runCfg.dataFiles || [])) {
        try { fs.copyFileSync(src, path.join(outDir, path.basename(src))); onLog(`staged data file ${path.basename(src)}`); }
        catch (e) { onLog(`data file skipped (${src}): ${e.message}`); }
    }

    // 3. JMeter. detect() returns an info object, not a path string.
    const info = jmeterDetector.detect();
    const jmeterBinPath = info && info.available ? info.path : null;
    if (!jmeterBinPath) return { ok: false, error: 'JMeter not found — set jmeterHome in perfscript.config.json or JMETER_HOME.' };

    // 4. Target + credentials. NOTE: targetBaseUrl is the loop's connection
    //    context; samplers still hit their recorded hosts (true cross-env host
    //    rewrite is a later phase). Override is accepted for when the recorded
    //    host == the test host but the base needs pinning.
    const targetBaseUrl = (runCfg.targetBaseUrlOverride || '').trim() || deriveBaseUrl(gen.flat);
    if (!targetBaseUrl) return { ok: false, error: 'No target base URL could be determined (set run.targetBaseUrlOverride).' };
    const credentials = (runCfg.credentials && runCfg.credentials.username) ? runCfg.credentials : undefined;

    onLog(`target=${targetBaseUrl} · credentials=${credentials ? 'yes' : 'no'} · jmeter=${jmeterBinPath} · maxIter=${maxIterations}`);

    const config = {
        jmeterBinPath,
        jmxPath: gen.jmxPath,
        outputDir: outDir,
        targetBaseUrl,
        credentials,
        maxIterations,
        disableOnly: true, // already correlated; the loop only disables un-replayables
        timeoutMs: 8 * 60 * 1000,
        jmeterProperties: {
            'jmeter.save.saveservice.output_format': 'xml',
            'jmeter.save.saveservice.response_data.on_error': 'true',
        },
        onIteration: (s) => onLog(`[iter] ${JSON.stringify(s).slice(0, 180)}`),
    };

    const result = await runFeedbackLoop(config, gen.flat);
    return { ok: true, result, jmxPath: result.finalJmxPath || gen.jmxPath, stats: gen.stats };
}

module.exports = { runValidate, deriveBaseUrl };
