const fs = require('fs');
const x = fs.readFileSync('output/Create_task_Nag1/iteration_1/results.jtl', 'utf8');
console.log('size:', x.length);
console.log('starts with:', x.slice(0, 300));
console.log('<sample tags:', (x.match(/<sample\b/g) || []).length);
console.log('<httpSample tags:', (x.match(/<httpSample\b/g) || []).length);
console.log('<assertionResult tags:', (x.match(/<assertionResult\b/g) || []).length);
console.log('<failureMessage tags:', (x.match(/<failureMessage\b/g) || []).length);
const allSamples = [...x.matchAll(/<(?:http)?[Ss]ample\s+[^>]*?\blb="([^"]+)"[^>]*?\bs="([^"]+)"[^>]*?\brc="([^"]+)"[^>]*?\brm="([^"]*)"/g)];
console.log('parsed samples (with lb/s/rc):', allSamples.length);
console.log('first 5 samples (lb, success, code, message):');
console.log(allSamples.slice(0, 5).map(m => m.slice(1)));
const failures = allSamples.filter(m => m[2] === 'false');
console.log('total failures:', failures.length, 'of', allSamples.length);
console.log('first 5 failures:');
console.log(failures.slice(0, 5).map(m => m.slice(1)));
// Look at failure messages
const fms = [...x.matchAll(/<failureMessage>([^<]+)<\/failureMessage>/g)].slice(0, 5).map(m => m[1]);
console.log('first 5 failure messages:'); fms.forEach(s => console.log('  -', s));
