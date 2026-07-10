'use strict';

const peNaming = require('./pe-naming');

const MUTATING_METHOD_RE = /^(POST|PUT|PATCH|DELETE)$/i;
// Universal business VERBS + cross-domain business NOUNS (commerce, banking,
// scheduling, workflow). App-specific nouns (/patient, /edoc, ...) still live
// in playbooks as protectedCalls — but the universal verbs/nouns here must be
// broad enough that a checkout / transfer / booking is protected out of the
// box for retail, banking, and scheduling apps, not only WebPT-shaped flows.
const BUSINESS_PATH_RE = /(?:\/api\/|\/graphql|\/rest\/|\/v\d+\/|\/batch|\/print|\/upload|\/download|\/export|\/import|\/save|\/create|\/update|\/edit|\/delete|\/remove|\/submit|\/tasks?|\/checkout|\/cart|\/order|\/orders|\/basket|\/payment|\/pay\b|\/purchase|\/refund|\/transfer|\/transaction|\/account|\/withdraw|\/deposit|\/booking|\/reservation|\/appointment|\/schedule|\/apply|\/approve|\/reject|\/confirm|\/place|\/process|\/quote|\/enroll|\/subscribe)/i;
const SESSION_PATH_RE = /(?:login|logon|auth|oauth|oidc|saml|sso|callback|token|session|csrf|xsrf|authorize|jwt\/v2\/create-cookie|iam|mfa|otp|2fa|totp|challenge|verify|step-?up|connect\/token|realms|adfs|wsfed|openid)/i;
// Token-exchange endpoints (OAuth2/OIDC token, PKCE, client-credentials) are
// business-critical auth producers, NOT foldable browser redirect hops. A POST
// to any of these must never be disabled to reach green (M2M/PKCE/banking).
const TOKEN_ENDPOINT_RE = /\/(?:oauth2?\/token|connect\/token|token|as\/token\.oauth2|v\d+\/token|services\/oauth2\/token|access[_-]?token)(?:\/|\?|$)/i;
const SESSION_MATERIAL_RE = /(?:sess|session|token|csrf|xsrf|auth|iam|idem|sso|jwt|access|refresh|PHPSESSID)/i;
const AUTHORIZE_RESUME_RE = /\/authorize\/resume\/?(?:\?|$)/i;
const INTERCEPTOR_AUTHORIZE_RE = /\/s\/interceptor\/authorize\/?(?:\?|$)/i;
const JWT_CREATE_COOKIE_RE = /\/jwt\/v2\/create-cookie(?:\/|\?|$)/i;
// NOTE: oauth/token is kept here for GET browser-redirect hops (SPA flows where
// JMeter follows the redirect), but isFoldableRedirectHop() below refuses to
// fold a POST token exchange — that carries the credential grant.
const REDIRECT_HOP_RE = /\/(?:s\/interceptor(?:\/authorize)?|interceptor|authorize\/resume|iam\/callback|oauth\/token|user\/iam\/authorize|redirect|logout|v2\/logout)(?:\/|\?|$)/i;
const SAFE_BROWSER_NOISE_RE = /(?:domainreliability|ohttp|safebrowsing|gstatic|beacon|analytics|telemetry|launchdarkly|\/sdk\/evalx|\/favicon\.ico|\/_next\/data\/)/i;

