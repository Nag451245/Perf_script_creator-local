'use strict';

const { replayOne } = require('./fast-replay');
const { safeJsonShape } = require('./verifier')._internal;
const semanticResponse = require('./semantic-response');
const requestDiff = require('./request-diff');
const { planReplayDependencies } = require('./replay-dependencies');

const HEADER_ALLOWLIST = new Set(['content-type', 'location', 'www-authenticate']);

async function collectFailingResponseEvidence({
    entries = [],
    failures = [],
    targetBaseUrl = '',
    insecure = true,
    timeoutMs,
    max = 4,
    correlationLedger = null,
    enabledBySampler = new Map(),
    targetHostMap = null,
    runEvidence = null,
    runtimeProof = null,
} = {}) {
    const out = [];
    let context = null;
    const ordered = normalizeFailures(failures, max);
    for (const failure of ordered) {
        const index = Number(failure.index ?? failure.samplerIndex);
        if (!Number.isFinite(index) || !entries[index]) continue;
        const plan = planReplayDependencies({ entries, targetIndexes: [index], correlationLedger, enabledBySampler });
        if (plan.blocked) {
            out.push(unverifiedEvidence(index, failure, plan, plan.blockedRequirements.map(item => item.reason).join(' ')));
            continue;
        }
        const key = flowKey(entries[index], plan);
        const reusable = context && context.key === key && isPrefix(context.replayedIndexes, plan.indexes);
        if (!reusable) context = { key, cookieJar: new Map(), vars: provenRuntimeVars(runEvidence, runtimeProof), replayedIndexes: [] };
        let targetResponse = null;
        let firstDivergence = null;
        try {
            for (const replayIndex of plan.indexes) {
                if (context.replayedIndexes.includes(replayIndex)) continue;
                if (!recordedBaseline(entries[replayIndex])) {
                    out.push(unverifiedEvidence(index, failure, plan, `Recorded response baseline is absent for prerequisite #${replayIndex}.`));
                    firstDivergence = { index: replayIndex, kind: 'missing_recorded_baseline', upstream: replayIndex !== index };
                    break;
                }
                const replayEntry = applyProvenCorrelationLinks(entries[replayIndex], replayIndex, runtimeProof);
                const response = await replayOne({
                    entry: replayEntry, vars: context.vars, cookieJar: context.cookieJar,
                    targetBaseUrl, targetHostMap, insecure, timeoutMs,
                });
                context.replayedIndexes.push(replayIndex);
                const replaySemantic = compareResponse(entries[replayIndex], response, failure, replayIndex);
                if (!firstDivergence && replaySemantic.issues.length) {
                    firstDivergence = {
                        index: replayIndex, prerequisiteIndex: replayIndex, producerIndex: replayIndex, consumerIndex: index,
                        kind: 'response_divergence', issues: replaySemantic.issues, upstream: replayIndex !== index,
                    };
                }
                if (replayIndex === index) targetResponse = response;
            }
            if (!targetResponse) continue;
            const r = targetResponse;
            const recordedBody = entries[index].response && entries[index].response.content && entries[index].response.content.text || '';
            const semantic = compareResponse(entries[index], r, failure, index);
            const reqDiff = requestDiff.compareRecordedRequestToObserved({
                entry: applyProvenCorrelationLinks(entries[index], index, runtimeProof),
                observedRequest: r.request || {},
                ignoreHeaderStillRecorded: usableHeaderNames(runtimeProof, index),
                index,
                sampler: failure.samplerName || failure.samplerLabel || '',
            });
            const redirectDiff = requestDiff.compareRedirectResponse({
                recorded: {
                    status: entries[index].response && entries[index].response.status,
                    headers: headersArrayToObject(entries[index].response && entries[index].response.headers),
                },
                observed: { status: r.status, headers: r.headers || {} },
                index,
                sampler: failure.samplerName || failure.samplerLabel || '',
            });
            out.push({
                index,
                sampler: failure.samplerName || failure.samplerLabel || '',
                status: r.status,
                headers: scrubHeaders(r.headers || {}),
                jsonShape: safeJsonShape(r.body || '') || null,
                semanticIssues: semantic.issues || [],
                requestIssues: reqDiff.issues || [],
                redirectIssues: redirectDiff.issues || [],
                title: extractTitle(r.body || ''),
                bodyExcerpt: excerpt(scrubText(r.body || ''), 1200),
                targetIndex: index,
                replayedIndexes: plan.indexes,
                prerequisiteIndexes: plan.requiredProducers,
                firstDivergence,
                upstream: !!(firstDivergence && firstDivergence.index !== index),
                casualty: !!(firstDivergence && firstDivergence.index !== index),
                variableReplay: Object.keys(context.vars).length ? 'PROVEN_FROM_JMETER' : 'UNVERIFIED',
                ...generatedSubstitutionEvidence({ runEvidence, runtimeProof, targetIndex: index }),
            });
        } catch (e) {
            out.push({
                index,
                sampler: failure.samplerName || failure.samplerLabel || '',
                status: 0,
                error: e.message,
            });
        }
    }
    return out;
}

