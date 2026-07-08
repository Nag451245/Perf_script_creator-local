'use strict';

const JSR223_BLOCK_RE = /<((?:JSR223)(?:PreProcessor|PostProcessor))\b[^>]*>[\s\S]*?<\/\1>\s*<hashTree\s*(?:\/>|>\s*<\/hashTree>)/g;

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

    for (const match of xml.matchAll(JSR223_BLOCK_RE)) {
        const body = match[0];
        blocks.push({
            type: match[1],
            testname: attr(body, 'testname') || '',
            scriptLanguage: prop(body, 'scriptLanguage') || '',
            start: match.index,
            end: match.index + body.length,
        });
    }
    return blocks;
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
