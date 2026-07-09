'use strict';

const peNaming = require('./pe-naming');

const FIRST_PARTY_HINT = /(?:^|\.)webpt\.com$|stage|stg|gateway|auth|app|tasks|emr/i;
const THIRD_PARTY_NOISE = /gstatic|google|beacon|domainreliability|analytics|dynatrace|newrelic|pendo|launchdarkly|sentry|ruxit|gravatar/i;
const NOISE_PATH = /\/(?:ohttp_gateway|domainreliability\/upload|favicon\.ico|robots\.txt)|\.(?:css|js|png|jpg|jpeg|gif|svg|ico|woff2?)(?:\?|$)/i;
const REDIRECT_PLUMBING_PATH = /\/(?:s\/interceptor|interceptor|authorize\/resume|iam\/callback|oauth\/token|user\/iam\/authorize|logout|v2\/logout)(?:\/|\?|$)/i;
const AUTH_OR_SESSION_PATH = /\/(?:u\/login|user\/login|jwt\/v2\/create-cookie|authorization|user\/iam\/save|scheduler\/index\/data)/i;
const JWT_CREATE_COOKIE_PATH = /\/jwt\/v2\/create-cookie(?:\/|\?|$)/i;
const MUTATING_METHOD = /^(POST|PUT|PATCH|DELETE)$/i;

function buildBusinessGuard({ xml, flowName = '', runCfg = {}, valueFlowDecisions = null } = {}) {
    const samplers = indexSamplers(xml || '');
    const goalTerms = goalTermsFor(flowName, runCfg);
    const operatorDisables = runCfg.allowUnsafeDisableProtected === true && Array.isArray(runCfg.disableCalls)
        ? runCfg.disableCalls.filter(Boolean)
        : [];
    const protectedSamplers = samplers
        .filter(s => isProtectedSampler(s, goalTerms, runCfg, valueFlowDecisions) && !matchesAnyConfigured(s, operatorDisables))
        .map(s => ({
            name: s.name,
            method: s.method,
            path: s.path,
            domain: s.domain,
            category: protectionCategory(s, goalTerms, valueFlowDecisionFor(s, valueFlowDecisions)),
            reason: protectionReason(s, goalTerms, valueFlowDecisionFor(s, valueFlowDecisions)),
        }));
    const protectedNames = new Set(protectedSamplers.map(s => s.name));
    return { enabled: runCfg.strictBusiness !== false, goalTerms, protectedSamplers, protectedNames };
}

function filterProtectedDisables(failureReport, guard) {
    if (!guard || guard.enabled === false || !guard.protectedNames || !failureReport) {
        return { report: failureReport, blocked: [] };
    }
    const blocked = [];
    const allowed = [];
    for (const item of failureReport.samplersToDisable || []) {
        if (guard.protectedNames.has(String(item.samplerLabel || '').trim())) blocked.push(item);
        else allowed.push(item);
    }
    return { report: { ...failureReport, samplersToDisable: allowed }, blocked };
}