function adjudicateRequests({
    entries = [],
    evidence = null,
    valueFlow = null,
    guard = null,
    failureReport = null,
    failureForensics = null,
} = {}) {
    const rowsByIndex = evidenceRowsByIndex(evidence);
    const failuresByIndex = failuresByIndexFrom({ evidence, failureReport });
    const rootCauseIndex = rootIndexFrom(failureForensics);
    const authWall = isAuthWall(failureForensics);
    const byIndex = {};
    const bySampler = {};
    const actions = { disable: [], protect: [], stop: [], ignore: [], blocked: [] };

    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index] || {};
        const label = labelFor(entry, index, rowsByIndex.get(index));
        const row = rowsByIndex.get(index) || {};
        const flow = valueFlowRow(valueFlow, index, label);
        const attemptedDisable = attemptedDisableFor(failureReport, index, label);
        const decision = classifyOne({
            entry,
            index,
            label,
            row,
            flow,
            attemptedDisable,
            guard,
            rootCauseIndex,
            authWall,
            failure: failuresByIndex.get(index),
        });
        if (!decision) continue;
        byIndex[index] = decision;
        bySampler[label] = decision;
        pushAction(actions, decision);
    }

    return {
        byIndex,
        bySampler,
        actions,
        summary: summarize(actions),
    };
}

function adjudicateFailureReport({
    failureReport = {},
    entries = [],
    evidence = null,
    valueFlow = null,
    guard = null,
    failureForensics = null,
} = {}) {
    const adjudication = adjudicateRequests({ entries, evidence, valueFlow, guard, failureReport, failureForensics });
    const blocked = [];
    const allowedByLabel = new Map();

    for (const item of failureReport.samplersToDisable || []) {
        const label = String(item.samplerLabel || item.sampler || item.label || '').trim();
        const decision = decisionForLabel(adjudication, label);
        if (isProtectedDecision(decision) || guardProtects(guard, label)) {
            blocked.push({ ...item, samplerLabel: label, reason: decision && decision.reason || item.reason || 'protected by adjudicator' });
            continue;
        }
        allowedByLabel.set(label, { ...item, samplerLabel: label });
    }

    for (const item of adjudication.actions.disable) {
        if (!allowedByLabel.has(item.samplerLabel)) {
            allowedByLabel.set(item.samplerLabel, {
                samplerLabel: item.samplerLabel,
                reason: item.reason,
                responseCode: item.responseCode || '',
            });
        }
    }

    return {
        report: { ...failureReport, samplersToDisable: [...allowedByLabel.values()] },
        blocked,
        adjudication,
    };
}

