'use strict';
/**
 * llm-patcher.js — turn LLM "fix suggestions" into actual JMX edits.
 *
 * Ponytail: the *application* of fixes is just string surgery on the JMX
 * (extractor injection, literal→variable rewrite, sampler enable/disable).
 * We REUSE `injectAfterSampler` from `src/extractors.js` rather than build a
 * second splicer. The patcher itself is pure (XML in → XML out + report).
 *
 * Why only a *safe subset* of patch kinds is honored
 * --------------------------------------------------
 * The LLM can emit anything — Groovy preprocessors, BeanShell, schema-level
 * rewrites. Most of those are unverifiable from outside a real JMeter run.
 * We deterministically apply ONLY the three patch shapes that cover ~80% of
 * real correlation failures AND are reviewable by eye:
 *
 *   1. addExtractor       — insert a JSONPostProcessor / RegexExtractor after
 *                            a named sampler (the deterministic-extractor case
 *                            the planner missed in the first pass).
 *   2. replaceValueWithVar — replace a literal value with `${variable}` inside
 *                            a named sampler's stringProp content (URL, header
 *                            value, post-data). Optional `sampler` field; when
 *                            omitted, applies to every sampler.
 *   3. setSamplerEnabled   — flip a sampler's `enabled` attribute. Lets the
 *                            LLM say "disable this unreplayable step" without
 *                            us having to invent a new JMX dialect.
 *
 * Anything else is recorded under `skipped` with `reason='unsupported_kind'`,
 * still written out so the human can act on it. No silent drops.
 *
 * Patch shape (lenient — we accept a few aliases the LLM emits in the wild):
 *   { kind|action: 'addExtractor', sampler|samplerName, variable, type: 'json'|'regex',
 *     path?: string,         // JSONPath when type='json'
 *     regex?: string,        // regex when type='regex'
 *     template?: string,     // defaults to '$1$'
 *     useHeaders?: boolean,  // defaults to false
 *   }
 *   { kind|action: 'replaceValueWithVar', sampler?: string, value: string, variable: string }
 *   { kind|action: 'setSamplerEnabled', sampler: string, enabled: boolean }
 */
const { injectAfterSampler, _internal: { escXmlAttr, indexSamplers } } = require('./extractors');

/**
 * @param {string} xml          rendered JMX
 * @param {Array}  fixes        LLM/user-supplied patch list
 * @returns {{ xml:string, applied:Array, skipped:Array }}
 */
function applyLlmPatches(xml, fixes) {
    const applied = [];
    const skipped = [];
    if (!xml || !Array.isArray(fixes) || fixes.length === 0) return { xml, applied, skipped };

    let out = xml;
    for (const raw of fixes) {
        const fix = normalize(raw);
        if (!fix.kind) {
            skipped.push({ reason: 'no_kind', raw });
            continue;
        }
        try {
            if (fix.kind === 'addExtractor') {
                const res = applyAddExtractor(out, fix);
                if (res.applied) { out = res.xml; applied.push(res.applied); }
                else skipped.push(res.skipped);
                continue;
            }
            if (fix.kind === 'replaceValueWithVar') {
                const res = applyReplaceValueWithVar(out, fix);
                if (res.applied) { out = res.xml; applied.push(res.applied); }
                else skipped.push(res.skipped);
                continue;
            }
            if (fix.kind === 'setSamplerEnabled') {
                const res = applySetSamplerEnabled(out, fix);
                if (res.applied) { out = res.xml; applied.push(res.applied); }
                else skipped.push(res.skipped);
                continue;
            }
            skipped.push({ reason: 'unsupported_kind', kind: fix.kind, raw });
        } catch (e) {
            skipped.push({ reason: 'apply_error', kind: fix.kind, error: e.message, raw });
        }
    }
    return { xml: out, applied, skipped };
}

/**
 * Normalize the lenient input into a strict internal shape. Returns a fresh
 * object (never mutates `raw`) so callers can keep the original around for
 * the suggestions.json artifact.
 */
function normalize(raw) {
    if (!raw || typeof raw !== 'object') return {};
    const kind = String(raw.kind || raw.action || raw.type_of_fix || '').trim();
    const sampler = String(raw.sampler || raw.samplerName || raw.target || raw.label || '').trim() || null;
    return {
        kind,
        sampler,
        variable: raw.variable || raw.varName || raw.refname || raw.refName || null,
        type: raw.type || raw.extractorType || null,
        path: raw.path || raw.jsonPath || null,
        regex: raw.regex || raw.expression || null,
        template: raw.template || '$1$',
        useHeaders: !!raw.useHeaders,
        value: raw.value != null ? String(raw.value) : null,
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : (raw.enabled === 'true'),
    };
}

