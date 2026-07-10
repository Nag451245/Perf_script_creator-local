'use strict';
/**
 * replanner.js — change APPROACH mid-job, not just parameters.
 *
 * When every repair round has failed, a human senior does not keep patching
 * the same script — they step back and rebuild it differently: "stop
 * correlating bare state, replay it literal", "those failing beacons feed
 * nothing, fold them", "loosen the mined assertions and see what's really
 * broken". Each strategy here is exactly that: a RE-GENERATION with a
 * different runCfg, selected by the run's failure evidence, tried at most
 * once, verified like any other attempt, and recorded in the attempt log.
 *
 * Strategies are evidence-gated — a strategy that the evidence doesn't
 * support is never proposed — and the operator's explicit config is never
 * overridden (a knob the config sets stays set).
 */

/**
 * @param {Object} args
 * @param {Object} args.result        final (failed) run result
 * @param {Object} args.runCfg        effective run config of the failed attempt
 * @param {Object} args.valueFlow     classifySamplerDisableDecisions output
 * @param {Object} args.classification classifyFirstFailure output (may be null)
 * @param {Object} args.seniorPeAnalysis structured senior PE analysis (may be null)
 * @param {string[]} args.tried       strategy ids already attempted
 * @returns {null | {id, reason, evidence, runCfgPatch}}
 */
function proposeReplan({ result = {}, runCfg = {}, valueFlow = null, classification = null, seniorPeAnalysis = null, gate0 = null, tried = [] } = {}) {
    const strategies = [];
    const reqs = (result.samples || []).filter(s => !s.isTransaction);
    const failing = reqs.filter(s => s.success === false);
    if (!failing.length) return null;

    // GATE 0 CHECK — an auth/session failure is only IRREDUCIBLE if the login
    // was SENT correctly. If Gate 0 proves the auth segment sent wrong/literal
    // values (a shifted CSV credential column, an undefined ${state}/${token}),
    // the "wall" is a fixable DATA defect surfacing downstream — do NOT stop
    // and ask for a browser session; fall through to repair strategies and let
    // the data-defect blocker lead. This is the split that keeps the agent from
    // giving up on a login it simply mis-sent.
    const authDataDefect = hasAuthDataDefect(gate0);

    const authStops = adjudicationActions(result, 'stop').filter(item => item.category === 'auth_wall');
    if (authStops.length && !authDataDefect) {
        if (tried.includes('auth-wall-stop')) return null;
        return {
            id: 'auth-wall-stop',
            reason: 'post-run adjudication proved an auth/session wall AND the login was sent correctly (Gate 0 clean); stop instead of chasing downstream casualties under strict GREEN policy',
            evidence: authStops.map(item => item.samplerLabel).slice(0, 5).join(', '),
            runCfgPatch: {},
        };
    }

    const nativePatch = nativeManagerPatch(seniorPeAnalysis);
    if (nativePatch) {
        strategies.push({
            id: 'native-manager-correction',
            reason: 'senior PE analysis found native HTTP state that should be owned by JMeter managers before more extractor patching',
            evidence: nativePatch.evidence,
            runCfgPatch: { forceNativeManagers: nativePatch.forceNativeManagers },
        });
    }

    if (seniorPeAnalysis && (seniorPeAnalysis.recommendedNextStrategy || {}).id === 'scenario-gap-warning') {
        strategies.push({
            id: 'scenario-gap-warning',
            reason: 'senior PE analysis found workload/SLO/data-model gaps; record the warning and keep deterministic repair knobs unchanged',
            evidence: (seniorPeAnalysis.riskGaps || []).map(g => `${g.gap}: ${g.action || ''}`).slice(0, 4).join('; '),
            runCfgPatch: {},
        });
    }

    const adjudicatedDisables = adjudicationActions(result, 'disable')
        .filter(item => ['dead_plumbing', 'safe_browser_plumbing', 'redirect_hop'].includes(item.category))
        .map(item => item.samplerLabel || item.sampler)
        .filter(Boolean);
    if (adjudicatedDisables.length) {
        strategies.push({
            id: 'post-run-fold-dead-plumbing',
            reason: `${adjudicatedDisables.length} sampler(s) were approved by post-run adjudication for folding; use the evidence-approved list instead of broad path patterns`,
            evidence: adjudicatedDisables.slice(0, 5).join(', '),
            runCfgPatch: { disableCalls: [...new Set([...(runCfg.disableCalls || []), ...adjudicatedDisables])] },
        });
    }

    // 1. Auth-state strategy: the first failure sits in the auth/login
    //    segment → flip how bare OAuth state/nonce are handled. Whichever way
    //    the last generation went, try the other — unless the operator pinned
    //    it in config (explicit oauth config wins, we only flip the effective
    //    value when it came from a default/playbook).
    const authFailure = failing.some(s => /login|logon|authorize|callback|identifier|password|oauth|oidc|saml|sso|iam|session|token|mfa|otp|2fa|challenge|verify|step-?up|realms|adfs|connect\/token/i.test(String(s.label || s.name || ''))) ||
        (classification && /auth|session|redirect/i.test(String(classification.category || '')));
    if (authFailure && !(runCfg.oauth && runCfg.oauth._operatorPinned)) {
        const current = !!(runCfg.oauth && runCfg.oauth.dropBareStateNonce);
        strategies.push({
            id: current ? 'correlate-bare-state-nonce' : 'drop-bare-state-nonce',
            reason: current
                ? 'auth segment still failing with state/nonce replayed as recorded literals — regenerate WITH bare state/nonce correlation'
                : 'auth segment failing with correlated state/nonce — regenerate replaying the recorded literals (some IdPs validate server-side session, not the echoed value)',
            evidence: `failing auth-segment sampler(s): ${failing.filter(s => /login|authorize|callback|identifier|password|oauth|iam/i.test(String(s.label || s.name || ''))).map(s => s.label || s.name).slice(0, 3).join(', ') || classification && classification.category}`,
            runCfgPatch: { oauth: { ...(runCfg.oauth || {}), dropBareStateNonce: !current } },
        });
    }

    // 2. Fold-disposables strategy: value-flow analysis marked failing
    //    samplers as disposable plumbing (nothing downstream consumes their
    //    output) → regenerate with them disabled from the start.
    const disposable = decisionRows(valueFlow)
        .filter(d => ['foldable_plumbing', 'disposable_plumbing'].includes(d.decision) && (d.failed || d.responseCode || d.sourceDecision))
        .map(d => d.samplerLabel || d.sampler)
        .filter(Boolean);
    if (disposable.length) {
        strategies.push({
            id: 'fold-disposable-plumbing',
            reason: `${disposable.length} failing sampler(s) produce nothing any later request consumes — fold them and re-verify the business flow without the noise`,
            evidence: disposable.slice(0, 5).join(', '),
            runCfgPatch: { disableCalls: [...new Set([...(runCfg.disableCalls || []), ...disposable])] },
        });
    }

    // 3. Assertion-relief strategy: every failing sampler returned 2xx/3xx —
    //    the flow may be healthy and the mined assertions wrong. Regenerate
    //    without mined assertions so the NEXT run separates "text drifted"
    //    from "flow broken". (Outcome probe and guard still stand watch.)
    const allSoft = failing.every(s => /^(2|3)\d\d$/.test(String(s.responseCode || s.code || '')));
    if (allSoft && runCfg.mineAssertions === true) {
        strategies.push({
            id: 'assertion-relief',
            reason: 'every failing sampler returned 2xx/3xx — likely mined-assertion strictness, not flow breakage; regenerate without mined assertions to isolate it (outcome probe + business guard remain)',
            evidence: failing.slice(0, 4).map(s => `${s.label || s.name}=${s.responseCode || s.code}`).join(', '),
            runCfgPatch: { mineAssertions: false },
        });
    }

    return strategies.find(s => !tried.includes(s.id)) || null;
}