function classifyOne({ entry, index, label, row, flow, attemptedDisable, guard, rootCauseIndex, authWall, failure }) {
    const method = methodOf(entry);
    const path = pathOf(entry);
    const url = entry.request && entry.request.url || '';
    const hay = `${label} ${url} ${path}`;
    const responseCode = String(row.observedStatus || failure && (failure.responseCode || failure.code) || '');
    const observedStatus = Number(responseCode || 0);
    const consumedOutputCount = Number(flow && flow.consumedOutputCount || 0);
    const protectedByGuard = guardProtects(guard, label);
    const failed = !!failure || row.success === false || (Number.isFinite(observedStatus) && observedStatus >= 400);
    const businessRequest = isBusinessRequest(method, hay);
    const sessionLike = SESSION_PATH_RE.test(hay);
    const tokenExchange = TOKEN_ENDPOINT_RE.test(path) && MUTATING_METHOD_RE.test(method || '');
    const redirectHop = REDIRECT_HOP_RE.test(path) && !tokenExchange;
    const safeNoise = SAFE_BROWSER_NOISE_RE.test(hay);
    const downstreamOfRoot = Number.isFinite(rootCauseIndex) && index > rootCauseIndex;
    const isRoot = Number.isFinite(rootCauseIndex) && index === rootCauseIndex;
    const sessionMaterial = producesSessionMaterial(entry, row);
    const foldableRedirectHop = isFoldableRedirectHop({
        method, path, redirectHop, protectedByGuard, businessRequest, consumedOutputCount, sessionMaterial,
    });

    if (authWall && downstreamOfRoot && failed && AUTHORIZE_RESUME_RE.test(path) && /^GET$/i.test(method || '')) {
        return buildDecision('redirect_hop', 'disable', {
            entry, index, label, row, flow,
            reason: `downstream authorize/resume redirect hop is stale under auth/session root cause at index ${rootCauseIndex}`,
        });
    }

    if (attemptedDisable && !foldableRedirectHop && (protectedByGuard || consumedOutputCount > 0 || businessRequest || sessionMaterial)) {
        return buildDecision('blocked_disable', 'protect', {
            entry, index, label, row, flow,
            tier: protectedByGuard ? 'guard' : 'evidence',
            reason: protectedByGuard ? 'business guard protected this sampler' : 'disable would remove required producer/business sampler',
        });
    }

    if (foldableRedirectHop && INTERCEPTOR_AUTHORIZE_RE.test(path) && (failed || isRoot || attemptedDisable)) {
        return buildDecision('redirect_hop', 'disable', {
            entry, index, label, row, flow, reason: INTERCEPTOR_AUTHORIZE_RE.test(path)
                ? 'interceptor authorize redirect hop produced no session cookie/token; fold it and let the parent auth/session chain continue'
                : 'recorded redirect/browser hop has no downstream session-material consumer and can be folded',
        });
    }

    if (authWall && isRoot) {
        return buildDecision('auth_wall', 'stop', {
            entry, index, label, row, flow, reason: 'root auth/session wall must be solved before downstream samplers are judged',
        });
    }

    if (authWall && downstreamOfRoot && failed) {
        return buildDecision('downstream_casualty', 'ignore', {
            entry, index, label, row, flow, reason: `downstream of auth/session root cause at index ${rootCauseIndex}`,
        });
    }

    if ((sessionMaterial || consumedOutputCount > 0) && (sessionLike || JWT_CREATE_COOKIE_RE.test(path)) && !INTERCEPTOR_AUTHORIZE_RE.test(path)) {
        return buildDecision('session_producer', 'protect', {
            entry, index, label, row, flow, reason: 'sampler produces session/cookie/token evidence consumed downstream',
        });
    }

    // A POST token-exchange is the credential grant; protect it unconditionally
    // (even if correlation didn't track its access_token as a consumer) so it is
    // never folded to reach green in M2M / PKCE / client-credentials / banking.
    if (tokenExchange) {
        return buildDecision('session_producer', 'protect', {
            entry, index, label, row, flow, tier: 'prior',
            reason: 'OAuth2/OIDC token exchange endpoint issues the access grant; never fold it',
        });
    }

    if (protectedByGuard || businessRequest) {
        return buildDecision('business_request', 'protect', {
            entry, index, label, row, flow,
            tier: protectedByGuard ? 'guard' : 'prior',
            reason: protectedByGuard ? 'business guard protected this sampler' : 'business request must not be disabled',
        });
    }

    if (redirectHop && consumedOutputCount === 0 && failed && !isRoot) {
        return buildDecision('redirect_hop', 'disable', {
            entry, index, label, row, flow, reason: 'recorded redirect/browser hop has no downstream consumer and can be folded',
        });
    }

    if (safeNoise && consumedOutputCount === 0 && failed) {
        return buildDecision('safe_browser_plumbing', 'disable', {
            entry, index, label, row, flow, tier: 'prior', reason: 'browser or third-party noise with no downstream consumer',
        });
    }

    if (failed && consumedOutputCount === 0 && isDeadPlumbingPath(path, hay)) {
        return buildDecision('dead_plumbing', 'disable', {
            entry, index, label, row, flow, tier: 'prior', reason: 'failing plumbing sampler has no downstream consumed output',
        });
    }

    if (sessionLike && failed) {
        return buildDecision('session_producer', 'protect', {
            entry, index, label, row, flow, tier: 'prior', reason: 'auth/session-like sampler is not safe to fold without stronger proof',
        });
    }

    if (failed) {
        return buildDecision('unknown', 'review', {
            entry, index, label, row, flow, tier: 'review', reason: 'insufficient evidence for automatic action',
        });
    }

    return null;
}

/**
 * Evidence tiers, highest first — every decision declares its basis so a
 * human (and the replanner) can see WHY a sampler was judged:
 *   guard    — operator config, steering, golden script (via the guard)
 *   evidence — observed facts: consumption links, session material, root cause
 *   prior    — pattern knowledge (regexes/playbooks); may only act when no
 *              higher-tier evidence contradicts it
 *   review   — insufficient basis for automatic action
 */
