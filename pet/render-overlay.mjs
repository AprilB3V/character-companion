import http from 'node:http';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { servePresentation } from './presentation-http.mjs';
import { normalizeConfig, parseReplay } from './presentation-model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export function findBrowser() {
    if (process.env.JINGJING_CHROMIUM) return process.env.JINGJING_CHROMIUM;
    for (const executable of [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ]) if (existsSync(executable)) return executable;
    const cache = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData/Local'), 'ms-playwright');
    if (existsSync(cache)) {
        for (const directory of readdirSync(cache).filter(name => name.startsWith('chromium-')).sort().reverse()) {
            const executable = join(cache, directory, 'chrome-win', 'chrome.exe');
            if (existsSync(executable)) return executable;
        }
    }
    throw new Error('Chromium not found. Set JINGJING_CHROMIUM to a Chrome/Edge executable.');
}

export async function createPresentationServer() {
    const server = http.createServer(async (request, response) => {
        try {
            if (await servePresentation(request, response)) return;
            response.writeHead(404); response.end();
        } catch {
            response.writeHead(500); response.end('Presentation asset unavailable');
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

async function run(executable, args) {
    await new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        let errors = '';
        child.stderr.on('data', data => { errors = (errors + data).slice(-6000); });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Encoder exited ${code}: ${errors}`)));
    });
}

export async function renderOverlay({ logPath, outDir, fps = 30, duration, config = {}, ffmpeg }) {
    fps = Number(fps);
    if (!Number.isFinite(fps) || fps < 1 || fps > 120) throw new Error('fps must be between 1 and 120');
    const logText = await readFile(logPath, 'utf8');
    const events = parseReplay(logText);
    if (!events.length) throw new Error('The event log is empty');
    config = normalizeConfig(config);
    const server = await createPresentationServer();
    let browser;
    try {
        browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
        const page = await browser.newPage({ viewport: { width: config.width, height: config.height }, deviceScaleFactor: 1 });
        await page.goto(`${server.url}/presentation?export=1`);
        await page.waitForFunction(() => window.presentationReady);
        await page.evaluate(async ({ config, logText }) => {
            await window.jingjingPresentation.configure(config);
            window.jingjingPresentation.loadReplay(logText);
        }, { config, logText });
        if (duration === undefined) {
            // Drain every caption after the last event, even if the log stops mid-display.
            duration = await page.evaluate(() => window.jingjingPresentation.replayEnd / 1000);
        }
        duration = Number(duration);
        if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) throw new Error('duration must be between 0 and 3600 seconds');
        // Never overwrite a prior render or source directory.
        await mkdir(resolve(outDir), { recursive: false });
        const framesDir = join(outDir, 'frames');
        await mkdir(framesDir);
        await writeFile(join(outDir, 'events.jsonl'), logText, 'utf8');
        await writeFile(join(outDir, 'config.json'), JSON.stringify(config, null, 4), 'utf8');
        const dialogue = events.filter(event => event.type === 'overlay' && event.state === 'speaking' && event.text).map(event => `${event.time}ms\t${event.text}`).join('\n');
        await writeFile(join(outDir, 'dialogue.txt'), dialogue, 'utf8');
        const totalFrames = Math.ceil(duration * fps);
        for (let index = 0; index < totalFrames; index++) {
            await page.evaluate(time => window.jingjingPresentation.renderAt(time), index * 1000 / fps);
            await page.screenshot({ path: join(framesDir, `${String(index).padStart(6, '0')}.png`), omitBackground: true, animations: 'disabled' });
            if (index % Math.max(1, Math.round(fps * 2)) === 0) process.stdout.write(`Rendered ${index + 1}/${totalFrames}\n`);
        }
        if (ffmpeg) {
            await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-n', '-framerate', String(fps), '-i', join(framesDir, '%06d.png'), '-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', join(outDir, 'overlay.mov')]);
        }
        const manifest = { schemaVersion: 1, logSource: resolve(logPath), fps, duration: totalFrames / fps, totalFrames, width: config.width, height: config.height, frames: 'frames/%06d.png', video: ffmpeg ? 'overlay.mov' : null, alpha: 'RGBA PNG; optional ProRes 4444', sound: 'Preview tones are not exported', editable: ['events.jsonl', 'config.json', 'dialogue.txt'], config };
        await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 4), 'utf8');
        await writeFile(join(outDir, 'review.md'), '# 离线浮窗渲染\n\n- PNG 序列与可选 ProRes 4444 MOV 使用透明背景；导出后应检查 alpha。\n- events.jsonl、config.json、dialogue.txt 可编辑，改字后重新渲染浮窗层即可。游戏底片无需重渲染。\n- 提示音不导出；未合成人声。\n- 剪映导入和实际叠加：未验证。\n- 帧序列时间来自事件日志，不是旁白录音对齐字幕。\n', 'utf8');
        return manifest;
    } finally {
        await browser?.close();
        await server.close();
    }
}

async function main() {
    const args = process.argv.slice(2);
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
        const key = args[index];
        if (!['--log', '--out', '--fps', '--duration', '--config', '--ffmpeg'].includes(key) || !args[index + 1]) throw new Error('Usage: node render-overlay.mjs --log events.jsonl --out NEW_DIRECTORY [--fps 30] [--duration SECONDS] [--config config.json] [--ffmpeg PATH]');
        options[key.slice(2)] = args[index + 1];
    }
    if (!options.log || !options.out) throw new Error('--log and --out are required');
    await access(dirname(resolve(options.out)));
    const manifest = await renderOverlay({ logPath: resolve(options.log), outDir: resolve(options.out), fps: options.fps ?? 30, duration: options.duration, config: options.config ? JSON.parse(await readFile(options.config, 'utf8')) : {}, ffmpeg: options.ffmpeg });
    process.stdout.write(`Done: ${manifest.totalFrames} frames, ${manifest.duration.toFixed(2)}s\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
