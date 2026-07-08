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
const { applyLlmPatches, validateLlmPatches } = require('./llm-patcher');
const { sanitizeJavaUnsafeJmx } = require('./java-safe');
const learningStore = require('./learning-store');
const businessGuard = require('./business-guard');
const { runFeedbackLoop } = require(path.join(ENGINE_ROOT, 'src/execution/feedbackLoop'));
const autoPatcher = require(path.join(ENGINE_ROOT, 'src/execution/autoPatcher'));
const aiService = require(path.join(ENGINE_ROOT, 'src/services/ai-service'));

// Phase 4 — LLM escalation. The deterministic loop disables what it can't
// repair; for those still-failing requests, ask OpenAI (preferred when
// configured) or the engine's Gemini ai-service for specific fixes. Strictly
// opt-in: no provider key => returns [] (clean no-op). Engine untouched; this is
// post-loop and the suggestions are written to <name>_llm_suggestions.json so
// a reviewer can audit what the LLM proposed even when we *do* apply some.
//
// Returns the fix array so the caller can deterministically patch + re-verify
// (see `runValidate` below). Kept backwards-compatible: still writes the
// suggestions file; callers that ignore the return value (tests, older code)
// keep working.
async function escalateToLlm({ result, jmxPath, correlations, outDir, name, onLog, flowNotes = [] }) {
    const failures = collectLlmFailures(result);
    if (!failures.length) return [];
    if (!process.env.OPENAI_API_KEY && !aiService.isEnabled()) {
        onLog(`AI escalation skipped — no OpenAI/Gemini key configured · ${failures.length} unresolved failure(s)`);
        return [];
    }
    try {
        const jmxContent = fs.readFileSync(jmxPath, 'utf8');
        const prompt = buildGeminiFixPrompt({ failures, jmxContent, correlations, flowNotes });
        const provider = llmProviderLabel(process.env);
        onLog(`AI escalation using ${provider} as senior performance engineer`);
        const out = process.env.OPENAI_API_KEY
            ? await generateWithOpenAi(prompt)
            : await generateWithGemini(prompt, failures, jmxContent, correlations);
        const fixes = normalizeGeminiFixes(out);
        fs.writeFileSync(path.join(outDir, `${name}_llm_suggestions.json`), JSON.stringify(fixes, null, 2));
        if (fixes.length) {
            onLog(`AI suggested ${fixes.length} fix(es) → ${name}_llm_suggestions.json`);
        } else {
            onLog(`AI escalation returned no actionable fixes → ${name}_llm_suggestions.json`);
        }
        return fixes;
    } catch (e) { onLog(`AI escalation error: ${e.message}`); return []; }
}

function llmProviderLabel(env = process.env) {
    if (env.OPENAI_API_KEY) return 'OpenAI';
    if (env.GOOGLE_API_KEY) return 'Gemini';
    return 'none';
}

async function generateWithGemini(prompt, failures, jmxContent, correlations) {
    if (!aiService.isEnabled()) {
        throw new Error(`no LLM key configured (set openai.apiKey, gemini.apiKey, OPENAI_API_KEY, or GOOGLE_API_KEY) · ${failures.length} unresolved failure(s)`);
    }
    return typeof aiService._generate === 'function'
        ? aiService._generate(prompt.systemInstruction, prompt.userPrompt)
        : aiService.analyzeFailuresAndSuggestFixes(failures, jmxContent, correlations || []);
}

