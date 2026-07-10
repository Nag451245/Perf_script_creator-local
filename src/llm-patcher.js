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

const PATCH_SCHEMAS = {
    addExtractor: {
        keys: new Set(['kind', 'sampler', 'variable', 'type', 'path', 'regex', 'template', 'useHeaders', 'selector', 'attribute']),
        required: ['kind', 'sampler', 'variable', 'type'],
    },
    replaceValueWithVar: {
        keys: new Set(['kind', 'sampler', 'value', 'variable']),
        required: ['kind', 'value', 'variable'],
    },
    setSamplerEnabled: {
        keys: new Set(['kind', 'sampler', 'enabled']),
        required: ['kind', 'sampler', 'enabled'],
    },
    removeAssertion: {
        keys: new Set(['kind', 'sampler', 'assertion']),
        required: ['kind', 'sampler', 'assertion'],
    },
};

function validateLlmPatches(fixes) {
    const accepted = [];
    const rejected = [];
    if (!Array.isArray(fixes)) return { accepted, rejected: [{ reason: 'not_array', raw: fixes }] };

    for (const raw of fixes) {
        const result = validateOne(raw);
        if (result.ok) accepted.push(result.fix);
        else rejected.push(result.rejected);
    }
    return { accepted, rejected };
}

function validateOne(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, rejected: { reason: 'not_object', raw } };
    }
    if (!Object.prototype.hasOwnProperty.call(raw, 'kind')) {
        const field = Object.keys(raw)[0] || 'kind';
        return { ok: false, rejected: { reason: 'unknown_field', kind: null, field, raw } };
    }

    const kind = raw.kind;
    const schema = PATCH_SCHEMAS[kind];
    if (!schema) return { ok: false, rejected: { reason: 'unsupported_kind', kind: kind || null, raw } };

    for (const key of Object.keys(raw)) {
        if (!schema.keys.has(key)) {
            return { ok: false, rejected: { reason: 'unknown_field', kind, field: key, raw } };
        }
    }

    for (const key of schema.required) {
        if (!(key in raw) || raw[key] == null || raw[key] === '') {
            return { ok: false, rejected: { reason: 'missing_field', kind, field: key, raw } };
        }
    }
    if (raw.variable && !isSafeVariableName(raw.variable)) {
        return { ok: false, rejected: { reason: 'invalid_variable', kind, variable: raw.variable, raw } };
    }

    if (kind === 'addExtractor') {
        if (!['json', 'regex', 'css'].includes(raw.type)) {
            return { ok: false, rejected: { reason: 'invalid_extractor_type', kind, type: raw.type, raw } };
        }
        if (raw.type === 'json' && !raw.path) {
            return { ok: false, rejected: { reason: 'missing_field', kind, field: 'path', raw } };
        }
        if (raw.type === 'regex' && !raw.regex) {
            return { ok: false, rejected: { reason: 'missing_field', kind, field: 'regex', raw } };
        }
        if (raw.type === 'css' && !raw.selector) {
            return { ok: false, rejected: { reason: 'missing_field', kind, field: 'selector', raw } };
        }
        // Validate the extractor EXPRESSION now, so a malformed regex/JSONPath is
        // rejected here instead of silently extracting nothing (or throwing) at
        // JMeter runtime and burning a full validation cycle.
        if (raw.type === 'regex' && !isValidRegex(raw.regex)) {
            return { ok: false, rejected: { reason: 'invalid_regex', kind, regex: raw.regex, raw } };
        }
        if (raw.type === 'json' && !isPlausibleJsonPath(raw.path)) {
            return { ok: false, rejected: { reason: 'invalid_jsonpath', kind, path: raw.path, raw } };
        }
    }

    if (kind === 'setSamplerEnabled' && typeof raw.enabled !== 'boolean') {
        return { ok: false, rejected: { reason: 'invalid_field', kind, field: 'enabled', raw } };
    }

    return { ok: true, fix: { ...raw } };
}

function isSafeVariableName(name) {
    const s = String(name || '');
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && !s.startsWith('__');
}

function isValidRegex(pattern) {
    const s = String(pattern == null ? '' : pattern);
    if (!s) return false;
    try { new RegExp(s); return true; } catch { return false; }
}

