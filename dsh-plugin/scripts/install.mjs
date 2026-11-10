#!/usr/bin/env node
// Install the Jingjing dsh plugin into a dsh profile (default: "jingjing").
//   node scripts/install.mjs [--profile jingjing] [--port auto|8790] [--model-from auto|web]
//     [--persona jingjing|own] [--own-persona-file <path> | --own-persona-from <profile>|global|none]
//     [--player-name <name>] [--chatty quiet|normal|lively] [--float on|off]
// Non-interactive; prints INSTALL_OK on success, INSTALL_FAILED: <reason> and exit 1 otherwise.
// Setup choices persist in local.json; flags left out keep the previous install's choices.
// Never overwrites an existing profile patch (the user's model settings live there).
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { buildPatch, DEFAULT_SETTINGS, OWN_PERSONA_PATH } from './build-patch.mjs';

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

const VALUE_FLAGS = {
    '--profile': 'profile', '--port': 'port', '--model-from': 'modelFrom', '--persona': 'persona',
    '--own-persona-file': 'ownPersonaFile', '--own-persona-from': 'ownPersonaFrom',
    '--player-name': 'playerName', '--chatty': 'chatty', '--float': 'float',
};

export function parseArgs(argv) {
    const args = { profile: 'jingjing', port: 'auto', modelFrom: null };
    for (let index = 0; index < argv.length; index++) {
        const key = VALUE_FLAGS[argv[index]];
        if (!key) throw new Error(`Unknown argument: ${argv[index]}`);
        if (index + 1 >= argv.length) throw new Error(`Missing value for ${argv[index]}`);
        args[key] = argv[++index];
    }
    if (!/^[A-Za-z0-9_-]+$/.test(args.profile) || ['desktop', 'web', 'headless', 'sdk', 'sdk-minimal', 'acp'].includes(args.profile)) {
        throw new Error(`Profile name not allowed: ${args.profile}`);
    }
    if (args.port !== 'auto' && !/^\d{2,5}$/.test(args.port)) throw new Error(`Invalid port: ${args.port}`);
    if (args.persona !== undefined && !['jingjing', 'own'].includes(args.persona)) throw new Error('--persona must be jingjing or own');
    if (args.chatty !== undefined && !['quiet', 'normal', 'lively'].includes(args.chatty)) throw new Error('--chatty must be quiet, normal or lively');
    if (args.float !== undefined && !['on', 'off'].includes(args.float)) throw new Error('--float must be on or off');
    if (args.playerName !== undefined && (args.playerName.length > 20 || /[{}\r\n"]/.test(args.playerName))) {
        throw new Error('--player-name must be at most 20 characters without braces, quotes or line breaks');
    }
    if (args.ownPersonaFile !== undefined && args.ownPersonaFrom !== undefined) throw new Error('Use only one of --own-persona-file and --own-persona-from');
    if (args.ownPersonaFrom !== undefined && !/^[A-Za-z0-9_-]+$/.test(args.ownPersonaFrom)) throw new Error(`Invalid --own-persona-from: ${args.ownPersonaFrom}`);
    if ((args.ownPersonaFile !== undefined || args.ownPersonaFrom !== undefined) && args.persona === 'jingjing') {
        throw new Error('--own-persona-* only applies with --persona own');
    }
    return args;
}

/** Previous choices + this run's flags. */
export function mergeSettings(previous, args) {
    const settings = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS)) if (previous?.[key] !== undefined) settings[key] = previous[key];
    if (args.persona !== undefined) settings.persona = args.persona;
    if (args.ownPersonaFile !== undefined || args.ownPersonaFrom !== undefined) settings.persona = 'own';
    if (args.playerName !== undefined) settings.playerName = args.playerName.trim();
    if (args.chatty !== undefined) settings.chatty = args.chatty;
    if (args.float !== undefined) settings.float = args.float === 'on';
    return settings;
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

/** Read a YAML scalar that starts with `first` (text after the key) and may continue on more-indented lines. */
function readScalar(first, rest, keyIndent) {
    const more = [];
    for (const line of rest) {
        if (line.trim() === '' || line.match(/^\s*/)[0].length > keyIndent) more.push(line);
        else break;
    }
    while (more.length && more[more.length - 1].trim() === '') more.pop();
    const block = first.match(/^([|>])[+-]?\d?\s*(#.*)?$/);
    if (block) {
        const indent = Math.min(...more.filter(line => line.trim()).map(line => line.match(/^\s*/)[0].length));
        const lines = more.map(line => line.slice(indent));
        if (block[1] === '|') return lines.join('\n');
        return lines.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ');
    }
    // Flow scalars: a single line break folds to a space, an empty line stands for a newline.
    const folded = [first, ...more.map(line => line.trim())].join('\n')
        .replace(/\n\n/g, '\u0000').replace(/\n/g, ' ').replace(/\u0000/g, '\n');
    if (folded.startsWith('"')) return JSON.parse(folded.slice(0, folded.lastIndexOf('"') + 1).replace(/\t/g, '\\t').replace(/\n/g, '\\n'));
    if (folded.startsWith("'")) return folded.slice(1, folded.lastIndexOf("'")).replace(/''/g, "'");
    return folded.replace(/\s+#.*$/, '').trim();
}

/** personaPrefix of the system-prompt row in a dsh patch file, or '' when that row sets none. */
export function extractPersonaPrefix(yaml) {
    const lines = pickRows(yaml, ['system-prompt']).split('\n');
    const index = lines.findIndex(line => /^\s*personaPrefix:/.test(line));
    if (index < 0) return '';
    const match = lines[index].match(/^(\s*)personaPrefix:\s*(.*)$/);
    return readScalar(match[2], lines.slice(index + 1), match[1].length).trim();
}

/** Store (or clear) the user's own persona text as persona.own.md; returns a log line. */
async function saveOwnPersona(args, dshHome) {
    let text;
    let origin;
    if (args.ownPersonaFile !== undefined) {
        const path = resolve(args.ownPersonaFile);
        if (!existsSync(path)) throw new Error(`Persona file not found: ${path}`);
        text = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');
        if (/\{\{|\}\}/.test(text)) throw new Error('Persona file contains {{ }}; dsh would parse it as a template variable. Remove those and retry.');
        origin = `file ${path}`;
    } else if (args.ownPersonaFrom === 'none') {
        await rm(OWN_PERSONA_PATH, { force: true });
        return 'own persona: none copied (identity comes from your AGENTS.md or the model default)';
    } else {
        const source = args.ownPersonaFrom === 'global'
            ? join(dshHome, 'cordis.patch.yml')
            : join(dshHome, 'profiles', args.ownPersonaFrom, 'cordis.patch.yml');
        if (!existsSync(source)) throw new Error(`No patch file for "${args.ownPersonaFrom}": ${source}`);
        text = extractPersonaPrefix(await readFile(source, 'utf8'));
        if (!text) throw new Error(`"${args.ownPersonaFrom}" sets no system-prompt personaPrefix; give the persona as a file with --own-persona-file instead`);
        origin = `profile "${args.ownPersonaFrom}"`;
    }
    if (!text.trim()) throw new Error('Own persona text is empty');
    await writeFile(OWN_PERSONA_PATH, `${text.trim()}\n`, 'utf8');
    return `own persona: copied from ${origin} (${text.trim().length} chars) to persona.own.md`;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
    const profileDir = join(dshHome, 'profiles', args.profile);
    // Re-installs keep the port and setup choices of the previous install, unless flags say otherwise.
    const previous = existsSync(join(ROOT, 'local.json')) ? JSON.parse(await readFile(join(ROOT, 'local.json'), 'utf8')) : null;
    if (args.port === 'auto') args.port = previous?.profile === args.profile && previous.port ? String(previous.port) : await freePort();
    if (args.modelFrom === 'auto') {
        args.modelFrom = existsSync(join(dshHome, 'profiles', 'web', 'cordis.patch.yml')) ? 'web' : null;
    }
    await mkdir(profileDir, { recursive: true });
    console.log(`float-window port: ${args.port}`);

    // 1. Setup choices, then the patch with this checkout's absolute paths and the chosen port.
    const settings = mergeSettings(previous, args);
    if (args.ownPersonaFile !== undefined || args.ownPersonaFrom !== undefined) console.log(await saveOwnPersona(args, dshHome));
    if (settings.persona === 'own' && !existsSync(OWN_PERSONA_PATH)) console.log('own persona: no text stored, identity comes from your AGENTS.md or the model default');
    console.log(`settings: persona=${settings.persona} chatty=${settings.chatty} float=${settings.float ? 'on' : 'off'}${settings.playerName ? ` player-name=${settings.playerName}` : ''}`);
    process.env.JINGJING_PET_PORT = args.port;
    const built = await buildPatch(settings);
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

    await writeFile(join(ROOT, 'local.json'), `${JSON.stringify({ profile: args.profile, port: Number(args.port), ...settings }, null, 2)}\n`, 'utf8');
    console.log(`\nINSTALL_OK  start with: start.cmd   (or: dsh ${args.profile})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { console.error(`INSTALL_FAILED: ${error.message}`); process.exit(1); });
}
