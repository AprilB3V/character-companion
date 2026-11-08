import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { findSensitive, loadLocalTerms } from './redact.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '0.1.0-rc.3';
const NODE_VERSION = '26.7.0';
const COHOST = 'vendor/CharacterLife-VideoCohost';
const CORE = COHOST + '/vendor/characterlife';
const require = createRequire(join(ROOT, COHOST, 'package.json'));
const ts = require('typescript');
const outputDir = join(ROOT, 'out', 'releases', VERSION + '-' + Date.now());
const packageName = 'CharacterCompanion-' + VERSION + '-win-x64';
const packageDir = join(outputDir, packageName);
const archiveDir = join(outputDir, 'sources');
const localTerms = loadLocalTerms(join(ROOT, 'tools/redact.local.json'));

function git(directory, args) {
    return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
}

async function extract(zipPath, destination) {
    // Environment variables keep arbitrary filesystem paths out of PowerShell source.
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Expand-Archive -LiteralPath $env:CC_ARCHIVE -DestinationPath $env:CC_DESTINATION'], {
        env: { ...process.env, CC_ARCHIVE: zipPath, CC_DESTINATION: destination },
    });
}

async function snapshot(relativePath, name, include) {
    const directory = join(ROOT, relativePath);
    const commit = git(directory, ['rev-parse', 'HEAD']);
    const zipPath = join(outputDir, name + '.zip');
    git(directory, ['archive', '--format=zip', '--output=' + zipPath, 'HEAD', '--', ...include]);
    const destination = join(archiveDir, name);
    await extract(zipPath, destination);
    return { commit, destination };
}

async function copy(relativePath, destination = relativePath) {
    await mkdir(dirname(join(packageDir, destination)), { recursive: true });
    await cp(join(archiveDir, 'companion', relativePath), join(packageDir, destination), { recursive: true });
}

async function compileCore(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            await compileCore(path);
        } else if (entry.name.endsWith('.ts')) {
            const source = await readFile(path, 'utf8');
            const result = ts.transpileModule(source, {
                fileName: path,
                compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023, rewriteRelativeImportExtensions: true },
            });
            await writeFile(path.slice(0, -3) + '.js', result.outputText);
        }
    }
}

async function inventory(directory, prefix = '') {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relativePath = prefix + entry.name;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...await inventory(path, relativePath + '/'));
        } else {
            const bytes = await readFile(path);
            const runtimeNotice = /(?:^|\/)(?:LICENSE|LICENSES\.chromium\.html)$/.test(relativePath);
            if (!runtimeNotice && /\.(?:json|m?js|cjs|ts|html|md|txt|ps1|cmd)$/i.test(entry.name)) {
                const findings = findSensitive(bytes.toString('utf8'), localTerms);
                if (findings.length) throw new Error('Sensitive content detected in ' + relativePath + ': ' + findings.map(finding => finding.rule).join(', '));
            }
            if (/(?:^|\/)(?:\.git|\.env[^/]*|local\.ps1|running-processes\.json)$/.test(relativePath)
                || /\.(?:db|sqlite|log)$/.test(relativePath)) throw new Error('Local state in package: ' + relativePath);
            files.push({ path: relativePath, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
        }
    }
    return files;
}

await mkdir(outputDir, { recursive: true });
console.log('Snapshotting committed application sources.');
const rootSnapshot = await snapshot('.', 'companion', ['pet', 'tools/portable.cmd', 'tools/portable-setup.ps1', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'docs/releases']);
const cohostSnapshot = await snapshot(COHOST, 'cohost', ['examples', 'package.json']);
const expectedCohost = git(ROOT, ['rev-parse', 'HEAD:' + COHOST]);
if (cohostSnapshot.commit !== expectedCohost) throw new Error('VideoCohost differs from the pinned revision.');
const coreSnapshot = await snapshot(CORE, 'core', ['src', 'examples/characters', 'package.json']);
const expectedCore = git(join(ROOT, COHOST), ['rev-parse', 'HEAD:vendor/characterlife']);
if (coreSnapshot.commit !== expectedCore) throw new Error('CharacterLife differs from the pinned revision.');

