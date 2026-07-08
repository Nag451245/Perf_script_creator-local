'use strict';
/**
 * extractors.js — deterministic native-extractor planner for un-correlated vars.
 *
 * Problem we solve
 * ----------------
 * The engine's dry-run validator wrongly flags variables defined by our local
 * CSV Data Set as orphans (its `<CSVDataSet>` look-back regex is 200 chars,
 * but the rendered CSVDataSet block is ~280 chars long, so `variableNames`
 * sits outside the window). It then asks `jmx-auto-repair` to inject a
 * 30-line JSR223 Auto-Discovery block PER variable, producing 3 nearly
 * identical Groovy stanzas for `username/password/visitDate`. That's brittle
 * (will pull `"password":"<server token>"` out of a response and overwrite
 * the CSV value) AND walks `prev.getParent()`, which doesn't return prior
 * siblings in JMeter PostProcessor context anyway.
 *
 * Strategy (ponytail: zero engine changes)
 * ---------------------------------------
 *   A. Filter orphans: drop any orphan whose name is already supplied by
 *      a UDV / CSV column / built-in / earlier extractor. This alone kills
 *      ~all bogus injections in practice.
 *   B. For real orphans, search recorded responses (body/headers/cookies)
 *      for the value and pick the right NATIVE JMeter extractor:
 *        - JSON body  -> JSONPostProcessor   (`$.path.to.field`)
 *        - HTML body  -> RegexExtractor      (`<input name="X" value="(.*?)">`)
 *        - Header     -> RegexExtractor on "(?im)^Name: (.+)$"
 *        - Set-Cookie -> RegexExtractor      (Cookie Manager will also re-emit)
 *      Inject ONE extractor into the producing sampler's hashTree.
 *   C. Whatever we can't locate deterministically falls through to the
 *      engine's existing JSR223 Auto-Discovery as the last resort (one block
 *      per var, not three).
 */

const SAMPLER_OPEN_RE = /<HTTPSamplerProxy\b[^>]*\btestname="([^"]*)"[^>]*>/g;
const SAMPLER_CLOSE_TAG = '</HTTPSamplerProxy>';

