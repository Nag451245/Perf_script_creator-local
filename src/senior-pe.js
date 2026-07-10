'use strict';

const { _internal: { samplerLabel } } = require('./value-flow-decisions');
const domainKnowledge = require('./domain-knowledge');

const DEFAULT_OBJECTIVE = 'mixed-load capacity';

function buildSeniorPeDebrief({
    name = '',
    entries = [],
    pages = [],
    runCfg = {},
    correlations = [],
    parameterCandidates = [],
    ghosts = [],
    polling = [],
    plannedExtractors = [],
    stats = {},
} = {}) {
    const objective = normalizeObjective(runCfg);
    const flow = reconstructFlow(entries, pages);
    const stackFingerprint = fingerprintStack(entries);
    const nativeManagers = auditNativeManagers(entries);
    const domainProfile = domainKnowledge.buildDomainProfile({ name, entries, runCfg });
    const valueLedger = buildValueLedger({
        entries,
        correlations,
        parameterCandidates,
        ghosts,
        objective,
        nativeManagers,
    });
    const validityGates = buildValidityGates({ objective, flow, nativeManagers, stats, domainProfile });
    const negativeSpace = buildNegativeSpaceAudit({ objective, entries, polling, runCfg, domainProfile });
    const coverage = estimateCoverage({ valueLedger, correlations, plannedExtractors, stats });

    return {
        name,
        objective,
        flow,
        stackFingerprint,
        domainProfile,
        nativeManagers,
        valueLedger,
        validityGates,
        negativeSpace,
        coverage,
        generatedAt: new Date().toISOString(),
    };
}

function normalizeObjective(runCfg = {}) {
    const raw = String(runCfg.testObjective || runCfg.businessGoal || '').trim();
    if (raw) {
        return {
            value: raw,
            assumed: false,
            rationale: 'Operator supplied the test objective; parameterization and pacing decisions should be checked against it.',
        };
    }
    return {
        value: DEFAULT_OBJECTIVE,
        assumed: true,
        rationale: 'No objective was provided. Assuming mixed-load capacity so unique sessions/data are preferred where they affect cache, locking, or dedup behavior.',
    };
}

function reconstructFlow(entries = [], pages = []) {
    const samplerMap = (entries || []).map((entry, index) => {
        const method = entry.request && entry.request.method || 'GET';
        const url = entry.request && entry.request.url || '';
        return {
            index,
            sampler: samplerLabel(entry, index),
            method,
            path: pathOf(url),
            businessStep: inferBusinessStep(entry),
            noise: isNoise(entry),
        };
    });
    const businessSteps = [];
    for (const item of samplerMap.filter(s => !s.noise)) {
        const last = businessSteps[businessSteps.length - 1];
        if (!last || last.name !== item.businessStep) {
            businessSteps.push({ name: item.businessStep, startIndex: item.index, endIndex: item.index, samplers: [item.sampler] });
        } else {
            last.endIndex = item.index;
            last.samplers.push(item.sampler);
        }
    }
    const narrative = businessSteps.length
        ? businessSteps.map(s => s.name).join(' -> ')
        : 'No business flow could be reconstructed from kept samplers.';
    return {
        narrative,
        businessSteps,
        samplerMap,
        pageTitles: (pages || []).map(p => p.title).filter(Boolean),
    };
}

function inferBusinessStep(entry = {}) {
    const method = String(entry.request && entry.request.method || 'GET').toUpperCase();
    const url = entry.request && entry.request.url || '';
    const path = pathOf(url).toLowerCase();
    const body = entry.request && entry.request.postData && entry.request.postData.text || '';
    if (/login|signin|authenticate|authorize|oauth|saml|session/.test(path + ' ' + body)) return 'authenticate';
    if (/search|query|filter/.test(path + ' ' + body)) return 'search';
    if (/cart|basket|checkout|order|submit|create|save/.test(path + ' ' + body) || /^(POST|PUT|PATCH|DELETE)$/.test(method)) return 'submit/update business data';
    if (/dashboard|home|landing/.test(path)) return 'land dashboard';
    if (/detail|record|item|task|case|profile/.test(path)) return 'open record/detail';
    return 'navigate/read';
}

