'use strict';

const { correlateAndReplay } = require('./replay-correlate');
const { classifyFirstFailure } = require('./failure-classifier');

async function runBlueprintPreflight({ ctx, entries, runCfg = {}, onLog = () => {} }) {
    const targetBaseUrl = String(runCfg.targetBaseUrlOverride || runCfg.targetBaseUrl || '').trim();
    if (!targetBaseUrl) {
        const skipped = { skipped: true, reason: 'run targetBaseUrl is required for blueprint replay preflight' };
        if (ctx) ctx.loop.attempts.push({ phase: 'replay-preflight', ...skipped });
        return skipped;
    }

    onLog(`blueprint preflight: replay-lineage against ${targetBaseUrl}`);
    const replay = await correlateAndReplay({
        entries,
        targetBaseUrl,
        insecure: !!(runCfg.fastReplay && runCfg.fastReplay.insecure),
        onLog,
    });

    if (ctx) {
        ctx.lineage.links = replay.links || [];
        ctx.lineage.orphans = replay.orphans || [];
        ctx.loop.attempts.push({
            phase: 'replay-preflight',
            skipped: false,
            reachedEnd: replay.reachedEnd,
            applied: replay.applied,
            verified: replay.verified,
            firstFailure: firstReplayFailure(replay),
        });
        ctx.loop.firstFailure = ctx.loop.firstFailure || classifyFirstFailure({ samples: replay.samples || [] });
    }

    return { skipped: false, replay };
}

function firstReplayFailure(replay) {
    const f = (replay.failures || [])[0];
    if (!f) return null;
    return {
        index: f.index,
        url: f.url,
        responseCode: String(f.status || ''),
        recordedCode: String(f.recStatus || ''),
        category: (f.status === 401 || f.status === 403) ? 'auth_correlation_failed' : 'payload_or_header_failed',
    };
}

module.exports = { runBlueprintPreflight, _internal: { firstReplayFailure } };
