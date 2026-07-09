'use strict';

function buildDomainProfile({ name = '', entries = [], runCfg = {}, verifiedLessons = [] } = {}) {
    const techStack = normalizeList(runCfg.techStack);
    const domainNotes = normalizeList(runCfg.domainNotes);
    const businessCriticalSteps = normalizeList(runCfg.businessCriticalSteps);
    const slo = normalizeSlo(runCfg.slo);
    const applicationKey = inferApplicationKey(entries, name);
    const stackProfile = buildStackProfile({ techStack, entries });
    const risks = inferDomainRisks({ domainNotes, entries, runCfg, slo });
    const memoryScope = [applicationKey, ...stackProfile.signals.map(s => s.stack)].filter(Boolean).join(' | ');

    return {
        name,
        applicationKey,
        stackProfile,
        domainNotes,
        businessCriticalSteps,
        slo,
        risks,
        memoryScope,
        verifiedLessonCount: Array.isArray(verifiedLessons) ? verifiedLessons.length : 0,
        hasOperatorContext: !!(techStack.length || domainNotes.length || businessCriticalSteps.length || Object.keys(slo).length),
        generatedAt: new Date().toISOString(),
    };
}

function buildStackProfile({ techStack = [], entries = [] } = {}) {
    const signals = [];
    const add = (stack, evidence, source = 'operator') => {
        if (!stack || signals.some(s => s.stack.toLowerCase() === String(stack).toLowerCase())) return;
        signals.push({ stack, evidence, source });
    };
    for (const item of techStack) add(item, 'operator supplied tech stack context', 'operator');
    const text = entries.map(e => [
        e.request && e.request.url,
        ...((e.request && e.request.headers) || []).map(h => `${h.name}:${h.value}`),
        ...((e.response && e.response.headers) || []).map(h => `${h.name}:${h.value}`),
        e.request && e.request.postData && e.request.postData.text,
    ].filter(Boolean).join(' ')).join(' ');
    if (/traceparent|x-b3-traceid|x-request-id/i.test(text)) add('Distributed tracing / service mesh', 'trace headers in recording', 'recording');
    if (/spring|JSESSIONID/i.test(text)) add('Spring/Java web stack', 'Spring/JSESSIONID signal', 'recording');
    if (/graphql|operationName/i.test(text)) add('GraphQL/API gateway', 'GraphQL operation signal', 'recording');
    if (/oauth|openid|client_id|SAMLResponse/i.test(text)) add('SSO/auth gateway', 'OAuth/SAML signal', 'recording');
    return {
        signals,
        confidence: signals.length ? 'medium' : 'low',
    };
}

function inferDomainRisks({ domainNotes = [], entries = [], runCfg = {}, slo = {} } = {}) {
    const risks = [];
    const mutates = entries.some(e => /^(POST|PUT|PATCH|DELETE)$/i.test(e.request && e.request.method || ''));
    if (mutates && !(runCfg.scenario || runCfg.loadProfile)) {
        risks.push({ gap: 'workload model missing', severity: 'high', action: 'Provide transactions/hour, users, duration, or loadProfile before treating this as a production load model.' });
    }
    if (mutates) {
        risks.push({ gap: 'data setup and cleanup', severity: 'high', action: 'Confirm seed data, uniqueness, and cleanup for mutating business flows.' });
    }
    if (slo.p95Ms || slo.errorRatePct != null) {
        risks.push({ gap: 'SLO validation', severity: 'medium', action: `Validate p95/error-rate targets against JMeter aggregate results: ${formatSlo(slo)}.` });
    }
    for (const note of domainNotes) {
        risks.push({ gap: 'operator domain note', severity: 'medium', action: note });
    }
    return dedupeBy(risks, r => `${r.gap}:${r.action}`);
}

function inferApplicationKey(entries = [], fallback = '') {
    for (const e of entries) {
        try {
            const u = new URL(e.request && e.request.url || '');
            if (u.hostname) return u.hostname;
        } catch { /* keep searching */ }
    }
    return String(fallback || 'unknown-app');
}

function normalizeSlo(slo = {}) {
    const out = {};
    const p95 = Number(slo.p95Ms);
    const err = Number(slo.errorRatePct);
    if (Number.isFinite(p95) && p95 > 0) out.p95Ms = p95;
    if (Number.isFinite(err) && err >= 0) out.errorRatePct = err;
    return out;
}

function normalizeList(value) {
    if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
    if (value == null) return [];
    return String(value).split(/[,;\n]+|\s+\+\s+/).map(v => v.trim()).filter(Boolean);
}

function formatSlo(slo = {}) {
    const parts = [];
    if (slo.p95Ms) parts.push(`p95 <= ${slo.p95Ms}ms`);
    if (slo.errorRatePct != null) parts.push(`error <= ${slo.errorRatePct}%`);
    return parts.join(', ') || 'not specified';
}

function dedupeBy(items, keyFn) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
        const key = keyFn(item);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

module.exports = {
    buildDomainProfile,
    _internal: { normalizeList, normalizeSlo, inferApplicationKey, inferDomainRisks, buildStackProfile },
};
