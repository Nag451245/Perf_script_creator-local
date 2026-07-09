'use strict';

const statusAnalysis = require('./status-analysis');

const AUTH_PATH_RE = /\/(?:authorize(?:\/resume)?|iam\/callback|redirect|authorization|login|u\/login|oauth|saml|sso)\b/i;

function analyzeFailureForensics({
    entries = [],
    samples = [],
    baselineDiff = null,
    responseEvidence = [],
} = {}) {
    const normalized = normalizeSamples(samples);
    const divergences = buildDivergenceLedger(entries, normalized, baselineDiff);
    const rootCause = divergences[0] || null;
    const redirects = buildRedirectLedger(entries, normalized, rootCause);
    const authSession = buildAuthSessionProof(entries, normalized, rootCause);
    const graphql = buildGraphqlEvidence(entries, normalized, rootCause, responseEvidence);
    const recommendedAction = recommendAction({ rootCause, redirects, authSession, graphql });

    return {
        summary: summarize({ rootCause, redirects, authSession, graphql, recommendedAction }),
        rootCause,
        divergences,
        authSession,
        redirects,
        graphql,
        recommendedAction,
        baseline: baselineDiff ? {
            samplesCompared: baselineDiff.samplesCompared || 0,
            driftCount: Array.isArray(baselineDiff.drift) ? baselineDiff.drift.length : 0,
        } : null,
    };
}

function buildDivergenceLedger(entries, samples) {
    const out = [];
    for (const pair of alignEntrySamplePairs(entries, samples)) {
        const { entry, sample, entryIndex } = pair;
        const recordedStatus = Number(entry.response && entry.response.status || 0);
        const observedStatus = Number(sample.status || 0);
        if (!recordedStatus || !observedStatus) continue;
        const transition = statusAnalysis.classifyStatusTransition(recordedStatus, observedStatus);
        if (transition.matchesRecording || transition.folded) continue;
        out.push({
            index: entryIndex,
            sampler: sample.label || samplerLabel(entry, entryIndex),
            method: methodOf(entry),
            url: entry.request && entry.request.url || '',
            recordedStatus,
            observedStatus,
            category: transition.category,
            relevance: transition.relevance,
            repairHint: transition.repairHint,
            recordedBodyLength: bodyLength(entry.response && entry.response.content && entry.response.content.text),
            observedBodyLength: bodyLength(sample.body),
        });
    }
    return out;
}

function buildAuthSessionProof(entries, samples, rootCause) {
    const recordedSetCookies = cookieNamesFromEntries(entries);
    const observedSetCookies = cookieNamesFromSamples(samples);
    const missingSessionCookies = recordedSetCookies.filter(name => !observedSetCookies.includes(name));
    const authDiverged = !!rootCause && (/auth|session|redirect/i.test(rootCause.category || '') || [401, 403].includes(Number(rootCause.observedStatus)));
    return {
        recordedSetCookies,
        observedSetCookies,
        missingSessionCookies,
        authDiverged,
        summary: missingSessionCookies.length
            ? `Recorded session cookie(s) not proven live: ${missingSessionCookies.join(', ')}.`
            : (recordedSetCookies.length ? 'Recorded session cookies were observed live or not required by evidence.' : 'No recorded Set-Cookie session evidence was found.'),
    };
}

