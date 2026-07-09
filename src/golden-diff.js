'use strict';
/**
 * golden-diff.js — learn from a human-fixed WORKING script ("golden").
 *
 * A senior engineer's fixed JMX is the densest source of truth we can get:
 * every extractor it contains is proven against the live app, and every
 * sampler it disables was judged disposable. Drop it into input/ as
 * `<flow>__golden.jmx` next to the recordings and this module:
 *
 *   1. diffs it against the freshly GENERATED script (model level — samplers
 *      matched by testname, never a text diff),
 *   2. copies the golden's proven extractors VERBATIM under the same-named
 *      samplers (we don't re-synthesize what a human already verified),
 *   3. mirrors its enable/disable judgments (a sampler the senior deleted or
 *      disabled is disposable; one they kept enabled must not be disabled),
 *   4. re-applies its literal→${var} substitutions where the generated
 *      script still ships a recorded literal.
 *
 * The result still goes through the normal JMeter verification — golden
 * knowledge is trusted but verified (it may be stale vs a fresh recording).
 * Deltas are reported to `_golden_deltas.json` and disable judgments are
 * surfaced so the business guard treats them as operator decisions.
 */
const { injectAfterSampler } = require('./extractors');
const { _internal: { indexSamplers } } = require('./transforms');

const EXTRACTOR_RE = /<(RegexExtractor|JSONPostProcessor|HtmlExtractor|BoundaryExtractor|XPath2Extractor)\b[\s\S]*?<\/\1>/g;

