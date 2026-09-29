'use strict';

/*
 * Runtime proof is deliberately stricter than correlation planning. Planning
 * can infer a likely producer; proof needs an executed producer response, a
 * native extractor that obtains a usable fresh value from that response, and a
 * rendered consumer request that actually transmits that exact value.
 */

function buildCorrelationRuntimeProof({
    entries = [],
    runEvidence = null,
    correlations = [],
    appliedLinks = [],
    ledger = null,
    jmx = '',
    protectedIndexes = [],
    businessIndexes = [],
} = {}) {
    const rows = runEvidence && Array.isArray(runEvidence.rows) ? runEvidence.rows : [];
    const links = correlationLinks({ correlations, appliedLinks, ledger })
        .sort((a, b) => a.producerIndex - b.producerIndex || a.consumerIndex - b.consumerIndex || a.variable.localeCompare(b.variable));
    const unresolved = requiredUnresolvedSinks(ledger);
    if (!links.length) {
        const complete = rows.length === entries.length && rows.length > 0 &&
            rows.every(row => String(row.observedBody || '').length > 0);
        const ledgerNeedsCorrelation = (ledger && ledger.entries || []).some(item =>
            ['server-issued-correlation', 'unresolved'].includes(item.role));
        const firstDivergence = unresolved[0] || { kind: 'no_dynamic_correlation_proof', reason: 'No links can be green without complete response evidence and an explicit no-correlation ledger.' };
        return complete && !ledgerNeedsCorrelation
            ? { status: 'VERIFIED', notApplicable: true, links: [], firstDivergence: null, counts: { verified: 0, failed: 0, unverified: 0, total: 0 } }
            : { status: 'UNVERIFIED', links: [], firstDivergence, unresolvedSinks: unresolved, counts: { verified: 0, failed: 0, unverified: unresolved.length, total: unresolved.length } };
    }
    const extractors = nativeExtractors(jmx);
    const protectedSet = new Set([...protectedIndexes, ...businessIndexes].map(Number));
    const proofLinks = links.map(link => proveLink({
        link, entries, rows, extractors, protectedSet,
    }));
    const counts = { verified: 0, failed: 0, unverified: unresolved.length, total: proofLinks.length + unresolved.length };
    for (const link of proofLinks) counts[link.status.toLowerCase()]++;
    const firstFailedLink = proofLinks.find(link => link.status === 'FAILED' || link.status === 'UNVERIFIED') || null;
    const firstDivergence = firstFailedLink
        ? { ...firstFailedLink.divergence, link: { variable: firstFailedLink.variable, producerIndex: firstFailedLink.producerIndex, consumerIndex: firstFailedLink.consumerIndex } }
        : (unresolved[0] || null);
    const status = counts.failed ? 'FAILED' : (counts.unverified ? 'UNVERIFIED' : 'VERIFIED');
    return { status, links: proofLinks, firstDivergence, unresolvedSinks: unresolved, counts };
}