function evaluateBusinessResult({ result, xml, guard } = {}) {
    if (!guard || guard.enabled === false) {
        return { ok: true, reason: 'strict business guard disabled', protectedSamplers: [] };
    }
    const samplers = indexSamplers(xml || '');
    const byName = new Map(samplers.map(s => [s.name, s]));
    const protectedSamplers = guard.protectedSamplers || [];
    if (!protectedSamplers.length) {
        return {
            ok: false,
            reason: `no protected business samplers were identified for goal "${(guard.goalTerms || []).join(' ')}"`,
            protectedSamplers,
        };
    }

    const disabled = protectedSamplers.filter(s => byName.get(s.name)?.enabled === false);
    if (disabled.length) {
        return {
            ok: false,
            reason: `required sampler(s) disabled: ${disabled.map(s => s.name).slice(0, 5).join(', ')}`,
            protectedSamplers,
            disabled,
        };
    }

    const reqSamples = (result && result.samples || []).filter(s => !s.isTransaction);
    const sampleByLabel = new Map(reqSamples.map(s => [String(s.label || s.name || '').trim(), s]));
    const missing = protectedSamplers.filter(s => !sampleByLabel.has(s.name));
    if (missing.length) {
        return {
            ok: false,
            reason: `required sampler(s) did not execute: ${missing.map(s => s.name).slice(0, 5).join(', ')}`,
            protectedSamplers,
            missing,
        };
    }

    const failed = protectedSamplers
        .map(s => ({ sampler: s, sample: sampleByLabel.get(s.name) }))
        .filter(({ sample }) => !sample || sample.success === false || isBadStatus(sample));
    if (failed.length) {
        return {
            ok: false,
            reason: `required sampler(s) failed: ${failed.map(f => f.sampler.name).slice(0, 5).join(', ')}`,
            protectedSamplers,
            failed,
        };
    }

    const businessCount = protectedSamplers.filter(s => s.category !== 'dependency').length;
    const dependencyCount = protectedSamplers.length - businessCount;
    return {
        ok: true,
        reason: `${protectedSamplers.length} required sampler(s) executed successfully (${businessCount} business-critical, ${dependencyCount} required dependenc${dependencyCount === 1 ? 'y' : 'ies'})`,
        protectedSamplers,
    };
}

function indexSamplers(xml) {
    const samplers = [];
    for (const m of String(xml || '').matchAll(/<HTTPSamplerProxy\b([^>]*)>([\s\S]*?)<\/HTTPSamplerProxy>/g)) {
        const attrs = m[1] || '';
        const inner = m[2] || '';
        const name = attr(attrs, 'testname') || '';
        const enabledAttr = attr(attrs, 'enabled');
        samplers.push({
            name,
            enabled: enabledAttr !== 'false',
            domain: prop(inner, 'HTTPSampler.domain'),
            path: prop(inner, 'HTTPSampler.path'),
            method: prop(inner, 'HTTPSampler.method') || methodFromName(name),
            body: inner,
        });
    }
    return samplers;
}

function isProtectedSampler(s, goalTerms, runCfg, valueFlowDecisions = null) {
    if (!s || !s.name) return false;
    const hay = `${s.name} ${s.domain} ${s.path} ${s.body}`;
    if (THIRD_PARTY_NOISE.test(hay) || NOISE_PATH.test(s.path || '')) return false;
    if (REDIRECT_PLUMBING_PATH.test(s.path || '')) return false;
    if (matchesAnyConfigured(s, runCfg.protectedCalls)) return true;
    const valueFlow = valueFlowDecisionFor(s, valueFlowDecisions);
    if (valueFlow && valueFlow.consumedOutputCount > 0) return true;
    if (JWT_CREATE_COOKIE_PATH.test(s.path || '') && matchesAnyConfigured(s, runCfg.disableCalls)) return false;
    if (valueFlow && valueFlow.consumedOutputCount === 0 && !MUTATING_METHOD.test(s.method || '')) return false;
    if (goalTerms.length && goalTerms.every(term => hay.toLowerCase().includes(term))) return true;
    if (/\bcreate\b|\/tasks\b|task/i.test(hay) && MUTATING_METHOD.test(s.method || '')) return true;
    if (/GraphQL mutation/i.test(s.name) && /(create|task|login|authenticate|verify)/i.test(hay)) return true;
    if (MUTATING_METHOD.test(s.method || '') && isFirstParty(s.domain) && !NOISE_PATH.test(s.path || '')) return true;
    if (AUTH_OR_SESSION_PATH.test(s.path || '') && isFirstParty(s.domain)) return true;
    return false;
}

