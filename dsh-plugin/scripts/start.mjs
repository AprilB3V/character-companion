#!/usr/bin/env node
// Start the Jingjing dsh edition: dsh web (own console window) + the Electron float window.
import { existsSync, mkdirSync, readFileSync, openSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { buildOverlay, dumpConfig } from './overlay.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PET = resolve(ROOT, '../pet');
const local = existsSync(join(ROOT, 'local.json')) ? JSON.parse(readFileSync(join(ROOT, 'local.json'), 'utf8')) : null;
if (!local) {
    console.error('Not installed yet: run install.cmd first.');
    process.exit(1);
}
// Float window is skipped with --no-window or when the user turned it off at install time.
const noWindow = process.argv.includes('--no-window') || local.float === false;
const dataDir = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'CharacterCompanion', 'dsh');
mkdirSync(join(dataDir, 'logs'), { recursive: true });

// Token saving overlay (see overlay.mjs); --keep-mcp leaves the user's other MCP servers on.
let patchArg = '';
const dump = dumpConfig(local.profile);
if (dump) {
    const overlay = buildOverlay(dump, { keepMcp: process.argv.includes('--keep-mcp') });
    const overlayPath = join(ROOT, 'patches', 'session.overlay.yml');
    mkdirSync(dirname(overlayPath), { recursive: true });
    writeFileSync(overlayPath, overlay.text, 'utf8');
    patchArg = ` --patch "${overlayPath}"`;
    if (overlay.disabledMcp.length) console.log(`Other MCP servers off for this session: ${overlay.disabledMcp.join(', ')} (start.cmd --keep-mcp keeps them).`);
} else {
    console.warn('Could not read the composed dsh config; starting without the token-saving overlay.');
}

// dsh web prints its tokenized URL and opens the browser itself; keep it in a visible console.
// Pass the command line verbatim: Node would escape the title quotes as \" which cmd/start misparse ("cannot find dsh\").
spawn('cmd.exe', [`/d /c start "鲸鲸 dsh" cmd /d /k dsh ${local.profile}${patchArg}`], {
    detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true,
}).unref();
console.log(`dsh ${local.profile} starting in its own window (Web UI opens in your browser).`);

if (!noWindow) {
    const electron = join(PET, 'node_modules', 'electron', 'dist', 'electron.exe');
    if (!existsSync(electron)) {
        console.error(`Float window skipped: ${electron} not found (run the companion installer for pet/).`);
        process.exit(0);
    }
    const log = openSync(join(dataDir, 'logs', 'float-window.log'), 'a');
    spawn(electron, ['shell/main.cjs'], {
        cwd: PET, detached: true, stdio: ['ignore', log, log],
        env: {
            ...process.env,
            JINGJING_RELAY_ORIGIN: `http://127.0.0.1:${local.port}`,
            JINGJING_ELECTRON_DATA: join(dataDir, 'electron'),
            JINGJING_CAPTION_LINES: process.env.JINGJING_CAPTION_LINES || '4',
            JINGJING_CAPTION_CHARS: process.env.JINGJING_CAPTION_CHARS || '160',
        },
    }).unref();
    console.log(`Float window starting, connects to 127.0.0.1:${local.port} once dsh has loaded the plugin.`);
}
console.log('Then say "开始陪玩" in the dsh Web UI.');
