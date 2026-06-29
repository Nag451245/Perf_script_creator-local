'use strict';
/**
 * host-rewrite.js — cross-environment host rewrite (local, no engine change).
 *
 * Repoints the recording's PRIMARY host to a target base URL so a recording
 * made against prod can be replayed against staging. Precise PER-SAMPLER: only
 * samplers whose domain equals `fromHost` are changed, so third-party hosts in
 * the recording (CDNs, analytics, payment iframes) keep their recorded values.
 */

function parseTarget(baseUrl) {
    const u = new URL(baseUrl);
    return { protocol: u.protocol.replace(':', ''), host: u.hostname, port: u.port || '' };
}

/**
 * @returns {{ xml, count }} rewritten XML and how many samplers were repointed.
 */
function rewriteHost(xml, fromHost, baseUrl) {
    if (!xml || !fromHost || !baseUrl) return { xml, count: 0 };
    const t = parseTarget(baseUrl);
    let count = 0;

    const fixBlock = (block) => {
        const m = block.match(/<stringProp name="HTTPSampler\.domain">([^<]*)<\/stringProp>/);
        if (!m || m[1] !== fromHost) return block;       // leave other hosts alone
        count++;
        return block
            .replace(/(<stringProp name="HTTPSampler\.domain">)[^<]*(<\/stringProp>)/, `$1${t.host}$2`)
            .replace(/(<stringProp name="HTTPSampler\.protocol">)[^<]*(<\/stringProp>)/, `$1${t.protocol}$2`)
            .replace(/(<stringProp name="HTTPSampler\.port">)[^<]*(<\/stringProp>)/, `$1${t.port}$2`);
    };

    const out = xml
        .replace(/<HTTPSamplerProxy[\s\S]*?<\/HTTPSamplerProxy>/g, fixBlock)
        .replace(/<ConfigTestElement[\s\S]*?<\/ConfigTestElement>/g, fixBlock);

    return { xml: out, count };
}

module.exports = { rewriteHost, parseTarget };
