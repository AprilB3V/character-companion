#!/usr/bin/env node
// Start the Jingjing dsh edition: dsh web (own console window) + the Electron float window.
import { existsSync, mkdirSync, readFileSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

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

// dsh web prints its tokenized URL and opens the browser itself; keep it in a visible console.
spawn('cmd.exe', ['/d', '/c', 'start', `"鲸鲸 dsh"`, 'cmd', '/d', '/k', 'dsh', local.profile], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
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