async function generateWithOpenAi(prompt) {
    const request = buildOpenAiChatRequest(prompt);
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${body.slice(0, 500)}`);
    const json = JSON.parse(body);
    const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    if (!content) return { fixes: [] };
    return parseLlmJson(content);
}

function buildOpenAiChatRequest(prompt) {
    return {
        model: process.env.OPENAI_MODEL || 'gpt-5.5',
        messages: [
            { role: 'system', content: prompt.systemInstruction },
            { role: 'user', content: prompt.userPrompt },
        ],
        max_completion_tokens: 2048,
    };
}

function parseLlmJson(content) {
    const raw = String(content || '').trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '');
    try { return JSON.parse(raw); }
    catch { return { fixes: [] }; }
}

function collectLlmFailures(result = {}) {
    const failures = [];
    const seen = new Set();
    for (const [i, s] of (result.samples || []).entries()) {
        if (s.isTransaction || s.success !== false) continue;
        const samplerName = s.label || s.name;
        if (!samplerName || seen.has(samplerName)) continue;
        seen.add(samplerName);
        failures.push({
            samplerName,
            samplerIndex: s.index != null ? s.index : i,
            responseCode: s.responseCode || s.code,
            responseMessage: s.responseMessage,
            failureMessage: s.failureMessage || s.assertionMessage || s.rootCause,
            category: s.rootCause || s.category,
            unresolvedVariables: s.unresolvedVariables || [],
        });
    }
    for (const [i, u] of (result.unresolvedFailures || []).entries()) {
        const samplerName = u.samplerLabel || u.samplerName;
        if (!samplerName || seen.has(samplerName)) continue;
        seen.add(samplerName);
        failures.push({
            samplerName,
            samplerIndex: u.index != null ? u.index : i,
            responseCode: u.responseCode,
            responseMessage: u.issue,
            failureMessage: u.manualFixHint || u.issue,
            category: u.issue,
            unresolvedVariables: u.varName ? [u.varName] : [],
        });
    }
    return failures;
}

function normalizeGeminiFixes(out) {
    if (Array.isArray(out)) return out;
    if (out && Array.isArray(out.fixes)) return out.fixes;
    return [];
}

function buildGeminiFixPrompt({ failures, jmxContent, correlations = [], flowNotes = [] }) {
    const prioritizedFailures = prioritizeLlmFailures(failures || []);
    const failureSummary = prioritizedFailures.failures.map((f, i) => ({
        sampler: f.samplerName,
        index: f.samplerIndex != null ? f.samplerIndex : i,
        responseCode: f.responseCode,
        responseMessage: f.responseMessage,
        failureMessage: f.failureMessage,
        category: f.category,
        unresolvedVariables: f.unresolvedVariables || [],
    }));
    const corrSummary = (correlations || []).slice(0, 50).map(c => ({
        variable: c.variableName || c.var || c.refName,
        type: c.type || c.extractionType,
        sourceSampler: c.sourceSampler || c.sourceRequestIndex,
        targetSampler: c.targetSampler || c.targetRequestIndex,
        regex: c.extractionRegex || c.regex,
        jsonPath: c.jsonPath || c.path,
    }));
    const snippets = extractRelevantJmxSnippets(jmxContent, prioritizedFailures.failures || []);

    const systemInstruction = `You are a senior performance engineer specializing in JMeter correlation, OAuth/OIDC/SAML replay, GraphQL/API validation, and load-test script hardening.

Operate like the senior engineer who manually fixed the Tasking script:
- Evidence first. Use only the failures, JMX snippets, and known correlations provided.
- Do not guess. If the exact producer, literal value, or sampler target is not visible, return no fix for that item.
- Do not hallucinate endpoints, variables, extractors, scripts, credentials, tokens, or response bodies.
- Prefer fresh server-issued correlation over hardcoded recorded values.
- Treat 401/403 after login as an upstream auth/session symptom until the failing sampler proves otherwise.
- Fold recorded redirect/OIDC plumbing instead of replaying stale redirect hops. Treat /authorize/resume and /oauth/token as non-business plumbing unless the evidence proves they are the business action.
- Preserve true business action samplers: login form submissions, SSO bridge posts, session save/create-cookie calls, GraphQL mutations, and create-task API calls.
- If protected login/auth/business samplers did not execute, do not try to make the run green by disabling earlier generic samplers. Fix the earliest root failure or return no fixes.
- Never suggest disabling an ambiguous first-party sampler like "POST /" or "GET /" unless the snippet proves it is telemetry/noise. A 4xx on a login form/root app path is diagnostic evidence, not a disable candidate.
- Disable samplers only when they are clearly third-party telemetry, browser noise, duplicate redirect/OIDC plumbing, or otherwise non-business-critical.
- Never propose Groovy, BeanShell, JSR223, Java code, arbitrary XML rewrites, file operations, or custom scripts.
- Return JSON only.${flowNotes.length ? `

Flow-specific notes from the operator's config (run.llmFlowNotes):
${flowNotes.map(n => `- ${n}`).join('\n')}` : ''}`;

    const userPrompt = `A generated JMeter JMX was validated and still has unresolved failures.

Analyze the evidence and return a JSON object with exactly one top-level key: "fixes".

Allowed fix objects are ONLY these exact schemas:

1. Add a native extractor after a producer sampler:
{"kind":"addExtractor","sampler":"exact sampler testname","variable":"safe_variable_name","type":"json","path":"$.json.path"}
{"kind":"addExtractor","sampler":"exact sampler testname","variable":"safe_variable_name","type":"regex","regex":"left([^\\\\s&\\\"]+)right","template":"$1$","useHeaders":true}

2. Replace a visible recorded literal with an existing/new safe JMeter variable:
{"kind":"replaceValueWithVar","sampler":"exact sampler testname or omit for all samplers","value":"exact literal visible in JMX","variable":"safe_variable_name"}

3. Disable a clearly useless/noisy sampler:
{"kind":"setSamplerEnabled","sampler":"exact sampler testname","enabled":false}

Hard rules:
- The only allowed kind values are addExtractor, replaceValueWithVar, setSamplerEnabled.
- Variable names must match ^[A-Za-z_][A-Za-z0-9_]*$ and must not start with "__".
- Do not include id, category, description, explanation, confidence, currentValue, proposedValue, xmlElement, notes, markdown, or any extra field.
- Do not propose JSR223, Groovy, BeanShell, JavaScript execution, or any unsupported patch kind.
- For regex extractors, use exactly one capture group and set useHeaders=true only for Location/Set-Cookie/header values.
- For JSON extractors, use JSON only when the value is produced in a response body JSON field.
- If a failure cannot be fixed from the provided evidence, omit it. An empty fix list is better than a hallucinated patch.

## FAILURES
${JSON.stringify(failureSummary, null, 2)}

## FAILURE TRIAGE
${JSON.stringify(prioritizedFailures.triage, null, 2)}

## RELEVANT JMX SNIPPETS
${snippets}

## KNOWN CORRELATIONS
${JSON.stringify(corrSummary, null, 2)}

Return format:
{"fixes":[]}`;

    return { systemInstruction, userPrompt };
}

function prioritizeLlmFailures(failures) {
    const all = Array.isArray(failures) ? failures : [];
    const business = all.filter(f =>
        f.category === 'business_verification_failed' ||
        /protected business sampler\(s\) did not execute/i.test(String(f.failureMessage || f.responseMessage || ''))
    );
    const root = all.filter(f => !/^cascade_from_/i.test(String(f.category || f.responseMessage || f.failureMessage || '')) &&
        f.category !== 'business_verification_failed');
    const cascades = all.length - root.length - business.length;
    const picked = [];
    for (const f of root.slice(0, 6)) picked.push(f);
    for (const f of business.slice(0, 2)) picked.push(f);
    if (!picked.length) picked.push(...all.slice(0, 8));
    return {
        failures: picked,
        triage: {
            totalFailures: all.length,
            rootFailuresShown: root.slice(0, 6).length,
            cascadeFailuresSuppressed: Math.max(0, cascades),
            businessVerificationFailuresShown: business.slice(0, 2).length,
            instruction: 'Analyze shown root failures first. Suppressed cascades are downstream symptoms and should not receive separate fixes.',
        },
    };
}

function extractRelevantJmxSnippets(jmxContent, failures) {
    if (!jmxContent) return '(JMX content not available)';
    const lines = jmxContent.split(/\r?\n/);
    const samplerNames = new Set((failures || []).map(f => f.samplerName).filter(Boolean));
    const unresolvedVars = new Set();
    for (const f of failures || []) {
        for (const v of f.unresolvedVariables || []) unresolvedVars.add(v);
    }

    const snippets = [];
    for (const name of samplerNames) {
        const idx = lines.findIndex(line => line.includes('<HTTPSamplerProxy') && line.includes(`testname="${name}"`));
        if (idx < 0) continue;
        snippets.push(lines.slice(Math.max(0, idx - 2), Math.min(lines.length, idx + 90)).join('\n'));
    }
    for (const varName of unresolvedVars) {
        const idx = lines.findIndex(line => line.includes(varName));
        if (idx < 0) continue;
        snippets.push(lines.slice(Math.max(0, idx - 20), Math.min(lines.length, idx + 40)).join('\n'));
    }

    return snippets.join('\n---\n').slice(0, 10000) || '(No relevant snippets found)';
}

function normalizeAgentCfg(agentCfg = {}) {
    return {
        enabled: agentCfg.enabled === true,
        maxLlmRounds: clampInt(agentCfg.maxLlmRounds, 1, 3, 1),
        javaSafeMode: agentCfg.javaSafeMode !== false,
    };
}

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
}

function normalizeLearningCfg(learningCfg = {}) {
    return {
        enabled: learningCfg.enabled !== false,
        autoApplyMinConfidence: clampNumber(learningCfg.autoApplyMinConfidence, 0, 0.99, 0.85),
        storePath: learningCfg.storePath || learningStore.defaultStorePath(path.join(__dirname, '..')),
    };
}

function filterProtectedPatchDisables(validation, guard) {
    if (!guard || guard.enabled === false || !guard.protectedNames || !validation) return validation;
    const accepted = [];
    const rejected = [...(validation.rejected || [])];
    for (const fix of validation.accepted || []) {
        const disablesProtected = fix.kind === 'setSamplerEnabled' &&
            fix.enabled === false &&
            guard.protectedNames.has(String(fix.sampler || '').trim());
        const disablesAmbiguousRoot = fix.kind === 'setSamplerEnabled' &&
            fix.enabled === false &&
            isAmbiguousRootSamplerName(fix.sampler);
        if (disablesProtected) {
            rejected.push({
                reason: 'protected_business_sampler',
                kind: fix.kind,
                sampler: fix.sampler,
                raw: fix,
            });
        } else if (disablesAmbiguousRoot) {
            rejected.push({
                reason: 'ambiguous_root_sampler_disable',
                kind: fix.kind,
                sampler: fix.sampler,
                raw: fix,
            });
        } else {
            accepted.push(fix);
        }
    }
    return { accepted, rejected };
}

function isAmbiguousRootSamplerName(sampler) {
    return /^Step\s+\d+\s+-\s+(GET|POST|PUT|PATCH|DELETE)\s+\/$/i.test(String(sampler || '').trim());
}

function guardedApplyPatch({ guard, blockedDisables, onLog }) {
    return async (jmxPath, failureReport, harEntries, options = {}) => {
        const filtered = businessGuard.filterProtectedDisables(failureReport, guard);
        if (filtered.blocked.length) {
            blockedDisables.push(...filtered.blocked.map(item => ({
                sampler: item.samplerLabel,
                reason: item.reason,
                responseCode: item.responseCode,
            })));
            onLog(`strict business guard: blocked disable of ${filtered.blocked.length} protected sampler(s): ` +
                filtered.blocked.map(item => item.samplerLabel).slice(0, 4).join(', '));
        }
        return autoPatcher.applyPatch(jmxPath, filtered.report, harEntries, options);
    };
}

/**
 * The engine loop's result parse can return an EMPTY or PARTIAL samples array
 * even after JMeter ran (its SAX parse drops rows silently — same failure
 * class the JTL watchdog guards). Business verification then sees executed
 * protected samplers as "did not execute" and the report undercounts. The
 * JTL the SimpleDataWriter wrote is ground truth for what executed: when
 * samples are empty it replaces them wholesale; otherwise any label present
 * in the JTL but missing from the engine's list is merged in (last
 * occurrence wins, so a later iteration's outcome supersedes an earlier
 * one). Mutates `result` in place; engine untouched.
 */
function recoverSamplesFromJtl(result, stableJtl, outDir, onLog) {
    if (!result) return result;
    try {
        const jtl = fs.existsSync(stableJtl) ? stableJtl : findLastJtl(outDir);
        if (!jtl) return result;
        const jtlRows = summarizeJtlFast(jtl);
        if (!jtlRows.length) return result;
        const byLabel = new Map();
        for (const r of jtlRows) byLabel.set(String(r.label || '').trim(), r); // last wins
        // The engine classifies "is this row a transaction?" by label shape
        // ("METHOD /path"), which mislabels GraphQL samplers ("GraphQL
        // mutation X") as transactions — the guard then filters them out and
        // reports "did not execute". The JTL tag is ground truth: real
        // samplers write <httpSample>, transaction controllers write <sample>.
        let reclassified = 0;
        for (const s of result.samples || []) {
            const row = byLabel.get(String(s.label || s.name || '').trim());
            if (row && s.isTransaction !== row.isTransaction) {
                s.isTransaction = row.isTransaction;
                reclassified++;
            }
        }
        if (reclassified) onLog(`corrected isTransaction on ${reclassified} row(s) using JTL tags (GraphQL samplers are requests, not transactions)`);
        const existing = new Set((result.samples || []).map(s => String(s.label || s.name || '').trim()));
        if (!existing.size) {
            result.samples = [...byLabel.values()];
            result.samplesRecoveredFromJtl = path.basename(jtl);
            onLog(`engine returned no per-sampler results — recovered ${result.samples.filter(s => !s.isTransaction).length} request row(s) from ${path.basename(jtl)}`);
            return result;
        }
        const missing = [...byLabel.entries()].filter(([label]) => label && !existing.has(label)).map(([, r]) => r);
        if (missing.length) {
            result.samples = [...result.samples, ...missing];
            result.samplesRecoveredFromJtl = path.basename(jtl);
            onLog(`engine sample list was partial — merged ${missing.length} executed row(s) from ${path.basename(jtl)}`);
        }
    } catch (e) { onLog(`sample recovery skipped: ${e.message}`); }
    return result;
}

function applyBusinessVerification(result, finalJmxPath, guard, blockedDisables = []) {
    let xml = '';
    try { xml = finalJmxPath && fs.existsSync(finalJmxPath) ? fs.readFileSync(finalJmxPath, 'utf8') : ''; }
    catch { xml = ''; }
    const evaluation = businessGuard.evaluateBusinessResult({ result, xml, guard });
    const withMeta = { ...(result || {}), businessVerification: { ...evaluation, blockedDisables } };
    if (evaluation.ok) return { result: withMeta, evaluation };
    const unresolved = Array.isArray(withMeta.unresolvedFailures) ? withMeta.unresolvedFailures.slice() : [];
    unresolved.push({
        issue: 'business_verification_failed',
        manualFixHint: evaluation.reason,
    });
    return {
        result: { ...withMeta, success: false, unresolvedFailures: unresolved },
        evaluation,
    };
}

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function resolveJMeterBinPath({ detector = jmeterDetector, homes = null } = {}) {
    const info = detector.detect();
    if (info && info.available && info.path) return info.path;

    const candidates = [];
    const homeCandidates = homes || [
        process.env.JMETER_HOME,
        'D:/apache-jmeter-5.6.3',
        'D:/apache-jmeter',
        'C:/apache-jmeter-5.6.3',
        'C:/apache-jmeter',
        'C:/Tools/apache-jmeter-5.6.3',
        'C:/Tools/apache-jmeter',
    ];
    for (const home of homeCandidates.filter(Boolean)) {
        candidates.push(...jmeterBinCandidates(home));
    }
    return candidates.find(p => fs.existsSync(p)) || null;
}

function jmeterBinCandidates(home) {
    return process.platform === 'win32'
        ? [path.join(home, 'bin', 'jmeter.bat'), path.join(home, 'bin', 'jmeter.cmd')]
        : [path.join(home, 'bin', 'jmeter')];
}

function applyJavaSafeGuard({ jmxPath, outDir, name, label, enabled, onLog }) {
    if (!enabled) return { changed: false, removed: [] };
    const before = fs.readFileSync(jmxPath, 'utf8');
    const sanitized = sanitizeJavaUnsafeJmx(before);
    if (!sanitized.changed) return sanitized;

    fs.writeFileSync(jmxPath, sanitized.xml);
    const safeLabel = String(label || 'run').replace(/[^a-zA-Z0-9_-]/g, '_');
    fs.writeFileSync(
        path.join(outDir, `${name}_java_safe_${safeLabel}.json`),
        JSON.stringify({ jmxPath: path.basename(jmxPath), removed: sanitized.removed }, null, 2)
    );
    onLog(`java-safe: stripped ${sanitized.removed.length} JSR223 pre/post processor(s) before JMeter`);
    return sanitized;
}

async function tryMemoryPatchRound({ result, jmxPath, config, gen, outDir, name, onLog, agent, learning, guard }) {
    const matches = learning.enabled
        ? learningStore.findMatchingLessons({
            storePath: learning.storePath,
            failures: result,
            minConfidence: learning.autoApplyMinConfidence,
        })
        : [];

    fs.writeFileSync(
        path.join(outDir, `${name}_memory_matches.json`),
        JSON.stringify({ enabled: learning.enabled, matches }, null, 2)
    );

    if (!matches.length) {
        if (learning.enabled) onLog('learning memory: no verified lesson matched current failures');
        return { result, jmxPath, memoryPatch: { matches, applied: 0, success: false }, successfulFixes: [] };
    }

    const fixes = matches.map(m => m.fix);
    const validation = filterProtectedPatchDisables(validateLlmPatches(fixes), guard);
    if (!validation.accepted.length) {
        onLog(`learning memory: ${matches.length} match(es), but schema gate accepted none`);
        return { result, jmxPath, memoryPatch: { matches, applied: 0, success: false }, successfulFixes: [] };
    }

    try {
        const before = fs.readFileSync(jmxPath, 'utf8');
        const patched = applyLlmPatches(before, validation.accepted);
        fs.writeFileSync(
            path.join(outDir, `${name}_memory_patches.json`),
            JSON.stringify({ applied: patched.applied, skipped: patched.skipped }, null, 2)
        );
        if (!patched.applied.length) {
            onLog(`learning memory: matched ${matches.length} lesson(s), but no patch applied`);
            return { result, jmxPath, memoryPatch: { matches, applied: 0, skipped: patched.skipped.length, success: false }, successfulFixes: [] };
        }

        const patchedJmxPath = path.join(outDir, `${name}.memory-patched.jmx`);
        fs.writeFileSync(patchedJmxPath, patched.xml);
        applyJavaSafeGuard({
            jmxPath: patchedJmxPath, outDir, name,
            label: 'memory', enabled: agent.javaSafeMode, onLog,
        });

        onLog(`learning memory: applied ${patched.applied.length} verified lesson patch(es) · re-verifying before AI escalation`);
        const result2 = await runFeedbackLoop({ ...config, jmxPath: patchedJmxPath, maxIterations: 1 }, gen.flat);
        const success = !!result2.success;
        return {
            result: result2,
            jmxPath: result2.finalJmxPath || patchedJmxPath,
            memoryPatch: { matches, applied: patched.applied.length, skipped: patched.skipped.length, success },
            successfulFixes: success ? validation.accepted : [],
        };
    } catch (e) {
        onLog(`learning memory patch error: ${e.message}`);
        return { result, jmxPath, memoryPatch: { matches, applied: 0, error: e.message, success: false }, successfulFixes: [] };
    }
}

async function runLlmPatchRounds({ result, jmxPath, config, gen, outDir, name, onLog, agentCfg, learningCfg, guard, flowNotes = [] }) {
    const agent = normalizeAgentCfg(agentCfg);
    if (!agent.enabled) {
        onLog('agent mode disabled — keeping deterministic JMX as final');
        return { result, jmxPath, llmPatch: null };
    }
    const learning = normalizeLearningCfg(learningCfg);

    onLog(`agent mode: monitoring unresolved failures; ${llmProviderLabel()} can assist for up to ${agent.maxLlmRounds} bounded round(s)`);

    let finalResult = result;
    let finalJmxPath = jmxPath;
    const rounds = [];
    const successfulFixes = [];
    const memoryAttempt = await tryMemoryPatchRound({
        result: finalResult, jmxPath: finalJmxPath, config, gen, outDir, name, onLog, agent, learning, guard,
    });
    finalResult = memoryAttempt.result;
    finalJmxPath = memoryAttempt.jmxPath;
    successfulFixes.push(...memoryAttempt.successfulFixes);

    if (finalResult.success) {
        onLog('learning memory round succeeded — shipping memory-patched JMX as final');
        return {
            result: finalResult,
            jmxPath: finalJmxPath,
            llmPatch: {
                memory: memoryAttempt.memoryPatch,
                rounds,
                success: true,
                successfulFixes,
            },
        };
    }

    for (let round = 1; round <= agent.maxLlmRounds && !finalResult.success; round++) {
        const fixes = await escalateToLlm({
            result: finalResult, jmxPath: finalJmxPath,
            correlations: gen.correlations, outDir, name, onLog, flowNotes,
        });
        if (!fixes || !fixes.length) break;

        const validation = filterProtectedPatchDisables(validateLlmPatches(fixes), guard);
        fs.writeFileSync(
            path.join(outDir, `${name}_llm_validation_round${round}.json`),
            JSON.stringify(validation, null, 2)
        );
        if (validation.rejected.length) {
            onLog(`LLM schema gate: accepted ${validation.accepted.length}, rejected ${validation.rejected.length}`);
        }
        if (!validation.accepted.length) break;

        try {
            const before = fs.readFileSync(finalJmxPath, 'utf8');
            const patched = applyLlmPatches(before, validation.accepted);
            const patchedJmxPath = path.join(outDir, `${name}.llm-patched.round${round}.jmx`);
            fs.writeFileSync(
                path.join(outDir, `${name}_llm_patches_round${round}.json`),
                JSON.stringify({ applied: patched.applied, skipped: patched.skipped }, null, 2)
            );

            if (!patched.applied.length) {
                onLog(`LLM patcher round ${round}: no applyable fixes after schema gate`);
                rounds.push({ round, applied: 0, skipped: patched.skipped.length, success: false });
                break;
            }

            fs.writeFileSync(patchedJmxPath, patched.xml);
            applyJavaSafeGuard({
                jmxPath: patchedJmxPath, outDir, name,
                label: `llm_round_${round}`, enabled: agent.javaSafeMode, onLog,
            });

            onLog(`LLM patcher round ${round}: applied ${patched.applied.length} / skipped ${patched.skipped.length} · re-verifying`);
            const result2 = await runFeedbackLoop({ ...config, jmxPath: patchedJmxPath, maxIterations: 1 }, gen.flat);
            const success = !!result2.success;
            rounds.push({ round, applied: patched.applied.length, skipped: patched.skipped.length, success });
            finalResult = result2;
            finalJmxPath = result2.finalJmxPath || patchedJmxPath;

            if (success) {
                successfulFixes.push(...validation.accepted);
                onLog(`LLM round ${round} succeeded — shipping patched JMX as final`);
                break;
            }
            onLog(`LLM round ${round} did not close all failures`);
        } catch (e) {
            onLog(`LLM patcher round ${round} error: ${e.message}`);
            rounds.push({ round, error: e.message, success: false });
            break;
        }
    }

    return {
        result: finalResult,
        jmxPath: finalJmxPath,
        llmPatch: (rounds.length || memoryAttempt.memoryPatch)
            ? { memory: memoryAttempt.memoryPatch, rounds, success: !!finalResult.success, successfulFixes }
            : null,
    };
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
async function runValidate({ entries, pages, outDir, name, runCfg = {}, maxIterations = 3, onLog = () => {}, genOpts = {}, agentCfg = {}, learningCfg = {} }) {
    const agent = normalizeAgentCfg(agentCfg);
    const learning = normalizeLearningCfg(learningCfg);
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

    // 3. JMeter. Use the engine detector first, then local common Windows
    // fallback paths (notably D:/apache-jmeter-5.6.3).
    const jmeterBinPath = resolveJMeterBinPath();
    if (!jmeterBinPath) return { ok: false, error: 'JMeter not found — set jmeterHome in perfscript.config.json or JMETER_HOME.' };

    // 4. Target + credentials. targetBaseUrl is the loop's connection context;
    //    cross-env host rewrite (recorded host -> target) IS applied in generate
    //    via rewriteHost when runCfg.hostRewrite is set (auto-derived above).
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
    // SimpleDataWriter APPENDS — a leftover final.jtl from a previous run
    // would pollute sample recovery, the guard, and the baseline diff with
    // stale rows. Start every run from a clean file.
    try { fs.rmSync(stableJtl, { force: true }); } catch { /* locked file — rows will be stale-tolerated */ }
    try {
        const originalJmx = fs.readFileSync(gen.jmxPath, 'utf8');
        const swap = stripGuiListenersForRun(originalJmx, stableJtl);
        if (swap.disabled > 0) {
            fs.writeFileSync(gen.jmxPath, swap.xml);
            onLog(`stripped ${swap.disabled} GUI listener(s); wired SimpleDataWriter -> final.jtl`);
        }
    } catch (e) { onLog(`listener strip skipped: ${e.message}`); }
    try {
        applyJavaSafeGuard({
            jmxPath: gen.jmxPath, outDir, name,
            label: 'initial', enabled: agent.javaSafeMode, onLog,
        });
    } catch (e) { onLog(`java-safe guard skipped: ${e.message}`); }

    const guardXml = fs.readFileSync(gen.jmxPath, 'utf8');
    const strictGuard = businessGuard.buildBusinessGuard({ xml: guardXml, flowName: name, runCfg: enrichedRunCfg });
    const blockedDisables = [];
    if (strictGuard.enabled) {
        onLog(`strict business guard: protecting ${strictGuard.protectedSamplers.length} sampler(s) from disable`);
    }

    // Run the engine loop, but guard against its parseJtl STALLING on a large
    // JTL with embedded malformed response bodies (the SAX recovery deadlocks
    // the stream so the promise never resolves). It's a stall, not CPU-bound, so
    // a timer fires reliably; on timeout we recover the verdict with a body-
    // agnostic regex summary of the JTL. Engine untouched.
    const WATCHDOG_MS = (config.timeoutMs || 240000) + 90000;
    let result;
    const raced = await Promise.race([
        runFeedbackLoop(config, gen.flat, {
            applyPatch: guardedApplyPatch({ guard: strictGuard, blockedDisables, onLog }),
        }).then(r => ({ kind: 'loop', r })),
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

    let finalJmxPath = result.finalJmxPath || gen.jmxPath;
    recoverSamplesFromJtl(result, stableJtl, outDir, onLog);
    let verified = applyBusinessVerification(result, finalJmxPath, strictGuard, blockedDisables);
    let finalResult = verified.result;
    if (!verified.evaluation.ok) {
        onLog(`strict business guard: NOT GREEN — ${verified.evaluation.reason}`);
    } else if (strictGuard.enabled) {
        onLog(`strict business guard: ${verified.evaluation.reason}`);
    }
    let llmPatch = null;
    if (!finalResult.success) {
        const flowNotes = Array.isArray(enrichedRunCfg.llmFlowNotes) ? enrichedRunCfg.llmFlowNotes : [];
        const llm = await runLlmPatchRounds({
            result: finalResult, jmxPath: finalJmxPath, config, gen, outDir, name, onLog, agentCfg: agent, learningCfg: learning, guard: strictGuard, flowNotes,
        });
        finalJmxPath = llm.jmxPath;
        recoverSamplesFromJtl(llm.result, stableJtl, outDir, onLog);
        verified = applyBusinessVerification(llm.result, finalJmxPath, strictGuard, blockedDisables);
        finalResult = verified.result;
        if (!verified.evaluation.ok) {
            onLog(`strict business guard after AI escalation: NOT GREEN — ${verified.evaluation.reason}`);
        }
        llmPatch = llm.llmPatch;
    }

    let learnedLessons = null;
    if (learning.enabled) {
        const fixSource = llmPatch && Array.isArray(llmPatch.successfulFixes) ? llmPatch.successfulFixes : [];
        learnedLessons = learningStore.learnFromRun({
            storePath: learning.storePath,
            flowName: name,
            sourceRun: outDir,
            appHost: targetBaseUrl,
            result: finalResult,
            fixes: fixSource,
        });
        fs.writeFileSync(
            path.join(outDir, `${name}_learned_lessons.json`),
            JSON.stringify(learnedLessons, null, 2)
        );
        if (learnedLessons.learned.length) {
            onLog(`learning memory: saved ${learnedLessons.learned.length} verified lesson(s)`);
        }
    }

    // 5b. Baseline-vs-test diff: status / body length / JSON shape per sampler.
    //     Run this after optional LLM rounds so artifacts describe the final
    //     verification attempt, not an earlier pre-patch JTL.
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

    return {
        ok: true, result: finalResult, jmxPath: finalJmxPath,
        stats: gen.stats, baselineDiff,
        memoryMatches: llmPatch && llmPatch.memory ? llmPatch.memory.matches || [] : [],
        learnedLessons,
        // Surface the generator's deeper artifacts for the HTML report so
        // it doesn't have to re-derive them.
        correlations: gen.correlations || [],
        reasoning: gen.reasoning || [],
        loadProfile: gen.loadProfile || null,
        llmPatch,
        businessVerification: finalResult.businessVerification || null,
    };
}

module.exports = {
    runValidate,
    deriveBaseUrl,
    escalateToLlm,
    runLlmPatchRounds,
    _internal: {
        normalizeAgentCfg,
        normalizeLearningCfg,
        resolveJMeterBinPath,
        collectLlmFailures,
        buildOpenAiChatRequest,
        llmProviderLabel,
        prioritizeLlmFailures,
        filterProtectedPatchDisables,
        applyBusinessVerification,
        recoverSamplesFromJtl,
        applyJavaSafeGuard,
        buildGeminiFixPrompt,
        normalizeGeminiFixes,
        extractRelevantJmxSnippets,
    },
};
