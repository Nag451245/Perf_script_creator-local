'use strict';

const fs = require('fs');
const path = require('path');

function summarizeRunProgress(outDir) {
    return snapshotRunProgress(outDir).summary;
}

function snapshotRunProgress(outDir) {
    const latest = latestIterationDir(outDir);
    if (!latest) {
        const summary = 'validation still running; waiting for JMeter iteration artifacts';
        return { summary, key: summary };
    }
    const runLog = path.join(latest.fullPath, 'run.log');
    const resultsJtl = path.join(latest.fullPath, 'results.jtl');
    const finalJtl = path.join(outDir, 'final.jtl');
    const parts = [`validation still running; ${latest.name}`];
    const resultStat = fileStat(resultsJtl);
    const finalStat = fileStat(finalJtl);
    if (resultStat) parts.push(`results.jtl ${formatBytes(resultStat.size)}, updated ${new Date(resultStat.mtimeMs).toLocaleTimeString()}`);
    if (finalStat) parts.push(`final.jtl ${formatBytes(finalStat.size)}, updated ${new Date(finalStat.mtimeMs).toLocaleTimeString()}`);
    const sampleCount = countSamples(resultsJtl);
    if (sampleCount != null) parts.push(`${sampleCount} sample(s) written`);
    const last = lastLogLine(runLog);
    if (last) parts.push(`last: ${last}`);
    const key = [
        latest.name,
        resultStat ? resultStat.size : 0,
        finalStat ? finalStat.size : 0,
        sampleCount == null ? '' : sampleCount,
        normalizeLogLine(last),
    ].join('|');
    return { summary: parts.join(' · '), key };
}

function latestIterationDir(outDir) {
    let entries;
    try { entries = fs.readdirSync(outDir, { withFileTypes: true }); }
    catch { return null; }
    const dirs = entries
        .filter(e => e.isDirectory() && /^iteration_\d+$/i.test(e.name))
        .map(e => ({
            name: e.name,
            fullPath: path.join(outDir, e.name),
            index: Number((e.name.match(/\d+/) || ['0'])[0]),
        }))
        .sort((a, b) => b.index - a.index);
    return dirs[0] || null;
}

function statSummary(file) {
    const stat = fileStat(file);
    return stat ? `${formatBytes(stat.size)}, updated ${new Date(stat.mtimeMs).toLocaleTimeString()}` : '';
}

function fileStat(file) {
    try {
        const stat = fs.statSync(file);
        return { size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
        return null;
    }
}

function countSamples(file) {
    try {
        const xml = fs.readFileSync(file, 'utf8');
        return (xml.match(/<(?:httpSample|sample)\b/g) || []).length;
    } catch {
        return null;
    }
}

function lastLogLine(file) {
    try {
        const text = fs.readFileSync(file, 'utf8');
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        return lines.length ? lines[lines.length - 1].slice(0, 220) : '';
    } catch {
        return '';
    }
}

function normalizeLogLine(line) {
    return String(line || '')
        .replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2},\d{3}\s+/, '')
        .replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<time>')
        .replace(/\b\d{10,}\b/g, '<number>')
        .trim();
}

function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

module.exports = {
    summarizeRunProgress,
    snapshotRunProgress,
    _internal: { latestIterationDir, statSummary, countSamples, lastLogLine, normalizeLogLine, formatBytes },
};
