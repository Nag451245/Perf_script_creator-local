'use strict';

const { replayOne } = require('./fast-replay');
const { safeJsonShape } = require('./verifier')._internal;
const semanticResponse = require('./semantic-response');
const requestDiff = require('./request-diff');

const HEADER_ALLOWLIST = new Set(['content-type', 'location', 'www-authenticate']);

async function collectFailingResponseEvidence({
    entries = [],
    failures = [],
    targetBaseUrl = '',
    insecure = true,
    timeoutMs,
    max = 4,
} = {}) {
    const cookieJar = new Map();
    const out = [];
    for (const failure of failures.slice(0, max)) {
        const index = Number(failure.index ?? failure.samplerIndex);
        if (!Number.isFinite(index) || !entries[index]) continue;
        try {
            const r = await replayOne({
                entry: entries[index],
                vars: {},
                cookieJar,
                targetBaseUrl,
                insecure,
                timeoutMs,
            });
            const recordedBody = entries[index].response && entries[index].response.content && entries[index].response.content.text || '';
            const semantic = semanticResponse.compareRecordedLiveResponse({
                recorded: {
                    status: entries[index].response && entries[index].response.status,
                    body: recordedBody,
                    contentType: headerValue(entries[index].response && entries[index].response.headers, 'content-type'),
                },
                observed: {
                    status: r.status,
                    body: r.body || '',
                    headers: r.headers || {},
                },
                sampler: failure.samplerName || failure.samplerLabel || '',
                index,
            });
            const reqDiff = requestDiff.compareRecordedRequestToObserved({
                entry: entries[index],
                observedRequest: r.request || {},
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
    _internal: { scrubText, scrubHeaders, extractTitle, headerValue, headersArrayToObject },
};