/**
 * Does Gate 0 prove the AUTH segment sends wrong/literal values? A column
 * shift corrupts credentials wholesale; an undefined auth-ish variable
 * (state/nonce/token/csrf/user/pass/session/auth/cred) transmits literally.
 * Either means the login wasn't sent correctly → the wall is fixable.
 */
function hasAuthDataDefect(gate0) {
    const findings = gate0 && Array.isArray(gate0.findings) ? gate0.findings : [];
    return findings.some(f => f && f.dataDefect && (
        f.kind === 'csv-column-shift' ||
        /state|nonce|token|csrf|xsrf|user|pass|session|auth|cred|iam|login/i.test(String(f.variable || ''))
    ));
}

function decisionRows(valueFlow) {
    if (!valueFlow || !valueFlow.byIndex) return [];
    return Array.isArray(valueFlow.byIndex)
        ? valueFlow.byIndex.filter(Boolean)
        : Object.values(valueFlow.byIndex).filter(Boolean);
}

function adjudicationActions(result, action) {
    const out = [];
    const iterations = result && result.requestAdjudication && result.requestAdjudication.iterations || [];
    for (const iter of iterations) {
        const rows = iter && iter.actions && iter.actions[action] || [];
        if (Array.isArray(rows)) out.push(...rows);
    }
    return out;
}

function nativeManagerPatch(analysis) {
    if (!analysis) return null;
    const requested = (analysis.recommendedNextStrategy || {}).id === 'native-manager-correction';
    const findings = analysis.nativeManagerFindings || [];
    const required = findings.filter(m => ['required', 'recommended'].includes(m.decision));
    if (!requested && !required.length) return null;
    const forceNativeManagers = {};
    for (const finding of required) {
        const manager = String(finding.manager || '').toLowerCase();
        if (manager.includes('cookie')) forceNativeManagers.cookie = true;
        if (manager.includes('cache')) forceNativeManagers.cache = true;
        if (manager.includes('authorization')) forceNativeManagers.authorization = true;
        if (manager.includes('redirect')) forceNativeManagers.redirects = true;
    }
    if (!Object.keys(forceNativeManagers).length && requested) forceNativeManagers.cookie = true;
    return {
        forceNativeManagers,
        evidence: required.map(m => `${m.manager}:${m.decision}`).join(', ') || (analysis.recommendedNextStrategy && analysis.recommendedNextStrategy.evidence) || '',
    };
}

module.exports = { proposeReplan, _internal: { nativeManagerPatch, decisionRows, adjudicationActions, hasAuthDataDefect } };
