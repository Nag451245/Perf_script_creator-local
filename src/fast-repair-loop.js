'use strict';

const { replayAll, replayOne } = require('./fast-replay');
const { applyLlmPatches, validateLlmPatches } = require('./llm-patcher');
const { _internal: { indexSamplers } } = require('./business-guard');
const { _internal: { samplerLabel } } = require('./value-flow-decisions');
const { _internal: { safeJsonShape } } = require('./verifier');

async function runFastRepairLoop({
    xml,
    entries = [],
    fixes = [],
    targetBaseUrl = '',
    insecure = true,
    timeoutMs,
    onLog = () => {},
} = {}) {
    const fastReplayable = (fixes || []).filter(f => f && isFastReplayableKind(f.kind));
    if (!targetBaseUrl || !fastReplayable.length) {
        return {
            skipped: true,
            reason: !targetBaseUrl ? 'targetBaseUrl required' : 'no fast-replayable patch kinds',
            replayedIndexes: [],
        };
    }

    const validation = validateLlmPatches(fastReplayable);
    if (!validation.accepted.length) {
        return { skipped: true, reason: 'no schema-accepted fast-replay patches', validation, replayedIndexes: [] };
    }

    const patched = applyLlmPatches(xml, validation.accepted);
    const enabledBySampler = new Map(indexSamplers(patched.xml).map(s => [s.name, s.enabled !== false]));
    const extractorPlan = buildExtractorPlan(validation.accepted, entries);
    const patchedEntries = applyReplaceFixesToEntries(entries, validation.accepted);

    if (extractorPlan.extractors.length || extractorPlan.replaceIndexes.length) {
        const replay = await replayWithExtractors({
            entries: patchedEntries,
            enabledBySampler,
            extractorPlan,
            targetBaseUrl,
            insecure,
            timeoutMs,
            onLog,
        });
        return {
            skipped: false,
            validation,
            applied: patched.applied,
            skippedPatches: patched.skipped,
            replay: replay.replay,
            replayedIndexes: replay.replayedIndexes,
            extractedVariables: replay.extractedVariables,
            accepted: replay.replay.ok ? validation.accepted : [],
        };
    }

    const replayedIndexes = [];
    const replayEntries = [];
    for (let i = 0; i < entries.length; i++) {
        const label = samplerLabel(entries[i], i);
        if (enabledBySampler.get(label) === false) continue;
        replayedIndexes.push(i);
        replayEntries.push(entries[i]);
    }

    onLog(`fast repair loop: replaying ${replayEntries.length}/${entries.length} enabled sampler(s)`);
    const replay = await replayAll({ entries: replayEntries, targetBaseUrl, insecure, timeoutMs, onLog });
    return {
        skipped: false,
        validation,
        applied: patched.applied,
        skippedPatches: patched.skipped,
        replay,
        replayedIndexes,
        accepted: replay.ok ? validation.accepted : [],
    };
}

function isFastReplayableKind(kind) {
    return ['setSamplerEnabled', 'addExtractor', 'replaceValueWithVar'].includes(kind);
}

function buildExtractorPlan(fixes, entries) {
    const extractors = [];
    const replaceIndexes = [];
    for (const fix of fixes || []) {
        if (fix.kind === 'addExtractor') {
            const index = indexForSampler(entries, fix.sampler);
            if (index >= 0) extractors.push({ ...fix, index });
        }
        if (fix.kind === 'replaceValueWithVar') {
            if (fix.sampler) {
                const index = indexForSampler(entries, fix.sampler);
                if (index >= 0) replaceIndexes.push(index);
            } else {
                for (let i = 0; i < entries.length; i++) replaceIndexes.push(i);
            }
        }
    }
    return {
        extractors,
        replaceIndexes: [...new Set(replaceIndexes)],
    };
}

function indexForSampler(entries, samplerName) {
    return (entries || []).findIndex((entry, i) => samplerLabel(entry, i) === samplerName || entry._samplerLabel === samplerName);
}

