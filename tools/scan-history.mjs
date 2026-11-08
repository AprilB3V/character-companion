import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSensitive, loadLocalTerms } from './redact.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const terms = loadLocalTerms(join(ROOT, 'tools/redact.local.json'));
const objects = execFileSync('git', ['rev-list', '--objects', '--all'], { cwd: ROOT, encoding: 'utf8' })
    .trim().split('\n').map(line => {
        const separator = line.indexOf(' ');
        return { sha: line.slice(0, separator), path: line.slice(separator + 1) };
    }).filter(object => /\.(?:md|txt|json|mjs|cjs|js|ts|cs|ps1|cmd|xml|html)$/.test(object.path)
        && object.path !== 'tools/redact.mjs');
const bytes = execFileSync('git', ['cat-file', '--batch'], {
    cwd: ROOT, input: objects.map(object => object.sha).join('\n') + '\n', maxBuffer: 128 * 1024 * 1024,
});
let offset = 0;
let count = 0;
for (const object of objects) {
    const headerEnd = bytes.indexOf(10, offset);
    const header = bytes.subarray(offset, headerEnd).toString('utf8').split(' ');
    if (header[1] !== 'blob') throw new Error('Expected text blob for ' + object.path);
    const size = Number(header[2]);
    const source = bytes.subarray(headerEnd + 1, headerEnd + 1 + size).toString('utf8');
    offset = headerEnd + 1 + size + 1;
    for (const finding of findSensitive(source, terms)) {
        // Report location and rule without reproducing the potentially sensitive value.
        console.log(JSON.stringify({ path: object.path, blob: object.sha, rule: finding.rule }));
        count++;
    }
}
console.log(JSON.stringify({ textBlobs: objects.length, findings: count }));
process.exitCode = count ? 1 : 0;
