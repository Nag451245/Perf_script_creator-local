'use strict';
/**
 * live-probe.js — hypothesis-testing against the LIVE system, the way a senior
 * engineer curls an endpoint before blaming the script.
 *
 * Strictly side-effect safe: GET only, no cookies carried, bounded redirects
 * and timeouts. First use case: the FRESHNESS probe — fetch the flow's landing
 * page live and compare the values the page embeds (inline-JS challenge pairs,
 * hidden inputs) against the recording. A value that differs is deployment-
 * rotated: replaying the recorded literal will fail SILENTLY, so the probe
 * says so before a single JMeter run is spent — and confirms which of those