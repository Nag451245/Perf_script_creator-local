'use strict';

const valueFlowDecisions = require('./value-flow-decisions');

const AUTH_SESSION_RE = /(?:login|auth|oauth|oidc|saml|sso|callback|token|session|csrf|authorize)/i;
const FOLDABLE_PLUMBING_RE = /(?:\/oauth\/token|\/authorize(?:\/resume)?|\/jwt\/v2\/create-cookie|\/saml|\/oidc|\/login|domainreliability|ohttp|safebrowsing|favicon|analytics|telemetry|_next\/static)/i;
// Universal business VERBS only — app-specific nouns belong in playbook
// protectedCalls (see post-run-adjudicator.js for the rationale).
const BUSINESS_PATH_RE = /(?:\/api\/|\/graphql|\/batch|\/print|\/upload|\/download|\/export|\/save|\/create|\/update|\/delete|\/submit|\/tasks?)/i;
const MUTATING_METHOD_RE = /^(POST|PUT|PATCH|DELETE)$/i;

function classifySamplerDecisions({ entries = [], failures = [], valueFlow = null, guard = null } = {}) {
    const flow = valueFlow || valueFlowDecisions.classifySamplerDisableDecisions({ entries, failures });
    const failureByIndex = new Map((failures || []).map(f => [Number(f.index), f]));
    const byIndex = {};
    const bySampler = {};

    for (let index = 0; index < entries.length; index++) {
        if (!failureByIndex.has(index) && !(flow.byIndex && flow.byIndex[index])) continue;
        const entry = entries[index] || {};
        const label = samplerLabel(entry, index);
        const flowDecision = flow.byIndex && flow.byIndex[index] || {};
        const decision = classifyOne({ entry, index, label, failure: failureByIndex.get(index), flowDecision, guard });
        byIndex[index] = decision;
        bySampler[label] = decision;
    }

    return { byIndex, bySampler };
}

function classifyOne({ entry, index, label, failure, flowDecision, guard }) {
    const method = methodOf(entry);
    const url = entry.request && entry.request.url || '';
    const path = pathOf(url);
    const hay = `${label} ${url} ${path}`;
    const hasLiveConsumer = Number(flowDecision.consumedOutputCount || 0) > 0;
    const guardProtected = isGuardProtected(guard, index, label);
    const businessMutation = isBusinessMutation(method, hay);
    const authSession = AUTH_SESSION_RE.test(hay);
    const foldablePlumbing = FOLDABLE_PLUMBING_RE.test(hay) && !hasLiveConsumer && !businessMutation;

    if (guardProtected || businessMutation || hasLiveConsumer || flowDecision.decision === 'must_fix') {
        return buildDecision('must_fix', { entry, index, label, failure, flowDecision, reason: reasonForMustFix({ guardProtected, businessMutation, hasLiveConsumer, flowDecision }) });
    }
    if (foldablePlumbing || flowDecision.decision === 'disposable_plumbing' || flowDecision.decision === 'foldable_plumbing') {
        return buildDecision('foldable_plumbing', { entry, index, label, failure, flowDecision, reason: 'no live downstream value or business role was proven' });
    }
    if (authSession) {
        return buildDecision('unsafe_to_disable', { entry, index, label, failure, flowDecision, reason: 'auth/session sampler lacks enough evidence to fold safely' });
    }
    return buildDecision('unknown', { entry, index, label, failure, flowDecision, reason: 'insufficient evidence for safe disable/fold decision' });
}

function buildDecision(decision, { entry, index, label, failure, flowDecision, reason }) {
    return {
        index,
        samplerLabel: label,
        decision,
        reason,
        method: methodOf(entry),
        url: entry.request && entry.request.url || '',
        responseCode: failure && failure.responseCode || '',
        consumedOutputCount: Number(flowDecision.consumedOutputCount || 0),
        consumerIndexes: flowDecision.consumerIndexes || [],
        sourceDecision: flowDecision.decision || '',
    };
}

function reasonForMustFix({ guardProtected, businessMutation, hasLiveConsumer, flowDecision }) {
    if (guardProtected) return 'business guard marks this sampler protected';
    if (businessMutation) return 'business mutation or outcome proof must execute';
    if (hasLiveConsumer) return 'sampler produces a live value consumed downstream';
    if (flowDecision.decision === 'must_fix') return flowDecision.reason || 'value-flow policy requires repair';
    return 'must repair before disabling';
}

function isGuardProtected(guard, index, label) {
    if (!guard) return false;
    const protectedIndexes = guard.protectedIndexes || guard.requiredIndexes || [];
    if (Array.isArray(protectedIndexes) && protectedIndexes.includes(index)) return true;
    const protectedSamplers = guard.protectedSamplers || guard.requiredSamplers || [];
    return Array.isArray(protectedSamplers) && protectedSamplers.includes(label);
}

function isBusinessMutation(method, hay) {
    return MUTATING_METHOD_RE.test(method) && BUSINESS_PATH_RE.test(hay);
}

function samplerLabel(entry, index) {
    const method = methodOf(entry);
    return `Step ${String(index + 1).padStart(2, '0')} - ${method} ${pathOf(entry.request && entry.request.url)}`;
}

function methodOf(entry) {
    return String(entry && entry.request && entry.request.method || 'GET').toUpperCase();
}

function pathOf(url) {
    try { return new URL(url || '').pathname || '/'; }
    catch { return String(url || '/').split('?')[0] || '/'; }
}

module.exports = {
    classifySamplerDecisions,
    _internal: {
        classifyOne,
        isBusinessMutation,
        pathOf,
        samplerLabel,
    },
};