/** Parse a JMX into a sampler-keyed model. */
function parseJmxModel(xml) {
    const samplers = indexSamplers(xml);
    const model = new Map(); // testname -> { name, enabled, order, extractors, path, args, headers }
    for (const s of samplers) {
        const openEnd = xml.indexOf('>', s.position);
        const openTag = xml.substring(s.position, openEnd + 1);
        const closeIdx = xml.indexOf('</HTTPSamplerProxy>', s.position);
        const inner = closeIdx > 0 ? xml.substring(openEnd + 1, closeIdx) : '';
        const segment = xml.substring(s.position, s.endPosition);
        const extractors = [];
        EXTRACTOR_RE.lastIndex = 0;
        let m;
        while ((m = EXTRACTOR_RE.exec(segment)) !== null) {
            const refname = (m[0].match(/name="[^"]*(?:refname|referenceNames)">([^<]+)</i) || [])[1];
            if (refname) extractors.push({ refname, type: m[1], xml: m[0] });
        }
        if (!model.has(s.name)) {
            model.set(s.name, {
                name: s.name,
                order: s.order,
                enabled: !/enabled="false"/.test(openTag),
                extractors,
                path: prop(inner, 'HTTPSampler.path'),
                args: argumentsByName(inner),
                headers: headersByName(segment),
            });
        }
    }
    return model;
}

function prop(block, name) {
    const m = block.match(new RegExp(`<stringProp name="${escapeRe(name)}">([\\s\\S]*?)</stringProp>`));
    return m ? m[1] : '';
}

function argumentsByName(inner) {
    const out = new Map();
    for (const m of inner.matchAll(/<elementProp\b[^>]*elementType="HTTPArgument"[\s\S]*?<\/elementProp>/g)) {
        const name = prop(m[0], 'Argument.name');
        const value = prop(m[0], 'Argument.value');
        if (name) out.set(name, value);
    }
    return out;
}

function headersByName(segment) {
    const out = new Map();
    for (const m of segment.matchAll(/<elementProp\b[^>]*elementType="Header"[\s\S]*?<\/elementProp>/g)) {
        const name = prop(m[0], 'Header.name');
        const value = prop(m[0], 'Header.value');
        if (name) out.set(name, value);
    }
    return out;
}

/**
 * Diff golden vs generated.
 * @returns {{extractorsToAdd, toDisable, toEnable, substitutions, notes}}
 */
function diffGoldenAgainstGenerated({ goldenXml, generatedXml }) {
    const golden = parseJmxModel(goldenXml);
    const generated = parseJmxModel(generatedXml);

    const generatedRefnames = new Set();
    for (const g of generated.values()) for (const e of g.extractors) generatedRefnames.add(e.refname);

    const extractorsToAdd = [];
    const toDisable = [];
    const toEnable = [];
    const substitutions = [];
    const notes = [];

    // Samplers the senior DELETED from the golden are disposable.
    for (const [name, gen] of generated) {
        if (!golden.has(name) && gen.enabled) {
            toDisable.push({ sampler: name, reason: 'absent_in_golden' });
        }
    }

    for (const [name, gold] of golden) {
        const gen = generated.get(name);
        if (!gen) { notes.push(`golden sampler "${name}" has no generated counterpart — skipped`); continue; }

        if (!gold.enabled && gen.enabled) toDisable.push({ sampler: name, reason: 'disabled_in_golden' });
        if (gold.enabled && !gen.enabled) toEnable.push({ sampler: name, reason: 'enabled_in_golden' });

        // Proven extractors the generation missed — copy verbatim.
        for (const e of gold.extractors) {
            const alreadyHere = gen.extractors.some(x => x.refname === e.refname);
            if (!alreadyHere && !generatedRefnames.has(e.refname)) {
                extractorsToAdd.push({ sampler: name, refname: e.refname, type: e.type, xml: e.xml });
                generatedRefnames.add(e.refname);
            }
        }

        // literal→${var} substitutions the golden carries and generation missed.
        collectSubstitution(gold.path, gen.path, name, 'path', substitutions);
        for (const [argName, goldVal] of gold.args) {
            if (gen.args.has(argName)) collectSubstitution(goldVal, gen.args.get(argName), name, `arg:${argName}`, substitutions);
        }
        for (const [hName, goldVal] of gold.headers) {
            if (gen.headers.has(hName)) collectSubstitution(goldVal, gen.headers.get(hName), name, `header:${hName}`, substitutions);
        }
    }

    // Only substitute variables that will actually be defined.
    const defined = new Set(generatedRefnames);
    const usable = substitutions.filter(s => defined.has(s.variable));
    const skipped = substitutions.length - usable.length;
    if (skipped > 0) notes.push(`${skipped} golden substitution(s) skipped — their variable has no extractor in the merged script`);

    return { extractorsToAdd, toDisable, toEnable, substitutions: usable, notes };
}

/**
 * Golden has `...prefix${var}suffix...` where generated has a literal in the
 * same field → recover the literal by anchor alignment and record the swap.
 */
function collectSubstitution(goldVal, genVal, sampler, field, out) {
    if (!goldVal || !genVal || goldVal === genVal) return;
    const varRe = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
    let m;
    while ((m = varRe.exec(goldVal)) !== null) {
        if (genVal.includes('${' + m[1] + '}')) continue; // generation already wired it
        let prefix = goldVal.slice(Math.max(0, m.index - 24), m.index);
        const brace = prefix.lastIndexOf('}');
        if (brace >= 0) prefix = prefix.slice(brace + 1);
        const suffix = goldVal.slice(m.index + m[0].length, m.index + m[0].length + 24).split('${')[0];
        const pAt = prefix ? genVal.indexOf(prefix) : 0;
        if (prefix && pAt < 0) continue;
        const start = prefix ? pAt + prefix.length : 0;
        const end = suffix ? genVal.indexOf(suffix, start) : genVal.length;
        if (end <= start) continue;
        const literal = genVal.slice(start, end);
        if (!literal || literal.length < 6 || literal.includes('<') || literal.includes('${')) continue;
        out.push({ sampler, field, variable: m[1], literal });
    }
}

/**
 * Apply the deltas to the generated XML.
 * @returns {{ xml, applied: {extractors:number, disabled:number, enabled:number, substitutions:number} }}
 */
function applyGoldenDeltas(generatedXml, deltas) {
    let xml = generatedXml;
    const applied = { extractors: 0, disabled: 0, enabled: 0, substitutions: 0 };

    for (const item of deltas.extractorsToAdd || []) {
        const samplers = indexSamplers(xml);
        const s = samplers.find(x => x.name === item.sampler);
        if (!s) continue;
        const next = injectAfterSampler(xml, s.order, `\n            ${item.xml}\n            <hashTree/>`);
        if (next !== xml) { xml = next; applied.extractors++; }
    }

    for (const item of deltas.toDisable || []) {
        const r = setSamplerEnabledByName(xml, item.sampler, false);
        xml = r.xml; applied.disabled += r.changed;
    }
    for (const item of deltas.toEnable || []) {
        const r = setSamplerEnabledByName(xml, item.sampler, true);
        xml = r.xml; applied.enabled += r.changed;
    }

    for (const sub of deltas.substitutions || []) {
        const samplers = indexSamplers(xml);
        const s = samplers.find(x => x.name === sub.sampler);
        if (!s) continue;
        const seg = xml.substring(s.position, s.endPosition);
        const replaced = seg.replace(
            /(<stringProp\b[^>]*>)([^<]*)(<\/stringProp>)/g,
            (_m, open, content, close) => content.includes(sub.literal)
                ? open + content.split(sub.literal).join('${' + sub.variable + '}') + close
                : _m
        );
        if (replaced !== seg) {
            xml = xml.substring(0, s.position) + replaced + xml.substring(s.endPosition);
            applied.substitutions++;
        }
    }

    return { xml, applied };
}

function setSamplerEnabledByName(xml, samplerName, enabled) {
    let changed = 0;
    const re = new RegExp(
        `(<HTTPSamplerProxy\\b[^>]*\\btestname="${escapeRe(samplerName)}"[^>]*\\benabled=")(true|false)(")`
    );
    const next = xml.replace(re, (_m, a, _v, b) => { changed++; return `${a}${enabled ? 'true' : 'false'}${b}`; });
    return { xml: next, changed };
}

function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
    diffGoldenAgainstGenerated,
    applyGoldenDeltas,
    _internal: { parseJmxModel, collectSubstitution, setSamplerEnabledByName },
};