function recordedBaseline(entry) {
    const response = entry && entry.response;
    return !!(response && (Number(response.status) > 0 || (response.content && typeof response.content.text === 'string')));
}

function compareResponse(entry, observed, failure, index) {
    const compared = semanticResponse.compareRecordedLiveResponse({
        recorded: {
            status: entry.response && entry.response.status,
            body: entry.response && entry.response.content && entry.response.content.text || '',
            contentType: headerValue(entry.response && entry.response.headers, 'content-type'),
        },
        observed: { status: observed.status, body: observed.body || '', headers: observed.headers || {} },
        sampler: failure.samplerName || failure.samplerLabel || '', index,
    });
    const recordedStatus = Number(entry.response && entry.response.status || 0);
    if (recordedStatus && recordedStatus !== Number(observed.status || 0)) {
        compared.issues.unshift({ kind: 'statusDiff', recorded: recordedStatus, observed: observed.status, severity: 'critical' });
    }
    return compared;
}

function flowKey(entry, plan) {
    try { return `${new URL(entry.request.url).hostname}|${plan.start}`; } catch { return `unknown|${plan.start}`; }
}

function isPrefix(prefix, values) {
    return prefix.every((value, index) => values[index] === value);
}

function unverifiedEvidence(index, failure, plan, reason) {
    const upstream = plan.start !== index;
    return {
        index, targetIndex: index, sampler: failure.samplerName || failure.samplerLabel || '',
        status: 'UNVERIFIED', error: reason, replayedIndexes: plan.indexes,
        prerequisiteIndexes: plan.requiredProducers,
        firstDivergence: { index: plan.start, prerequisiteIndex: plan.start, producerIndex: plan.start, consumerIndex: index, kind: 'unverified_replay_context', reason, upstream },
        upstream, casualty: upstream,
    };
}

function normalizeFailures(failures = [], max = 4) {
    const unique = new Map();
    for (const failure of failures || []) {
        const index = Number(failure && (failure.index ?? failure.samplerIndex));
        if (!Number.isFinite(index) || unique.has(index)) continue;
        const normalized = { ...failure, index };
        delete normalized.samplerIndex;
        unique.set(index, normalized);
    }
    return [...unique.values()].sort((a, b) => a.index - b.index).slice(0, max);
}

function generatedSubstitutionEvidence({ runEvidence, runtimeProof, targetIndex }) {
    const row = (runEvidence && runEvidence.rows || []).find(item => Number(item.entryIndex ?? item.index) === Number(targetIndex));
    const rendered = !!(row && row.renderedRequest && row.renderedRequest.evidenceProvenance && row.renderedRequest.evidenceProvenance.requestData);
    const links = (runtimeProof && runtimeProof.links || []).filter(link => Number(link.consumerIndex) === Number(targetIndex));
    return {
        jmeterRenderedRequest: rendered ? 'VERIFIED' : 'UNVERIFIED',
        generatedSubstitutions: links.map(link => ({
            variable: String(link.variable || link.link && link.link.variable || 'unknown'),
            status: String(link.status || 'UNVERIFIED'),
            fresh: replayUsableLink(link),
            consumerSuccess: link.consumer ? link.consumer.success !== false : null,
        })),
    };
}

function provenRuntimeVars(runEvidence, runtimeProof) {
    const vars = {};
    for (const link of runtimeProof && runtimeProof.links || []) {
        if (!replayUsableLink(link) || !link.variable) continue;
        vars[link.variable] = link.value;
    }
    return vars;
}

function applyProvenCorrelationLinks(entry, consumerIndex, runtimeProof) {
    const clone = JSON.parse(JSON.stringify(entry || {}));
    for (const link of runtimeProof && runtimeProof.links || []) {
        if (!replayUsableLink(link) || Number(link.consumerIndex) !== Number(consumerIndex)) continue;
        replaceSink(clone.request || {}, link, String(link.value));
    }
    return clone;
}

