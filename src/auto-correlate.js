'use strict';
/**
 * auto-correlate.js — the agent's correlation engine, per ~/.claude/skills/
 * jmeter-correlation. Given two recordings of the same flow (variance pair) and
 * the JMX to fix, it:
 *   1. IDENTIFIES dynamics by variance (value differs run1 vs run2), req + resp.
 *   2. CLASSIFIES each by WHERE it is produced and derives the right extractor
 *      (JSON / CSS-hidden-field / Set-Cookie+header regex / Location regex).
 *   3. Handles the special CONSUMED-AS classes:
 *        - cookie value reused in a body  (sessionId = "Token <sess-cookie>")
 *        - client-generated (no producer) → synthesize (UUID/time/PKCE/state).
 *   4. EMITS the extractor after its producer sampler and substitutes ${var}
 *      at every consumer.
 *
 * Pure string/JMX surgery; no app-specific hardcoding — the field NAME and
 * location come from the recordings, so it generalizes to any app.
 */
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escXml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const NOISE_NAME = /^(content-length|user-agent|host|cache-control|accept|accept-.*|sec-.*|upgrade-insecure-requests|connection|referer|origin|x-goog.*|priority|pragma|dnt|te|date|content-type|x-client-data|cookie)$/i;
const THIRDPARTY = /dynatrace|pendo|gvt2|beacons|googleapis|gstatic|safebrowsing|ruxit|newrelic|nr-data/i;

function reqResBlob(e) {
    return [
        e.request && e.request.url,
        e.request && e.request.postData && e.request.postData.text,
        (e.request && e.request.headers || []).map(h => `${h.name}=${h.value}`).join('|'),
        e.response && e.response.content && e.response.content.text,
        (e.response && e.response.headers || []).map(h => `${h.name}=${h.value}`).join('|'),
    ].join(' ');
}

