'use strict';

// Scripting elements that break "Java-safe by default": JSR223 and the legacy
// BeanShell/BSF pre/post-processors all execute arbitrary code the customer's
// JMeter may not permit (Groovy engine missing, security manager, etc.).
const JSR223_BLOCK_RE = /<((?:JSR223)(?:PreProcessor|PostProcessor))\b[^>]*>[\s\S]*?<\/\1>\s*<hashTree\s*(?:\/>|>\s*<\/hashTree>)/g;
const BEANSHELL_BLOCK_RE = /<((?:BeanShell|BSF)(?:PreProcessor|PostProcessor))\b[^>]*>[\s\S]*?<\/\1>\s*<hashTree\s*(?:\/>|>\s*<\/hashTree>)/g;

function sanitizeJavaUnsafeJmx(xml, opts = {}) {
    const mode = opts.mode || 'strip';
    const removed = findJavaUnsafeJsr223(xml);
    if (!removed.length) return { xml, changed: false, removed: [] };

    if (mode === 'reject') {
        return {
            xml,
            changed: false,
            removed,
            error: `JMX contains ${removed.length} JSR223 pre/post processor block(s)`,
        };
    }

    let out = '';
    let last = 0;
    for (const block of removed) {
        out += xml.slice(last, block.start);
        last = block.end;
    }
    out += xml.slice(last);

    return { xml: out, changed: out !== xml, removed };
}

function findJavaUnsafeJsr223(xml) {
    const blocks = [];
    if (!xml) return blocks;

    for (const re of [JSR223_BLOCK_RE, BEANSHELL_BLOCK_RE]) {
        for (const match of xml.matchAll(re)) {
            const body = match[0];
            blocks.push({
                type: match[1],
                testname: attr(body, 'testname') || '',
                scriptLanguage: prop(body, 'scriptLanguage') || '',
                start: match.index,
                end: match.index + body.length,
            });
        }
    }
    // Reconstruction slices depend on ascending start order across both scanners.
    return blocks.sort((a, b) => a.start - b.start);
}

function attr(xml, name) {
    const re = new RegExp(`\\b${escapeRe(name)}="([^"]*)"`);
    const m = xml.match(re);
    return m ? unescapeXml(m[1]) : null;
}

function prop(xml, name) {
    const re = new RegExp(`<stringProp name="${escapeRe(name)}">([\\s\\S]*?)<\\/stringProp>`);
    const m = xml.match(re);
    return m ? unescapeXml(m[1]) : null;
}

function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unescapeXml(s) {
    return String(s)
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

module.exports = { sanitizeJavaUnsafeJmx, findJavaUnsafeJsr223 };
