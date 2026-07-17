'use strict';

const statusAnalysis = require('./status-analysis');
const semanticTriage = require('./semantic-triage');
const invariantsModule = require('./invariants');

// 200-status responses that carry an application-level failure. These are the
// "everything 200 but nothing worked" bodies: GraphQL error envelopes, SOAP
// faults, gRPC status, and common soft-failure markers. Operators can extend
// via run.softFailurePatterns.
const DEFAULT_SOFT_FAILURE_RES = [
    /"errors"\s*:\s*\[\s*\{/i,               // GraphQL error envelope (non-empty)
    /\bsession expired\b/i,
    /\binvalid[_-]?token\b/i,
    /\bunauthenticated\b/i,                  // gRPC / OIDC
    /\baccess denied\b/i,
    /"faultstring"\s*:/i,                    // SOAP fault (JSON-encoded)
    /<faultstring>/i,                        // SOAP fault (XML)
    /"success"\s*:\s*false/i,
    /"status"\s*:\s*"(?:error|failed|unauthorized|forbidden)"/i,
];

function evaluateFinalGreenGate({
    result = {},
    baselineDiff = null,
    semanticDiff = null,
    businessVerification = null,
    evidence = null,
    assertionsPlanned = null,
    requireAssertions = false,
    softFailurePatterns = [],
    invariants = null,
} = {}) {
    const failures = [];
    const warnings = [];

    // Body-truth invariants: markers both recordings agree on must still be in
    // each passing sampler's LIVE body. A 200 whose step-content vanished
    // (auth wall past login, an error page, the wrong response entirely) fails
    // its step regardless of status. Judged only where a body was captured.
    if (invariants && evidence && Array.isArray(evidence.rows)) {
        const misses = invariantsModule.checkInvariants({ rows: evidence.rows, invariants });
        if (misses.length) {
            failures.push({
                category: 'business_marker_missing',
                reason: `${misses.length} passing sampler(s) lost the body markers both recordings agree on — ` +
                    misses.slice(0, 3).map(m => `"${m.sampler}" missing ${m.missing.length}/${m.expected} (e.g. ${m.missing[0]})`).join('; ') +
                    '. The step returned a success code without its real content.',
                details: misses,
            });
        }
    }

    // Assertion coverage: a JMX with zero assertions passes JMeter on HTTP
    // status alone — the classic "everything 200 but nothing verified" trap.
    // Default is a review WARNING (so today's assertion-light flows still reach
    // GREEN); run.requireAssertions promotes it to a hard gate for teams that
    // demand every green script prove a business marker.
    if (assertionsPlanned != null && Number(assertionsPlanned) <= 0) {
        const assertionFinding = {
            category: 'no_assertion_coverage',
            reason: 'The script ships with no response assertions — HTTP 200 alone cannot prove the business flow worked.',
        };
        if (requireAssertions) failures.push(assertionFinding);
        else warnings.push(assertionFinding);
    }

    if (result.success === false) {
        failures.push({
            category: result.recordingDriftFailure ? 'recording_drift_failure' : 'jmeter_failure',
            reason: result.failureMessage || result.error || 'JMeter run did not pass all request samples.',
        });
    }

    // Baseline drift on a run where every sampler PASSED is a review flag,
    // not a failure: live dynamic pages legitimately differ in size from a
    // days-old recording, and assertions + the business guard + the outcome
    // probe already vouch for correctness. Blocking here made GREEN
    // unreachable for perfect scripts. Drift stays blocking evidence when
    // the run itself failed.
    if (baselineDiff && Array.isArray(baselineDiff.drift) && baselineDiff.drift.length > 0) {
        const driftFinding = {
            category: 'baseline_drift',
            reason: `${baselineDiff.drift.length} sampler(s) differed from the recording.`,
            details: baselineDiff.drift,
        };
        if (result.success === false) failures.push(driftFinding);
        else warnings.push(driftFinding);
    }

    if (semanticDiff && Array.isArray(semanticDiff.issues) && semanticDiff.issues.length > 0) {
        failures.push({
            category: 'semantic_drift',
            reason: `${semanticDiff.issues.length} semantic response issue(s) detected.`,
            details: semanticDiff.issues,
        });
    }

    if (businessVerification && businessVerification.ok === false) {
        failures.push({
            category: 'business_verification_failed',
            reason: businessVerification.reason || 'Protected business verification failed.',
            details: businessVerification,
        });
    }

    const evidenceGate = evaluateEvidenceGate(evidence, { softFailurePatterns });
    // The auth wall is hoisted to its own TOP-LEVEL category and put FIRST: it
    // is not "drift", it is the whole run being a lie, and burying it inside a
    // details[] array of a generic drift failure is how a false green survives.
    const authWalls = evidenceGate.failures.filter(f => f.category === 'auth_wall');
    const otherEvidenceFailures = evidenceGate.failures.filter(f => f.category !== 'auth_wall');
    if (authWalls.length) {
        failures.unshift({
            category: 'auth_wall',
            reason: authWalls[0].reason,
            details: authWalls,
        });
    }
    if (otherEvidenceFailures.length) {
        failures.push({
            category: 'recording_evidence_drift',
            reason: otherEvidenceFailures[0].reason,
            details: otherEvidenceFailures,
        });
    }
    if (evidenceGate.businessErrors.length) {
        failures.push({
            category: 'business_error_in_body',
            reason: evidenceGate.businessErrors[0].reason,
            details: evidenceGate.businessErrors,
        });
    }
    if (evidenceGate.warnings.length) warnings.push(...evidenceGate.warnings);

    return {
        ok: failures.length === 0,
        categories: unique(failures.map(f => f.category)),
        failures,
        warnings,
        reason: failures.length
            ? failures.map(f => f.reason).join(' | ')
            : (warnings.length
                ? `GREEN with review flags: ${warnings.map(w => w.reason).join(' | ')}`
                : 'All green gates passed.'),
    };
}

function evaluateEvidenceGate(evidence, opts = {}) {
    const failures = [];
    const warnings = [];
    const businessErrors = [];
    const softFailureRes = compileSoftFailurePatterns(opts.softFailurePatterns);
    if (!evidence || !Array.isArray(evidence.rows)) return { failures, warnings, businessErrors };
    const rows = evidence.rows || [];

    // THE AUTH WALL outranks every other check. An unauthenticated run answers
    // 200 with the login page, so JMeter passes every sampler and the verdict
    // reads green while the script never touched the application. Any sampler
    // whose live body is a login page its RECORDED body was not proves the
    // session is gone — no number from this run means anything.
    const authWall = semanticTriage.findAuthWall(rows);
    if (authWall.walls.length) {
        const e = authWall.earliest;
        const detail = `${authWall.walls.length} sampler(s) returned the LOGIN page instead of application content` +
            (authWall.falsePasses ? ` — ${authWall.falsePasses} of them counted as PASSING (HTTP ${e.observedStatus})` : '') +
            `. Earliest: "${e.label}" (recorded "${e.recordedTitle || 'app content'}", observed "${e.observedTitle || 'login'}"). The session is not established; every downstream "pass" is measuring the login page, not the application.`;
        failures.push({
            category: 'auth_wall',
            index: e.entryIndex,
            sampler: e.label,
            reason: detail,
            detail,
            walls: authWall.walls.map(w => ({ sampler: w.label, passed: w.passed, observedTitle: w.observedTitle })),
        });
    }

    let bodyComparable = 0;
    for (const row of rows) {
        if (row.isTransaction) continue;
        if (row.recordedBodyLength > 0 && row.observedBodyLength > 0) bodyComparable++;
        // Soft failure inside a returned body (works whenever bodies were
        // captured — run.captureResponseBodies='full' or the fast-replay path).
        // Only a PRESENT body can trip this, so it can never flip a body-free
        // run; it strictly closes the "200 but broken" hole when evidence exists.
        const observedBody = String(row.observedBody || '');
        if (observedBody) {
            const hit = softFailureRes.find(re => re.test(observedBody));
            if (hit) {
                businessErrors.push({
                    index: row.entryIndex,
                    sampler: row.label,
                    reason: `${row.label} returned status ${row.observedStatus || '?'} but its body contains an application-level failure (matched /${hit.source}/).`,
                    marker: hit.source,
                });
            }
        }
        if (isLogoutRow(row) && rowFailed(row)) {
            warnings.push({
                category: 'logout_failure_ignored',
                reason: `Ignored logout sampler failure at ${formatSamplerWithTransaction(row)}.`,
                details: {
                    index: row.entryIndex,
                    sampler: row.label,
                    transactionName: transactionNameOf(row),
                    observedStatus: row.observedStatus,
                },
            });
            continue;
        }
        const transition = statusAnalysis.classifySampleReplay(row.entry || {}, {
            ...(row.sample || {}),
            label: row.label,
            code: row.observedStatus,
            responseCode: row.observedStatus,
            status: row.observedStatus,
            body: row.observedBody,
            responseBody: row.observedBody,
            finalUrl: row.finalUrl,
        });
        if (!transition || transition.matchesRecording || transition.folded) continue;
        if (isBodylessAuthRedirectReview(row, transition)) {
            const downstreamFailure = firstDownstreamFailure(rows, row.entryIndex);
            if (!downstreamFailure) {
                warnings.push({
                    category: 'bodyless_redirect_review',
                    reason: `${row.label} changed from recorded ${transition.recorded} to observed ${transition.observed}, but recording and replay bodies are both empty and no downstream request failed.`,
                    details: { index: row.entryIndex, sampler: row.label, transition },
                });
                continue;
            }
            if (isLogoutRow(downstreamFailure)) {
                warnings.push({
                    category: 'logout_downstream_ignored',
                    reason: `${row.label} changed from recorded ${transition.recorded} to observed ${transition.observed}, but the only downstream failure is logout transaction ${downstreamFailure.transactionName || downstreamFailure.label}.`,
                    details: { index: row.entryIndex, sampler: row.label, transition, downstreamFailure },
                });
                continue;
            }
            failures.push({
                index: row.entryIndex,
                sampler: row.label,
                reason: `${row.label} bodyless redirect mismatch has downstream failure at ${formatSamplerWithTransaction(downstreamFailure)}`,
                transition,
                downstreamFailure,
            });
            break;
        }
        if (/auth|session|login|redirect/i.test(`${transition.category || ''} ${transition.relevance || ''}`)) {
            // A status-family divergence is only a FAILURE when it actually
            // broke something: the sampler itself failed, or a downstream
            // request failed. A divergence on a request that PASSED with no
            // downstream failure is benign recording drift (aged recording vs
            // live app), not a green-gate failure — otherwise a working flow
            // (every request 2xx/3xx, business guard satisfied) is blocked by a
            // cosmetic 302→200 on the landing page or a third-party beacon.
            const downstreamFailure = firstDownstreamFailure(rows, row.entryIndex);
            if (!downstreamFailure && !rowFailed(row)) {
                warnings.push({
                    category: 'status_drift_review',
                    reason: `${row.label} diverged from recording (${transition.recorded}→${transition.observed}: ${transition.category}) but it passed and no downstream request failed — benign recording drift.`,
                    details: { index: row.entryIndex, sampler: row.label, transition },
                });
                continue;
            }
            failures.push({
                index: row.entryIndex,
                sampler: row.label,
                reason: `${row.label} diverged from recording: ${transition.category}`,
                transition,
                downstreamFailure,
            });
            break;
        }
    }
    if (!bodyComparable) {
        warnings.push({
            category: 'body_compare_unavailable',
            reason: 'No recorded and observed response bodies were available for recording comparison. Set run.captureResponseBodies="full" for body-level green verification.',
        });
    }
    return { failures, warnings, businessErrors };
}

function compileSoftFailurePatterns(extra = []) {
    const compiled = [...DEFAULT_SOFT_FAILURE_RES];
    for (const p of (Array.isArray(extra) ? extra : [])) {
        try {
            if (p instanceof RegExp) compiled.push(p);
            else if (typeof p === 'string' && p.trim()) compiled.push(new RegExp(p, 'i'));
        } catch { /* skip invalid operator-supplied pattern */ }
    }
    return compiled;
}

function isBodylessAuthRedirectReview(row = {}, transition = {}) {
    if (transition.category !== 'auth_redirect_bounce') return false;
    const recordedBody = String(row.recordedBody || '').trim();
    const observedBody = String(row.observedBody || '').trim();
    const recordedLen = Number(row.recordedBodyLength || recordedBody.length || 0);
    const observedLen = Number(row.observedBodyLength || observedBody.length || 0);
    return recordedLen === 0 && observedLen === 0 && !recordedBody && !observedBody;
}

function firstDownstreamFailure(rows = [], index) {
    const start = Number(index);
    for (const row of rows) {
        if (row.isTransaction) continue;
        if (!Number.isFinite(start) || Number(row.entryIndex) <= start) continue;
        const status = Number(row.observedStatus || row.sample && (row.sample.responseCode || row.sample.code || row.sample.status) || 0);
        if (row.success === false || status >= 400) {
            return {
                index: row.entryIndex,
                label: row.label,
                responseCode: status || '',
                transactionName: transactionNameOf(row),
            };
        }
    }
    return null;
}

function transactionNameOf(row = {}) {
    return row.transactionName ||
        row.transaction ||
        row.parentTransaction ||
        (row.sample && (row.sample.transactionName || row.sample.transaction || row.sample.parentTransaction)) ||
        '';
}

function isLogoutRow(row = {}) {
    return /logout|logoff|signout|sign-off/i.test(`${row.label || ''} ${transactionNameOf(row)}`);
}

function rowFailed(row = {}) {
    const status = Number(row.observedStatus || row.sample && (row.sample.responseCode || row.sample.code || row.sample.status) || 0);
    return row.success === false || (row.sample && row.sample.success === false) || status >= 400;
}

function formatSamplerWithTransaction(row = {}) {
    const label = row.label || row.sampler || 'later sampler';
    const transactionName = transactionNameOf(row);
    return transactionName ? `${label} in transaction ${transactionName}` : label;
}

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

module.exports = { evaluateFinalGreenGate, _internal: { evaluateEvidenceGate, isBodylessAuthRedirectReview, firstDownstreamFailure, compileSoftFailurePatterns, isLogoutRow, formatSamplerWithTransaction } };