function protectionReason(s, goalTerms, valueFlow = null) {
    const hay = `${s.name} ${s.path}`.toLowerCase();
    if (valueFlow && valueFlow.consumedOutputCount > 0) return 'required value-flow producer';
    if (goalTerms.length && goalTerms.every(term => hay.includes(term))) return 'matches business goal';
    if (/\bcreate\b|\/tasks\b|task/i.test(hay)) return 'task/create business endpoint';
    if (/GraphQL mutation/i.test(s.name || '')) return 'GraphQL mutation';
    if (AUTH_OR_SESSION_PATH.test(s.path || '')) return 'auth/session producer';
    if (MUTATING_METHOD.test(s.method || '')) return 'first-party mutating request';
    return 'business-critical';
}

function protectionCategory(s, goalTerms, valueFlow = null) {
    const hay = `${s.name} ${s.path}`.toLowerCase();
    if (AUTH_OR_SESSION_PATH.test(s.path || '')) return 'dependency';
    if (goalTerms.length && goalTerms.every(term => hay.includes(term))) return 'business';
    if (/\bcreate\b|\/tasks\b|task/i.test(hay)) return 'business';
    if (/GraphQL mutation/i.test(s.name || '')) return 'business';
    if (MUTATING_METHOD.test(s.method || '')) return 'business';
    if (valueFlow && valueFlow.consumedOutputCount > 0) return 'dependency';
    return 'dependency';
}

function valueFlowDecisionFor(s, valueFlowDecisions) {
    if (!s || !valueFlowDecisions) return null;
    if (valueFlowDecisions.bySampler && valueFlowDecisions.bySampler[s.name]) return valueFlowDecisions.bySampler[s.name];
    const step = peNaming.stepNumberFromLabel(s.name);
    if (step && Array.isArray(valueFlowDecisions.byIndex)) return valueFlowDecisions.byIndex[step - 1] || null;
    return null;
}

function goalTermsFor(flowName, runCfg) {
    const raw = String(runCfg.businessGoal || flowName || '')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLowerCase();
    const terms = raw.split(/[^a-z0-9]+/).filter(Boolean)
        .flatMap(term => term === 'createtask' ? ['create', 'task'] : [term]);
    return [...new Set(terms.filter(t => !['run', 'flow', 'script', 'jmx'].includes(t)))];
}

function matchesAnyConfigured(s, patterns) {
    if (!Array.isArray(patterns) || patterns.length === 0) return false;
    const hay = `${s.name} ${s.domain}${s.path}`;
    // Full step labels are recording-specific — exact testname match only,
    // so one flow's "Step 07 - POST /" never matches another flow's
    // "Step 07 - POST /u/login/identifier" (same rule as the disable pass).
    const stepLabel = /^Step \d+ - [A-Z]+ \S*$/;
    return patterns.some(p => p && (stepLabel.test(String(p)) ? s.name === p : hay.includes(String(p))));
}

function isFirstParty(domain) {
    const d = String(domain || '').replace(/^\$\{|\}$/g, '');
    if (!d) return true;
    return FIRST_PARTY_HINT.test(d) && !THIRD_PARTY_NOISE.test(d);
}

function isBadStatus(sample) {
    const code = Number(sample.responseCode || sample.code);
    return Number.isFinite(code) && (code < 200 || code >= 400);
}

function attr(attrs, name) {
    const m = String(attrs || '').match(new RegExp(`${name}="([^"]*)"`));
    return m ? m[1] : '';
}

function prop(inner, name) {
    const m = String(inner || '').match(new RegExp(`<stringProp name="${escapeRegExp(name)}">([\\s\\S]*?)<\\/stringProp>`));
    return m ? decodeXml(m[1]) : '';
}

function methodFromName(name) {
    const m = String(name || '').match(/\b(GET|POST|PUT|PATCH|DELETE)\b/i);
    return m ? m[1].toUpperCase() : '';
}

function decodeXml(s) {
    return String(s || '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
    buildBusinessGuard,
    filterProtectedDisables,
    evaluateBusinessResult,
    _internal: { indexSamplers, goalTermsFor, isProtectedSampler, valueFlowDecisionFor, protectionCategory },
};