// JMeter JSONPath: must start with '$' and have balanced brackets. We don't
// fully parse JSONPath, but we reject the obvious breakage (no root, unbalanced
// brackets) that yields a runtime no-op extraction.
function isPlausibleJsonPath(path) {
    const s = String(path == null ? '' : path).trim();
    if (!s.startsWith('$')) return false;
    let depth = 0;
    for (const ch of s) {
        if (ch === '[') depth++;
        else if (ch === ']') { depth--; if (depth < 0) return false; }
    }
    return depth === 0;
}

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
            if (fix.kind === 'removeAssertion') {
                const res = applyRemoveAssertion(out, fix);
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
        selector: raw.selector || raw.cssSelector || null,
        attribute: raw.attribute || 'value',
        assertion: raw.assertion || raw.assertionName || null,
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
    if (fix.type === 'json' || (fix.path && !fix.regex && !fix.selector)) {
        if (!fix.path) return { skipped: { reason: 'missing_json_path', kind: fix.kind } };
        block = `
            <JSONPostProcessor guiclass="JSONPostProcessorGui" testclass="JSONPostProcessor" testname="LLM-fix Extract ${escXmlAttr(fix.variable)} (JSON)" enabled="true">
              <stringProp name="JSONPostProcessor.referenceNames">${escXmlAttr(fix.variable)}</stringProp>
              <stringProp name="JSONPostProcessor.jsonPathExprs">${escXmlAttr(fix.path)}</stringProp>
              <stringProp name="JSONPostProcessor.match_numbers">1</stringProp>
              <stringProp name="JSONPostProcessor.defaultValues">NOT_FOUND_${escXmlAttr(fix.variable)}</stringProp>
            </JSONPostProcessor>
            <hashTree/>`;
    } else if (fix.type === 'css' || fix.selector) {
        if (!fix.selector) return { skipped: { reason: 'missing_css_selector', kind: fix.kind } };
        block = `
            <HtmlExtractor guiclass="HtmlExtractorGui" testclass="HtmlExtractor" testname="LLM-fix Extract ${escXmlAttr(fix.variable)} (CSS)" enabled="true">
              <stringProp name="HtmlExtractor.refname">${escXmlAttr(fix.variable)}</stringProp>
              <stringProp name="HtmlExtractor.expr">${escXmlAttr(fix.selector)}</stringProp>
              <stringProp name="HtmlExtractor.attribute">${escXmlAttr(fix.attribute || 'value')}</stringProp>
              <stringProp name="HtmlExtractor.default">NOT_FOUND_${escXmlAttr(fix.variable)}</stringProp>
              <stringProp name="HtmlExtractor.match_number">1</stringProp>
            </HtmlExtractor>
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

function applyRemoveAssertion(xml, fix) {
    if (!fix.sampler) return { skipped: { reason: 'missing_sampler', kind: fix.kind } };
    if (!fix.assertion) return { skipped: { reason: 'missing_assertion', kind: fix.kind } };
    const samplerRe = new RegExp(`<HTTPSamplerProxy\\b[^>]*\\btestname="${escapeRegExp(fix.sampler)}"[^>]*>[\\s\\S]*?<\\/HTTPSamplerProxy>\\s*<hashTree>[\\s\\S]*?<\\/hashTree>`);
    const match = String(xml || '').match(samplerRe);
    if (!match) return { skipped: { reason: 'sampler_not_found', sampler: fix.sampler } };
    const block = match[0];
    const assertionRe = new RegExp(`\\s*<ResponseAssertion\\b[^>]*\\btestname="${escapeRegExp(fix.assertion)}"[^>]*>[\\s\\S]*?<\\/ResponseAssertion>\\s*<hashTree\\/>`, 'g');
    let removed = 0;
    const nextBlock = block.replace(assertionRe, () => { removed++; return ''; });
    if (!removed) return { skipped: { reason: 'assertion_not_found', sampler: fix.sampler, assertion: fix.assertion } };
    return {
        xml: xml.replace(block, nextBlock),
        applied: { kind: 'removeAssertion', sampler: fix.sampler, assertion: fix.assertion, removed },
    };
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
        const endIdx = s.endPosition || result.indexOf('</HTTPSamplerProxy>', s.position);
        if (endIdx < 0) continue;
        const samplerXml = result.substring(s.position, endIdx);
        if (!samplerXml.includes(fix.value)) continue;
        // Only replace inside stringProp/Header.value content nodes — never
        // inside attributes (testname="...") or tag names. The reliable way
        // is to scope by `<stringProp ...>VALUE</stringProp>` pattern.
        const scoped = samplerXml.replace(
            /(<stringProp\b[^>]*>)([^<]*)(<\/stringProp>)/g,
            (_m, a, content, b) => `${a}${content.split(fix.value).join(replacement)}${b}`
        );
        if (scoped !== samplerXml) {
            result = result.substring(0, s.position) + scoped + result.substring(endIdx);
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

function escapeRegExp(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { applyLlmPatches, validateLlmPatches, _internal: { normalize, applyAddExtractor, applyReplaceValueWithVar, applySetSamplerEnabled, applyRemoveAssertion, validateOne, isSafeVariableName } };
