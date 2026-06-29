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
const { stripGuiListenersForRun } = require('./transforms');
const { diffRunAgainstRecording, generateHtmlDashboard, findLastJtl, summarizeJtlFast } = require('./verifier');
const { applyLlmPatches } = require('./llm-patcher');
const { runFeedbackLoop } = require(path.join(ENGINE_ROOT, 'src/execution/feedbackLoop'));
const aiService = require(path.join(ENGINE_ROOT, 'src/services/ai-service'));

// Phase 4 — LLM escalation. The deterministic loop disables what it can't
// repair; for those still-failing requests, ask the engine's ai-service
// (Gemini) for specific fixes. Strictly opt-in: no GOOGLE_API_KEY =>
// isEnabled() is false => returns [] (clean no-op). Engine untouched; this is
// post-loop and the suggestions are written to <name>_llm_suggestions.json so
// a reviewer can audit what the LLM proposed even when we *do* apply some.
//
// Returns the fix array so the caller can deterministically patch + re-verify
// (see `runValidate` below). Kept backwards-compatible: still writes the
// suggestions file; callers that ignore the return value (tests, older code)
// keep working.
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
    if (!failures.length) return [];
    if (!aiService.isEnabled()) {
        onLog(`LLM escalation skipped — no Gemini key (set gemini.apiKey / GOOGLE_API_KEY) · ${failures.length} unresolved failure(s)`);
        return [];
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
        return fixes;
    } catch (e) { onLog(`LLM escalation error: ${e.message}`); return []; }
}

function deriveBaseUrl(entries) {
    // Pick the MOST FREQUENT origin, not the first entry. Recordings often open
    // with a third-party beacon/telemetry call (e.g. beacons.gcp.gvt2.com), so
    // "first URL" would point the whole run at the wrong host. The app under
    // test dominates the request count, so the mode is the right primary host.
    const counts = new Map();
    for (const e of entries || []) {
        try {
            const u = new URL(e.request.url);
            const origin = `${u.protocol}//${u.host}`;
            counts.set(origin, (counts.get(origin) || 0) + 1);
        } catch { /* skip unparseable */ }
    }
    let best = null, n = -1;
    for (const [origin, c] of counts) if (c > n) { best = origin; n = c; }
    return best;
}

/**
 * Generate + run the bounded feedback loop against a live target.
 * @returns {Promise<{ok, error?, result?, jmxPath?, stats?}>}
 */