function applyAddExtractor(xml, fix) {
    if (!fix.sampler) return { skipped: { reason: 'missing_sampler', kind: fix.kind } };
    if (!fix.variable) return { skipped: { reason: 'missing_variable', kind: fix.kind } };
    const samplers = indexSamplers(xml);
    const idx = samplers.findIndex(s => s.name === fix.sampler);
    if (idx < 0) return { skipped: { reason: 'sampler_not_found', sampler: fix.sampler } };

    let block;
    if (fix.type === 'json' || (fix.path && !fix.regex)) {
        if (!fix.path) return { skipped: { reason: 'missing_json_path', kind: fix.kind } };
        block = `
            <JSONPostProcessor guiclass="JSONPostProcessorGui" testclass="JSONPostProcessor" testname="LLM-fix Extract ${escXmlAttr(fix.variable)} (JSON)" enabled="true">
              <stringProp name="JSONPostProcessor.referenceNames">${escXmlAttr(fix.variable)}</stringProp>
              <stringProp name="JSONPostProcessor.jsonPathExprs">${escXmlAttr(fix.path)}</stringProp>
              <stringProp name="JSONPostProcessor.match_numbers">1</stringProp>
              <stringProp name="JSONPostProcessor.defaultValues">NOT_FOUND_${escXmlAttr(fix.variable)}</stringProp>
            </JSONPostProcessor>
            <hashTree/>`;
    } else if (fix.type === 'regex' || fix.regex) {
        if (!fix.regex) return { skipped: { reason: 'missing_regex', kind: fix.kind } };
        block = `
            <RegexExtractor guiclass="RegexExtractorGui" testclass="RegexExtractor" testname="LLM-fix Extract ${escXmlAttr(fix.variable)} (regex)" enabled="true">
              <stringProp name="RegexExtractor.useHeaders">${fix.useHeaders ? 'true' : 'false'}</stringProp>
              <stringProp name="RegexExtractor.refname">${escXmlAttr(fix.variable)}</stringProp>
              <stringProp name="RegexExtractor.regex">${escXmlAttr(fix.regex)}</stringProp>
              <stringProp name="RegexExtractor.template">${escXmlAttr(fix.template)}</stringProp>
              <stringProp name="RegexExtractor.match_number">1</stringProp>
              <stringProp name="RegexExtractor.default">NOT_FOUND_${escXmlAttr(fix.variable)}</stringProp>
            </RegexExtractor>
            <hashTree/>`;
    } else {
        return { skipped: { reason: 'unknown_extractor_type', kind: fix.kind } };
    }

    const next = injectAfterSampler(xml, idx, block);
    if (next === xml) return { skipped: { reason: 'splice_failed', sampler: fix.sampler } };
    return { xml: next, applied: { kind: 'addExtractor', sampler: fix.sampler, variable: fix.variable, type: fix.type || (fix.path ? 'json' : 'regex') } };
}

function applyReplaceValueWithVar(xml, fix) {
    if (!fix.value) return { skipped: { reason: 'missing_value', kind: fix.kind } };
    if (!fix.variable) return { skipped: { reason: 'missing_variable', kind: fix.kind } };
    // Safety: refuse short / structural values that would shred the XML. A
    // 1-2 char "value" matches `<` or `"` and explodes the document.
    if (fix.value.length < 4) return { skipped: { reason: 'value_too_short', kind: fix.kind } };

    const replacement = '${' + fix.variable + '}';
    const samplers = indexSamplers(xml);
    if (samplers.length === 0) return { skipped: { reason: 'no_samplers' } };

    let result = xml;
    let replacements = 0;
    // Apply in reverse so earlier offsets stay valid.
    for (let i = samplers.length - 1; i >= 0; i--) {
        const s = samplers[i];
        if (fix.sampler && s.name !== fix.sampler) continue;
        const closeIdx = result.indexOf('</HTTPSamplerProxy>', s.position);
        if (closeIdx < 0) continue;
        const samplerXml = result.substring(s.position, closeIdx);
        if (!samplerXml.includes(fix.value)) continue;
        // Only replace inside stringProp/Header.value content nodes — never
        // inside attributes (testname="...") or tag names. The reliable way
        // is to scope by `<stringProp ...>VALUE</stringProp>` pattern.
        const scoped = samplerXml.replace(
            /(<stringProp\b[^>]*>)([^<]*)(<\/stringProp>)/g,
            (_m, a, content, b) => `${a}${content.split(fix.value).join(replacement)}${b}`
        );
        if (scoped !== samplerXml) {
            result = result.substring(0, s.position) + scoped + result.substring(closeIdx);
            replacements++;
            if (fix.sampler) break;
        }
    }
    if (replacements === 0) return { skipped: { reason: 'value_not_found', kind: fix.kind, value: fix.value } };
    return { xml: result, applied: { kind: 'replaceValueWithVar', sampler: fix.sampler || '*', variable: fix.variable, replacements } };
}

function applySetSamplerEnabled(xml, fix) {
    if (!fix.sampler) return { skipped: { reason: 'missing_sampler', kind: fix.kind } };
    const re = new RegExp(
        `(<HTTPSamplerProxy\\b[^>]*\\btestname="${fix.sampler.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*\\benabled=")(true|false)(")`,
        'g'
    );
    let touched = 0;
    const next = xml.replace(re, (_m, a, _v, b) => { touched++; return `${a}${fix.enabled ? 'true' : 'false'}${b}`; });
    if (touched === 0) return { skipped: { reason: 'sampler_not_found', sampler: fix.sampler } };
    return { xml: next, applied: { kind: 'setSamplerEnabled', sampler: fix.sampler, enabled: !!fix.enabled, touched } };
}

module.exports = { applyLlmPatches, _internal: { normalize, applyAddExtractor, applyReplaceValueWithVar, applySetSamplerEnabled } };