await mkdir(packageDir, { recursive: true });
const petFiles = (await readdir(join(archiveDir, 'companion', 'pet'))).filter(name => /\.(?:mjs|html)$/.test(name));
for (const name of petFiles) await copy('pet/' + name);
for (const path of ['pet/shell', 'pet/knowledge', 'pet/data/asr-glossary.json', 'pet/start.ps1', 'pet/stop.ps1', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'tools/portable-setup.ps1']) await copy(path);
await copy('tools/portable.cmd', 'CharacterCompanion.cmd');
await writeFile(join(packageDir, 'Configure.cmd'), '@echo off\r\ncall "%~dp0CharacterCompanion.cmd" setup\r\n');
await writeFile(join(packageDir, 'Stop.cmd'), '@echo off\r\ncall "%~dp0CharacterCompanion.cmd" stop\r\n');
await copy('docs/releases/quickstart.txt', 'READ-ME.txt');
await copy('docs/releases/characterlife-notice.txt', 'CHARACTERLIFE-NOTICE.txt');
await mkdir(join(packageDir, 'pet/assets/jingjing'), { recursive: true });
await copy('pet/assets/jingjing-avatar.png');
for (const name of await readdir(join(archiveDir, 'companion', 'pet/assets/jingjing'))) {
    if (name.endsWith('.png')) await copy('pet/assets/jingjing/' + name);
}
await cp(cohostSnapshot.destination, join(packageDir, COHOST), {
    recursive: true,
    filter: source => !/(?:^|[/\\])(?:replay|console-demo\.ts|review-cli\.ts)$/.test(source),
});
await cp(coreSnapshot.destination, join(packageDir, CORE), { recursive: true });
const dependencyDir = join(packageDir, COHOST, 'node_modules/characterlife');
await cp(coreSnapshot.destination, dependencyDir, { recursive: true });
await compileCore(join(dependencyDir, 'src'));
await compileCore(join(dependencyDir, 'examples'));
const corePackage = JSON.parse(await readFile(join(dependencyDir, 'package.json'), 'utf8'));
for (const key of Object.keys(corePackage.exports)) corePackage.exports[key] = corePackage.exports[key].replace(/\.ts$/, '.js');
await writeFile(join(dependencyDir, 'package.json'), JSON.stringify(corePackage, null, 4));
const petLock = JSON.parse(await readFile(join(rootSnapshot.destination, 'pet/package-lock.json'), 'utf8'));
const electronVersion = petLock.packages['node_modules/electron'].version;
const electronName = 'electron-v' + electronVersion + '-win32-x64.zip';
const electronBase = 'https://github.com/electron/electron/releases/download/v' + electronVersion + '/';
console.log('Verifying the pinned Electron runtime.');
const electronSums = await fetch(electronBase + 'SHASUMS256.txt', { signal: AbortSignal.timeout(60000) });
if (!electronSums.ok) throw new Error('Cannot fetch official Electron checksums.');
const electronSum = (await electronSums.text()).split('\n').find(line => line.trim().split(/\s+/).at(-1).replace(/^\*/, '') === electronName);
if (!electronSum) throw new Error('Missing checksum for Electron runtime.');
let electronZip;
for (const cacheDir of [
    process.env.ELECTRON_RELEASE_CACHE,
    join(ROOT, 'pet/electron-data/install-smoke/electron/Cache'),
    join(process.env.LOCALAPPDATA ?? '', 'electron/Cache'),
].filter(Boolean)) {
    for (const entry of await readdir(cacheDir, { withFileTypes: true }).catch(() => [])) {
        const candidate = join(cacheDir, entry.name, electronName);
        if (entry.isDirectory() && await stat(candidate).catch(() => null)) { electronZip = candidate; break; }
    }
    if (electronZip) break;
}
if (!electronZip) {
    electronZip = join(outputDir, electronName);
    const electronResponse = await fetch(electronBase + electronName, { signal: AbortSignal.timeout(600000) });
    if (!electronResponse.ok || !electronResponse.body) throw new Error('Cannot download Electron.');
    await pipeline(electronResponse.body, createWriteStream(electronZip));
}
if (createHash('sha256').update(await readFile(electronZip)).digest('hex') !== electronSum.split(/\s+/)[0]) throw new Error('Electron checksum mismatch.');
await extract(electronZip, join(packageDir, 'pet/node_modules/electron/dist'));