function buildRedirectLedger(entries, samples, rootCause) {
    const redirects = [];
    let interactiveAuthWall = false;
    for (const pair of alignEntrySamplePairs(entries, samples)) {
        const { entry, sample, entryIndex } = pair;
        const url = entry.request && entry.request.url || '';
        const path = pathOf(url);
        const recordedStatus = Number(entry.response && entry.response.status || 0);
        const observedStatus = Number(sample.status || 0);
        if (!AUTH_PATH_RE.test(path) && recordedStatus < 300 && observedStatus < 300) continue;
        const item = {
            index: entryIndex,
            sampler: sample.label || samplerLabel(entry, entryIndex),
            path,
            recordedStatus,
            observedStatus,
            category: classifyRedirectObservation(path, recordedStatus, observedStatus),
        };
        if (/authorize\/resume|iam\/callback|redirect|authorization/i.test(path) &&
            recordedStatus >= 300 && recordedStatus < 400 &&
            [401, 403].includes(observedStatus)) {
            interactiveAuthWall = true;
            item.interactiveAuthWall = true;
        }
        redirects.push(item);
    }
    return {
        items: redirects,
        interactiveAuthWall,
        rootCauseIsRedirect: !!rootCause && redirects.some(r => r.index === rootCause.index),
    };
}

function buildGraphqlEvidence(entries, samples, rootCause, responseEvidence) {
    const requests = [];
    const downstreamSymptoms = [];
    const semanticErrors = [];
    for (const pair of alignEntrySamplePairs(entries, samples)) {
        const { entry, sample, entryIndex } = pair;
        if (!isGraphql(entry, sample)) continue;
        const observedStatus = Number(sample.status || 0);
        const item = {
            index: entryIndex,
            sampler: sample.label || samplerLabel(entry, entryIndex),
            recordedStatus: Number(entry.response && entry.response.status || 0),
            observedStatus,
        };
        requests.push(item);
        if (rootCause && rootCause.index < entryIndex && [401, 403].includes(observedStatus)) {
            downstreamSymptoms.push({ ...item, rootCauseIndex: rootCause.index });
        }
        if (hasGraphqlError(sample.body) || evidenceHasGraphqlError(responseEvidence, entryIndex)) {
            semanticErrors.push(item);
        }
    }
    return {
        requests,
        downstreamSymptoms,
        semanticErrors,
        summary: downstreamSymptoms.length
            ? `${downstreamSymptoms.length} GraphQL failure(s) are downstream of the first auth/session divergence.`
            : `${requests.length} GraphQL request(s) inspected.`,
    };
}

function recommendAction({ rootCause, redirects, authSession }) {
    if (!rootCause) {
        return { id: 'collect-more-evidence', reason: 'No recording-vs-replay divergence could be proven from available samples.' };
    }
    if (redirects.interactiveAuthWall) {
        return { id: 'provide-test-auth-path', reason: 'Interactive auth redirect recorded success but replay was rejected; extractor guessing will not mint a browser-bound session.' };
    }
    if (isAuthSessionDivergence(rootCause, authSession)) {
        return { id: 'repair-auth-session-correlation', reason: 'The first divergence is in auth/session setup; repair stale state, hidden fields, cookies, or redirect payloads before treating downstream failures as root cause.' };
    }
    if (Number(rootCause.observedStatus) >= 500) {
        return { id: 'fix-environment', reason: 'The first divergence is a server error outside proven auth/session setup; validate staging manually before script repair.' };
    }
    if (authSession.authDiverged && authSession.missingSessionCookies.length) {
        return { id: 'provide-test-auth-path', reason: 'Replay did not prove the recorded session cookie was minted live.' };
    }
    if (/payload|header|client_error|bad_request/i.test(rootCause.category || '')) {
        return { id: 'repair-correlation', reason: 'The first divergence is a request/payload/header problem; repair that sampler before downstream failures.' };
    }
    return { id: 'fix-earliest-divergence', reason: 'Repair the earliest recording-vs-replay divergence before downstream symptoms.' };
}

function isAuthSessionDivergence(rootCause, authSession) {
    if (!rootCause) return false;
    const path = pathOf(rootCause.url || '');
    const hay = `${rootCause.category || ''} ${rootCause.relevance || ''} ${rootCause.sampler || ''} ${path}`.toLowerCase();
    return AUTH_PATH_RE.test(path) ||
        /auth|session|cookie|csrf|token|login|redirect|sso|saml|oauth/.test(hay) ||
        !!(authSession && authSession.authDiverged && authSession.missingSessionCookies && authSession.missingSessionCookies.length);
}