function buildDecision(category, action, { entry, index, label, row, flow, reason, tier = 'evidence' }) {
    return {
        index,
        samplerLabel: label,
        category,
        action,
        tier,
        reason,
        method: methodOf(entry),
        url: entry.request && entry.request.url || '',
        path: pathOf(entry),
        responseCode: String(row.observedStatus || ''),
        finalUrl: row.finalUrl || '',
        consumedOutputCount: Number(flow && flow.consumedOutputCount || 0),
        consumerIndexes: flow && flow.consumerIndexes || [],
    };
}

function evidenceRowsByIndex(evidence) {
    const map = new Map();
    for (const row of evidence && evidence.rows || []) {
        if (Number.isFinite(Number(row.entryIndex))) map.set(Number(row.entryIndex), row);
    }
    return map;
}

function failuresByIndexFrom({ evidence, failureReport }) {
    const map = new Map();
    for (const row of evidence && evidence.rows || []) {
        const code = Number(row.observedStatus || 0);
        if (row.success === false || code >= 400) map.set(Number(row.entryIndex), row);
    }
    for (const item of failureReport && failureReport.samplersToDisable || []) {
        const index = Number(item.index ?? item.samplerIndex);
        if (Number.isFinite(index)) map.set(index, item);
        const step = peNaming.stepNumberFromLabel(item.samplerLabel || item.sampler || item.label);
        if (step) map.set(step - 1, item);
    }
    return map;
}

function valueFlowRow(valueFlow, index, label) {
    if (!valueFlow) return null;
    if (valueFlow.byIndex) {
        const row = Array.isArray(valueFlow.byIndex) ? valueFlow.byIndex[index] : valueFlow.byIndex[index];
        if (row) return row;
    }
    return valueFlow.bySampler && valueFlow.bySampler[label] || null;
}

function attemptedDisableFor(failureReport, index, label) {
    for (const item of failureReport && failureReport.samplersToDisable || []) {
        const itemLabel = String(item.samplerLabel || item.sampler || item.label || '').trim();
        if (itemLabel === label) return item;
        const step = peNaming.stepNumberFromLabel(itemLabel);
        if (step && step - 1 === index) return item;
    }
    return null;
}

function decisionForLabel(adjudication, label) {
    if (!adjudication || !label) return null;
    if (adjudication.bySampler && adjudication.bySampler[label]) return adjudication.bySampler[label];
    const step = peNaming.stepNumberFromLabel(label);
    return step ? adjudication.byIndex && adjudication.byIndex[step - 1] || null : null;
}

function pushAction(actions, decision) {
    const item = {
        index: decision.index,
        samplerLabel: decision.samplerLabel,
        category: decision.category,
        reason: decision.reason,
        responseCode: decision.responseCode,
    };
    switch (decision.action) {
        case 'disable':
            actions.disable.push(item);
            break;
        case 'protect':
            actions.protect.push(item);
            break;
        case 'stop':
            actions.stop.push(item);
            break;
        case 'ignore':
            actions.ignore.push(item);
            break;
        default:
            break;
    }
    if (decision.category === 'blocked_disable') actions.blocked.push(item);
}

function summarize(actions) {
    return {
        disable: actions.disable.length,
        protect: actions.protect.length,
        stop: actions.stop.length,
        ignore: actions.ignore.length,
        blocked: actions.blocked.length,
    };
}

function isProtectedDecision(decision) {
    return !!decision && ['protect', 'stop', 'ignore'].includes(decision.action);
}

function guardProtects(guard, label) {
    return !!(guard && guard.protectedNames && guard.protectedNames.has(String(label || '').trim()));
}

function rootIndexFrom(failureForensics) {
    const index = failureForensics && failureForensics.rootCause && failureForensics.rootCause.index;
    return Number.isFinite(Number(index)) ? Number(index) : null;
}