const nodeFileName = 'node-v' + NODE_VERSION + '-win-x64.zip';
console.log('Downloading and verifying the pinned Node.js runtime.');
const nodeBase = 'https://nodejs.org/dist/v' + NODE_VERSION + '/';
const sumsResponse = await fetch(nodeBase + 'SHASUMS256.txt', { signal: AbortSignal.timeout(60000) });
if (!sumsResponse.ok) throw new Error('Cannot fetch official Node checksums.');
const sumLine = (await sumsResponse.text()).split('\n').find(line => line.trim().split(/\s+/).at(-1).replace(/^\*/, '') === nodeFileName);
if (!sumLine) throw new Error('No checksum for pinned Node runtime.');
const nodeZip = process.env.NODE_RELEASE_ARCHIVE ?? join(outputDir, nodeFileName);
if (!process.env.NODE_RELEASE_ARCHIVE) {
    const response = await fetch(nodeBase + nodeFileName, { signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body) throw new Error('Cannot download pinned Node runtime.');
    await pipeline(response.body, createWriteStream(nodeZip));
}
if (createHash('sha256').update(await readFile(nodeZip)).digest('hex') !== sumLine.split(/\s+/)[0]) throw new Error('Node checksum mismatch.');
await mkdir(join(packageDir, 'runtime/node'), { recursive: true });
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '$archive = [IO.Compression.ZipFile]::OpenRead($env:CC_ARCHIVE)',
    'try { foreach ($name in @("node.exe", "LICENSE")) {',
    '$entry = $archive.GetEntry($env:CC_NODE_PREFIX + "/" + $name)',
    '[IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $env:CC_DESTINATION $name))',
    '} } finally { $archive.Dispose() }',
].join('\n')], {
    env: { ...process.env, CC_ARCHIVE: nodeZip, CC_DESTINATION: join(packageDir, 'runtime/node'), CC_NODE_PREFIX: 'node-v' + NODE_VERSION + '-win-x64' },
});
const manifest = {
    version: VERSION, platform: 'win-x64', nodeVersion: NODE_VERSION,
    electronVersion: (await readFile(join(packageDir, 'pet/node_modules/electron/dist/version'), 'utf8')).trim(),
    commits: { companion: rootSnapshot.commit, cohost: cohostSnapshot.commit, core: coreSnapshot.commit },
    runtimeArchives: { nodeSha256: sumLine.split(/\s+/)[0], electronSha256: electronSum.split(/\s+/)[0] },
    workshopId: '3835039157', files: await inventory(packageDir),
};
await writeFile(join(packageDir, 'release-manifest.json'), JSON.stringify(manifest, null, 4));
const zipPath = join(outputDir, packageName + '.zip');
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Compress-Archive -LiteralPath $env:CC_SOURCE -DestinationPath $env:CC_ZIP'], {
    env: { ...process.env, CC_SOURCE: packageDir, CC_ZIP: zipPath },
});
const checksum = createHash('sha256').update(await readFile(zipPath)).digest('hex');
await writeFile(join(outputDir, 'SHA256SUMS.txt'), checksum + '  ' + packageName + '.zip\n');
console.log(JSON.stringify({ outputDir, zipPath, bytes: (await stat(zipPath)).size, sha256: checksum }, null, 4));