function isNoise(entry = {}) {
    const url = String(entry.request && entry.request.url || '').toLowerCase();
    return /analytics|beacon|telemetry|gstatic|google-analytics|favicon|\.css\b|\.js\b|\.png\b|\.jpg\b|\.svg\b/.test(url);
}

function fingerprintStack(entries = []) {
    const signals = [];
    const seen = new Set();
    const add = (name, evidence) => {
        if (seen.has(name)) return;
        seen.add(name);
        signals.push({ stack: name, evidence });
    };
    for (const e of entries || []) {
        const headers = [...(e.request && e.request.headers || []), ...(e.response && e.response.headers || [])];
        const cookieNames = [
            ...(e.request && e.request.cookies || []).map(c => c.name),
            ...(e.response && e.response.cookies || []).map(c => c.name),
            ...headers.filter(h => /^set-cookie$/i.test(h.name || '')).map(h => String(h.value || '').split('=')[0]),
        ].join(' ');
        const hay = `${headers.map(h => `${h.name}:${h.value}`).join(' ')} ${cookieNames} ${e.request && e.request.postData && e.request.postData.text || ''}`;
        if (/ASP\.NET|__VIEWSTATE|__EVENTVALIDATION/i.test(hay)) add('.NET / WebForms', '__VIEWSTATE/ASP.NET signal');
        if (/JSESSIONID|jsessionid/i.test(hay)) add('Java servlet', 'JSESSIONID cookie');
        if (/sap-contextid|sap-usercontext|sap/i.test(hay)) add('SAP', 'SAP cookie/header signal');
        if (/graphql|operationName|"query"\s*:/i.test(hay)) add('GraphQL/API gateway', 'GraphQL payload signal');
        if (/SAMLResponse|RelayState/i.test(hay)) add('SAML SSO', 'SAMLResponse/RelayState signal');
        if (/oauth|openid|client_id|code_challenge|nonce/i.test(hay)) add('OAuth/OIDC', 'OAuth/OIDC parameter signal');
    }
    return {
        signals,
        note: 'Stack fingerprint is a prior for search order only; replay evidence remains authoritative.',
    };
}

function auditNativeManagers(entries = []) {
    const managers = [];
    const hasCookie = entries.some(e => hasHeader(e.response && e.response.headers, 'set-cookie') || (e.request && (e.request.cookies || []).length));
    if (hasCookie) managers.push({ manager: 'HTTP Cookie Manager', decision: 'required', rationale: 'Session cookies should be handled natively, not regex-correlated unless reused outside Cookie headers.' });
    const hasCache = entries.some(e => hasHeader(e.request && e.request.headers, 'if-none-match') || hasHeader(e.response && e.response.headers, 'etag') || hasHeader(e.response && e.response.headers, 'last-modified'));
    if (hasCache) managers.push({ manager: 'HTTP Cache Manager', decision: 'recommended', rationale: 'ETag/Last-Modified churn belongs to cache semantics, not manual correlation.' });
    const hasAuth = entries.some(e => hasHeader(e.request && e.request.headers, 'authorization') || /www-authenticate/i.test(headersText(e.response && e.response.headers)));
    if (hasAuth) managers.push({ manager: 'HTTP Authorization Manager', decision: 'review', rationale: 'Authorization headers may be native auth or bearer-token lifecycle; classify before correlating.' });
    const hasRedirect = entries.some(e => Number(e.response && e.response.status || 0) >= 300 && Number(e.response && e.response.status || 0) < 400);
    if (hasRedirect) managers.push({ manager: 'JMeter redirect handling', decision: 'review', rationale: 'Redirect chains should usually be followed live instead of replaying stale recorded hops.' });
    return managers;
}

