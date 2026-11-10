#!/usr/bin/env node
// Install the Jingjing dsh plugin into a dsh profile (default: "jingjing").
//   node scripts/install.mjs [--profile jingjing] [--port auto|8790] [--model-from auto|web]
// Non-interactive; prints INSTALL_OK on success, INSTALL_FAILED: <reason> and exit 1 otherwise.
// Never overwrites an existing profile patch (the user's model settings live there).
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { buildPatch } from './build-patch.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = 'jingjing-dsh';
// Rows that carry model choice and provider credentials-by-env; everything else stays behind.
const MODEL_ROWS = ['agent-default-model', 'llm-pi-ai', 'llm-deepseek'];

const DEFAULT_PORTS = [8790, 8795, 8796, 8797, 8798, 8799];

/** First port in the list nobody is listening on (the old relay keeps 8790). */
async function freePort(ports = DEFAULT_PORTS) {
    for (const port of ports) {
        const free = await new Promise(resolveProbe => {
            const server = createServer();
            server.once('error', () => resolveProbe(false));
            server.listen(port, '127.0.0.1', () => server.close(() => resolveProbe(true)));
        });
        if (free) return String(port);
    }
    throw new Error(`No free float-window port among ${ports.join(', ')}; pass --port`);
}

function parseArgs(argv) {
    const args = { profile: 'jingjing', port: 'auto', modelFrom: null };
    for (let index = 0; index < argv.length; index++) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (flag === '--profile') { args.profile = value; index++; }
        else if (flag === '--port') { args.port = value; index++; }
        else if (flag === '--model-from') { args.modelFrom = value; index++; }
        else throw new Error(`Unknown argument: ${flag}`);
    }
    if (!/^[A-Za-z0-9_-]+$/.test(args.profile) || ['desktop', 'web', 'headless', 'sdk', 'sdk-minimal', 'acp'].includes(args.profile)) {
        throw new Error(`Profile name not allowed: ${args.profile}`);
    }
    if (args.port !== 'auto' && !/^\d{2,5}$/.test(args.port)) throw new Error(`Invalid port: ${args.port}`);
    return args;
}

/** Split a top-level YAML patch list into row blocks and keep the ones whose id is wanted. */
export function pickRows(yaml, ids) {
    const blocks = [];
    let current = null;
    for (const line of yaml.replace(/\r\n?/g, '\n').split('\n')) {
        if (/^- /.test(line)) {
            current = { lines: [line], id: line.match(/^- id:\s*(\S+)/)?.[1] ?? null };
            blocks.push(current);
        } else if (current && (/^\s/.test(line) || line === '')) {
            current.lines.push(line);
        } else {
            current = null;
        }
    }
    return blocks.filter(block => ids.includes(block.id)).map(block => block.lines.join('\n').trimEnd()).join('\n');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
    const profileDir = join(dshHome, 'profiles', args.profile);
    // Re-installs keep the port the float window already uses, unless one is given.
    const previous = existsSync(join(ROOT, 'local.json')) ? JSON.parse(await readFile(join(ROOT, 'local.json'), 'utf8')) : null;
    if (args.port === 'auto') args.port = previous?.profile === args.profile && previous.port ? String(previous.port) : await freePort();
    if (args.modelFrom === 'auto') {
        args.modelFrom = existsSync(join(dshHome, 'profiles', 'web', 'cordis.patch.yml')) ? 'web' : null;
    }
    await mkdir(profileDir, { recursive: true });
    console.log(`float-window port: ${args.port}`);

    // 1. Patch with this checkout's absolute paths and the chosen float-window port.
    process.env.JINGJING_PET_PORT = args.port;
    const built = await buildPatch();
    console.log(`patch: ${built.out}`);

    // 2. Profile manifest: keep other dependencies, make sure the bundle is linked and listed.
    const manifestPath = join(profileDir, 'package.json');
    const manifest = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, 'utf8'))
        : { name: `dsh-profile-${args.profile}`, private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } };
    manifest.dependencies = { ...manifest.dependencies, [BUNDLE]: `link:${ROOT.replace(/\\/g, '/')}` };
    const bundles = manifest.dsh?.profile?.bundles ?? ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
    if (!bundles.includes(BUNDLE)) bundles.push(BUNDLE);
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(`profile: ${profileDir}`);

    // 3. User patch: only created when missing; optionally seeded with model rows of another profile.
    const patchPath = join(profileDir, 'cordis.patch.yml');
    if (existsSync(patchPath)) {
        console.log('profile patch exists, left unchanged (model settings kept)');
    } else {
        let body = '[]\n';
        if (args.modelFrom) {
            const source = join(dshHome, 'profiles', args.modelFrom, 'cordis.patch.yml');
            const rows = existsSync(source) ? pickRows(await readFile(source, 'utf8'), MODEL_ROWS) : '';
            if (rows) body = `${rows}\n`;
            console.log(rows ? `model settings copied from profile "${args.modelFrom}"` : `no model rows found in "${args.modelFrom}", using dsh defaults`);
        }
        await writeFile(patchPath, `# Your patch layer for this dsh profile.\n${body}`, 'utf8');
    }

    // 4. Link the bundle into the profile's node_modules.
    // dsh is a .cmd shim on Windows, so go through the shell; the profile name was validated above.
    const result = spawnSync(`dsh plugin --profile ${args.profile} install`, { stdio: 'inherit', shell: true });
    if (result.status !== 0) throw new Error('dsh plugin install failed; is dsh installed and on PATH?');

    await writeFile(join(ROOT, 'local.json'), `${JSON.stringify({ profile: args.profile, port: Number(args.port) }, null, 2)}\n`, 'utf8');
    console.log(`\nINSTALL_OK  start with: start.cmd   (or: dsh ${args.profile})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { console.error(`INSTALL_FAILED: ${error.message}`); process.exit(1); });
}