async function runValidate({ entries, pages, outDir, name, runCfg = {}, maxIterations = 3, onLog = () => {}, genOpts = {} }) {
    // Auto-derive host rewrite from the recorded primary host -> target base
    // when the user gave us a target but didn't spell out hostRewrite. Honest
    // shortcut for the common case (record prod, run staging) so the JMX
    // actually hits the test env instead of the recorded one.
    const enrichedRunCfg = { ...runCfg };
    if (!enrichedRunCfg.hostRewrite && enrichedRunCfg.targetBaseUrlOverride) {
        const recordedHost = deriveBaseUrl(entries);
        try {
            const fromHost = recordedHost ? new URL(recordedHost).hostname : null;
            const toUrl = enrichedRunCfg.targetBaseUrlOverride;
            const toHost = new URL(toUrl).hostname;
            if (fromHost && fromHost !== toHost) {
                enrichedRunCfg.hostRewrite = { from: fromHost, to: toUrl };
                onLog(`auto host-rewrite: ${fromHost} -> ${toUrl}`);
            }
        } catch (e) { onLog(`host-rewrite skipped: ${e.message}`); }
    }

    // 1. Generate the correlated + parameterized JMX (local generate). Writes
    //    into outDir; the synthesized data CSV + a relative CSV Data Set in the
    //    JMX resolve against the JMX's directory = outDir.
    const gen = generate(entries, pages, outDir, name, { ...genOpts, runCfg: enrichedRunCfg });
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
        timeoutMs: 4 * 60 * 1000,
        jmeterProperties: {
            'jmeter.save.saveservice.output_format': 'xml',
            // Do NOT save response bodies into the engine-parsed JTL. With many
            // failures (e.g. 401 pages), saved bodies bloat the JTL to multiple
            // MB and the engine's parseJtl hangs the CLI (event loop stalls,
            // node exits silently). Codes/assertions are still saved; the
            // human-readable response bodies live in the recording + dashboard.
            'jmeter.save.saveservice.response_data': 'false',
            'jmeter.save.saveservice.response_data.on_error': 'false',
            'jmeter.save.saveservice.samplerData': 'false',
        },
        onIteration: (s) => onLog(`[iter] ${JSON.stringify(s).slice(0, 180)}`),
    };

    // 5a. Strip GUI listeners + add a SimpleDataWriter pointing at a stable
    //     JTL path. The engine's feedback loop also writes its own JTL per
    //     iteration; we keep BOTH so the dashboard / baseline-diff always
    //     have a known destination even when the loop exits early.
    const stableJtl = path.join(outDir, 'final.jtl');
    try {
        const originalJmx = fs.readFileSync(gen.jmxPath, 'utf8');
        const swap = stripGuiListenersForRun(originalJmx, stableJtl);
        if (swap.disabled > 0) {
            fs.writeFileSync(gen.jmxPath, swap.xml);
            onLog(`stripped ${swap.disabled} GUI listener(s); wired SimpleDataWriter -> final.jtl`);
        }
    } catch (e) { onLog(`listener strip skipped: ${e.message}`); }

    // Run the engine loop, but guard against its parseJtl STALLING on a large
    // JTL with embedded malformed response bodies (the SAX recovery deadlocks
    // the stream so the promise never resolves). It's a stall, not CPU-bound, so
    // a timer fires reliably; on timeout we recover the verdict with a body-
    // agnostic regex summary of the JTL. Engine untouched.
    const WATCHDOG_MS = (config.timeoutMs || 240000) + 90000;
    let result;
    const raced = await Promise.race([
        runFeedbackLoop(config, gen.flat).then(r => ({ kind: 'loop', r })),
        new Promise(res => setTimeout(() => res({ kind: 'watchdog' }), WATCHDOG_MS)),
    ]);
    if (raced.kind === 'loop') {
        result = raced.r;
    } else {
        const jtl = fs.existsSync(stableJtl) ? stableJtl : findLastJtl(outDir);
        const samples = jtl ? summarizeJtlFast(jtl) : [];
        const reqs = samples.filter(s => !s.isTransaction);
        result = {
            success: reqs.length > 0 && reqs.every(s => s.success),
            iterationsRun: 1, samples, finalJmxPath: gen.jmxPath,
            recoveredFromJtl: true,
            connectionError: `Engine result-parse stalled after JMeter ran; verdict recovered directly from ${jtl ? path.basename(jtl) : 'JTL'} (${reqs.length} requests).`,
        };
        onLog(`engine parse stalled (>${Math.round(WATCHDOG_MS / 1000)}s after JMeter) — recovered verdict from JTL: ${reqs.filter(s => s.success).length}/${reqs.length} requests passed`);
    }

    // 5b. Baseline-vs-test diff: status / body length / JSON shape per sampler.
    //     "GREEN" without this is just "200s came back" — useless for catching
    //     a login page returned in place of a dashboard, etc.
    let baselineDiff = null;
    try {
        baselineDiff = diffRunAgainstRecording({ outDir, flatEntries: gen.flat });
        if (baselineDiff.drift.length) {
            fs.writeFileSync(path.join(outDir, `${name}_baseline_diff.json`), JSON.stringify(baselineDiff, null, 2));
            onLog(`baseline drift detected on ${baselineDiff.drift.length}/${baselineDiff.samplesCompared} sampler(s) — see _baseline_diff.json`);
        } else if (baselineDiff.samplesCompared > 0) {
            onLog(`baseline diff clean (${baselineDiff.samplesCompared} sampler(s) match recording)`);
        }
    } catch (e) { onLog(`baseline diff skipped: ${e.message}`); }

    // 5c. JMeter HTML dashboard. Best-effort; uses the stable JTL when present
    //     (SimpleDataWriter), otherwise the last iteration's JTL.
    try {
        const jtlForDash = fs.existsSync(stableJtl) ? stableJtl
            : (baselineDiff && baselineDiff.jtlPath) || null;
        if (jtlForDash) {
            const dash = await generateHtmlDashboard({ jmeterBinPath, jtlPath: jtlForDash, outDir, onLog });
            if (!dash.ok) onLog(`dashboard not generated: ${dash.error}`);
        }
    } catch (e) { onLog(`dashboard skipped: ${e.message}`); }

    // Phase 4: if anything is still failing after the deterministic loop,
    // escalate to the LLM (opt-in via Gemini key) AND — when the LLM emits
    // patches in our safe-subset shape — apply them and re-verify ONCE more.
    // That round-trip is what makes "hands-free" honest; previously the
    // suggestions sat in a JSON file waiting for a human. Bounded to a
    // single extra iteration so we can't infinite-loop a bad LLM.
    let finalJmxPath = result.finalJmxPath || gen.jmxPath;
    let finalResult = result;
    let llmPatch = null;
    if (!result.success) {
        const fixes = await escalateToLlm({
            result, jmxPath: finalJmxPath,
            correlations: gen.correlations, outDir, name, onLog,
        });
        if (fixes && fixes.length) {
            try {
                const before = fs.readFileSync(finalJmxPath, 'utf8');
                const patched = applyLlmPatches(before, fixes);
                if (patched.applied.length) {
                    const patchedJmxPath = path.join(outDir, `${name}.llm-patched.jmx`);
                    fs.writeFileSync(patchedJmxPath, patched.xml);
                    fs.writeFileSync(
                        path.join(outDir, `${name}_llm_patches.json`),
                        JSON.stringify({ applied: patched.applied, skipped: patched.skipped }, null, 2)
                    );
                    onLog(`LLM patcher: applied ${patched.applied.length} / skipped ${patched.skipped.length} · re-verifying`);
                    // Re-run with a tight budget (1 iteration). The
                    // deterministic loop already gave its best; this is the
                    // verification of the LLM's contribution, not a fresh
                    // round of repair.
                    const cfg2 = { ...config, jmxPath: patchedJmxPath, maxIterations: 1 };
                    const result2 = await runFeedbackLoop(cfg2, gen.flat);
                    if (result2.success) {
                        finalResult = result2;
                        finalJmxPath = result2.finalJmxPath || patchedJmxPath;
                        onLog('LLM round-trip succeeded — shipping patched JMX as final');
                    } else {
                        onLog('LLM round-trip did not close all failures — keeping deterministic JMX as final, patched copy retained for review');
                    }
                    llmPatch = { applied: patched.applied, skipped: patched.skipped, success: !!result2.success };
                } else if (patched.skipped.length) {
                    onLog(`LLM patcher: nothing applyable (${patched.skipped.length} skipped) — see ${name}_llm_suggestions.json`);
                }
            } catch (e) { onLog(`LLM patcher error: ${e.message}`); }
        }
    }

    return {
        ok: true, result: finalResult, jmxPath: finalJmxPath,
        stats: gen.stats, baselineDiff,
        // Surface the generator's deeper artifacts for the HTML report so
        // it doesn't have to re-derive them.
        correlations: gen.correlations || [],
        reasoning: gen.reasoning || [],
        loadProfile: gen.loadProfile || null,
        llmPatch,
    };
}

module.exports = { runValidate, deriveBaseUrl, escalateToLlm };