function correlationLinks({ correlations, appliedLinks, ledger }) {
    const raw = [
        ...(Array.isArray(correlations) ? correlations : []).map(item => ({ ...item, role: item.role || 'server-issued-correlation' })),
        ...(Array.isArray(appliedLinks) ? appliedLinks : []).map(item => ({ ...item, role: item.role || 'server-issued-correlation' })),
        ...(ledger && ledger.entries || []).flatMap(item =>
            item.role !== 'server-issued-correlation' ? [] :
            (item.consumerLinks || []).map(link => ({
                variableName: item.name, value: item.value,
                producerEntryIndex: link.producerIndex, targetRequestIndex: link.consumerIndex,
                sinkLocation: link.location || '',
                sinkName: link.name || '',
                sinkEncoding: link.encoding || '',
                role: item.role,
            }))),
    ];
    const seen = new Set();
    return raw.map(item => ({
        variable: String(item.variableName || item.variable || item.name || ''),
        recordedValue: String(item.value == null ? (item.recordedValue == null ? '' : item.recordedValue) : item.value),
        producerIndex: numberOf(item.producerEntryIndex ?? item.producerIndex ?? item.sourceRequestIndex ?? item.producer ?? item.source),
        consumerIndex: numberOf(item.targetRequestIndex ?? item.consumerEntryIndex ?? item.consumerIndex ?? item.consumer ?? item.target),
        sinkLocation: String(item.sinkLocation || item.location || ''),
        sinkName: String(item.sinkName || sinkNameFromLocation(item.sinkLocation || item.location || '')),
        sinkEncoding: String(item.sinkEncoding || item.encoding || 'plain'),
        role: String(item.role || ''),
    })).filter(link => {
        const key = `${link.recordedValue}\0${link.producerIndex}\0${link.consumerIndex}\0${link.sinkLocation}\0${link.sinkName}\0${link.sinkEncoding}`;
        if (link.role !== 'server-issued-correlation' || !link.variable || !Number.isInteger(link.producerIndex) || !Number.isInteger(link.consumerIndex) || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function sinkNameFromLocation(location) {
    const value = String(location || '');
    const colon = value.indexOf(':');
    return colon < 0 ? '' : value.slice(colon + 1);
}

function requiredUnresolvedSinks(ledger) {
    return (ledger && ledger.entries || [])
        .filter(item => item && item.role === 'unresolved' && !['native-manager', 'keep-literal', 'parameterize', 'synthesize'].includes(item.necessity))
        .filter(item => (item.consumerIndexes || []).length || (item.sinks || []).length)
        .map(item => ({
            kind: 'unresolved_required_sink',
            name: String(item.name || ''),
            consumerIndexes: [...new Set([...(item.consumerIndexes || []), ...(item.sinks || []).map(sink => sink.entryIndex)])].filter(Number.isInteger),
            locations: [...new Set((item.sinks || []).map(sink => String(sink.location || '')).filter(Boolean))],
            reason: 'A required request sink has no proven server producer or supported synthesis.',
        }));
}

function proveLink({ link, entries, rows, extractors, protectedSet }) {
    const base = { ...link, status: 'UNVERIFIED', producer: {}, consumer: {} };
    const producerRow = rowFor(rows, link.producerIndex);
    const consumerRow = rowFor(rows, link.consumerIndex);
    if (!producerRow || !consumerRow) return divergence(base, 'UNVERIFIED', 'missing_runtime_evidence', 'Producer or consumer runtime sample is absent.');
    base.producer = { index: link.producerIndex, executed: didExecute(producerRow), status: producerRow.observedStatus };
    base.consumer = { index: link.consumerIndex, executed: didExecute(consumerRow), status: consumerRow.observedStatus, success: consumerSucceeded(consumerRow), protected: protectedSet.has(link.consumerIndex) };
    if (!didExecute(producerRow)) return divergence(base, 'UNVERIFIED', 'producer_not_executed', 'Producer sampler did not execute.');
    if (!didExecute(consumerRow)) return divergence(base, 'UNVERIFIED', 'consumer_not_executed', 'Consumer sampler did not execute.');
    const candidates = extractors.filter(item => item.variable === link.variable);
    if (!candidates.length) return divergence(base, 'UNVERIFIED', 'native_extractor_missing', 'No native JSON, Regex, or CSS extractor definition was found.');
    const exact = candidates.filter(item => item.ownerIndex === link.producerIndex && item.enabled);
    if (!exact.length) return divergence(base, 'UNVERIFIED', 'extractor_wrong_producer', 'The extractor is not enabled under the claimed producer sampler.');
    if (exact.length > 1 || candidates.length > 1) return divergence(base, 'UNVERIFIED', 'extractor_ambiguous', 'Duplicate extractor refnames cannot prove an exact producer.');
    const extractor = exact[0];
    const observed = evaluateExtractor(extractor, producerRow);
    base.extractor = { type: extractor.type, expression: extractor.expression, scope: extractor.scope, source: observed.source || '' };
    if (!observed.available) return divergence(base, 'UNVERIFIED', 'producer_response_missing', 'Live producer body/headers/redirect evidence is absent.');
    if (observed.supported === false) return divergence(base, 'UNVERIFIED', 'extractor_semantics_unsupported', 'The native extractor expression is outside the fail-closed evaluator.');
    const value = observed.value;
    base.value = value == null ? '' : String(value);
    const invalid = invalidValue(base.value, link.recordedValue);
    if (invalid) return divergence(base, 'FAILED', invalid, 'Extractor produced an invalid, unresolved, or recorded stale value.');
    const rendered = consumerRow.renderedRequest;
    if (!rendered) return divergence(base, 'UNVERIFIED', 'rendered_request_missing', 'Consumer sampler data is absent; transmission cannot be proven.');
    if (link.recordedValue && renderedContainsAtSink(rendered, link.recordedValue, link)) {
        return divergence(base, 'FAILED', 'stale_recorded_value', 'Consumer rendered request still transmits the recorded literal.');
    }
    const sink = recordedSink(link, entries[link.consumerIndex]);
    if (!hasFieldProvenance(rendered, sink)) return divergence(base, 'UNVERIFIED', `request_${sink}_evidence_missing`, `Direct ${sink} evidence is required to prove this consumer sink.`);
    const transmitted = renderedContainsAtSink(rendered, base.value, link, sink);
    base.consumer.transmitted = transmitted;
    if (!transmitted) return divergence(base, 'FAILED', 'fresh_value_not_transmitted', 'Consumer rendered request does not contain the fresh extracted value.');
    if (!consumerSucceeded(consumerRow)) return divergence(base, 'FAILED', protectedSet.has(link.consumerIndex) ? 'protected_business_consumer_failed' : 'consumer_failed_after_transmission', 'Fresh value was transmitted but the consumer did not succeed.');
    base.status = 'VERIFIED';
    return base;
}

function divergence(link, status, kind, reason) {
    link.status = status;
    link.divergence = { kind, producerIndex: link.producerIndex, consumerIndex: link.consumerIndex, reason };
    return link;
}

function rowFor(rows, index) {
    return rows.find(row => Number(row.entryIndex) === Number(index)) || null;
}

function didExecute(row) {
    return !!row && Number(row.observedStatus || row.sample && (row.sample.responseCode || row.sample.code || row.sample.status) || 0) > 0;
}

function consumerSucceeded(row) {
    const status = Number(row.observedStatus || 0);
    return row.success !== false && status > 0 && status < 400;
}

function invalidValue(value, recorded) {
    const text = String(value == null ? '' : value);
    if (!text) return 'empty';
    if (/\$\{[^}]+\}/.test(text)) return 'unresolved_variable';
    if (/(?:_NOTFOUND\b|\bNOT_FOUND_)/i.test(text)) return 'not_found';
    if (recorded && text === String(recorded)) return 'stale_recorded_value';
    return '';
}

function renderedContains(rendered, value, sink = '') {
    const fields = sink === 'body' ? [rendered.body]
        : sink === 'header' ? (rendered.headers || []).map(h => h && h.value)
            : sink === 'url' ? [rendered.url, ...Object.values(rendered.query || {}).flatMap(v => Array.isArray(v) ? v : [v])]
                : [rendered.url, rendered.body, ...(rendered.headers || []).map(h => h && h.value), ...Object.values(rendered.query || {}).flatMap(v => Array.isArray(v) ? v : [v])];
    return fields.some(field => valueMatches(field, value));
}

function renderedContainsAtSink(rendered, value, link = {}, fallbackSink = '') {
    const location = String(link.sinkLocation || '');
    const name = String(link.sinkName || sinkNameFromLocation(location) || '');
    if (!location || !name) return renderedContains(rendered, value, fallbackSink || recordedSink(link));
    if (/^(?:url-query|query-string):/i.test(location)) return exactQueryValue(rendered, name, value);
    if (/^header:/i.test(location)) return (rendered.headers || [])
        .filter(header => String(header && header.name || '').toLowerCase() === name.toLowerCase())
        .some(header => headerValueMatches(header && header.value, value));
    if (/^(?:form|post-data-param):/i.test(location)) return exactFormValue(rendered.body, name, value);
    if (/^json:/i.test(location)) return exactJsonValue(rendered.body, name, value);
    return renderedContains(rendered, value, fallbackSink || recordedSink(link));
}

function exactQueryValue(rendered, name, value) {
    const values = [];
    try {
        const parsed = new URL(String(rendered.url || ''));
        values.push(...parsed.searchParams.getAll(name));
    } catch { /* direct query evidence below */ }
    const query = rendered.query || {};
    for (const [key, candidate] of Object.entries(query)) {
        if (String(key).toLowerCase() !== name.toLowerCase()) continue;
        values.push(...(Array.isArray(candidate) ? candidate : [candidate]));
    }
    return values.some(candidate => scalarEquals(candidate, value));
}

function exactFormValue(body, name, value) {
    return String(body || '').split('&').some(pair => {
        const index = pair.indexOf('=');
        if (index < 0) return false;
        const key = decodeFormComponent(pair.slice(0, index));
        return key === name && scalarEquals(decodeFormComponent(pair.slice(index + 1)), value);
    });
}

function exactJsonValue(body, path, value) {
    let node;
    try { node = JSON.parse(String(body || '')); } catch { return false; }
    for (const segment of String(path || '').split('.').filter(Boolean)) {
        const parts = [...segment.matchAll(/([^[\]]+)|\[(\d+)\]/g)];
        for (const part of parts) {
            const key = part[1] == null ? Number(part[2]) : part[1];
            if (!node || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, key)) return false;
            node = node[key];
        }
    }
    return scalarEquals(node, value);
}

function decodeFormComponent(value) {
    try { return decodeURIComponent(String(value || '').replace(/\+/g, ' ')); }
    catch { return String(value || ''); }
}

function scalarEquals(field, value) {
    return String(field == null ? '' : field) === String(value == null ? '' : value);
}

function headerValueMatches(field, value) {
    const text = String(field == null ? '' : field);
    const expected = String(value == null ? '' : value);
    return text === expected || new RegExp(`(?:^|[\\s,;=])${escapeRegex(expected)}(?:$|[\\s,;])`).test(text);
}

function recordedSink(link = {}, entry = {}) {
    const value = String(link.recordedValue || '');
    const structured = String(link.sinkLocation || '').toLowerCase();
    if (/^(?:form|json|post-data-param):/.test(structured)) return 'body';
    if (/^header:/.test(structured)) return 'header';
    if (/^(?:url-query|query-string):/.test(structured)) return 'url';
    const request = entry.request || {};
    if ((request.headers || []).some(header => String(header.value || '').includes(value))) return 'header';
    const body = String(request.postData && request.postData.text || '');
    if (bodyContainsValue(body, value)) return 'body';
    return 'url';
}

function bodyContainsValue(body, value) {
    if (!body || !value) return false;
    if (body.includes(value)) return true;
    try {
        const parsed = JSON.parse(body);
        return JSON.stringify(parsed).includes(JSON.stringify(value));
    } catch { /* form body below */ }
    return body.split('&').some(pair => {
        const equals = pair.indexOf('=');
        if (equals < 0) return false;
        try { return decodeURIComponent(pair.slice(equals + 1).replace(/\+/g, ' ')) === value; }
        catch { return false; }
    });
}

function hasFieldProvenance(rendered = {}, sink) {
    const provenance = rendered.evidenceProvenance || {};
    if (sink === 'body') return provenance.requestData === true || provenance.samplerData === true;
    if (sink === 'header') return provenance.requestHeaders === true || provenance.samplerData === true;
    return provenance.samplerData === true;
}

function valueMatches(field, value) {
    const text = String(field == null ? '' : field);
    if (text.includes(value)) return true;
    try { return decodeURIComponent(text.replace(/\+/g, ' ')).includes(value); } catch { return false; }
}

function nativeExtractors(xml) {
    const defs = [];
    for (const owner of samplerTrees(xml)) {
        for (const { block } of blocks(owner.tree, 'JSONPostProcessor')) {
            const variables = split(prop(block, 'JSONPostProcessor.referenceNames'));
            const expressions = split(prop(block, 'JSONPostProcessor.jsonPathExprs'));
            const defaults = split(prop(block, 'JSONPostProcessor.defaultValues'));
            const matches = split(prop(block, 'JSONPostProcessor.match_numbers'));
            const supported = variables.length === expressions.length &&
                (!defaults.length || defaults.length === variables.length) &&
                (!matches.length || matches.length === variables.length);
            for (let i = 0; i < variables.length; i++) {
                defs.push({ type: 'json', variable: variables[i], expression: expressions[i] || '', defaultValue: defaults[i] || '', matchNumber: Number(matches[i] || 1), scope: scopeOf(block), supported, enabled: owner.enabled && !/\benabled="false"/i.test(block), ownerIndex: owner.ownerIndex, ownerLabel: owner.ownerLabel });
            }
        }
        for (const { block } of blocks(owner.tree, 'RegexExtractor')) {
            const variable = prop(block, 'RegexExtractor.refname');
            if (variable) defs.push({
                type: 'regex', variable, expression: prop(block, 'RegexExtractor.regex'),
                template: prop(block, 'RegexExtractor.template') || '$1$', useHeaders: /<(?:bool|string)Prop name="RegexExtractor\.useHeaders">true<\/(?:bool|string)Prop>/i.test(block),
                scope: scopeOf(block), matchNumber: Number(prop(block, 'RegexExtractor.match_number') || 1), defaultValue: prop(block, 'RegexExtractor.default'), enabled: owner.enabled && !/\benabled="false"/i.test(block), ownerIndex: owner.ownerIndex, ownerLabel: owner.ownerLabel,
            });
        }
        for (const { block } of blocks(owner.tree, 'HtmlExtractor')) {
            const variable = prop(block, 'HtmlExtractor.refname');
            if (variable) defs.push({ type: 'css', variable, expression: prop(block, 'HtmlExtractor.expr'), attribute: prop(block, 'HtmlExtractor.attribute'), scope: scopeOf(block), enabled: owner.enabled && !/\benabled="false"/i.test(block), ownerIndex: owner.ownerIndex, ownerLabel: owner.ownerLabel });
        }
    }
    return defs;
}

function evaluateExtractor(extractor, row) {
    if (extractor.supported === false) return { available: true, supported: false };
    const sources = responseSources(row, extractor.scope === 'all' || extractor.scope === 'children');
    if (!sources.length) return { available: false };
    for (const source of sources) {
        const text = extractor.useHeaders ? source.headers : source.body;
        if (!text && extractor.useHeaders) continue;
        const value = extractor.type === 'json' ? jsonValue(text, extractor.expression, extractor.matchNumber, extractor.defaultValue)
            : extractor.type === 'regex' ? regexValue(text, extractor.expression, extractor.template, extractor.matchNumber, extractor.defaultValue)
                : cssValue(text, extractor.expression, extractor.attribute);
        if (!value.supported) return { available: true, supported: false, source: source.kind };
        if (value.value != null) return { available: true, supported: true, value: value.value, source: source.kind };
    }
    return { available: true, supported: true, value: '' };
}

function responseSources(row, includeRedirects) {
    const main = {
        kind: 'response', body: String(row.observedBody || ''),
        headers: headerText(row.observedResponseHeaders || row.sample && row.sample.responseHeaders || []),
    };
    const sources = [main];
    if (includeRedirects) for (const redirect of row.redirects || []) {
        sources.push({
            kind: 'redirect', body: String(redirect.responseBody || redirect.body || ''),
            headers: headerText(redirect.responseHeaders || redirect.headers || []),
        });
    }
    return sources;
}

function jsonValue(text, expression, matchNumber = 1, defaultValue = '') {
    if (Number(matchNumber) !== 1) return { supported: false };
    let node; try { node = JSON.parse(text); } catch { return { supported: true, value: null }; }
    const path = String(expression || '').trim();
    if (!path.startsWith('$') || /\[\?|\*|\.\.\[/.test(path)) return { supported: false };
    const recursive = /^\$\.\.([A-Za-z_$][\w$]*)$/.exec(path);
    if (recursive) return { supported: true, value: findRecursive(node, recursive[1]) };
    const keys = path.replace(/^\$\.?/, '').replace(/\[['"]([^'"]+)['"]\]/g, '.$1').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    for (const key of keys) {
        if (node == null || !Object.prototype.hasOwnProperty.call(node, key)) return { supported: true, value: null };
        node = node[key];
    }
    return { supported: true, value: node == null || typeof node === 'object' ? null : String(node) };
}

function findRecursive(node, key) {
    if (!node || typeof node !== 'object') return null;
    if (Object.prototype.hasOwnProperty.call(node, key) && node[key] != null && typeof node[key] !== 'object') return String(node[key]);
    for (const value of Object.values(node)) { const hit = findRecursive(value, key); if (hit != null) return hit; }
    return null;
}

function regexValue(text, expression, template, matchNumber = 1, defaultValue = '') {
    try {
        if (Number(matchNumber) <= 0) return { supported: false };
        const inline = /^\(\?([ims]+)\)/.exec(String(expression || ''));
        const flags = `${inline && inline[1].includes('i') ? 'i' : ''}${inline && inline[1].includes('m') ? 'm' : ''}${inline && inline[1].includes('s') ? 's' : ''}g`;
        const pattern = String(expression || '').replace(/^\(\?[ims]+\)/, '');
        const matches = [...text.matchAll(new RegExp(pattern, flags))];
        const selected = matches[Number(matchNumber || 1) - 1];
        if (!selected) return { supported: true, value: defaultValue || null };
        return { supported: true, value: String(template || '$1$').replace(/\$(\d+)\$/g, (_, n) => selected[Number(n)] || '') };
    } catch { return { supported: false }; }
}

function cssValue(html, selector, attribute) {
    const match = /^([a-z0-9_-]+)((?:\[[^=\]]+=["']?[^"'\]]+["']?\])*)$/i.exec(String(selector || '').trim());
    if (!match) return { supported: false };
    const predicates = [...match[2].matchAll(/\[([^=\]]+)=["']?([^"'\]]+)["']?\]/g)];
    const tags = String(html || '').match(new RegExp(`<${match[1]}\\b[^>]*>`, 'ig')) || [];
    for (const tag of tags) {
        if (predicates.some(predicate => !new RegExp(`\\b${escapeRegex(predicate[1])}=["']${escapeRegex(predicate[2])}["']`, 'i').test(tag))) continue;
        const attr = new RegExp(`\\b${escapeRegex(attribute || 'value')}=["']([^"']*)["']`, 'i').exec(tag);
        if (attr) return { supported: true, value: attr[1] };
    }
    return { supported: true, value: null };
}

function blocks(xml, tag) {
    const re = new RegExp(`<${escapeRegex(tag)}\\b[\\s\\S]*?<\\/${escapeRegex(tag)}>`, 'g');
    const out = []; let match;
    while ((match = re.exec(String(xml || ''))) !== null) out.push({ block: match[0], index: match.index });
    return out;
}
function samplerTrees(xml) {
    const text = String(xml || '');
    const samplers = [...text.matchAll(/<HTTPSamplerProxy\b([^>]*)>[\s\S]*?<\/HTTPSamplerProxy>/g)];
    return samplers.map((sampler, ownerIndex) => {
        const afterSampler = sampler.index + sampler[0].length;
        const sibling = /^\s*<hashTree\b[^>]*>/.exec(text.slice(afterSampler));
        if (!sibling) return null;
        const treeStart = afterSampler + sibling[0].search(/<hashTree\b/i);
        const end = balancedHashTreeEnd(text, treeStart);
        if (end < 0) return null;
        return {
            ownerIndex,
            ownerLabel: (sampler[1].match(/\btestname="([^"]*)"/) || [])[1] || '',
            enabled: !/\benabled="false"/i.test(sampler[1]),
            tree: text.slice(treeStart, end),
        };
    }).filter(Boolean);
}

function balancedHashTreeEnd(text, start) {
    const re = /<\/?hashTree\b[^>]*>/g;
    re.lastIndex = start;
    let depth = 0; let match;
    while ((match = re.exec(text)) !== null) {
        if (/^<\//.test(match[0])) depth--;
        else if (!/\/>$/.test(match[0])) depth++;
        if (depth === 0) return re.lastIndex;
    }
    return -1;
}
function prop(block, name) {
    const esc = escapeRegex(name);
    const m = new RegExp(`<stringProp\\s+name="${esc}"[^>]*>([\\s\\S]*?)<\\/stringProp>`).exec(block);
    return decodeXml(m ? m[1] : '');
}
function scopeOf(block) {
    const scope = prop(block, 'Sample.scope') || prop(block, 'Scope.variable');
    return String(scope || '').toLowerCase();
}
function split(value) { return String(value || '').split(/[;,]/).map(s => s.trim()).filter(Boolean); }
function headerText(headers) {
    return Array.isArray(headers) ? headers.map(h => `${h.name}: ${h.value}`).join('\n') : String(headers || '');
}
function decodeXml(value) { return String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }
function escapeRegex(value) { return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function numberOf(value) { const n = Number(value); return Number.isInteger(n) ? n : NaN; }

module.exports = { buildCorrelationRuntimeProof, _internal: { nativeExtractors, evaluateExtractor, renderedContains, invalidValue, correlationLinks, recordedSink, bodyContainsValue, jsonValue, regexValue, cssValue, samplerTrees } };