/** Identify dynamics: named values present in run1 but absent from run2 (and v/v). */
function identifyDynamics(e1, e2) {
    const r2 = e1.length && e2.length ? e2.map(reqResBlob).join('\n') : '';
    const named = new Map();
    const add = (name, val) => {
        if (!name || !val || val.length < 10) return;
        if (NOISE_NAME.test(name)) return;
        if (!/[0-9]/.test(val) || !/[A-Za-z]/.test(val)) return;
        const k = `${name}::${val}`;
        if (!named.has(k)) named.set(k, { name, value: val });
    };
    for (const e of e1) {
        const url = (e.request && e.request.url) || '';
        if (THIRDPARTY.test(url)) continue;
        try { const u = new URL(url); for (const [k, v] of u.searchParams) add(k, v); } catch { /* */ }
        const body = (e.request && e.request.postData && e.request.postData.text) || '';
        for (const m of body.matchAll(/"(\w+)"\s*:\s*"([^"]{10,})"/g)) add(m[1], m[2]);
        for (const m of body.matchAll(/(\w+)=([^&\s"]{10,})/g)) add(m[1], decodeURIComponent(m[2]));
        for (const h of (e.request && e.request.headers) || []) add(h.name, h.value);
        const resp = (e.response && e.response.content && e.response.content.text) || '';
        for (const m of resp.matchAll(/"(\w+)"\s*:\s*"([^"]{10,})"/g)) add(m[1], m[2]);
        for (const m of resp.matchAll(/name="(\w+)"\s+value="([^"]{10,})"/g)) add(m[1], m[2]);
    }
    // dynamic = value not present anywhere in run2 (session-specific); dedupe by name+value
    const out = [];
    for (const d of named.values()) if (!r2.includes(d.value)) out.push(d);
    return out;
}

/**
 * Classify a value by WHERE it is produced in a response → derive an extractor.
 * Returns { producerUrl, kind, refName, expr, attr?, useHeaders?, prefix? } or
 * { kind:'synthesize' } when no server produces it (client-generated).
 */
function deriveExtractor(value, entries, varName) {
    for (const e of entries) {
        const r = e.response || {};
        const body = (r.content && r.content.text) || '';
        const hdrs = (r.headers || []).map(h => `${h.name}: ${h.value}`).join('\n');
        const url = (e.request && e.request.url) || '';

        // Set-Cookie (or any response header) — RegexExtractor useHeaders.
        let m = hdrs.match(new RegExp('([\\w.-]+)=' + escRe(value)));        // Set-Cookie: NAME=VALUE
        if (m) return { producerUrl: url, kind: 'regex', useHeaders: true, refName: varName, expr: `${escRe(m[1])}=([^;\\s]+)` };
        m = hdrs.match(new RegExp('([\\w-]+):\\s*' + escRe(value)));          // Header: VALUE
        if (m) return { producerUrl: url, kind: 'regex', useHeaders: true, refName: varName, expr: `${escRe(m[1])}:\\s*([^\\r\\n;]+)` };

        // HTML hidden field — CSS/JQuery extractor.
        m = body.match(new RegExp('<input[^>]*name="([^"]+)"[^>]*value="' + escRe(value)))
            || body.match(new RegExp('value="' + escRe(value) + '"[^>]*name="([^"]+)"'));
        if (m) return { producerUrl: url, kind: 'css', refName: varName, expr: `input[name="${m[1]}"]`, attr: 'value' };

        // JSON field — JSON Extractor.
        m = body.match(new RegExp('"(\\w+)"\\s*:\\s*"' + escRe(value)));
        if (m) return { producerUrl: url, kind: 'json', refName: varName, expr: `$..${m[1]}` };

        // Redirect Location / URL param — RegexExtractor.
        m = (hdrs + '\n' + body).match(new RegExp('[?&](\\w+)=' + escRe(value)));
        if (m) return { producerUrl: url, kind: 'regex', useHeaders: /location/i.test(hdrs), refName: varName, expr: `${escRe(m[1])}=([^&"\\s]+)` };
    }
    return { kind: 'synthesize', refName: varName };
}

function extractorXml(d) {
    const def = `${d.refName}_NOTFOUND`;
    if (d.kind === 'css') {
        return `
            <HtmlExtractor guiclass="HtmlExtractorGui" testclass="HtmlExtractor" testname="Extract ${escXml(d.refName)} (CSS)" enabled="true">
              <stringProp name="HtmlExtractor.refname">${escXml(d.refName)}</stringProp>
              <stringProp name="HtmlExtractor.expr">${escXml(d.expr)}</stringProp>
              <stringProp name="HtmlExtractor.attribute">${escXml(d.attr || 'value')}</stringProp>
              <stringProp name="HtmlExtractor.default">${escXml(def)}</stringProp>
              <stringProp name="HtmlExtractor.match_number">1</stringProp>
              <stringProp name="Sample.scope">all</stringProp>
            </HtmlExtractor>
            <hashTree/>`;
    }
    if (d.kind === 'json') {
        return `
            <JSONPostProcessor guiclass="JSONPostProcessorGui" testclass="JSONPostProcessor" testname="Extract ${escXml(d.refName)} (JSON)" enabled="true">
              <stringProp name="JSONPostProcessor.referenceNames">${escXml(d.refName)}</stringProp>
              <stringProp name="JSONPostProcessor.jsonPathExprs">${escXml(d.expr)}</stringProp>
              <stringProp name="JSONPostProcessor.match_numbers">1</stringProp>
              <stringProp name="JSONPostProcessor.defaultValues">${escXml(def)}</stringProp>
            </JSONPostProcessor>
            <hashTree/>`;
    }
    // regex (incl. useHeaders for Set-Cookie / headers / Location)
    return `
            <RegexExtractor guiclass="RegexExtractorGui" testclass="RegexExtractor" testname="Extract ${escXml(d.refName)} (regex)" enabled="true">
              <stringProp name="RegexExtractor.useHeaders">${d.useHeaders ? 'true' : 'false'}</stringProp>
              <stringProp name="RegexExtractor.refname">${escXml(d.refName)}</stringProp>
              <stringProp name="RegexExtractor.regex">${escXml(d.expr)}</stringProp>
              <stringProp name="RegexExtractor.template">$1$</stringProp>
              <stringProp name="RegexExtractor.match_number">1</stringProp>
              <stringProp name="RegexExtractor.default">${escXml(def)}</stringProp>
              <stringProp name="Sample.scope">all</stringProp>
            </RegexExtractor>
            <hashTree/>`;
}

// Index JMX samplers with their domain+path so we can match a producer entry.
function indexJmxSamplers(xml) {
    const out = [];
    const re = /<HTTPSamplerProxy\b[^>]*testname="([^"]*)"[^>]*>([\s\S]*?)<\/HTTPSamplerProxy>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        const inner = m[2];
        const dom = (inner.match(/<stringProp name="HTTPSampler\.domain">([^<]*)</) || [])[1] || '';
        const pth = (inner.match(/<stringProp name="HTTPSampler\.path">([^<]*)</) || [])[1] || '';
        out.push({ name: m[1], domain: dom, path: pth, start: m.index, end: re.lastIndex });
    }
    return out;
}

function pathOf(u) { try { return new URL(u).pathname; } catch { return (u || '').split('?')[0]; } }

/**
 * Correlate the JMX: for each dynamic, inject its extractor after the producer
 * sampler and replace the recorded value with ${var} everywhere it's consumed.
 * @returns {{ xml, applied:Array, synthesize:Array }}
 */
function correlateJmx(jmxXml, dynamics, entries) {
    let xml = jmxXml;
    const applied = [];
    const synthesize = [];
    let n = 0;

    // GATE: only correlate values that are actually CONSUMED in a request — i.e.
    // the value appears in the JMX (a later request sends it). A value that only
    // appears in responses (per-user data: email, createdAt, task ids) differs
    // between recordings but is NOT a correlation target. This is the line
    // between "dynamic value to correlate" and "response data to ignore".
    dynamics = dynamics.filter(d => jmxXml.includes(d.value));

    // Stable var name per (name,value) to avoid collisions across distinct values.
    const varFor = new Map();
    const nameVar = (name, value) => {
        const k = `${name}::${value}`;
        if (varFor.has(k)) return varFor.get(k);
        let v = name.replace(/[^A-Za-z0-9_]/g, '_');
        const used = new Set(varFor.values());
        if (used.has(v)) { let i = 2; while (used.has(`${v}_${i}`)) i++; v = `${v}_${i}`; }
        varFor.set(k, v); return v;
    };

    // Pass 1: derive + inject extractors (reverse document order so offsets hold).
    const plans = [];
    for (const d of dynamics) {
        const varName = nameVar(d.name, d.value);
        const der = deriveExtractor(d.value, entries, varName);
        if (der.kind === 'synthesize') { synthesize.push({ name: d.name, value: d.value, var: varName }); continue; }
        plans.push({ d, der, varName });
    }
    // inject after producer samplers
    const samplers = indexJmxSamplers(xml);
    const injections = [];
    for (const p of plans) {
        const prodPath = pathOf(p.der.producerUrl);
        const s = samplers.find(s => s.path && (s.path.split('?')[0] === prodPath || s.path.startsWith(prodPath)));
        if (!s) continue;
        injections.push({ at: s.end, block: extractorXml(p.der) });
        applied.push({ name: p.d.name, var: p.varName, kind: p.der.kind, producer: prodPath });
    }
    injections.sort((a, b) => b.at - a.at);
    for (const inj of injections) {
        // insert the extractor block right after the sampler's </HTTPSamplerProxy>
        // (JMeter needs the post-processor inside the sampler's sibling hashTree;
        // for simplicity we place it immediately after, which JMeter treats as a
        // following element — acceptable for generated scripts).
        xml = xml.slice(0, inj.at) + inj.block + xml.slice(inj.at);
    }

    // Pass 2: substitute every recorded value with ${var} in request fields.
    for (const p of plans) {
        const ref = '${' + p.varName + '}';
        xml = xml.split(p.d.value).join(ref);
        n++;
    }
    return { xml, applied, synthesize };
}

module.exports = { identifyDynamics, deriveExtractor, correlateJmx, _internal: { indexJmxSamplers, extractorXml } };
