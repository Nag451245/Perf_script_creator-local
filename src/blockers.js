'use strict';
/**
 * blockers.js — when the agent is beaten, say EXACTLY what a human must
 * provide, instead of a generic "needs attention".
 *
 * A senior engineer's terminal state is never "it failed"; it is "give me a
 * test account without MFA", "the env is returning 500s to bare requests —
 * fix staging first", "I need a second recording". Each rule here is
 * evidence-gated: it only fires when the recording/run actually shows the
 * condition, and each blocker carries a one-line ask a human can act on
 * without reading the whole report.
 */

const LOGIN_LABEL_RE = /login|identifier|password|authenticate|signin|sign-in/i;
const MFA_RE = /\b(otp|totp|mfa|2fa|webauthn|authenticator)\b/i;

/**
 * @returns {Array<{id, blocker, ask, evidence}>}
 */
function deriveBlockers({
    result = {},
    runCfg = {},
    entries = [],
    hasSecondRecording = true,
    ghostsRefused = 0,
    uploadFiles = null,
    gate0 = null,
} = {}) {
    const blockers = [];
    const reqs = (result.samples || []).filter(s => !s.isTransaction);
    const failing = reqs.filter(s => s.success === false);
    const codeOf = (s) => String(s.responseCode || s.code || '');
    const forensic = result.failureForensics || null;

    // GATE 0 first: if the script would SEND wrong/literal values, that is the
    // root cause — a DATA defect, fixable, and it must lead. It also means any
    // auth/session failure downstream is a SYMPTOM, so we suppress the
    // "provide a browser session / non-MFA account" speculation that would
    // otherwise bury the real one-line fix (this is exactly what mis-triaged
    // the Scheduled Visits credential corruption as an irreducible auth wall).
    const gate0Defects = (gate0 && Array.isArray(gate0.findings) ? gate0.findings : []).filter(f => f && f.dataDefect);
    const suppressAuthSpeculation = gate0Defects.some(f =>
        f.kind === 'csv-column-shift' ||
        /user|pass|token|state|nonce|csrf|auth|cred|session/i.test(String(f.variable || '')));
    for (const f of gate0Defects.slice(0, 3)) {
        blockers.push({
            id: `gate0-${f.kind}`,
            blocker: `The script would send an incorrect value: ${f.message}`,
            ask: f.fix || 'Fix the data source so the request sends the intended value, then rerun.',
            evidence: [f.variable ? `\${${f.variable}}` : null, f.file ? `${f.file} row ${f.row}` : null, f.evidence].filter(Boolean).join(' · ') || f.kind,
        });
    }

    if (forensic && forensic.rootCause) {
        const root = forensic.rootCause;
        const recorded = root.recordedStatus ?? root.expected;
        const observed = root.observedStatus ?? root.observed;
        const missingCookies = forensic.authSession && forensic.authSession.missingSessionCookies || [];
        const downstreamGraphql = forensic.graphql && forensic.graphql.downstreamSymptoms || [];
        const authEvidence = forensic.redirects && forensic.redirects.interactiveAuthWall ||
            missingCookies.length ||
            /auth|session|cookie|csrf|token/i.test(root.category || '') ||
            /^(401|403)$/.test(String(observed || ''));
        if (authEvidence && !suppressAuthSpeculation) {
            blockers.push({
                id: 'auth-session-forensics',
                blocker: `${root.sampler} diverged first: recorded ${recorded}, observed ${observed}`,
                ask: 'Provide a test-friendly login path: a non-MFA account, browser-captured session fallback, or API token for this environment. Do not keep guessing extractors against downstream API/GraphQL symptoms until this auth/session producer is proven live.',
                evidence: [
                    missingCookies.length ? `missing session cookie(s): ${missingCookies.join(', ')}` : null,
                    forensic.redirects && forensic.redirects.interactiveAuthWall ? 'interactive auth redirect wall detected' : null,
                    downstreamGraphql.length ? `${downstreamGraphql.length} GraphQL downstream symptom(s)` : null,
                ].filter(Boolean).join('; ') || forensic.summary || root.category || '',
            });
        }
        if (Number(observed) >= 500) {
            blockers.push({
                id: 'environment-forensics',
                blocker: `${root.sampler} diverged first: recorded ${recorded}, observed ${observed}`,
                ask: 'Validate staging manually for this exact endpoint before script repair. If a logged-in browser or curl gets the same 5xx, fix the environment first.',
                evidence: forensic.summary || `category=${root.category || 'server_error'}`,
            });
        }
    }

    // 1. Login rejected and we have no operator credentials to try.
    const authFail = failing.find(s => LOGIN_LABEL_RE.test(String(s.label || s.name || '')) && /^(401|403)$/.test(codeOf(s)));
    if (authFail) {
        const noCreds = !(runCfg.credentials && runCfg.credentials.username);
        blockers.push({
            id: 'credentials',
            blocker: `${authFail.label || authFail.name} was rejected (${codeOf(authFail)})`,
            ask: noCreds
                ? 'Provide a valid test account in perfscript.config.json → run.credentials (username/password). The recorded account may be rotated or locked.'
                : 'The configured run.credentials were rejected — confirm the account is still valid on this environment.',
            evidence: `label="${authFail.label || authFail.name}" code=${codeOf(authFail)}`,
        });
    }

    // 2. The recorded flow contains an MFA/OTP step — unreplayable by design.
    const mfaEntry = entries.find(e => {
        const url = (e.request && e.request.url) || '';
        const body = (e.request && e.request.postData && e.request.postData.text) || '';
        const params = ((e.request && e.request.postData && e.request.postData.params) || []).map(p => p.name).join(' ');
        return MFA_RE.test(url) || MFA_RE.test(params) || /name=["']?(otp|totp|mfa|code_challenge_method_mfa)/i.test(body);
    });
    if (mfaEntry && failing.length && !suppressAuthSpeculation) {
        blockers.push({
            id: 'mfa',
            blocker: 'the recorded flow contains an MFA/OTP step — single-use codes cannot be replayed or synthesized',
            ask: 'Use a test account with MFA disabled for this environment, or provide a TOTP seed the script may use.',
            evidence: (mfaEntry.request && mfaEntry.request.url || '').slice(0, 120),
        });
    }

    // 3. Environment health: a request that succeeded when recorded now 5xxs.
    const envFail = failing.find(s => /^5\d\d$/.test(codeOf(s)));
    if (envFail) {
        blockers.push({
            id: 'environment',
            blocker: `${envFail.label || envFail.name} returns ${codeOf(envFail)} — it succeeded when recorded`,
            ask: `Manually hit this endpoint once (browser/curl) to separate "environment is unhealthy" from "script is missing session state". If a logged-in browser also fails, fix staging before iterating on the script.`,
            evidence: `label="${envFail.label || envFail.name}" code=${codeOf(envFail)}`,
        });
    }

    // 4. Unresolved dynamics with only ONE recording — variance is the tool.
    if (!hasSecondRecording && failing.length) {
        blockers.push({
            id: 'second-recording',
            blocker: 'failures remain and only a single recording was provided — dynamic-vs-static is a guess without variance',
            ask: 'Record the SAME flow a second time and drop it in input/ as <flow>__run2 (JMX+recording or HAR). Two recordings turn correlation guesses into facts.',
            evidence: `${failing.length} failing sampler(s), single-recording mode`,
        });
    }

    // 5. Client-minted values that need a signing secret never present in traffic.
    if (ghostsRefused > 0) {
        blockers.push({
            id: 'signing-secret',
            blocker: `${ghostsRefused} client-minted value(s) look signed (HMAC/JWT-like) — the signing key never appears in traffic`,
            ask: 'Ask the dev team for the signing logic/key for these values, or confirm their consumers are safe to disable. See the ghosts section of the reasoning report for names.',
            evidence: `ghostsRefused=${ghostsRefused}`,
        });
    }

    const missingUploads = uploadFiles && Array.isArray(uploadFiles.missing) ? uploadFiles.missing : [];
    if (missingUploads.length) {
        const names = [...new Set(missingUploads.map(u => u.fileName).filter(Boolean))];
        const ambiguous = missingUploads.filter(u => u.reason === 'ambiguous-compatible-file' && Array.isArray(u.candidateNames) && u.candidateNames.length);
        const candidateNames = [...new Set(ambiguous.flatMap(u => u.candidateNames).filter(Boolean))];
        blockers.push({
            id: 'upload-file',
            blocker: ambiguous.length
                ? `${names.length} upload file reference(s) have multiple compatible local candidates`
                : `${names.length} upload file(s) referenced by the recording were not found locally`,
            ask: ambiguous.length
                ? `Choose the correct file for ${names.slice(0, 5).join(', ')} from these candidates: ${candidateNames.slice(0, 8).join(', ')}. Keep only the intended file in input/, bin/, or configured upload dirs and rerun.`
                : `Place ${names.slice(0, 5).join(', ')} in input/, bin/, or configured upload dirs and rerun. JMeter cannot replay multipart upload steps without the original file bytes.`,
            evidence: missingUploads.slice(0, 3).map(u =>
                `${u.samplerLabel || 'upload sampler'} field=${u.fieldName || 'file'} file=${u.fileName}`
            ).join('; '),
        });
    }

    return blockers;
}

function renderBlockersMarkdown(name, blockers) {
    const lines = [`# ${name} — blocked: what a human must provide`, ''];
    if (!blockers.length) { lines.push('No human-input blockers identified.'); return lines.join('\n'); }
    blockers.forEach((b, i) => {
        lines.push(`## ${i + 1}. ${b.blocker}`);
        lines.push('');
        lines.push(`**Ask:** ${b.ask}`);
        lines.push('');
        lines.push(`Evidence: \`${b.evidence}\``);
        lines.push('');
    });
    return lines.join('\n');
}

module.exports = { deriveBlockers, renderBlockersMarkdown };
