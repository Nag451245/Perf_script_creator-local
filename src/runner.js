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
const { stripGuiListenersForRun, disableSamplersByPattern: disableByPatternTransform } = require('./transforms');
const steeringModule = require('./steering');
const { diffRunAgainstRecording, generateHtmlDashboard, findLastJtl, summarizeJtlFast } = require('./verifier');
const { applyLlmPatches, validateLlmPatches } = require('./llm-patcher');
const { sanitizeJavaUnsafeJmx } = require('./java-safe');
const learningStore = require('./learning-store');
const businessGuard = require('./business-guard');
const blueprintContext = require('./blueprint-context');
const blueprintAgent = require('./blueprint-agent');
const { classifyFirstFailure } = require('./failure-classifier');
const valueFlowDecisions = require('./value-flow-decisions');
const samplerDecision = require('./sampler-decision');
const runEvidence = require('./run-evidence');
const postRunAdjudicator = require('./post-run-adjudicator');
const responseEvidence = require('./response-evidence');
const fastRepairLoop = require('./fast-repair-loop');
const correlationHypotheses = require('./correlation-hypotheses');
const statusAnalysis = require('./status-analysis');
const finalGreenGate = require('./final-green-gate');
const blockersModule = require('./blockers');
const replanner = require('./replanner');
const seniorPeAnalysis = require('./senior-pe-analysis');
const failureForensics = require('./failure-forensics');
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
async function escalateToLlm({ result, jmxPath, correlations, outDir, name, onLog, flowNotes = [], blueprintEvidence = null }) {
    const failures = collectLlmFailures(result);
    if (!failures.length) return [];
    if (!process.env.OPENAI_API_KEY && !aiService.isEnabled()) {
        onLog(`AI escalation skipped — no OpenAI/Gemini key configured · ${failures.length} unresolved failure(s)`);
        return [];
    }
    try {
        const jmxContent = fs.readFileSync(jmxPath, 'utf8');
        const prompt = buildGeminiFixPrompt({ failures, jmxContent, correlations, flowNotes, blueprintEvidence });
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
    if (result.statusRootCause && result.statusRootCause.rootCause) {
        const root = result.statusRootCause.rootCause;
        const samplerName = root.sampler || '';
        if (samplerName) {
            seen.add(samplerName);
            failures.push({
                samplerName,
                samplerIndex: result.statusRootCause.rootCauseIndex,
                responseCode: String(root.observed || ''),
                responseMessage: root.relevance || '',
                failureMessage: result.statusRootCause.summary || root.repairHint || '',
                category: root.category,
                unresolvedVariables: [],
            });
        }
    }
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

function buildGeminiFixPrompt({ failures, jmxContent, correlations = [], flowNotes = [], blueprintEvidence = null }) {
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
- Interpret HTTP status codes recording-first: 200/202/3xx/4xx/5xx are only correct when they match the recorded sampler's expected status and response shape.
- Follow the senior PE gates when evidence is present: objective -> flow intent -> role/necessity ledger -> native managers -> producer-localized repair -> validity/negative-space audit.
- Do not parameterize values merely because they differ; tie parameterization to the test objective and role. Do not correlate values that Cookie/Cache/Auth/redirect managers own.
- If a downstream sampler fails, inspect prior statusRootCause / baseline drift first; repair the earliest upstream divergence before patching the downstream symptom.
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
{"kind":"addExtractor","sampler":"exact sampler testname","variable":"safe_variable_name","type":"css","selector":"input[name=\\"csrf\\"]","attribute":"value"}

2. Replace a visible recorded literal with an existing/new safe JMeter variable:
{"kind":"replaceValueWithVar","sampler":"exact sampler testname or omit for all samplers","value":"exact literal visible in JMX","variable":"safe_variable_name"}

3. Disable or re-enable an exact sampler when evidence proves it:
{"kind":"setSamplerEnabled","sampler":"exact sampler testname","enabled":false}
{"kind":"setSamplerEnabled","sampler":"exact sampler testname","enabled":true}

4. Remove a bad generated assertion under an exact sampler:
{"kind":"removeAssertion","sampler":"exact sampler testname","assertion":"exact assertion testname"}

Hard rules:
- The only allowed kind values are addExtractor, replaceValueWithVar, setSamplerEnabled, removeAssertion.
- Variable names must match ^[A-Za-z_][A-Za-z0-9_]*$ and must not start with "__".
- Do not include id, category, description, explanation, confidence, currentValue, proposedValue, xmlElement, notes, markdown, or any extra field.
- Do not propose JSR223, Groovy, BeanShell, JavaScript execution, or any unsupported patch kind.
- For regex extractors, use exactly one capture group and set useHeaders=true only for Location/Set-Cookie/header values.
- For JSON extractors, use JSON only when the value is produced in a response body JSON field.
- For CSS extractors, use only when the failing response evidence shows an HTML input/meta value.
- Remove assertions only when failing response evidence shows the assertion is wrong for a healthy response shape.
- If a failure cannot be fixed from the provided evidence, omit it. An empty fix list is better than a hallucinated patch.

${blueprintEvidence ? `## BLUEPRINT EVIDENCE
${JSON.stringify(blueprintEvidence, null, 2)}

` : ''}## FAILURES
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
        maxReplans: clampInt(agentCfg.maxReplans, 0, 2, 0),
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

function guardedApplyPatch({ guard, blockedDisables, onLog, valueFlow = null, stableJtl = '', outDir = '', name = '', adjudicationRecords = [] }) {
    let pendingFoldProbes = [];
    return async (jmxPath, failureReport, harEntries, options = {}) => {
        const probeResult = evaluateFoldProbes({ pending: pendingFoldProbes, failureReport, guard });
        pendingFoldProbes = probeResult.pending;
        if (probeResult.accepted.length) {
            onLog(`fold probe: accepted ${probeResult.accepted.length} plumbing disable(s): ${probeResult.accepted.map(p => p.samplerLabel).slice(0, 4).join(', ')}`);
        }
        if (probeResult.rejected.length) {
            onLog(`fold probe: rolling back ${probeResult.rejected.length} disable(s) that harmed protected flow: ${probeResult.rejected.map(p => p.samplerLabel).slice(0, 4).join(', ')}`);
            jmxPath = rollbackRejectedFoldProbes({ jmxPath, rejected: probeResult.rejected, iteration: options.iteration || 0 });
        }
        const evidence = buildAttemptRunEvidence({ entries: harEntries, stableJtl, outDir, onLog });
        const forensics = buildPatchFailureForensics({ entries: harEntries, evidence, onLog });
        const filtered = guardFailureReportWithAdjudication({
            failureReport,
            entries: harEntries,
            evidence,
            valueFlow,
            guard,
            failureForensics: forensics,
        });
        filtered.report = suppressRejectedProbeDisables(filtered.report, probeResult.rejected);
        if (probeResult.accepted.length || probeResult.rejected.length) {
            filtered.adjudication.foldProbe = {
                accepted: probeResult.accepted,
                rejected: probeResult.rejected,
            };
        }
        writeRequestAdjudicationArtifacts({
            outDir,
            name,
            iteration: options.iteration || 0,
            adjudication: filtered.adjudication,
            records: adjudicationRecords,
        });
        if (filtered.blocked.length) {
            blockedDisables.push(...filtered.blocked.map(item => ({
                sampler: item.samplerLabel,
                reason: item.reason,
                responseCode: item.responseCode,
            })));
            onLog(`strict business guard: blocked disable of ${filtered.blocked.length} protected sampler(s): ` +
                filtered.blocked.map(item => item.samplerLabel).slice(0, 4).join(', '));
        }
        logRequestAdjudication(filtered.adjudication, onLog);
        const patchResult = await autoPatcher.applyPatch(jmxPath, filtered.report, harEntries, options);
        if ((!patchResult || !patchResult.patchedJmxPath) && hasAdjudicatorStop(filtered.adjudication)) {
            const root = filtered.adjudication.actions.stop[0];
            onLog(`adjudicator: auth/session wall recorded at ${root.samplerLabel}; continuing bounded iterations for evidence without unsafe downstream patches`);
            return continueWithNoopPatch({ jmxPath, iteration: options.iteration || 0, reason: root.reason });
        }
        if (patchResult && patchResult.patchedJmxPath) {
            pendingFoldProbes = buildPendingFoldProbes({
                adjudication: filtered.adjudication,
                failureReport,
                guard,
                iteration: options.iteration || 0,
            });
        }
        return patchResult;
    };
}

function buildPendingFoldProbes({ adjudication, failureReport, guard, iteration = 0 } = {}) {
    const disables = adjudication && adjudication.actions && Array.isArray(adjudication.actions.disable)
        ? adjudication.actions.disable
        : [];
    const allowed = new Set(['dead_plumbing', 'safe_browser_plumbing', 'redirect_hop']);
    return disables
        .filter(item => item && allowed.has(item.category) && item.samplerLabel)
        .map(item => ({
            samplerLabel: item.samplerLabel,
            category: item.category,
            iteration,
            protectedFailuresBefore: [...protectedFailureLabels(failureReport, guard)],
            failureCountBefore: allFailureLabels(failureReport).size,
        }));
}

function evaluateFoldProbes({ pending = [], failureReport = {}, guard = null } = {}) {
    if (!pending.length) return { accepted: [], rejected: [], pending: [] };
    const protectedNow = protectedFailureLabels(failureReport, guard);
    const allNow = allFailureLabels(failureReport);
    const accepted = [];
    const rejected = [];
    const stillPending = [];
    for (const probe of pending) {
        const beforeProtected = new Set(probe.protectedFailuresBefore || []);
        const newProtected = [...protectedNow].filter(label => !beforeProtected.has(label));
        if (newProtected.length) {
            rejected.push({ ...probe, newProtectedFailures: newProtected });
            continue;
        }
        if (allNow.size <= Number(probe.failureCountBefore || 0)) {
            accepted.push(probe);
            continue;
        }
        stillPending.push(probe);
    }
    return { accepted, rejected, pending: stillPending };
}

function protectedFailureLabels(failureReport = {}, guard = null) {
    const protectedNames = guard && guard.protectedNames instanceof Set ? guard.protectedNames : new Set();
    const out = new Set();
    for (const label of allFailureLabels(failureReport)) {
        if (protectedNames.has(label)) out.add(label);
    }
    return out;
}

function allFailureLabels(failureReport = {}) {
    const out = new Set();
    const rows = [
        ...(failureReport.brokenSamplers || []),
        ...(failureReport.samplersToDisable || []),
        ...(failureReport.unresolvedFailures || []),
    ];
    for (const row of rows) {
        const label = String(row && (row.samplerLabel || row.sampler || row.label || row.name) || '').trim();
        if (label) out.add(label);
    }
    return out;
}

function suppressRejectedProbeDisables(report = {}, rejected = []) {
    if (!rejected.length || !report || !Array.isArray(report.samplersToDisable)) return report;
    const blocked = new Set(rejected.map(item => item.samplerLabel));
    return {
        ...report,
        samplersToDisable: report.samplersToDisable.filter(item => !blocked.has(String(item.samplerLabel || '').trim())),
    };
}

function rollbackRejectedFoldProbes({ jmxPath, rejected = [], iteration = 0 } = {}) {
    if (!jmxPath || !fs.existsSync(jmxPath) || !rejected.length) return jmxPath;
    const fixes = rejected.map(item => ({ kind: 'setSamplerEnabled', sampler: item.samplerLabel, enabled: true }));
    const xml = fs.readFileSync(jmxPath, 'utf8');
    const patched = applyLlmPatches(xml, fixes);
    if (!patched.applied.length) return jmxPath;
    const parsed = path.parse(jmxPath);
    const suffix = iteration ? `_fold_probe_rollback_iter_${iteration}` : '_fold_probe_rollback';
    const patchedJmxPath = path.join(parsed.dir, `${parsed.name}${suffix}${parsed.ext || '.jmx'}`);
    fs.writeFileSync(patchedJmxPath, patched.xml);
    return patchedJmxPath;
}

function hasAdjudicatorStop(adjudication) {
    return !!(adjudication && adjudication.actions && Array.isArray(adjudication.actions.stop) && adjudication.actions.stop.length);
}

function continueWithNoopPatch({ jmxPath, iteration = 0, reason = '' } = {}) {
    if (!jmxPath || !fs.existsSync(jmxPath)) return { patchedJmxPath: null, patchSummary: [] };
    const parsed = path.parse(jmxPath);
    const suffix = iteration ? `_adjudication_iter_${iteration}` : '_adjudication_continue';
    const patchedJmxPath = path.join(parsed.dir, `${parsed.name}${suffix}${parsed.ext || '.jmx'}`);
    if (path.resolve(jmxPath) !== path.resolve(patchedJmxPath)) {
        fs.copyFileSync(jmxPath, patchedJmxPath);
    }
    return {
        patchedJmxPath,
        patchSummary: [{
            type: 'SKIPPED',
            sampler: '',
            reason: reason || 'auth/session wall recorded; no safe patch available, continuing bounded evidence collection',
        }],
    };
}

function buildPatchFailureForensics({ entries = [], evidence = null, onLog = () => {} } = {}) {
    try {
        if (!evidence) return null;
        return failureForensics.analyzeFailureForensics({
            entries,
            samples: evidence.samples || [],
            evidence,
        });
    } catch (e) {
        onLog(`adjudicator forensics skipped: ${e.message}`);
        return null;
    }
}

function writeRequestAdjudicationArtifacts({ outDir = '', name = '', iteration = 0, adjudication = null, records = [] } = {}) {
    if (!outDir || !name || !adjudication) return null;
    try {
        fs.mkdirSync(outDir, { recursive: true });
        const record = {
            iteration,
            generatedAt: new Date().toISOString(),
            summary: adjudication.summary || {},
            actions: adjudication.actions || {},
            decisions: Object.values(adjudication.byIndex || {}),
        };
        records.push(record);
        const iterPath = path.join(outDir, `${name}_request_adjudication_iter_${iteration}.json`);
        const aggregatePath = path.join(outDir, `${name}_request_adjudication.json`);
        fs.writeFileSync(iterPath, JSON.stringify(record, null, 2));
        fs.writeFileSync(aggregatePath, JSON.stringify({ name, iterations: records }, null, 2));
        return { iterPath, aggregatePath };
    } catch {
        return null;
    }
}

function logRequestAdjudication(adjudication, onLog = () => {}) {
    if (!adjudication || !adjudication.summary) return;
    const summary = adjudication.summary;
    if (!summary.disable && !summary.protect && !summary.ignore && !summary.stop && !summary.blocked) return;
    onLog(`adjudicator: disabled ${summary.disable || 0} dead/safe plumbing sampler(s), protected ${summary.protect || 0} producer/business sampler(s), ${summary.ignore || 0} downstream casualties ignored`);
}

function guardFailureReportWithAdjudication({
    failureReport = {},
    entries = [],
    evidence = null,
    valueFlow = null,
    guard = null,
    failureForensics = null,
} = {}) {
    const adjudicated = postRunAdjudicator.adjudicateFailureReport({
        failureReport,
        entries,
        evidence,
        valueFlow,
        guard,
        failureForensics,
    });
    const filtered = businessGuard.filterProtectedDisables(adjudicated.report, guard);
    return {
        report: filtered.report,
        blocked: [...(adjudicated.blocked || []), ...(filtered.blocked || [])],
        adjudication: adjudicated.adjudication,
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

function buildAttemptRunEvidence({ entries = [], stableJtl = '', outDir = '', onLog = () => {} } = {}) {
    try {
        const jtlPath = stableJtl && fs.existsSync(stableJtl) ? stableJtl : findLastJtl(outDir);
        if (!jtlPath) return null;
        return runEvidence.buildRunEvidence({ entries, jtlPath });
    } catch (e) {
        onLog(`run evidence skipped: ${e.message}`);
        return null;
    }
}

function baselineDiffArtifact(diff) {
    if (!diff || !diff.evidence) return diff;
    return {
        ...diff,
        evidence: {
            jtlPath: diff.evidence.jtlPath,
            samples: (diff.evidence.samples || []).length,
            rows: (diff.evidence.rows || []).map(row => ({
                entryIndex: row.entryIndex,
                sampleIndex: row.sampleIndex,
                label: row.label,
                recordedStatus: row.recordedStatus,
                observedStatus: row.observedStatus,
                recordedUrl: row.recordedUrl,
                finalUrl: row.finalUrl,
                subUrls: row.subUrls,
                recordedBodyLength: row.recordedBodyLength,
                observedBodyLength: row.observedBodyLength,
                assertionFailure: row.assertionFailure,
                success: row.success,
            })),
        },
    };
}

function adjudicatedDisableFixes(result = {}) {
    if (!result || result.success !== true) return [];
    const allowed = new Set(['dead_plumbing', 'safe_browser_plumbing', 'redirect_hop']);
    const iterations = result.requestAdjudication && Array.isArray(result.requestAdjudication.iterations)
        ? result.requestAdjudication.iterations
        : [];
    const fixes = [];
    const seen = new Set();
    for (const iter of iterations) {
        const disables = iter && iter.actions && Array.isArray(iter.actions.disable) ? iter.actions.disable : [];
        for (const item of disables) {
            const sampler = String(item.samplerLabel || item.sampler || '').trim();
            if (!sampler || !allowed.has(item.category) || seen.has(sampler)) continue;
            seen.add(sampler);
            fixes.push({ kind: 'setSamplerEnabled', sampler, enabled: false });
        }
    }
    return fixes;
}

function applyStatusRootCauseToResult(result = {}, entries = [], evidence = null) {
    const statusRootCause = statusAnalysis.traceStatusRootCause({
        entries,
        samples: result.samples || [],
        evidence,
    });
    result.statusRootCause = statusRootCause;
    if (statusRootCause) {
        result.success = false;
        result.recordingDriftFailure = true;
        result.failureMessage = statusRootCause.summary;
    } else {
        delete result.recordingDriftFailure;
    }
    return result;
}

function attachFailureForensics({ result = {}, entries = [], evidence = null, outDir, name, blueprintCtx = null, onLog = () => {} } = {}) {
    const analysis = failureForensics.analyzeFailureForensics({
        entries,
        samples: result.samples || [],
        evidence,
    });
    result.failureForensics = analysis;
    if (blueprintCtx && blueprintCtx.validation) blueprintCtx.validation.failureForensics = analysis;
    if (outDir && name) {
        fs.writeFileSync(path.join(outDir, `${name}_failure_forensics.json`), JSON.stringify(analysis, null, 2));
        fs.writeFileSync(path.join(outDir, `${name}_failure_forensics.md`), failureForensics.renderFailureForensicsMarkdown(name, analysis));
    }
    if (analysis.rootCause) {
        const root = analysis.rootCause;
        const missing = analysis.authSession && analysis.authSession.missingSessionCookies && analysis.authSession.missingSessionCookies.length
            ? `; missing session cookie(s): ${analysis.authSession.missingSessionCookies.join(', ')}`
            : '';
        onLog(`failure forensics: first divergence ${root.sampler} recorded ${root.recordedStatus} observed ${root.observedStatus}${missing}`);
    }
    return analysis;
}

function refreshBlueprintFirstFailure(ctx, result = {}) {
    if (!ctx || !ctx.loop) return null;
    if (result.statusRootCause) {
        if (ctx.validation) ctx.validation.statusRootCause = result.statusRootCause;
        ctx.loop.firstFailure = classifyFirstFailure(result);
        return ctx.loop.firstFailure;
    }
    ctx.loop.firstFailure = ctx.loop.firstFailure || classifyFirstFailure(result);
    return ctx.loop.firstFailure;
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

function reverifyIterationBudget(config = {}) {
    return clampInt(config.maxIterations, 1, 5, 1);
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

function summarizeBlueprintEvidence(ctx) {
    if (!ctx) return null;
    return {
        firstFailure: ctx.loop.firstFailure || null,
        statusRootCause: ctx.validation.statusRootCause || null,
        failureForensics: ctx.validation.failureForensics ? summarizeFailureForensics(ctx.validation.failureForensics) : null,
        seniorPe: ctx.seniorPe ? summarizeSeniorPeDebrief(ctx.seniorPe) : null,
        flowIntentAnalysis: ctx.seniorPeAnalysis ? summarizeSeniorPeAnalysis(ctx.seniorPeAnalysis) : null,
        aiStrategy: ctx.seniorPeAiStrategy ? {
            proposedStrategy: ctx.seniorPeAiStrategy.proposedStrategy || null,
            questions: (ctx.seniorPeAiStrategy.questions || []).slice(0, 8),
            evidenceCitationCount: (ctx.seniorPeAiStrategy.evidenceCitations || []).length,
        } : null,
        lineageSummary: (ctx.lineage.links || []).slice(0, 25).map(l => ({
            variable: l.varName || l.variable,
            producer: l.producer,
            consumer: l.consumer,
        })),
        orphanCount: (ctx.lineage.orphans || []).length,
        repairAttempts: ctx.loop.attempts || [],
    };
}

function summarizeFailureForensics(analysis) {
    return {
        summary: analysis.summary || '',
        rootCause: analysis.rootCause || null,
        recommendedAction: analysis.recommendedAction || null,
        missingSessionCookies: analysis.authSession && analysis.authSession.missingSessionCookies || [],
        interactiveAuthWall: !!(analysis.redirects && analysis.redirects.interactiveAuthWall),
        downstreamGraphqlSymptoms: analysis.graphql && Array.isArray(analysis.graphql.downstreamSymptoms)
            ? analysis.graphql.downstreamSymptoms.length
            : 0,
    };
}

function summarizeSeniorPeAnalysis(analysis) {
    return {
        businessJourney: analysis.businessJourney,
        brokenBusinessStep: analysis.brokenBusinessStep || null,
        failureClass: analysis.failureClass,
        upstreamCause: analysis.upstreamCause || null,
        recommendedNextStrategy: analysis.recommendedNextStrategy || null,
        riskGaps: (analysis.riskGaps || []).slice(0, 12),
        seniorPeVerdict: analysis.seniorPeVerdict || null,
    };
}

function summarizeSeniorPeDebrief(debrief) {
    return {
        objective: debrief.objective || null,
        flowNarrative: debrief.flow && debrief.flow.narrative,
        stackFingerprint: (debrief.stackFingerprint && debrief.stackFingerprint.signals || []).slice(0, 8),
        valueLedger: (debrief.valueLedger || []).slice(0, 25).map(v => ({
            name: v.name,
            role: v.role,
            decision: v.decision,
            native: v.native,
            rationale: v.necessityRationale,
            provenance: v.provenance,
        })),
        nativeManagers: debrief.nativeManagers || [],
        validityGates: debrief.validityGates || [],
        negativeSpace: debrief.negativeSpace || [],
        coverage: debrief.coverage || null,
    };
}

async function tryMemoryPatchRound({ result, jmxPath, config, gen, outDir, name, onLog, agent, learning, guard }) {
    const matches = learning.enabled
        ? learningStore.findMatchingLessons({
            storePath: learning.storePath,
            failures: result,
            minConfidence: learning.autoApplyMinConfidence,
            stackFingerprint: (gen.seniorPeDebrief && gen.seniorPeDebrief.stackFingerprint && gen.seniorPeDebrief.stackFingerprint.signals) || [],
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
        const result2 = await runFeedbackLoop({ ...config, jmxPath: patchedJmxPath, maxIterations: reverifyIterationBudget(config) }, gen.flat);
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

async function tryVerifiedCorrelationRepairRound({
    result,
    jmxPath,
    config,
    gen,
    outDir,
    name,
    onLog,
    agent = normalizeAgentCfg({ enabled: true }),
    guard = null,
    blueprintCtx = null,
    feedbackLoop = runFeedbackLoop,
} = {}) {
    const failures = collectLlmFailures(result);
    const xml = fs.existsSync(jmxPath) ? fs.readFileSync(jmxPath, 'utf8') : '';
    const hypotheses = correlationHypotheses.proposeCorrelationHypotheses({
        xml,
        entries: gen.flat,
        failures,
    });
    fs.writeFileSync(
        path.join(outDir, `${name}_correlation_hypotheses.json`),
        JSON.stringify(hypotheses, null, 2)
    );
    if (blueprintCtx) {
        blueprintCtx.loop.attempts.push({
            phase: 'verified-correlation-repair',
            proposedFixes: hypotheses.fixes.length,
            attempts: hypotheses.attempts,
            rejected: hypotheses.rejected,
        });
    }
    if (!hypotheses.fixes.length) {
        return {
            result,
            jmxPath,
            repair: { attempted: false, success: false, hypotheses },
            successfulFixes: [],
        };
    }

    const validation = filterProtectedPatchDisables(validateLlmPatches(hypotheses.fixes), guard);
    fs.writeFileSync(
        path.join(outDir, `${name}_correlation_hypothesis_validation.json`),
        JSON.stringify(validation, null, 2)
    );
    if (!validation.accepted.length) {
        onLog(`verified correlation repair: ${hypotheses.fixes.length} proposed fix(es), schema gate accepted none`);
        return {
            result,
            jmxPath,
            repair: { attempted: true, success: false, hypotheses, validation },
            successfulFixes: [],
        };
    }

    const fastRepair = await fastRepairLoop.runFastRepairLoop({
        xml,
        entries: gen.flat,
        fixes: validation.accepted,
        targetBaseUrl: config.targetBaseUrl,
        insecure: true,
        timeoutMs: config.timeoutMs,
        onLog,
    });
    fs.writeFileSync(
        path.join(outDir, `${name}_correlation_fast_repair.json`),
        JSON.stringify(fastRepair, null, 2)
    );
    if (fastRepair.skipped || !fastRepair.replay || !fastRepair.replay.ok) {
        onLog(`verified correlation repair: rejected hypothesis before JMeter (${fastRepair.reason || 'fast replay did not verify'})`);
        return {
            result,
            jmxPath,
            repair: { attempted: true, success: false, hypotheses, validation, fastRepair },
            successfulFixes: [],
        };
    }

    const patched = applyLlmPatches(xml, validation.accepted);
    fs.writeFileSync(
        path.join(outDir, `${name}_correlation_patches.json`),
        JSON.stringify({ applied: patched.applied, skipped: patched.skipped }, null, 2)
    );
    if (!patched.applied.length) {
        onLog(`verified correlation repair: fast replay passed but no patch applied`);
        return {
            result,
            jmxPath,
            repair: { attempted: true, success: false, hypotheses, validation, fastRepair, patched },
            successfulFixes: [],
        };
    }

    const patchedJmxPath = path.join(outDir, `${name}.correlation-patched.jmx`);
    fs.writeFileSync(patchedJmxPath, patched.xml);
    applyJavaSafeGuard({
        jmxPath: patchedJmxPath,
        outDir,
        name,
        label: 'verified_correlation',
        enabled: agent.javaSafeMode,
        onLog,
    });

    onLog(`verified correlation repair: applied ${patched.applied.length} patch(es) · re-verifying with JMeter`);
    const result2 = await feedbackLoop({ ...config, jmxPath: patchedJmxPath, maxIterations: reverifyIterationBudget(config) }, gen.flat);
    const success = !!result2.success;
    if (blueprintCtx) {
        blueprintCtx.loop.patches.push({
            phase: 'verified-correlation-repair',
            applied: patched.applied,
            skipped: patched.skipped,
            success,
        });
    }
    return {
        success,
        result: result2,
        jmxPath: result2.finalJmxPath || patchedJmxPath,
        repair: {
            attempted: true,
            success,
            hypotheses,
            validation,
            fastRepair,
            applied: patched.applied,
            skipped: patched.skipped,
        },
        successfulFixes: success ? validation.accepted : [],
    };
}

async function runLlmPatchRounds({ result, jmxPath, config, gen, outDir, name, onLog, agentCfg, learningCfg, guard, flowNotes = [], blueprintEvidence = null, blueprintCtx = null }) {
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
    applyStatusRootCauseToResult(finalResult, gen.flat);

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

    const verifiedCorrelationAttempt = await tryVerifiedCorrelationRepairRound({
        result: finalResult,
        jmxPath: finalJmxPath,
        config,
        gen,
        outDir,
        name,
        onLog,
        agent,
        guard,
        blueprintCtx,
    });
    finalResult = verifiedCorrelationAttempt.result;
    finalJmxPath = verifiedCorrelationAttempt.jmxPath;
    successfulFixes.push(...verifiedCorrelationAttempt.successfulFixes);
    applyStatusRootCauseToResult(finalResult, gen.flat);
    if (verifiedCorrelationAttempt.repair.attempted) {
        onLog(`verified correlation repair: ${verifiedCorrelationAttempt.repair.success ? 'succeeded' : 'did not close all failures'}`);
    }

    if (finalResult.success) {
        return {
            result: finalResult,
            jmxPath: finalJmxPath,
            llmPatch: {
                memory: memoryAttempt.memoryPatch,
                verifiedCorrelation: verifiedCorrelationAttempt.repair,
                rounds,
                success: true,
                successfulFixes,
            },
        };
    }

    const fastRepairRounds = [];
    for (let round = 1; round <= agent.maxLlmRounds && !finalResult.success; round++) {
        const fixes = await escalateToLlm({
            result: finalResult, jmxPath: finalJmxPath,
            correlations: gen.correlations, outDir, name, onLog, flowNotes, blueprintEvidence,
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
            const fastRepair = await fastRepairLoop.runFastRepairLoop({
                xml: before,
                entries: gen.flat,
                fixes: validation.accepted,
                targetBaseUrl: config.targetBaseUrl,
                insecure: true,
                timeoutMs: config.timeoutMs,
                onLog,
            });
            fastRepairRounds.push({ round, ...fastRepair });
            fs.writeFileSync(
                path.join(outDir, `${name}_fast_repair_rounds.json`),
                JSON.stringify(fastRepairRounds, null, 2)
            );
            if (!fastRepair.skipped && !fastRepair.replay.ok) {
                onLog(`fast repair loop round ${round}: rejected patch hypothesis before JMeter`);
                rounds.push({ round, applied: 0, skipped: 0, success: false, fastReplay: false });
                break;
            }
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
            const result2 = await runFeedbackLoop({ ...config, jmxPath: patchedJmxPath, maxIterations: reverifyIterationBudget(config) }, gen.flat);
            applyStatusRootCauseToResult(result2, gen.flat);
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
        llmPatch: (rounds.length || memoryAttempt.memoryPatch || verifiedCorrelationAttempt.repair.attempted)
            ? { memory: memoryAttempt.memoryPatch, verifiedCorrelation: verifiedCorrelationAttempt.repair, rounds, success: !!finalResult.success, successfulFixes, fastRepair: fastRepairRounds }
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

    // Golden judgments are operator decisions: the business guard must not
    // protect (or fail the verdict over) samplers a human's working script
    // deliberately disables.
    if (Array.isArray(gen.goldenDisables) && gen.goldenDisables.length) {
        enrichedRunCfg.disableCalls = [...(enrichedRunCfg.disableCalls || []), ...gen.goldenDisables];
        onLog(`golden: adopted ${gen.goldenDisables.length} disable judgment(s) from the working script`);
    }
    // Playbook priors likewise: their disables are deliberate, and their flow
    // notes must reach AI escalation.
    if (Array.isArray(gen.playbookDisables) && gen.playbookDisables.length) {
        enrichedRunCfg.disableCalls = [...(enrichedRunCfg.disableCalls || []), ...gen.playbookDisables];
    }
    // App-specific business nouns from playbooks: the guard protects them so
    // no generic regex ever has to know one app's endpoint names.
    if (Array.isArray(gen.playbookProtects) && gen.playbookProtects.length) {
        enrichedRunCfg.protectedCalls = [...(enrichedRunCfg.protectedCalls || []), ...gen.playbookProtects];
    }
    if (Array.isArray(gen.playbooksApplied) && gen.playbooksApplied.length) {
        enrichedRunCfg.llmFlowNotes = gen.effectiveLlmFlowNotes;
        onLog(`playbooks: ${gen.playbooksApplied.map(p => p.id).join(', ')}`);
    }

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
    const targetBaseUrl = (enrichedRunCfg.targetBaseUrlOverride || '').trim() || deriveBaseUrl(gen.flat);
    if (!targetBaseUrl) return { ok: false, error: 'No target base URL could be determined (set run.targetBaseUrlOverride).' };
    enrichedRunCfg.targetBaseUrl = targetBaseUrl;
    let finalRunCfg = enrichedRunCfg;
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
            'jmeter.save.saveservice.responseHeaders': 'true',
            'jmeter.save.saveservice.url': 'true',
        },
        onIteration: (s) => {
            onLog(`[iter] ${JSON.stringify(s).slice(0, 180)}`);
            steeringTick('between JMeter iterations');
        },
    };
    // Rebound once the steering channel exists (declared below, after the
    // guard); the engine loop only starts after that, so this stub never
    // races the real hook.
    let steeringTick = () => 0;

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
    const valueFlow = valueFlowDecisions.classifySamplerDisableDecisions({
        entries: gen.flat,
        protectedCalls: enrichedRunCfg.protectedCalls,
    });
    const samplerDecisions = samplerDecision.classifySamplerDecisions({
        entries: gen.flat,
        valueFlow,
    });
    let currentSamplerDecisions = samplerDecisions;
    const strictGuard = businessGuard.buildBusinessGuard({
        xml: guardXml,
        flowName: name,
        runCfg: enrichedRunCfg,
        valueFlowDecisions: samplerDecisions,
    });
    const blockedDisables = [];
    const requestAdjudications = [];
    if (strictGuard.enabled) {
        onLog(`strict business guard: protecting ${strictGuard.protectedSamplers.length} sampler(s) from disable`);
    }

    // ── Live operator steering ─────────────────────────────────────────
    // The UI writes messages into a per-run steering file; we poll it at
    // every decision checkpoint. protect = instant (guard reads the set
    // live); disable = folded from the next repair/regeneration; free text
    // = injected into AI escalation + replan context; questions get an
    // answer in the chat. Every applied message is acknowledged so the
    // operator sees exactly what changed course.
    const steering = steeringModule.createSteeringChannel({ file: process.env.PERFSCRIPT_STEERING, onLog });
    const applySteering = (checkpoint) => {
        const commands = steering.poll();
        for (const cmd of commands) {
            if (cmd.kind === 'protect') {
                enrichedRunCfg.protectedCalls = [...(enrichedRunCfg.protectedCalls || []), cmd.pattern];
                let hits = 0;
                try {
                    const currentXml = fs.readFileSync(finalJmxPathRef.value, 'utf8');
                    for (const s of businessGuard._internal.indexSamplers(currentXml)) {
                        if (`${s.name} ${s.domain || ''}${s.path || ''}`.includes(cmd.pattern)) {
                            strictGuard.protectedNames.add(s.name); hits++;
                        }
                    }
                } catch { /* jmx unreadable mid-write — protectedCalls still covers rebuilds */ }
                steering.say(`Protected "${cmd.pattern}" (${hits} sampler(s) matched) — I will not disable these, effective immediately.`);
            } else if (cmd.kind === 'disable') {
                enrichedRunCfg.disableCalls = [...(enrichedRunCfg.disableCalls || []), cmd.pattern];
                let disabledNow = 0;
                try {
                    const currentXml = fs.readFileSync(finalJmxPathRef.value, 'utf8');
                    const dis = stripAwareDisable(currentXml, cmd.pattern, strictGuard);
                    if (dis.disabled > 0) { fs.writeFileSync(finalJmxPathRef.value, dis.xml); disabledNow = dis.disabled; }
                } catch { /* applied at next regeneration instead */ }
                steering.say(`Disabling "${cmd.pattern}" — ${disabledNow} sampler(s) folded now, and every regeneration this run inherits it.` +
                    (disabledNow === 0 ? ' (No live match yet; it will apply at the next regeneration.)' : ''));
            } else if (cmd.kind === 'question') {
                const ff = blueprintCtx && blueprintCtx.loop && blueprintCtx.loop.firstFailure;
                const lastAttempt = blueprintCtx && blueprintCtx.loop && blueprintCtx.loop.attempts.slice(-1)[0];
                steering.say(`You asked: "${cmd.text}" · Current diagnosis: ${ff ? `${ff.category || 'unclassified'} — ${(ff.message || '').slice(0, 160)}` : 'no failure classified yet'}. ` +
                    `Last attempt: ${lastAttempt ? `${lastAttempt.phase || lastAttempt.strategy || 'n/a'} (${lastAttempt.success ? 'succeeded' : 'not green'})` : 'initial validation'}. ` +
                    `Checkpoint: ${checkpoint}.`);
            } else {
                enrichedRunCfg.llmFlowNotes = [...(enrichedRunCfg.llmFlowNotes || []), `OPERATOR (live, during run): ${cmd.text}`];
                steering.say(`Noted — your guidance will steer the next AI round and any replan: "${cmd.text.slice(0, 140)}"`);
            }
        }
        return commands.length;
    };
    const stripAwareDisable = (xml, pattern, guard) => disableByPatternTransform(xml, [pattern], {
        protect: (s) => guard && guard.protectedNames && guard.protectedNames.has(s.name),
    });
    const finalJmxPathRef = { value: gen.jmxPath };
    steeringTick = (checkpoint) => { try { return applySteering(checkpoint); } catch (e) { onLog(`steering poll skipped: ${e.message}`); return 0; } };
    if (steering.active) steering.say(`Chat online. You can steer me while I work: "protect <name>", "disable <name>", free-text guidance, or a question ending in "?".`);

    const blueprintCtx = blueprintContext.createBlueprintContext({
        entries,
        secondaryEntries: genOpts.secondaryEntries || [],
        pages,
        mode: 'run',
        outDir,
        name,
        runCfg: enrichedRunCfg,
        agentCfg: agent,
    });
    blueprintCtx.validation.businessGuard = {
        enabled: strictGuard.enabled,
        protectedSamplers: strictGuard.protectedSamplers,
    };
    blueprintCtx.seniorPe = gen.seniorPeDebrief || null;
    blueprintCtx.lineage.disableDecisions = samplerDecisions;
    let blueprintEvidence = null;
    if (agent.enabled) {
        try {
            await blueprintAgent.runBlueprintPreflight({
                ctx: blueprintCtx,
                entries: gen.flat,
                runCfg: enrichedRunCfg,
                onLog,
            });
            blueprintEvidence = summarizeBlueprintEvidence(blueprintCtx);
        } catch (e) {
            onLog(`blueprint preflight skipped after error: ${e.message}`);
            blueprintCtx.loop.attempts.push({ phase: 'replay-preflight', error: e.message });
            blueprintEvidence = summarizeBlueprintEvidence(blueprintCtx);
        }
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
            applyPatch: guardedApplyPatch({
                guard: strictGuard,
                blockedDisables,
                onLog,
                valueFlow,
                stableJtl,
                outDir,
                name,
                adjudicationRecords: requestAdjudications,
            }),
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
    finalJmxPathRef.value = finalJmxPath;
    steeringTick('after initial validation');
    recoverSamplesFromJtl(result, stableJtl, outDir, onLog);
    let currentEvidence = buildAttemptRunEvidence({ entries: gen.flat, stableJtl, outDir, onLog });
    let verified = applyBusinessVerification(result, finalJmxPath, strictGuard, blockedDisables);
    let finalResult = verified.result;
    if (!verified.evaluation.ok) {
        onLog(`strict business guard: NOT GREEN — ${verified.evaluation.reason}`);
    } else if (strictGuard.enabled) {
        onLog(`strict business guard: ${verified.evaluation.reason}`);
    }
    applyStatusRootCauseToResult(finalResult, gen.flat, currentEvidence);
    if (finalResult.statusRootCause) {
        blueprintCtx.validation.statusRootCause = finalResult.statusRootCause;
        onLog(`status root cause: ${finalResult.statusRootCause.summary}`);
    }
    attachFailureForensics({ result: finalResult, entries: gen.flat, evidence: currentEvidence, outDir, name, blueprintCtx, onLog });
    refreshBlueprintFirstFailure(blueprintCtx, finalResult);
    try {
        blueprintCtx.seniorPeAnalysis = seniorPeAnalysis.analyzeSeniorPeFailure({
            name,
            seniorPeDebrief: gen.seniorPeDebrief || null,
            result: finalResult,
            blueprintEvidence: summarizeBlueprintEvidence(blueprintCtx),
        });
        seniorPeAnalysis.writeSeniorPeAnalysisArtifacts(outDir, name, blueprintCtx.seniorPeAnalysis);
        blueprintCtx.seniorPeAiStrategy = seniorPeAnalysis.buildAiStrategy(blueprintCtx.seniorPeAnalysis);
        seniorPeAnalysis.writeAiStrategyArtifacts(outDir, name, blueprintCtx.seniorPeAiStrategy);
        onLog(`senior PE analysis: ${blueprintCtx.seniorPeAnalysis.failureClass} → ${blueprintCtx.seniorPeAnalysis.recommendedNextStrategy.id}`);
    } catch (e) {
        onLog(`senior PE analysis skipped: ${e.message}`);
    }
    blueprintEvidence = summarizeBlueprintEvidence(blueprintCtx);
    let llmPatch = null;
    if (!finalResult.success) {
        if (agent.enabled && targetBaseUrl) {
            try {
                const failingResponses = await responseEvidence.collectFailingResponseEvidence({
                    entries: gen.flat,
                    failures: collectLlmFailures(finalResult),
                    targetBaseUrl,
                    insecure: !!(enrichedRunCfg.fastReplay && enrichedRunCfg.fastReplay.insecure),
                    timeoutMs: enrichedRunCfg.fastReplay && enrichedRunCfg.fastReplay.timeoutMs,
                });
                if (failingResponses.length) {
                    blueprintCtx.validation.failingResponses = failingResponses;
                    blueprintEvidence = { ...summarizeBlueprintEvidence(blueprintCtx), failingResponses };
                    onLog(`blueprint evidence: captured ${failingResponses.length} failing response body excerpt(s)`);
                }
            } catch (e) {
                onLog(`blueprint failing-response evidence skipped: ${e.message}`);
            }
        }
        steeringTick('before AI escalation');
        if (steering.active) steering.say('Deterministic repair is exhausted — starting AI escalation. Guidance sent now reaches the model.');
        const flowNotes = Array.isArray(enrichedRunCfg.llmFlowNotes) ? enrichedRunCfg.llmFlowNotes : [];
        const llm = await runLlmPatchRounds({
            result: finalResult, jmxPath: finalJmxPath, config, gen, outDir, name, onLog, agentCfg: agent, learningCfg: learning, guard: strictGuard, flowNotes, blueprintEvidence, blueprintCtx,
        });
        finalJmxPath = llm.jmxPath;
        finalJmxPathRef.value = finalJmxPath;
        recoverSamplesFromJtl(llm.result, stableJtl, outDir, onLog);
        currentEvidence = buildAttemptRunEvidence({ entries: gen.flat, stableJtl, outDir, onLog });
        verified = applyBusinessVerification(llm.result, finalJmxPath, strictGuard, blockedDisables);
        finalResult = verified.result;
        applyStatusRootCauseToResult(finalResult, gen.flat, currentEvidence);
        if (finalResult.statusRootCause) {
            blueprintCtx.validation.statusRootCause = finalResult.statusRootCause;
        }
        attachFailureForensics({ result: finalResult, entries: gen.flat, evidence: currentEvidence, outDir, name, blueprintCtx, onLog });
        if (!verified.evaluation.ok) {
            onLog(`strict business guard after AI escalation: NOT GREEN — ${verified.evaluation.reason}`);
        }
        llmPatch = llm.llmPatch;
    }

    // ORGANIC RE-PLANNING: repair rounds patch the current script; when they
    // are exhausted the agent changes APPROACH — it regenerates with a
    // different strategy chosen from the failure evidence (flip state
    // handling, fold disposables, relieve assertions) and verifies the new
    // script like any other attempt. Bounded; every attempt recorded.
    const replans = [];
    if (!finalResult.success && agent.enabled) {
        const triedStrategies = [];
        for (let attempt = 1; attempt <= agent.maxReplans && !finalResult.success; attempt++) {
            steeringTick('before replan');
            const strategy = replanner.proposeReplan({
                result: finalResult,
                runCfg: finalRunCfg,
                valueFlow: samplerDecisions,
                classification: (blueprintCtx && blueprintCtx.loop && blueprintCtx.loop.firstFailure) || null,
                seniorPeAnalysis: blueprintCtx && blueprintCtx.seniorPeAnalysis || null,
                tried: triedStrategies,
            });
            if (!strategy) { onLog('replan: no untried strategy fits the evidence'); break; }
            triedStrategies.push(strategy.id);
            if (steering.active) steering.say(`Replanning with strategy "${strategy.id}": ${strategy.reason.slice(0, 160)} — say "protect <name>" now if I should not touch something.`);
            onLog(`REPLAN ${attempt}/${agent.maxReplans}: ${strategy.id} — ${strategy.reason}`);
            try {
                const replanCfg = { ...finalRunCfg, ...strategy.runCfgPatch };
                const replanDir = path.join(outDir, `replan_${attempt}`);
                const gen2 = generate(entries, pages, replanDir, name, { ...genOpts, runCfg: replanCfg });
                try {
                    const swap = stripGuiListenersForRun(fs.readFileSync(gen2.jmxPath, 'utf8'), stableJtl);
                    if (swap.disabled > 0) fs.writeFileSync(gen2.jmxPath, swap.xml);
                } catch { /* keep unstripped */ }
                applyJavaSafeGuard({ jmxPath: gen2.jmxPath, outDir: replanDir, name, label: `replan_${attempt}`, enabled: agent.javaSafeMode, onLog });
                try { fs.rmSync(stableJtl, { force: true }); } catch { /* locked */ }
                const valueFlow2 = valueFlowDecisions.classifySamplerDisableDecisions({
                    entries: gen2.flat,
                    protectedCalls: replanCfg.protectedCalls,
                });
                const samplerDecisions2 = samplerDecision.classifySamplerDecisions({ entries: gen2.flat, valueFlow: valueFlow2 });
                const guard2 = businessGuard.buildBusinessGuard({
                    xml: fs.readFileSync(gen2.jmxPath, 'utf8'),
                    flowName: name,
                    runCfg: replanCfg,
                    valueFlowDecisions: samplerDecisions2,
                });
                const replanBlockedDisables = [];
                const result2 = await runFeedbackLoop(
                    { ...config, jmxPath: gen2.jmxPath, maxIterations: reverifyIterationBudget(config) },
                    gen2.flat,
                    {
                        applyPatch: guardedApplyPatch({
                            guard: guard2,
                            blockedDisables: replanBlockedDisables,
                            onLog,
                            valueFlow: valueFlow2,
                            stableJtl,
                            outDir,
                            name,
                            adjudicationRecords: requestAdjudications,
                        }),
                    }
                );
                recoverSamplesFromJtl(result2, stableJtl, outDir, onLog);
                const evidence2 = buildAttemptRunEvidence({ entries: gen2.flat, stableJtl, outDir, onLog });
                const verified2 = applyBusinessVerification(result2, result2.finalJmxPath || gen2.jmxPath, guard2, replanBlockedDisables);
                applyStatusRootCauseToResult(verified2.result, gen2.flat, evidence2);
                const success = !!verified2.result.success;
                replans.push({ attempt, strategy: strategy.id, reason: strategy.reason, evidence: strategy.evidence, success });
                if (blueprintCtx) blueprintCtx.loop.attempts.push({ phase: 'replan', strategy: strategy.id, reason: strategy.reason, success });
                if (success) {
                    onLog(`REPLAN ${strategy.id} SUCCEEDED — adopting the regenerated script as final`);
                    finalResult = verified2.result;
                    finalJmxPath = verified2.result.finalJmxPath || gen2.jmxPath;
                    finalJmxPathRef.value = finalJmxPath;
                    currentEvidence = evidence2;
                    finalRunCfg = replanCfg;
                    currentSamplerDecisions = samplerDecisions2;
                    Object.assign(gen, gen2);
                } else {
                    const stillFailing = (verified2.result.samples || []).filter(s => !s.isTransaction && s.success === false).length;
                    onLog(`replan ${strategy.id} did not reach GREEN (${stillFailing} failing) — keeping evidence, trying next strategy`);
                }
            } catch (e) {
                replans.push({ attempt, strategy: strategy.id, error: e.message, success: false });
                onLog(`replan ${strategy.id} errored: ${e.message}`);
            }
        }
    }

    if (requestAdjudications.length) {
        finalResult.requestAdjudication = { iterations: requestAdjudications };
        if (blueprintCtx && blueprintCtx.validation) blueprintCtx.validation.requestAdjudication = finalResult.requestAdjudication;
    }

    if (blueprintCtx) {
        refreshBlueprintFirstFailure(blueprintCtx, finalResult);
        blueprintCtx.ai.promptEvidence = blueprintEvidence;
        blueprintContext.writeBlueprintArtifacts(blueprintCtx);
    }

    // 5b. Baseline-vs-test diff: status / body length / JSON shape per sampler.
    //     Run before learning so false-green drift never becomes a verified lesson.
    let baselineDiff = null;
    try {
        baselineDiff = diffRunAgainstRecording({
            outDir,
            flatEntries: gen.flat,
            jtlPath: stableJtl && fs.existsSync(stableJtl) ? stableJtl : null,
        });
        if (baselineDiff.drift.length) {
            fs.writeFileSync(path.join(outDir, `${name}_baseline_diff.json`), JSON.stringify(baselineDiffArtifact(baselineDiff), null, 2));
            onLog(`baseline drift detected on ${baselineDiff.drift.length}/${baselineDiff.samplesCompared} sampler(s) — see _baseline_diff.json`);
        } else if (baselineDiff.samplesCompared > 0) {
            onLog(`baseline diff clean (${baselineDiff.samplesCompared} sampler(s) match recording)`);
        }
    } catch (e) { onLog(`baseline diff skipped: ${e.message}`); }
    if (baselineDiff && baselineDiff.evidence) currentEvidence = baselineDiff.evidence;

    const finalGate = finalGreenGate.evaluateFinalGreenGate({
        result: finalResult,
        baselineDiff,
        semanticDiff: finalResult.semanticDiff || null,
        businessVerification: finalResult.businessVerification || null,
        evidence: currentEvidence,
    });
    finalResult.finalGreenGate = finalGate;
    fs.writeFileSync(path.join(outDir, `${name}_final_green_gate.json`), JSON.stringify(finalGate, null, 2));
    if (!finalGate.ok) {
        finalResult.success = false;
        finalResult.finalGreenFailure = true;
        onLog(`final green gate: NOT GREEN — ${finalGate.reason}`);
    } else {
        onLog('final green gate: GREEN');
    }

    let learnedLessons = null;
    if (learning.enabled) {
        const fixSource = [
            ...(llmPatch && Array.isArray(llmPatch.successfulFixes) ? llmPatch.successfulFixes : []),
            ...adjudicatedDisableFixes(finalResult),
        ];
        learnedLessons = learningStore.learnFromRun({
            storePath: learning.storePath,
            flowName: name,
            sourceRun: outDir,
            appHost: targetBaseUrl,
            result: finalResult,
            fixes: fixSource,
            stackFingerprint: (gen.seniorPeDebrief && gen.seniorPeDebrief.stackFingerprint && gen.seniorPeDebrief.stackFingerprint.signals) || [],
        });
        fs.writeFileSync(
            path.join(outDir, `${name}_learned_lessons.json`),
            JSON.stringify(learnedLessons, null, 2)
        );
        if (learnedLessons.learned.length) {
            onLog(`learning memory: saved ${learnedLessons.learned.length} verified lesson(s)`);
        }
    }

    // Blocked-state report: when the verdict is not GREEN, translate the
    // terminal evidence into PRECISE human asks instead of "needs attention".
    let humanBlockers = [];
    if (!finalResult.success) {
        try {
            humanBlockers = blockersModule.deriveBlockers({
                result: finalResult,
                runCfg: finalRunCfg,
                entries: gen.flat,
                hasSecondRecording: !!(genOpts.secondaryEntries && genOpts.secondaryEntries.length),
                ghostsRefused: (gen.stats && gen.stats.ghostsRefused) || 0,
                uploadFiles: gen.uploadFiles || null,
            });
            if (humanBlockers.length) {
                fs.writeFileSync(path.join(outDir, `${name}_blockers.json`), JSON.stringify(humanBlockers, null, 2));
                fs.writeFileSync(path.join(outDir, `${name}_blockers.md`), blockersModule.renderBlockersMarkdown(name, humanBlockers));
                onLog(`BLOCKED — ${humanBlockers.length} precise ask(s) for a human:`);
                for (const b of humanBlockers) onLog(`  · ${b.ask}`);
            }
        } catch (e) { onLog(`blocker analysis skipped: ${e.message}`); }
    }

    // 5c. JMeter HTML dashboard. Best-effort and opt-in; `jmeter -g` can hang
    //     on large/XML JTLs and should never block the agent's final verdict.
    try {
        const dashboardEnabled = finalRunCfg.dashboard && finalRunCfg.dashboard.enabled === true;
        const jtlForDash = dashboardEnabled
            ? (fs.existsSync(stableJtl) ? stableJtl : (baselineDiff && baselineDiff.jtlPath) || null)
            : null;
        if (!dashboardEnabled) {
            onLog('dashboard skipped: disabled by default; set run.dashboard.enabled=true to generate JMeter HTML dashboard');
        } else if (jtlForDash) {
            const timeoutMs = Number(finalRunCfg.dashboard && finalRunCfg.dashboard.timeoutMs) || 30_000;
            const dash = await generateHtmlDashboard({ jmeterBinPath, jtlPath: jtlForDash, outDir, onLog, timeoutMs });
            if (!dash.ok) onLog(`dashboard not generated: ${dash.error}`);
        }
    } catch (e) { onLog(`dashboard skipped: ${e.message}`); }

    return {
        ok: true, result: finalResult, jmxPath: finalJmxPath, humanBlockers,
        steeringActive: steering.active,
        stats: gen.stats, baselineDiff, finalGreenGate: finalResult.finalGreenGate || null,
        memoryMatches: llmPatch && llmPatch.memory ? llmPatch.memory.matches || [] : [],
        learnedLessons,
        // Surface the generator's deeper artifacts for the HTML report so
        // it doesn't have to re-derive them.
        correlations: gen.correlations || [],
        reasoning: gen.reasoning || [],
        loadProfile: gen.loadProfile || null,
        llmPatch,
        businessVerification: finalResult.businessVerification || null,
        disableDecisions: currentSamplerDecisions,
        failureForensics: finalResult.failureForensics || null,
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
        applyStatusRootCauseToResult,
        attachFailureForensics,
        refreshBlueprintFirstFailure,
        guardFailureReportWithAdjudication,
        buildPatchFailureForensics,
        writeRequestAdjudicationArtifacts,
        logRequestAdjudication,
        hasAdjudicatorStop,
        continueWithNoopPatch,
        buildPendingFoldProbes,
        evaluateFoldProbes,
        rollbackRejectedFoldProbes,
        suppressRejectedProbeDisables,
        adjudicatedDisableFixes,
        applyJavaSafeGuard,
        tryVerifiedCorrelationRepairRound,
        summarizeBlueprintEvidence,
        buildGeminiFixPrompt,
        normalizeGeminiFixes,
        extractRelevantJmxSnippets,
    },
};