function applyReplaceFixesToEntries(entries, fixes) {
    const out = (entries || []).map(entry => JSON.parse(JSON.stringify(entry)));
    for (const fix of fixes || []) {
        if (!fix || fix.kind !== 'replaceValueWithVar' || !fix.value || !fix.variable) continue;
        const ref = '${' + fix.variable + '}';
        for (let i = 0; i < out.length; i++) {
            if (fix.sampler && samplerLabel(out[i], i) !== fix.sampler && out[i]._samplerLabel !== fix.sampler) continue;
            replaceInRequest(out[i], fix.value, ref);
        }
    }
    return out;
}

function replaceInRequest(entry, value, replacement) {
    const req = entry.request || {};
    if (typeof req.url === 'string') req.url = req.url.split(value).join(replacement);
    for (const h of req.headers || []) {
        if (typeof h.value === 'string') h.value = h.value.split(value).join(replacement);
    }
    if (req.postData && typeof req.postData.text === 'string') {
        req.postData.text = req.postData.text.split(value).join(replacement);
    }
    if (Array.isArray(req.queryString)) {
        for (const q of req.queryString) {
            if (typeof q.value === 'string') q.value = q.value.split(value).join(replacement);
            if (typeof q.name === 'string') q.name = q.name.split(value).join(replacement);
        }
    }
}

async function replayWithExtractors({ entries, enabledBySampler, extractorPlan, targetBaseUrl, insecure, timeoutMs, onLog }) {
    const cookieJar = new Map();
    const vars = {};
    const samples = [];
    const drift = [];
    const errors = [];
    const extractorsByIndex = new Map();
    for (const extractor of extractorPlan.extractors) {
        const list = extractorsByIndex.get(extractor.index) || [];
        list.push(extractor);
        extractorsByIndex.set(extractor.index, list);
    }

    const replayedIndexes = segmentIndexes(entries, enabledBySampler, extractorPlan);
    const start = Date.now();
    for (const index of replayedIndexes) {
        const entry = entries[index];
        try {
            const response = await replayOne({ entry, vars, cookieJar, targetBaseUrl, insecure, timeoutMs });
            for (const extractor of extractorsByIndex.get(index) || []) {
                const value = extractVariable(response, extractor);
                if (value != null) vars[extractor.variable] = value;
            }
            const issues = responseIssues(entry, response);
            samples.push({
                index,
                url: entry.request.url,
                status: response.status,
                durationMs: response.durationMs,
                success: response.status > 0 && response.status < 400 && issues.length === 0,
            });
            if (issues.length) drift.push({ index, sampler: `${entry.request.method} ${entry.request.url}`, issues });
        } catch (err) {
            errors.push({ index, url: entry.request && entry.request.url, message: err.message });
            samples.push({ index, url: entry.request && entry.request.url, status: 0, durationMs: 0, success: false });
            onLog(`fast-replay #${index} error: ${err.message}`);
        }
    }

    const ok = errors.length === 0 && drift.length === 0 && samples.every(s => s.success);
    return {
        replayedIndexes,
        extractedVariables: vars,
        replay: { ok, samples, drift, errors, durationMs: Date.now() - start },
    };
}

function segmentIndexes(entries, enabledBySampler, extractorPlan) {
    const interesting = [
        ...extractorPlan.extractors.map(e => e.index),
        ...extractorPlan.replaceIndexes,
    ].filter(n => n >= 0);
    const start = interesting.length ? Math.min(...interesting) : 0;
    const end = interesting.length ? Math.max(...interesting) : entries.length - 1;
    const out = [];
    for (let i = start; i <= end; i++) {
        if (enabledBySampler.get(samplerLabel(entries[i], i)) === false) continue;
        out.push(i);
    }
    return out;
}

function responseIssues(entry, response) {
    const recStatus = Number(entry.response && entry.response.status || 0);
    const recBody = (entry.response && entry.response.content && entry.response.content.text) || '';
    const recShape = safeJsonShape(recBody);
    const obsShape = safeJsonShape(response.body);
    const issues = [];
    if (recStatus && response.status && recStatus !== response.status) {
        issues.push({ kind: 'statusDiff', recorded: recStatus, observed: response.status });
    }
    if (recBody && response.body) {
        const pct = Math.abs(response.body.length - recBody.length) / Math.max(1, recBody.length) * 100;
        if (pct > 30) issues.push({ kind: 'lengthDriftPct', pct: Math.round(pct), recorded: recBody.length, observed: response.body.length });
    }
    if (recShape && obsShape && recShape !== obsShape) {
        issues.push({ kind: 'shapeDiff', recorded: recShape, observed: obsShape });
    }
    return issues;
}

