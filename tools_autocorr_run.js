'use strict';
const path = require('path');
const fs = require('fs');
const APP = 'D:/Users/nagendra.bpuchala/Documents/perfscript-local';
const E = require(path.join(APP, 'src/engine'));
const { identifyDynamics, correlateJmx } = require(path.join(APP, 'src/auto-correlate'));

const e1 = E.jtlParser.parseJtlBuffer(fs.readFileSync(APP + '/input/task__run1.recording.xml')).entries;
const e2 = E.jtlParser.parseJtlBuffer(fs.readFileSync(APP + '/input/task__run2.recording.xml')).entries;
const jmx = fs.readFileSync(APP + '/input/task__run1.jmx', 'utf8');

const dynamics = identifyDynamics(e1, e2);
console.log('dynamics identified (variance):', dynamics.length);

const { xml, applied, synthesize } = correlateJmx(jmx, dynamics, e1);
fs.mkdirSync(APP + '/output', { recursive: true });
const outPath = APP + '/output/task.correlated.jmx';
fs.writeFileSync(outPath, xml);

console.log('\nEXTRACTORS auto-emitted:', applied.length);
const seen = new Set();
for (const a of applied) { const k = a.var + a.kind; if (seen.has(k)) continue; seen.add(k); console.log(`  ${a.var}  [${a.kind}]  <- ${a.producer}`); }
console.log('\nclient-generated (need synthesis, no server producer):', synthesize.length);
[...new Set(synthesize.map(s => s.name))].slice(0, 12).forEach(n => console.log('  ' + n));
console.log('\nwrote', outPath);
console.log('sanity — key correlations present in output JMX:');
console.log('  token CSS extractor:', /Extract token \(CSS\)|input\[name="token"\]/.test(xml));
console.log('  ${stgapp_webpt_com_sess} used:', /\$\{stgapp_webpt_com_sess\}/.test(xml));
console.log('  any ${...} substitutions:', (xml.match(/\$\{[A-Za-z]/g) || []).length);