function replaceSink(request, link, value) {
    const location = String(link.sinkLocation || '');
    const name = String(link.sinkName || location.split(':').slice(1).join(':') || '');
    if (!location || !name) return;
    if (/^(?:url-query|query-string):/i.test(location)) {
        const url = new URL(String(request.url || ''));
        url.searchParams.set(name, value);
        request.url = url.toString();
    } else if (/^header:/i.test(location)) {
        const header = (request.headers || []).find(item => String(item.name || '').toLowerCase() === name.toLowerCase());
        if (header) {
            const recorded = String(link.recordedValue || '');
            header.value = recorded && String(header.value || '').includes(recorded)
                ? String(header.value).split(recorded).join(value) : value;
        }
    } else if (/^(?:form|post-data-param):/i.test(location)) {
        const body = request.postData && typeof request.postData.text === 'string' ? request.postData.text : null;
        if (body != null) request.postData.text = body.split('&').map(part => {
            const index = part.indexOf('=');
            return index >= 0 && decodeURIComponent(part.slice(0, index).replace(/\+/g, ' ')) === name
                ? `${part.slice(0, index + 1)}${encodeURIComponent(value)}` : part;
        }).join('&');
        for (const param of request.postData && request.postData.params || []) {
            if (String(param.name || '') === name) param.value = value;
        }
    } else if (/^json:/i.test(location) && request.postData && request.postData.text) {
        try {
            const json = JSON.parse(request.postData.text);
            let node = json;
            const parts = name.match(/[^.[\]]+|\[\d+\]/g) || [];
            for (let i = 0; i < parts.length - 1; i++) node = node[parts[i].replace(/^\[|\]$/g, '')];
            const key = parts.at(-1).replace(/^\[|\]$/g, '');
            if (node && Object.prototype.hasOwnProperty.call(node, key)) request.postData.text = JSON.stringify(json);
            if (node && Object.prototype.hasOwnProperty.call(node, key)) node[key] = value;
            request.postData.text = JSON.stringify(json);
        } catch { /* unsupported body stays unchanged */ }
    }
}

function usableHeaderNames(runtimeProof, consumerIndex) {
    return (runtimeProof && runtimeProof.links || [])
        .filter(link => replayUsableLink(link) && Number(link.consumerIndex) === Number(consumerIndex) && /^header:/i.test(String(link.sinkLocation || '')))
        .map(link => String(link.sinkName || String(link.sinkLocation).split(':').slice(1).join(':')).toLowerCase());
}

function replayUsableLink(link = {}) {
    const value = String(link.value == null ? '' : link.value);
    return !!value && !/(?:_NOTFOUND\b|\bNOT_FOUND_)/i.test(value) && link.consumer && link.consumer.transmitted === true;
}

function scrubHeaders(headers) {
    const out = {};
    for (const [k, v] of Object.entries(headers || {})) {
        const name = String(k || '').toLowerCase();
        if (!HEADER_ALLOWLIST.has(name)) continue;
        out[name] = scrubText(Array.isArray(v) ? v.join(', ') : String(v || ''));
    }
    return out;
}

function scrubText(text) {
    let out = String(text || '');
    out = out.replace(/"([^"]*(?:token|secret|password|cookie|session|csrf|xsrf|sid)[^"]*)"\s*:\s*"[^"]*"/gi, '"$1":"[REDACTED]"');
    out = out.replace(/((?:access_token|refresh_token|id_token|token|secret|password|session|sid|csrf|xsrf)=)[^&\s"']+/gi, '$1[REDACTED]');
    out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
    return out;
}

function extractTitle(body) {
    const m = String(body || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return m ? excerpt(scrubText(m[1].replace(/\s+/g, ' ').trim()), 200) : '';
}

function excerpt(text, max) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max)}...` : s;
}

function headerValue(headers, name) {
    const wanted = String(name || '').toLowerCase();
    const found = (headers || []).find(h => String(h.name || '').toLowerCase() === wanted);
    return found ? String(found.value || '') : '';
}

function headersArrayToObject(headers = []) {
    const out = {};
    for (const h of headers || []) out[String(h.name || '').toLowerCase()] = String(h.value || '');
    return out;
}

module.exports = {
    collectFailingResponseEvidence,
    _internal: { scrubText, scrubHeaders, extractTitle, headerValue, headersArrayToObject, normalizeFailures, generatedSubstitutionEvidence, provenRuntimeVars, applyProvenCorrelationLinks, replayUsableLink, usableHeaderNames },
};