function renderFailureForensicsMarkdown(name, analysis = {}) {
    const lines = [`# ${name} Failure Forensics`, ''];
    if (!analysis.rootCause) {
        lines.push('No recording-vs-replay divergence could be proven from available evidence.');
        return lines.join('\n');
    }
    const root = analysis.rootCause;
    lines.push(`First divergence: ${root.sampler} recorded ${root.recordedStatus}, observed ${root.observedStatus}.`);
    lines.push('');
    lines.push(`Recommended action: ${analysis.recommendedAction && analysis.recommendedAction.id || 'unknown'} — ${analysis.recommendedAction && analysis.recommendedAction.reason || ''}`);
    lines.push('');
    lines.push('## Session Proof', '');
    lines.push(analysis.authSession && analysis.authSession.summary || 'No session proof available.');
    lines.push('');
    lines.push('## Redirect/Auth Evidence', '');
    if (analysis.redirects && analysis.redirects.items && analysis.redirects.items.length) {
        for (const item of analysis.redirects.items.slice(0, 10)) {
            lines.push(`- ${item.sampler}: recorded ${item.recordedStatus}, observed ${item.observedStatus} (${item.category})`);
        }
    } else {
        lines.push('- None');
    }
    lines.push('');
    lines.push('## GraphQL Evidence', '');
    lines.push(analysis.graphql && analysis.graphql.summary || 'No GraphQL evidence available.');
    return lines.join('\n');
}

function summarize({ rootCause, redirects, authSession, graphql, recommendedAction }) {
    if (!rootCause) return 'No proven recording-vs-replay divergence.';
    const parts = [`first divergence ${rootCause.sampler} recorded ${rootCause.recordedStatus} observed ${rootCause.observedStatus}`];
    if (authSession.missingSessionCookies.length) parts.push(`missing session cookie(s): ${authSession.missingSessionCookies.join(', ')}`);
    if (redirects.interactiveAuthWall) parts.push('interactive auth redirect wall detected');
    if (graphql.downstreamSymptoms.length) parts.push(`${graphql.downstreamSymptoms.length} downstream GraphQL symptom(s)`);
    if (recommendedAction) parts.push(`action=${recommendedAction.id}`);
    return parts.join('; ');
}

function normalizeSamples(samples) {
    return (samples || [])
        .filter(s => !s.isTransaction)
        .map(s => ({
            ...s,
            label: s.label || s.name || '',
            status: Number(s.responseCode || s.code || s.status || s.response && s.response.status || 0),
            body: s.body || s.responseBody || s.response && s.response.content && s.response.content.text || '',
        }));
}

function alignEntrySamplePairs(entries, samples) {
    const pairs = [];
    const usedSampleIndexes = new Set();
    const usedEntryIndexes = new Set();

    for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
        const sample = samples[sampleIndex] || {};
        const stepNumber = stepNumberFromLabel(sample.label);
        if (!stepNumber) continue;
        const entryIndex = stepNumber - 1;
        if (entryIndex < 0 || entryIndex >= entries.length || usedEntryIndexes.has(entryIndex)) continue;
        pairs.push({ entry: entries[entryIndex] || {}, sample, entryIndex, sampleIndex });
        usedEntryIndexes.add(entryIndex);
        usedSampleIndexes.add(sampleIndex);
    }

    let fallbackEntryIndex = 0;
    for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
        if (usedSampleIndexes.has(sampleIndex)) continue;
        while (fallbackEntryIndex < entries.length && usedEntryIndexes.has(fallbackEntryIndex)) fallbackEntryIndex++;
        if (fallbackEntryIndex >= entries.length) break;
        pairs.push({
            entry: entries[fallbackEntryIndex] || {},
            sample: samples[sampleIndex] || {},
            entryIndex: fallbackEntryIndex,
            sampleIndex,
        });
        usedEntryIndexes.add(fallbackEntryIndex);
        fallbackEntryIndex++;
    }

    return pairs.sort((a, b) => a.entryIndex - b.entryIndex || a.sampleIndex - b.sampleIndex);
}