function buildValueLedger({ entries = [], correlations = [], parameterCandidates = [], ghosts = [], objective, nativeManagers = [] } = {}) {
    const ledger = [];
    const nativeCookieManager = nativeManagers.some(m => m.manager === 'HTTP Cookie Manager');
    for (const c of correlations || []) {
        const variable = c.variableName || c.name || c.refName || 'correlated_value';
        const value = c.value || c.originalValue || '';
        const provenance = provenanceForCorrelation(c, entries);
        const cookieLike = /cookie|session|jsessionid|asp\.net_sessionid/i.test(`${variable} ${provenance.source || ''}`);
        ledger.push({
            value: redactValue(value),
            name: variable,
            role: cookieLike && nativeCookieManager ? 'native_managed_state' : 'server_generated_echoed_by_client',
            native: cookieLike && nativeCookieManager ? 'HTTP Cookie Manager' : null,
            decision: cookieLike && nativeCookieManager ? 'do_not_correlate_if_cookie_manager_covers_end_to_end' : 'correlate',
            necessityRationale: 'Server-issued value is consumed later; replay must use the fresh value from the producing response.',
            provenance,
        });
    }
    for (const p of parameterCandidates || []) {
        const name = p.name || p.variableName || 'input';
        // Static config (api version, locale, tenant/realm, region, public app/
        // client id, channel) is a constant of the environment, not per-user test
        // input. Keeping it a literal avoids both needless CSV parameterization
        // and mistaken correlation of a value that never changes per session.
        if (isStaticConfigName(name)) {
            ledger.push({
                value: redactValue(p.value || p.sample || ''),
                name,
                role: 'static_config',
                native: null,
                decision: 'keep_static_literal',
                necessityRationale: 'Environment constant (version/locale/tenant/region/public id); do not parameterize or correlate — pin as a literal unless the objective targets multiple tenants/regions.',
                provenance: { source: 'recorded request input', consumer: p.location || p.source || '' },
            });
            continue;
        }
        ledger.push({
            value: redactValue(p.value || p.sample || ''),
            name,
            role: 'user_test_input',
            native: null,
            decision: parameterDecisionForObjective(name, objective),
            necessityRationale: `Decision is tied to objective "${objective.value}"; vary only when the workload model needs unique or high-cardinality data.`,
            provenance: { source: 'recorded request input', consumer: p.location || p.source || '' },
        });
    }
    for (const g of ghosts || []) {
        const name = g.paramName || g.name || 'client_value';
        ledger.push({
            value: redactValue(g.sampleValue || g.value || ''),
            name,
            role: 'client_computed',
            native: null,
            decision: /hmac|sig(nature)?|jwt/i.test(`${name} ${g.kind || ''}`) ? 'flag_for_human_algorithm_or_key' : 'synthesize_or_native_function',
            necessityRationale: 'No server producer exists in the recording; extractor correlation would be fake.',
            provenance: { source: 'request-only value', consumer: g.location || '', kind: g.kind || '' },
        });
    }
    return ledger;
}

function parameterDecisionForObjective(name, objective) {
    const n = String(name || '').toLowerCase();
    const obj = String(objective && objective.value || '').toLowerCase();
    if (/idempotency|request.?id|uuid|guid/.test(n)) return 'unique_per_request';
    if (/user|login|email|account/.test(n) && /capacity|stress|soak|endurance/.test(obj)) return 'csv_unique_users';
    if (/search|query|q|keyword/.test(n) && /search|cache/.test(obj)) return 'csv_high_cardinality';
    if (/single|certification/.test(obj)) return 'leave_representative_or_small_csv';
    return 'parameterization_candidate_review';
}

function provenanceForCorrelation(c, entries) {
    const producer = firstDefined(c.sourceRequestIndex, c.sourceSampler, c.producerIndex, c.producer);
    const consumer = firstDefined(c.targetRequestIndex, c.targetSampler, c.consumerIndex, c.consumer);
    return {
        producer,
        consumer,
        source: labelForIndex(entries, producer),
        sink: labelForIndex(entries, consumer),
    };
}

function firstDefined(...values) {
    return values.find(v => v != null && v !== '');
}

function labelForIndex(entries, idx) {
    const n = Number(idx);
    if (!Number.isInteger(n) || !entries[n]) return '';
    return samplerLabel(entries[n], n);
}