function escXmlAttr(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function escRegex(s) {
    return String(s == null ? '' : s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the set of variable names that are already defined elsewhere in the
 * test plan (CSV columns + UDVs + previously-emitted extractor refnames +
 * JMeter built-ins). Mirrors what the engine validator SHOULD catch but
 * with a wider scan window so our CSVDataSet block is always recognised.
 *
 * Returns a Set<string>.
 */
function knownDefinedVars(xml, extraNames = []) {
    const out = new Set(extraNames.map(String).filter(Boolean));
    // CSV Data Set columns. Wide window: walk EVERY <CSVDataSet>…</CSVDataSet>
    // block and pull the variableNames prop from inside.
    for (const csv of xml.matchAll(/<CSVDataSet\b[\s\S]*?<\/CSVDataSet>/g)) {
        const block = csv[0];
        const m = block.match(/<stringProp\s+name=["']variableNames["'][^>]*>([^<]*)<\/stringProp>/);
        if (!m) continue;
        for (const n of m[1].split(/[,;]/).map(s => s.trim()).filter(Boolean)) out.add(n);
    }
    // User Defined Variables (Argument.name OUTSIDE HTTPSamplerProxy).
    const samplerRanges = [];
    for (const so of xml.matchAll(/<HTTPSamplerProxy\b[^>]*>/g)) {
        const close = xml.indexOf('</HTTPSamplerProxy>', so.index);
        samplerRanges.push([so.index, close > 0 ? close + 19 : xml.length]);
    }
    const inSampler = pos => samplerRanges.some(([a, b]) => pos >= a && pos < b);
    for (const m of xml.matchAll(/<stringProp\s+name="Argument\.name"[^>]*>([^<]+)<\/stringProp>/g)) {
        if (inSampler(m.index)) continue;
        const v = m[1].trim();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) out.add(v);
    }
    return out;
}

/**
 * Look up an orphan variable's value in earlier HAR entries and pick the most
 * appropriate native extractor. Returns null when no producing entry is found
 * (caller should fall back to JSR223 auto-discovery).
 *
 * @param {string} varName
 * @param {Array<{name:string,value:string}>} candidateValues  values to look for
 * @param {Array} entries  flat HAR entries in document order
 * @param {number} consumerOrder  the sampler index referencing ${varName}
 * @returns {null | {
 *   type: 'json'|'regex',
 *   sourceOrder: number,
 *   sourceLabel: string,
 *   block: string  // ready-to-splice XML PostProcessor + hashTree pair
 * }}
 */
function planExtractor(varName, candidateValues, entries, consumerOrder) {
    if (!Array.isArray(entries) || !entries.length) return null;
    const horizon = Math.min(consumerOrder, entries.length);
    for (let i = 0; i < horizon; i++) {
        const e = entries[i];
        const resp = e.response || {};
        const body = (resp.content && resp.content.text) || '';
        const headers = resp.headers || [];
        const mimeRaw = (resp.content && resp.content.mimeType) || (resp.contentType) || '';
        const mime = String(mimeRaw).toLowerCase();
        const label = (e._samplerLabel) || `Step ${String(i + 1).padStart(2, '0')} - ${e.request?.method || 'GET'} ${(() => { try { return new URL(e.request?.url || '').pathname; } catch { return e.request?.url || ''; } })()}`;

        for (const cand of candidateValues) {
            const value = cand && cand.value;
            if (!value || typeof value !== 'string' || value.length < 4) continue;
            // 1) JSON body: prefer JSONPostProcessor with a derived $.path.
            if (mime.includes('json') || (body && /^[\s\uFEFF]*[{[]/.test(body))) {
                const jsonPath = findJsonPath(body, varName, value);
                if (jsonPath) return makeJsonExtractor(varName, jsonPath, i, label);
            }
            // 2) Body contains the value verbatim -> regex extractor.
            if (body && body.includes(value)) {
                const rx = buildBodyRegex(varName, body, value);
                if (rx) {
                    const verified = verifyRegexPlan({
                        varName,
                        expr: rx.expr,
                        useHeaders: rx.useHeaders,
                        body,
                        headers,
                        expectedValue: value,
                    });
                    if (verified.ok) {
                        return makeRegexExtractor(varName, rx.expr, rx.template, rx.useHeaders, i, label, 'body', verified.value);
                    }
                }
            }
            // 3) Response header / Set-Cookie source.
            for (const h of headers) {
                const hv = String(h.value || '');
                if (!hv.includes(value)) continue;
                const isSetCookie = /^set-cookie$/i.test(h.name || '');
                if (isSetCookie) {
                    // Cookie Manager handles cookies automatically; only emit
                    // an extractor when the value ALSO needs to land in a
                    // non-Cookie sink (the engine's correlation pass already
                    // handles the cookie sink itself).
                    const cookieName = cookieNameForValue(hv, value);
                    if (!cookieName) continue;
                    const expr = `(?i)^Set-Cookie:\\s*${escRegex(cookieName)}=([^;\\r\\n]+)`;
                    const verified = verifyRegexPlan({
                        varName,
                        expr,
                        useHeaders: true,
                        body,
                        headers,
                        expectedValue: value,
                    });
                    if (!verified.ok) continue;
                    return makeRegexExtractor(varName, expr, '$1$', true, i, label, 'set-cookie', verified.value);
                }
                const expr = `(?im)^${escRegex(h.name)}:\\s*([^\\r\\n]+)`;
                const verified = verifyRegexPlan({
                    varName,
                    expr,
                    useHeaders: true,
                    body,
                    headers,
                    expectedValue: value,
                });
                if (!verified.ok) continue;
                return makeRegexExtractor(varName, expr, '$1$', true, i, label, 'header', verified.value);
            }
        }
    }
    return null;
}

function cookieNameForValue(headerValue, expectedValue) {
    const value = String(expectedValue || '');
    if (!value) return null;
    for (const part of String(headerValue || '').split(/,(?=\s*[\w.-]+=)/)) {
        const m = part.trim().match(/^([\w.-]+)=([^;]*)/);
        if (m && m[2] === value) return m[1];
    }
    return null;
}

function findJsonPath(body, varName, value) {
    if (!body) return null;
    let parsed;
    try { parsed = JSON.parse(body); } catch { return null; }
    const stack = [{ node: parsed, path: '$' }];
    let best = null;
    while (stack.length) {
        const { node, path: p } = stack.pop();
        if (node == null) continue;
        if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
            if (String(node) === value) {
                const keyEnd = p.split('.').pop();
                // Prefer paths whose terminal key name matches the var name.
                if (keyEnd && keyEnd.toLowerCase() === String(varName).toLowerCase()) return p;
                best = best || p;
            }
            continue;
        }
        if (Array.isArray(node)) {
            for (let i = node.length - 1; i >= 0; i--) stack.push({ node: node[i], path: `${p}[${i}]` });
            continue;
        }
        if (typeof node === 'object') {
            for (const [k, v] of Object.entries(node)) stack.push({ node: v, path: `${p}.${k}` });
        }
    }
    return best;
}

/** Pick a short, anchor-y body regex for a given value, preferring HTML/JSON shapes. */
function buildBodyRegex(varName, body, value) {
    const ev = escRegex(value);
    // HTML hidden input
    const html = new RegExp(`<input[^>]*\\bname=["']${escRegex(varName)}["'][^>]*\\bvalue=["']([^"']+)["']`);
    if (html.test(body)) {
        return { expr: `<input[^>]*\\bname=["']${escRegex(varName)}["'][^>]*\\bvalue=["']([^"']+)["']`, template: '$1$', useHeaders: false };
    }
    // `"varName":"VALUE"` (JSON-ish, even when the body wasn't strict JSON)
    const jsonish = new RegExp(`"${escRegex(varName)}"\\s*:\\s*"([^"]+)"`);
    if (jsonish.test(body)) {
        return { expr: `"${escRegex(varName)}"\\s*:\\s*"([^"]+)"`, template: '$1$', useHeaders: false };
    }
    // `varName=VALUE` query-style
    const qs = new RegExp(`(?:[?&;\\s>"']|^)${escRegex(varName)}\\s*=\\s*([^&\\s"';#<]+)`);
    if (qs.test(body)) {
        return { expr: `(?:[?&;\\s>"']|^)${escRegex(varName)}\\s*=\\s*([^&\\s"';#<]+)`, template: '$1$', useHeaders: false };
    }
    // Last resort: anchor on literal surrounding context. SAFETY RULES:
    //   1. Require BOTH a left and right anchor. A single-side boundary
    //      makes the regex too greedy and pulls garbage out of a changed
    //      response, silently overwriting the variable.
    //   2. Capture group is a generic "value token" class — no whitespace,
    //      no JSON/HTML separators. We never embed the RECORDED value as an
    //      alternative; the whole point of an extractor is to grab what the
    //      SERVER returns next time, which is different by definition.
    //   3. Anchors are length-capped to keep the regex cheap at runtime
    //      (JMeter's regex extractor runs against potentially MB-size bodies).
    const ctxLen = 18;
    const idx = body.indexOf(value);
    if (idx >= 0) {
        const left = body.substring(Math.max(0, idx - ctxLen), idx);
        const right = body.substring(idx + value.length, idx + value.length + ctxLen);
        const lAnchor = left.match(/[\w"'><=:,{[]+$/)?.[0] || '';
        const rAnchor = right.match(/^[\w"'><=:,}\]]+/)?.[0] || '';
        if (lAnchor && rAnchor) {
            return {
                expr: `${escRegex(lAnchor)}([^"'<>{}\\s,;]+?)${escRegex(rAnchor)}`,
                template: '$1$',
                useHeaders: false,
            };
        }
    }
    return null;
}

function makeJsonExtractor(varName, jsonPath, sourceOrder, sourceLabel) {
    const block = `
            <JSONPostProcessor guiclass="JSONPostProcessorGui" testclass="JSONPostProcessor" testname="Extract ${escXmlAttr(varName)} (JSON)" enabled="true">
              <stringProp name="JSONPostProcessor.referenceNames">${escXmlAttr(varName)}</stringProp>
              <stringProp name="JSONPostProcessor.jsonPathExprs">${escXmlAttr(jsonPath)}</stringProp>
              <stringProp name="JSONPostProcessor.match_numbers">1</stringProp>
              <stringProp name="JSONPostProcessor.defaultValues">NOT_FOUND_${escXmlAttr(varName)}</stringProp>
            </JSONPostProcessor>
            <hashTree/>`;
    return { type: 'json', sourceOrder, sourceLabel, block };
}

function makeRegexExtractor(varName, expr, template, useHeaders, sourceOrder, sourceLabel, originLabel, extractedValue = undefined) {
    const fieldToCheck = useHeaders ? 'true' : 'false';
    const block = `
            <RegexExtractor guiclass="RegexExtractorGui" testclass="RegexExtractor" testname="Extract ${escXmlAttr(varName)} (${escXmlAttr(originLabel)})" enabled="true">
              <stringProp name="RegexExtractor.useHeaders">${fieldToCheck}</stringProp>
              <stringProp name="RegexExtractor.refname">${escXmlAttr(varName)}</stringProp>
              <stringProp name="RegexExtractor.regex">${escXmlAttr(expr)}</stringProp>
              <stringProp name="RegexExtractor.template">${escXmlAttr(template)}</stringProp>
              <stringProp name="RegexExtractor.match_number">1</stringProp>
              <stringProp name="RegexExtractor.default">NOT_FOUND_${escXmlAttr(varName)}</stringProp>
            </RegexExtractor>
            <hashTree/>`;
    return { type: 'regex', sourceOrder, sourceLabel, block, extractedValue };
}

function verifyRegexPlan({ expr, useHeaders, body, headers, expectedValue }) {
    if (!expr || expectedValue == null) return { ok: false, reason: 'missing_input' };
    let rx;
    try {
        rx = compileJMeterRegexForLocalProof(expr);
    } catch (e) {
        return { ok: false, reason: 'invalid_regex', error: e.message };
    }
    const haystack = useHeaders
        ? (headers || []).map(h => `${h.name}: ${h.value}`).join('\n')
        : String(body || '');
    const match = haystack.match(rx);
    if (!match) return { ok: false, reason: 'no_match' };
    if (match.length < 2) return { ok: false, reason: 'no_capture' };
    if (match[1] !== String(expectedValue)) {
        return { ok: false, reason: 'wrong_value', value: match[1] };
    }
    return { ok: true, value: match[1] };
}

function compileJMeterRegexForLocalProof(expr) {
    let pattern = String(expr || '');
    let flags = '';
    const flagMatch = pattern.match(/^\(\?([im]+)\)/i);
    if (flagMatch) {
        for (const flag of flagMatch[1].toLowerCase()) {
            if (!flags.includes(flag)) flags += flag;
        }
        pattern = pattern.slice(flagMatch[0].length);
    }
    return new RegExp(pattern, flags);
}

/**
 * Collect (position, order, name) of every HTTPSamplerProxy in document order.
 * Mirrors the structure jmx-auto-repair builds.
 */
function indexSamplers(xml) {
    const out = [];
    SAMPLER_OPEN_RE.lastIndex = 0;
    let m;
    while ((m = SAMPLER_OPEN_RE.exec(xml)) !== null) {
        out.push({ order: out.length, position: m.index, name: m[1] });
    }
    for (let i = 0; i < out.length; i++) {
        out[i].endPosition = i + 1 < out.length ? out[i + 1].position : xml.length;
    }
    return out;
}

/**
 * Splice an extractor block into a sampler's trailing hashTree. Returns new xml
 * (or the same xml when the splice point isn't found, which is rare).
 */
function injectAfterSampler(xml, samplerOrder, block) {
    const samplers = indexSamplers(xml);
    const s = samplers[samplerOrder];
    if (!s) return xml;
    const region = xml.substring(s.position, s.endPosition);
    const closeIdx = region.indexOf(SAMPLER_CLOSE_TAG);
    if (closeIdx < 0) return xml;
    const afterClose = s.position + closeIdx + SAMPLER_CLOSE_TAG.length;
    const tail = xml.substring(afterClose);
    const selfClose = tail.match(/^\s*<hashTree\s*\/>/);
    const openTag = tail.match(/^\s*<hashTree>/);
    if (selfClose) {
        const matchEnd = afterClose + selfClose[0].length;
        const expanded = '\n        <hashTree>' + block + '\n        </hashTree>';
        return xml.substring(0, afterClose) + expanded + xml.substring(matchEnd);
    }
    if (openTag) {
        const insertPos = afterClose + openTag[0].length;
        return xml.substring(0, insertPos) + block + xml.substring(insertPos);
    }
    return xml;
}

module.exports = {
    knownDefinedVars,
    planExtractor,
    injectAfterSampler,
    _internal: { escXmlAttr, escRegex, indexSamplers, findJsonPath, buildBodyRegex, verifyRegexPlan, cookieNameForValue, compileJMeterRegexForLocalProof },
};