function isAuthWall(failureForensics) {
    if (!failureForensics) return false;
    const root = failureForensics.rootCause || {};
    const action = failureForensics.recommendedAction && failureForensics.recommendedAction.id || '';
    return !!(failureForensics.redirects && failureForensics.redirects.interactiveAuthWall) ||
        /provide-test-auth-path|auth-wall-stop/.test(action) ||
        /auth_redirect_bounce|redirect_flow_drift|interactive_auth|auth_wall/i.test(`${root.category || ''} ${root.relevance || ''}`);
}

function isBusinessRequest(method, hay) {
    return MUTATING_METHOD_RE.test(method) && BUSINESS_PATH_RE.test(hay);
}

function isDeadPlumbingPath(path, hay) {
    return JWT_CREATE_COOKIE_RE.test(path) ||
        REDIRECT_HOP_RE.test(path) ||
        SAFE_BROWSER_NOISE_RE.test(hay) ||
        /(?:logout|create-cookie|telemetry|analytics|beacon|domainreliability|launchdarkly|sdk\/evalx)/i.test(hay);
}

function isFoldableRedirectHop({ method, path, redirectHop, protectedByGuard, businessRequest, consumedOutputCount, sessionMaterial }) {
    if (!redirectHop || protectedByGuard || businessRequest || sessionMaterial) return false;
    // A POST to a token-exchange endpoint is the credential grant itself (OAuth2
    // token, PKCE code exchange, client-credentials, Salesforce oauth2/token). Its
    // access_token output may not be tracked as a consumer if correlation missed
    // it, but folding it silently breaks every downstream authenticated call.
    if (TOKEN_ENDPOINT_RE.test(path) && MUTATING_METHOD_RE.test(method || '')) return false;
    if (INTERCEPTOR_AUTHORIZE_RE.test(path)) return /^GET$/i.test(method || '');
    return consumedOutputCount === 0;
}

function producesSessionMaterial(entry, row) {
    const headers = [
        ...headersFromEntry(entry),
        ...headersFromRow(row),
    ];
    for (const header of headers) {
        const name = String(header.name || '');
        const value = String(header.value || '');
        if (/^set-cookie$/i.test(name)) {
            const cookieName = value.split('=')[0] || '';
            if (SESSION_MATERIAL_RE.test(cookieName)) return true;
        }
        if (/^(authorization|x-csrf-token|x-xsrf-token)$/i.test(name) && value) return true;
    }
    const body = entry && entry.response && entry.response.content && entry.response.content.text || '';
    if (/\b(?:access_token|refresh_token|id_token|csrfToken|csrf_token|sessionId|session_id)\b/i.test(String(body || ''))) return true;
    return false;
}

function headersFromEntry(entry) {
    return entry && entry.response && Array.isArray(entry.response.headers) ? entry.response.headers : [];
}

function headersFromRow(row) {
    if (!row) return [];
    if (Array.isArray(row.observedResponseHeaders)) return row.observedResponseHeaders;
    if (Array.isArray(row.responseHeaders)) return row.responseHeaders;
    return [];
}

function labelFor(entry, index, row) {
    return row && row.label || `Step ${String(index + 1).padStart(2, '0')} - ${methodOf(entry)} ${pathOf(entry)}`;
}

function methodOf(entry) {
    return String(entry && entry.request && entry.request.method || 'GET').toUpperCase();
}

function pathOf(entry) {
    const url = typeof entry === 'string' ? entry : entry && entry.request && entry.request.url;
    try { return new URL(url || '').pathname || '/'; }
    catch { return String(url || '/').split('?')[0] || '/'; }
}

module.exports = {
    adjudicateRequests,
    adjudicateFailureReport,
    _internal: {
        classifyOne,
        isAuthWall,
        isDeadPlumbingPath,
        isFoldableRedirectHop,
        producesSessionMaterial,
        rootIndexFrom,
    },
};