function buildValidityGates({ objective, flow, nativeManagers, stats, domainProfile = null }) {
    const gates = [
        { gate: 'business_content_assertions', required: true, status: 'review', rationale: 'HTTP 200 is insufficient; assertions must prove the business step completed.' },
        { gate: 'data_realism', required: true, status: 'review', rationale: `Validate CSV/UDV cardinality against objective "${objective.value}".` },
        { gate: 'pacing_and_think_time', required: true, status: stats && stats.pacingTimers ? 'partially_covered' : 'review', rationale: 'Recording speed is not user pacing; tune for soak/stress/spike objective.' },
        { gate: 'transaction_grouping', required: true, status: flow.businessSteps.length ? 'covered_by_mapping' : 'review', rationale: 'Results should report business steps, not anonymous HTTP sampler numbers.' },
        { gate: 'native_managers_present', required: true, status: nativeManagers.length ? 'review' : 'not_applicable', rationale: 'Cookie/Cache/Auth/redirect manager decisions must be deliberate.' },
    ];
    if (domainProfile && domainProfile.slo && Object.keys(domainProfile.slo).length) {
        gates.push({
            gate: 'performance_slo',
            required: true,
            status: 'review',
            rationale: `Validate configured SLO targets against run metrics: ${JSON.stringify(domainProfile.slo)}.`,
        });
    }
    return gates;
}

function buildNegativeSpaceAudit({ objective, entries = [], polling = [], runCfg = {}, domainProfile = null }) {
    const gaps = [];
    const obj = String(objective.value || '').toLowerCase();
    if (/soak|endurance|capacity|stress/.test(obj)) {
        gaps.push({ gap: 'token expiry mid-run', severity: /soak|endurance/.test(obj) ? 'critical' : 'medium', action: 'Verify refresh/re-auth behavior or define credential/session rotation.' });
    }
    if ((polling || []).length || entries.some(e => /status|poll|progress/i.test(e.request && e.request.url || ''))) {
        gaps.push({ gap: 'async/polling terminal state', severity: 'high', action: 'Verify the loop exits on business state, not only request count.' });
    }
    if (entries.some(e => /[?&](page|offset|cursor)=/i.test(e.request && e.request.url || ''))) {
        gaps.push({ gap: 'pagination beyond page one', severity: 'medium', action: 'Decide whether the load model needs page depth, cursor reuse, or only first-page traffic.' });
    }
    if (entries.some(e => /^(POST|PUT|PATCH|DELETE)$/i.test(e.request && e.request.method || ''))) {
        gaps.push({ gap: 'setup/teardown and data exhaustion', severity: 'high', action: 'Confirm seed data, cleanup, uniqueness, and idempotency strategy for mutating flows.' });
        if (!(runCfg.scenario || runCfg.loadProfile)) {
            gaps.push({ gap: 'workload model missing', severity: 'high', action: 'Provide transactions/hour, users, duration, or loadProfile before treating this as a production load model.' });
        }
    }
    if (entries.some(e => Number(e.response && e.response.status || 0) === 429 || hasHeader(e.response && e.response.headers, 'retry-after'))) {
        gaps.push({ gap: 'rate limiting / Retry-After', severity: 'high', action: 'Model throttling as a load ceiling signal, not a script failure only.' });
    }
    for (const risk of (domainProfile && domainProfile.risks) || []) {
        gaps.push(risk);
    }
    return gaps;
}

// Environment constants that are neither per-user input nor server-issued
// correlation. Name-based (values of these are stable across the recording).
const STATIC_CONFIG_NAME_RE = /^(?:api[_-]?version|version|ver|v|locale|lang|language|country|region|market|tenant|tenant[_-]?id|realm|environment|env|stage|channel|platform|device[_-]?type|os|app[_-]?id|application[_-]?id|client[_-]?id|product[_-]?id|edition|timezone|tz|currency|format|output|content[_-]?type)$/i;

function isStaticConfigName(name) {
    return STATIC_CONFIG_NAME_RE.test(String(name || '').trim());
}

function estimateCoverage({ valueLedger = [], correlations = [], plannedExtractors = [], stats = {} }) {
    const staticRoles = new Set(['user_test_input', 'static_config']);
    const dynamicCount = valueLedger.filter(v => !staticRoles.has(v.role)).length;
    const resolved = valueLedger.filter(v => ['correlate', 'synthesize_or_native_function', 'native_managed_state'].includes(v.decision)).length;
    const dynamicCoveragePct = dynamicCount ? Math.round(resolved / dynamicCount * 100) : 100;
    return {
        dynamicValueCoveragePct: dynamicCoveragePct,
        correlationCount: (correlations || []).length,
        nativeExtractorCount: (plannedExtractors || []).length || stats.nativeExtractorsPlanned || 0,
        note: 'Coverage is based on recorded evidence and proposal state; replay artifacts remain authoritative.',
    };
}

