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
const { jmeterDetector, ENGINE_ROOT } = require('./engine');
const { generate } = require('./generate');
const { runFeedbackLoop } = require(path.join(ENGINE_ROOT, 'src/execution/feedbackLoop'));
const aiService = require(path.join(ENGINE_ROOT, 'src/services/ai-service'));

// Phase 4 — LLM escalation. The deterministic loop disables what it can't
// repair; for those still-failing requests, ask the engine's ai-service
// (Gemini) for specific fixes. Strictly opt-in: no GOOGLE_API_KEY => isEnabled()
// is false => returns [] (clean no-op). Engine untouched; this is a post-loop
// advisory, written to <name>_llm_suggestions.json for human review.
async function escalateToLlm({ result, jmxPath, correlations, outDir, name, onLog }) {
    const failures = (result.samples || [])
        .filter(s => !s.isTransaction && s.success === false)
        .map((s, i) => ({
            samplerName: s.label || s.name,
            samplerIndex: s.index != null ? s.index : i,
            responseCode: s.responseCode,
            responseMessage: s.responseMessage,
            failureMessage: s.failureMessage || s.assertionMessage || s.rootCause,
            category: s.rootCause || s.category,
            unresolvedVariables: s.unresolvedVariables || [],
        }));
    if (!failures.length) return;
    if (!aiService.isEnabled()) {
        onLog(`LLM escalation skipped — no Gemini key (set gemini.apiKey / GOOGLE_API_KEY) · ${failures.length} unresolved failure(s)`);
        return;
    }
    try {
        const jmxContent = fs.readFileSync(jmxPath, 'utf8');
        const out = await aiService.analyzeFailuresAndSuggestFixes(failures, jmxContent, correlations || []);
        const fixes = Array.isArray(out) ? out : (out && out.fixes) || [];
        if (fixes.length) {
            fs.writeFileSync(path.join(outDir, `${name}_llm_suggestions.json`), JSON.stringify(fixes, null, 2));
            onLog(`LLM suggested ${fixes.length} fix(es) → ${name}_llm_suggestions.json`);
        } else {
            onLog('LLM escalation returned no actionable fixes');
        }
    } catch (e) { onLog(`LLM escalation error: ${e.message}`); }
}

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
    // 1. Generate the correlated + parameterized JMX (local generate). Writes
    //    into outDir; the synthesized data CSV + a relative CSV Data Set in the
    //    JMX resolve against the JMX's directory = outDir.
    const gen = generate(entries, pages, outDir, name);
    onLog(`generated ${path.basename(gen.jmxPath)} — ${gen.stats.samplers} samplers, ` +
        `${gen.stats.correlations} correlations, ${gen.stats.parameterized} parameterized`);

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

    // Phase 4: if anything is still failing after the deterministic loop,
    // escalate to the LLM (opt-in via Gemini key).
    if (!result.success) {
        await escalateToLlm({
            result, jmxPath: result.finalJmxPath || gen.jmxPath,
            correlations: gen.correlations, outDir, name, onLog,
        });
    }

    return { ok: true, result, jmxPath: result.finalJmxPath || gen.jmxPath, stats: gen.stats };
}

module.exports = { runValidate, deriveBaseUrl, escalateToLlm };