function extractVariable(response, extractor) {
    if (!response || !extractor) return null;
    if (extractor.type === 'json') return extractJsonPath(response.body, extractor.path);
    if (extractor.type === 'regex') {
        const haystack = extractor.useHeaders ? headersText(response.headers) : String(response.body || '');
        try {
            const match = haystack.match(new RegExp(extractor.regex));
            return match && match[1] != null ? match[1] : null;
        } catch {
            return null;
        }
    }
    return null;
}

function extractJsonPath(body, path) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { return null; }
    const p = String(path || '');
    if (p.startsWith('$..')) {
        // $..key or $..key[0] — recursive key search with optional index tail.
        const tail = p.slice(3);
        const m = tail.match(/^([^.[\]]+)(\[\d+\])?$/);
        if (m) {
            const found = findJsonKey(parsed, m[1], /* wantNode */ !!m[2]);
            if (m[2] && Array.isArray(found)) {
                const idx = Number(m[2].slice(1, -1));
                const v = found[idx];
                return v == null || typeof v === 'object' ? null : String(v);
            }
            return typeof found === 'object' ? null : found;
        }
        return findJsonKey(parsed, tail);
    }
    if (!p.startsWith('$.') && !p.startsWith('$[')) return null;
    const tokens = tokenizeJsonPath(p.replace(/^\$/, ''));
    if (!tokens) return null;
    let node = parsed;
    for (const key of tokens) {
        if (node == null || typeof node !== 'object') return null;
        node = node[key];
        if (node === undefined) return null;
    }
    return node == null || typeof node === 'object' ? null : String(node);
}

// Turn `.data.items[0]['x-token']` into ['data','items',0,'x-token'].
// Supports dot keys, [n] array indexes, and ['quoted key'] / ["quoted key"].
function tokenizeJsonPath(expr) {
    const tokens = [];
    const re = /\.([^.[\]]+)|\[(\d+)\]|\['([^']*)'\]|\["([^"]*)"\]/g;
    let lastIndex = 0;
    let match;
    while ((match = re.exec(expr)) !== null) {
        if (match.index !== lastIndex) return null; // gap => malformed
        if (match[1] != null) tokens.push(match[1]);
        else if (match[2] != null) tokens.push(Number(match[2]));
        else tokens.push(match[3] != null ? match[3] : match[4]);
        lastIndex = re.lastIndex;
    }
    if (lastIndex !== expr.length || !tokens.length) return null;
    return tokens;
}

function findJsonKey(node, key, wantNode = false) {
    if (node == null) return null;
    if (Array.isArray(node)) {
        for (const item of node) {
            const found = findJsonKey(item, key, wantNode);
            if (found != null) return found;
        }
        return null;
    }
    if (typeof node === 'object') {
        if (Object.prototype.hasOwnProperty.call(node, key) && node[key] != null) {
            const val = node[key];
            if (wantNode) return val;                          // caller wants the array/object node
            if (typeof val !== 'object') return String(val);   // scalar leaf
        }
        for (const value of Object.values(node)) {
            const found = findJsonKey(value, key, wantNode);
            if (found != null) return found;
        }
    }
    return null;
}

function headersText(headers = {}) {
    const lines = [];
    for (const [name, value] of Object.entries(headers || {})) {
        if (Array.isArray(value)) {
            for (const v of value) lines.push(`${name}: ${v}`);
        } else {
            lines.push(`${name}: ${value}`);
        }
    }
    return lines.join('\n');
}

module.exports = {
    runFastRepairLoop,
    _internal: {
        buildExtractorPlan,
        applyReplaceFixesToEntries,
        extractVariable,
        extractJsonPath,
    },
};