function renderSeniorPeDebriefMarkdown(debrief) {
    const lines = [];
    lines.push(`# Senior Performance Engineering Debrief — ${debrief.name || 'flow'}`);
    lines.push('');
    lines.push(`Objective: ${debrief.objective.value}${debrief.objective.assumed ? ' (assumed)' : ''}`);
    lines.push('');
    lines.push(`Flow: ${debrief.flow.narrative}`);
    lines.push('');
    lines.push('## Business Steps');
    for (const step of debrief.flow.businessSteps) {
        lines.push(`- ${step.name}: samplers ${step.startIndex + 1}-${step.endIndex + 1}`);
    }
    lines.push('');
    lines.push('## Stack Fingerprint');
    if (debrief.stackFingerprint.signals.length) {
        for (const s of debrief.stackFingerprint.signals) lines.push(`- ${s.stack}: ${s.evidence}`);
    } else {
        lines.push('- No strong stack signal detected.');
    }
    lines.push('');
    if (debrief.domainProfile && debrief.domainProfile.hasOperatorContext) {
        lines.push('## Domain / SLO Context');
        lines.push(`- Application key: ${debrief.domainProfile.applicationKey}`);
        if (debrief.domainProfile.slo && Object.keys(debrief.domainProfile.slo).length) lines.push(`- SLO: ${JSON.stringify(debrief.domainProfile.slo)}`);
        if (debrief.domainProfile.domainNotes.length) lines.push(`- Notes: ${debrief.domainProfile.domainNotes.join('; ')}`);
        lines.push('');
    }
    lines.push('## Value Ledger');
    for (const v of debrief.valueLedger.slice(0, 100)) {
        lines.push(`- ${v.name}: ${v.role} -> ${v.decision}. ${v.necessityRationale}`);
    }
    if (debrief.valueLedger.length > 100) lines.push(`- ... ${debrief.valueLedger.length - 100} more value(s) omitted.`);
    lines.push('');
    lines.push('## Native Managers');
    if (debrief.nativeManagers.length) {
        for (const m of debrief.nativeManagers) lines.push(`- ${m.manager}: ${m.decision}. ${m.rationale}`);
    } else {
        lines.push('- No native-manager requirement detected from the recording.');
    }
    lines.push('');
    lines.push('## Negative Space');
    if (debrief.negativeSpace.length) {
        for (const g of debrief.negativeSpace) lines.push(`- ${g.gap} (${g.severity}): ${g.action}`);
    } else {
        lines.push('- No major negative-space gaps inferred from the recording/objective.');
    }
    lines.push('');
    lines.push('## Coverage');
    lines.push(`- Dynamic-value coverage estimate: ${debrief.coverage.dynamicValueCoveragePct}%`);
    lines.push(`- Correlations: ${debrief.coverage.correlationCount}`);
    lines.push(`- Native extractors: ${debrief.coverage.nativeExtractorCount}`);
    return lines.join('\n');
}

function pathOf(url) {
    try { return new URL(url).pathname || '/'; } catch { return String(url || ''); }
}

function hasHeader(headers = [], name) {
    return (headers || []).some(h => String(h.name || '').toLowerCase() === String(name || '').toLowerCase());
}

function headersText(headers = []) {
    return (headers || []).map(h => `${h.name}:${h.value}`).join(' ');
}

function redactValue(value) {
    const s = String(value == null ? '' : value);
    if (!s) return '';
    if (/token|secret|password|session|csrf|xsrf|bearer|sid/i.test(s) || s.length > 16) {
        return `${s.slice(0, 4)}...[redacted:${s.length}]`;
    }
    return s;
}

module.exports = {
    buildSeniorPeDebrief,
    renderSeniorPeDebriefMarkdown,
    _internal: {
        normalizeObjective,
        reconstructFlow,
        fingerprintStack,
        auditNativeManagers,
        buildValueLedger,
        buildNegativeSpaceAudit,
        parameterDecisionForObjective,
        isStaticConfigName,
    },
};