function stepNumberFromLabel(label) {
    const match = /^Step\s+0*(\d+)\b/i.exec(String(label || '').trim());
    return match ? Number(match[1]) : 0;
}

function cookieNamesFromEntries(entries) {
    const names = [];
    for (const entry of entries || []) {
        for (const h of entry.response && entry.response.headers || []) {
            if (!/^set-cookie$/i.test(h.name || '')) continue;
            const name = cookieName(h.value);
            if (name && !names.includes(name)) names.push(name);
        }
    }
    return names;
}

function cookieNamesFromSamples(samples) {
    const names = [];
    for (const sample of samples || []) {
        for (const value of headerValues(sample, 'set-cookie')) {
            const name = cookieName(value);
            if (name && !names.includes(name)) names.push(name);
        }
    }
    return names;
}

function headerValues(sample, wantedName) {
    const wanted = String(wantedName || '').toLowerCase();
    const headers = sample.headers || sample.responseHeaders || sample.response && sample.response.headers || [];
    if (Array.isArray(headers)) {
        return headers.filter(h => String(h.name || '').toLowerCase() === wanted).map(h => String(h.value || ''));
    }
    const value = headers[wanted] || headers[wantedName] || '';
    return Array.isArray(value) ? value.map(String) : (value ? [String(value)] : []);
}

function cookieName(value) {
    const first = String(value || '').split(';')[0];
    const eq = first.indexOf('=');
    return eq > 0 ? first.slice(0, eq).trim() : '';
}

function samplerLabel(entry, index) {
    return `Step ${String(index + 1).padStart(2, '0')} - ${methodOf(entry)} ${pathOf(entry.request && entry.request.url)}`;
}

function methodOf(entry) {
    return String(entry && entry.request && entry.request.method || 'GET').toUpperCase();
}

function pathOf(url) {
    try { return new URL(url || '').pathname || '/'; }
    catch { return String(url || '/').split('?')[0] || '/'; }
}

function bodyLength(body) {
    return String(body || '').length;
}

function classifyRedirectObservation(path, recordedStatus, observedStatus) {
    if (recordedStatus >= 300 && recordedStatus < 400 && [401, 403].includes(observedStatus)) return 'auth_redirect_rejected';
    if (recordedStatus >= 300 && recordedStatus < 400 && observedStatus >= 200 && observedStatus < 300) return 'redirect_folded';
    if (AUTH_PATH_RE.test(path)) return 'auth_path_observed';
    return 'redirect_observed';
}

function isGraphql(entry, sample) {
    const url = entry.request && entry.request.url || '';
    const body = entry.request && entry.request.postData && entry.request.postData.text || '';
    const label = sample.label || sample.name || '';
    return /\/graphql\b/i.test(url) || /\bGraphQL\b/i.test(label) || /"query"\s*:|"mutation"\s*:|\bquery\s+\w+|\bmutation\s+\w+/i.test(body);
}

function hasGraphqlError(body) {
    return /"errors"\s*:\s*\[/.test(String(body || ''));
}

function evidenceHasGraphqlError(responseEvidence, index) {
    const evidence = (responseEvidence || []).find(e => Number(e.index) === Number(index));
    if (!evidence) return false;
    return (evidence.semanticIssues || []).some(i => /graphql|error/i.test(`${i.kind || ''} ${i.message || ''}`)) ||
        /"errors"\s*:\s*\[/.test(String(evidence.bodyExcerpt || ''));
}

module.exports = {
    analyzeFailureForensics,
    renderFailureForensicsMarkdown,
    _internal: {
        buildDivergenceLedger,
        cookieNamesFromEntries,
        cookieNamesFromSamples,
        isGraphql,
    },
};
