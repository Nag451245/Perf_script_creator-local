'use strict';

const { injectAfterSampler, _internal: { indexSamplers } } = require('./extractors');

const escXml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function sanitizeVarPart(value) {
    const clean = String(value || 'graphql')
        .replace(/[^A-Za-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return clean || 'graphql';
}

function samplerRegion(xml, sampler) {
    return xml.slice(sampler.position, sampler.endPosition);
}

function samplerBlock(region) {
    const close = region.indexOf('</HTTPSamplerProxy>');
    return close >= 0 ? region.slice(0, close + '</HTTPSamplerProxy>'.length) : region;
}

function samplerPath(block) {
    return (block.match(/<stringProp name="HTTPSampler\.path">([^<]*)<\/stringProp>/) || [])[1] || '';
}

function operationName(block, fallback) {
    return (block.match(/<stringProp name="GraphQLHTTPSampler\.operationName">([^<]*)<\/stringProp>/) || [])[1]
        || (block.match(/&quot;operationName&quot;:&quot;([^&]+)&quot;/) || [])[1]
        || fallback
        || 'graphql';
}

function isGraphqlCsrfProducer(block) {
    return samplerPath(block).split('?')[0] === '/graphql' && /\bcsrfToken\b/.test(block);
}

function buildProducerVars(xml) {
    const samplers = indexSamplers(xml);
    const used = new Set([...xml.matchAll(/\$\{([A-Za-z0-9_]+)\}/g)].map(m => m[1]));
    const producers = new Map();
    for (const sampler of samplers) {
        const block = samplerBlock(samplerRegion(xml, sampler));
        if (!isGraphqlCsrfProducer(block)) continue;
        const base = `gql_${sanitizeVarPart(operationName(block, sampler.name))}_csrfToken`;
        let ref = base;
        let suffix = 2;
        while (used.has(ref)) ref = `${base}_${suffix++}`;
        used.add(ref);
        producers.set(sampler.order, { ref, samplerName: sampler.name, operationName: operationName(block, sampler.name) });
    }
    return producers;
}

function replaceCsrfHeader(region, ref) {
    let changed = false;
    const next = region.replace(
        /<elementProp\b[^>]*elementType="Header"[^>]*>[\s\S]*?<stringProp name="Header\.name">([^<]+)<\/stringProp>[\s\S]*?<stringProp name="Header\.value">([^<]*)<\/stringProp>[\s\S]*?<\/elementProp>/g,
        (block, name, value) => {
            if (!/^x-csrf-token$/i.test(String(name || '').trim())) return block;
            const current = String(value || '');
            if (current === '${' + ref + '}') return block;
            if (/^\$\{[^}]+\}$/.test(current)) return block;
            changed = true;
            return block.replace(
                /(<stringProp name="Header\.value">)([^<]*)(<\/stringProp>)/,
                `$1\${${ref}}$3`
            );
        }
    );
    return { region: next, changed };
}

function jsonExtractorXml(ref) {
    return `
            <JSONPostProcessor guiclass="JSONPostProcessorGui" testclass="JSONPostProcessor" testname="Extract ${escXml(ref)} (GraphQL csrfToken)" enabled="true">
              <stringProp name="JSONPostProcessor.referenceNames">${escXml(ref)}</stringProp>
              <stringProp name="JSONPostProcessor.jsonPathExprs">$..csrfToken</stringProp>
              <stringProp name="JSONPostProcessor.match_numbers">1</stringProp>
              <stringProp name="JSONPostProcessor.defaultValues">NOT_FOUND_${escXml(ref)}</stringProp>
            </JSONPostProcessor>
            <hashTree/>`;
}

function hasExtractorFor(region, ref) {
    return new RegExp(`<stringProp name="JSONPostProcessor\\.referenceNames">${escXml(ref).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</stringProp>`).test(region);
}

function propagateGraphqlCsrfTokens(jmxXml) {
    let xml = String(jmxXml || '');
    const samplers = indexSamplers(xml);
    if (!samplers.length) return { xml, producers: [], substitutions: 0, extractors: 0 };

    const producerVars = buildProducerVars(xml);
    if (!producerVars.size) return { xml, producers: [], substitutions: 0, extractors: 0 };

    const replacements = [];
    const producersToInject = new Set();
    let active = null;
    let substitutions = 0;

    for (const sampler of samplers) {
        const region = samplerRegion(xml, sampler);
        if (active) {
            const replaced = replaceCsrfHeader(region, active.ref);
            if (replaced.changed) {
                replacements.push({ start: sampler.position, end: sampler.endPosition, region: replaced.region });
                producersToInject.add(active.order);
                substitutions++;
            }
        }
        const produced = producerVars.get(sampler.order);
        if (produced) active = { ...produced, order: sampler.order };
    }

    if (!substitutions) return { xml, producers: [], substitutions: 0, extractors: 0 };

    for (const r of replacements.reverse()) {
        xml = xml.slice(0, r.start) + r.region + xml.slice(r.end);
    }

    let extractors = 0;
    for (const order of [...producersToInject].sort((a, b) => b - a)) {
        const producer = producerVars.get(order);
        const currentSamplers = indexSamplers(xml);
        const region = currentSamplers[order] ? samplerRegion(xml, currentSamplers[order]) : '';
        if (!producer || hasExtractorFor(region, producer.ref)) continue;
        const next = injectAfterSampler(xml, order, jsonExtractorXml(producer.ref));
        if (next !== xml) {
            xml = next;
            extractors++;
        }
    }

    return {
        xml,
        producers: [...producersToInject].sort((a, b) => a - b).map(order => ({ order, ...producerVars.get(order) })),
        substitutions,
        extractors,
    };
}

module.exports = { propagateGraphqlCsrfTokens, _internal: { buildProducerVars, replaceCsrfHeader } };
