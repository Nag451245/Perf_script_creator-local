'use strict';
/**
 * report-docs.js — fold every readable diagnostic INTO the HTML report.
 *
 * A finished run wrote 17 files a person cannot actually open: on Windows a
 * .md opens in nothing, a .json opens as unformatted text in Notepad, and a
 * .jtl has no association at all. A folder of those is a folder the operator
 * cannot read, so the content may as well not exist.
 *
 * Everything worth reading is therefore rendered into the one artifact that
 * always opens — report.html — and the loose copies are cleared afterwards.
 * Markdown is converted here rather than pulled from a library, because the
 * report must stay a single self-contained file with no dependencies.
 */

const fs = require('fs');
const path = require('path');

const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Inline markdown: `code` and **bold**, escaped first so content can't inject HTML. */
function inlineMd(text) {
    return esc(text)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/**
 * Markdown → HTML, dependency-free and deliberately small: headings, lists,
 * fenced code, bold, paragraphs — everything the agent's own documents use.
 */
function mdToHtml(md) {
    const lines = String(md || '').split(/\r?\n/);
    const out = [];
    let inList = false;
    let inCode = false;
    const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };

    for (const raw of lines) {
        const line = raw.replace(/\s+$/, '');
        if (/^```/.test(line)) {
            closeList();
            out.push(inCode ? '</code></pre>' : '<pre><code>');
            inCode = !inCode;
            continue;
        }
        if (inCode) { out.push(esc(raw)); continue; }

        const heading = line.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
            closeList();
            const level = Math.min(6, heading[1].length + 2);
            out.push(`<h${level}>${inlineMd(heading[2])}</h${level}>`);
            continue;
        }
        const item = line.match(/^\s*[-*]\s+(.*)$/);
        if (item) {
            if (!inList) { out.push('<ul>'); inList = true; }
            out.push(`<li>${inlineMd(item[1])}</li>`);
            continue;
        }
        if (!line.trim()) { closeList(); continue; }
        closeList();
        out.push(`<p>${inlineMd(line)}</p>`);
    }
    closeList();
    if (inCode) out.push('</code></pre>');
    return out.join('\n');
}

/** The readable documents, most useful first. */
const DOCS = [
    ['_blockers.md', 'What a human needs to provide'],
    ['_human_questions.md', 'Questions for you'],
    ['_failure_forensics.md', 'Failure forensics'],
    ['_pe_analysis.md', 'Failure and flow-intent analysis'],
    ['_senior_pe_debrief.md', 'Senior performance engineering debrief'],
    ['_reasoning.md', 'Reasoning trace — every decision and why'],
];

/** Small JSON findings worth showing as a readable list. */
const FINDINGS = [
    ['_knowledge_review.json', 'Known issues recognised in this script', (rows) =>
        rows.map(r => `<li><strong>${esc(r.title || r.id)}</strong>${r.evidence ? ` — ${esc(r.evidence)}` : ''}${r.remedy ? `<br><span class="muted">${esc(String(r.remedy).split('.')[0])}.</span>` : ''}</li>`).join('')],
    ['_live_probe.json', 'Live checks against the environment', (rows) =>
        rows.map(r => `<li><strong>${esc(r.url || '')}</strong> — ${esc(r.summary || r.notes || '')}</li>`).join('')],
];

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Build the "Details" section: every markdown document rendered inline, plus
 * the small structured findings, each collapsed so the page still opens on the
 * summary rather than a wall of text.
 */
function embeddedDocs(outDir, name) {
    const sections = [];
    for (const [suffix, title] of DOCS) {
        const full = path.join(outDir, `${name}${suffix}`);
        if (!fs.existsSync(full)) continue;
        let body = '';
        try { body = fs.readFileSync(full, 'utf8'); } catch { continue; }
        if (!body.trim()) continue;
        sections.push(`<details><summary>${esc(title)}</summary><div class="doc">${mdToHtml(body)}</div></details>`);
    }
    for (const [suffix, title, render] of FINDINGS) {
        const parsed = readJson(path.join(outDir, `${name}${suffix}`));
        const rows = Array.isArray(parsed) ? parsed : null;
        if (!rows || !rows.length) continue;
        sections.push(`<details><summary>${esc(title)}</summary><div class="doc"><ul>${render(rows)}</ul></div></details>`);
    }
    if (!sections.length) return '';
    return `<h2>Details</h2>
  <p class="muted">Everything the agent wrote about this run — the same content that used to sit in .md and .json files nothing opens.</p>
  ${sections.join('\n  ')}`;
}

module.exports = { embeddedDocs, mdToHtml };
