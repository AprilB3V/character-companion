// Local configuration page for the companion: model/API settings, connection test, start/stop.
// Usage: node config-app.mjs [--ensure] [--no-open] [--port N] [--config PATH] [start args...]
//   --ensure  exit 0 at once when the model configuration is ready (or -Demo is passed);
//             otherwise open the page and exit 3 after it closes.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile, copyFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    DEFAULT_BASE_URL, DEFAULT_MODEL, diagnose, maskSecret, normalizeModelInput,
    renderEnv, statusFromText, validateModelInput,
} from './config-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const INSTALL_DIR = process.env.CHARACTER_COMPANION_HOME
    ?? join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Local'), 'CharacterCompanion');
const configArg = process.argv.indexOf('--config');
const CONFIG_PATH = configArg > 0 ? resolve(process.argv[configArg + 1])
    : process.env.CHARACTER_COMPANION_CONFIG ?? join(INSTALL_DIR, 'config', '.env.video.local');
const LOG_DIR = join(INSTALL_DIR, 'logs');
const IDLE_EXIT_MS = 180_000;
const FIRST_LOAD_MS = 10 * 60_000;
const TEST_TIMEOUT_MS = 25_000;
const MAX_BODY = 16 * 1024;

const args = process.argv.slice(2);
const ensureMode = args.includes('--ensure');
const noOpen = args.includes('--no-open');
const portArg = args.indexOf('--port');
const fixedPort = portArg >= 0 ? Number(args[portArg + 1]) : 0;

async function readConfig() {
    try {
        return { exists: true, text: await readFile(CONFIG_PATH, 'utf8') };
    } catch (error) {
        if (error.code === 'ENOENT') return { exists: false, text: '' };
        throw error;
    }
}

async function writeConfig(text) {
    await mkdir(dirname(CONFIG_PATH), { recursive: true });
    if (existsSync(CONFIG_PATH)) await copyFile(CONFIG_PATH, `${CONFIG_PATH}.bak`);
    const temp = `${CONFIG_PATH}.${randomBytes(6).toString('hex')}.tmp`;
    try {
        await writeFile(temp, text, { encoding: 'utf8' });
        await rename(temp, CONFIG_PATH);
    } finally {
        await rm(temp, { force: true });
    }
}

if (ensureMode) {
    if (args.some(arg => /^-demo$/i.test(arg))) process.exit(0);
    const current = await readConfig();
    if (current.exists && statusFromText(current.text).ready) process.exit(0);
}

const sessionToken = randomBytes(24).toString('hex');
let lastSeen = Date.now();
let pageLoaded = false;
let busy = false;

function tokenOk(req) {
    const given = Buffer.from(String(req.headers['x-config-token'] ?? ''));
    const expected = Buffer.from(sessionToken);
    return given.length === expected.length && timingSafeEqual(given, expected);
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    });
    res.end(payload);
}

async function readJson(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) throw Object.assign(new Error('Request too large'), { status: 413 });
        chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw Object.assign(new Error('Invalid JSON'), { status: 400 });
    }
}

async function currentState() {
    const config = await readConfig();
    const { problems, values } = diagnose(config);
    const status = config.exists ? statusFromText(config.text) : { mode: 'unconfigured', ready: false, reason: 'missing-file' };
    return {
        configPath: CONFIG_PATH,
        logDir: LOG_DIR,
        exists: config.exists,
        status,
        problems,
        hasKey: Boolean(values.DEEPSEEK_API_KEY),
        maskedKey: maskSecret(values.DEEPSEEK_API_KEY),
        baseUrl: values.DEEPSEEK_BASE_URL ?? '',
        model: values.DEEPSEEK_MODEL ?? '',
        defaults: { baseUrl: DEFAULT_BASE_URL, model: DEFAULT_MODEL },
        running: await companionRunning(),
    };
}

// Fill an empty key field with the saved (possibly commented-out) key so users need not paste it again.
async function resolveInput(body) {
    const input = normalizeModelInput(body);
    if (!input.apiKey && body.keepKey) {
        const { values } = diagnose(await readConfig());
        input.apiKey = values.DEEPSEEK_API_KEY ?? '';
        Object.assign(input, normalizeModelInput(input));
    }
    return input;
}

async function testConnection(input) {
    const baseUrl = input.baseUrl || DEFAULT_BASE_URL;
    const model = input.model || DEFAULT_MODEL;
    const started = Date.now();
    let response;
    try {
        response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.apiKey}` },
            body: JSON.stringify({ model, messages: [{ role: 'user', content: '只回复“好”。' }], max_tokens: 16, stream: false }),
            signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        });
    } catch (error) {
        const reason = error.name === 'TimeoutError' ? '连接超时' : `无法连接：${error.cause?.code ?? error.message}`;
        return { ok: false, message: `${reason}。请检查地址、网络或代理。` };
    }
    const elapsedMs = Date.now() - started;
    const text = await response.text().catch(() => '');
    let data = null;
    try { data = JSON.parse(text); } catch { /* non-JSON error page */ }
    if (response.ok && Array.isArray(data?.choices)) {
        const reply = String(data.choices[0]?.message?.content ?? '').slice(0, 60);
        return { ok: true, message: `连接成功（${elapsedMs} ms）`, reply, model: data.model ?? model };
    }
    const detail = String(data?.error?.message ?? data?.message ?? text).replaceAll(input.apiKey, '***').slice(0, 300);
    const hints = {
        401: 'API Key 无效或已过期。',
        403: '账号无权限使用该模型，或模型尚未开通。',
        404: '地址或模型名不对：地址一般到 /v1 或 /api/v3 为止，不要带 /chat/completions。',
        429: '请求过多或余额不足。',
    };
    const hint = hints[response.status] ?? (response.ok ? '返回内容不是 Chat Completions 格式，请确认地址是否兼容 OpenAI。' : '');
    return { ok: false, status: response.status, message: `HTTP ${response.status}。${hint}`, detail };
}

function runPowerShell(script, scriptArgs, timeoutMs) {
    return new Promise(resolvePromise => {
        const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...scriptArgs], {
            cwd: ROOT, windowsHide: true, env: process.env,
        });
        let output = '';
        const collect = chunk => { output = (output + chunk.toString()).slice(-4000); };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        const timer = setTimeout(() => child.kill(), timeoutMs);
        child.on('error', error => { clearTimeout(timer); resolvePromise({ ok: false, output: error.message }); });
        child.on('close', code => { clearTimeout(timer); resolvePromise({ ok: code === 0, code, output: output.trim() }); });
    });
}

async function companionRunning() {
    try {
        const response = await fetch('http://127.0.0.1:8790/api/status', { signal: AbortSignal.timeout(1500) });
        if (!response.ok) return false;
        const data = await response.json();
        return { model: data.model?.mode ?? null, cl: Boolean(data.cl?.connected) };
    } catch {
        return false;
    }
}

function openPath(target) {
    spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
}

const routes = {
    'GET /api/state': async () => currentState(),
    'POST /api/test': async body => {
        const input = await resolveInput(body);
        const errors = validateModelInput(input);
        if (Object.keys(errors).length) return { ok: false, errors, message: '请先修正标红的项目。' };
        return testConnection(input);
    },
    'POST /api/save': async body => {
        const input = await resolveInput(body);
        const errors = validateModelInput(input);
        if (Object.keys(errors).length) return { ok: false, errors, message: '请先修正标红的项目。' };
        const current = await readConfig();
        const text = renderEnv(current.text, input);
        if (!statusFromText(text).ready) return { ok: false, message: '保存后的配置仍未通过检查，请检查填写内容。' };
        await writeConfig(text);
        return { ok: true, message: '已保存。', state: await currentState() };
    },
    'POST /api/start': async () => {
        const result = await runPowerShell(join(HERE, 'start.ps1'), ['-Installed'], 180_000);
        return { ...result, message: result.ok ? '鲸鲸已启动（或已用新配置重新加载）。' : '启动失败，请查看下方输出和日志目录。' };
    },
    'POST /api/stop': async () => {
        const result = await runPowerShell(join(HERE, 'stop.ps1'), ['-Installed', '-IncludeCl'], 60_000);
        return { ...result, message: result.ok ? '已停止。' : '停止时出现问题。' };
    },
    'POST /api/open-logs': async () => {
        await mkdir(LOG_DIR, { recursive: true });
        openPath(LOG_DIR);
        return { ok: true };
    },
    'POST /api/open-config-folder': async () => {
        await mkdir(dirname(CONFIG_PATH), { recursive: true });
        openPath(dirname(CONFIG_PATH));
        return { ok: true };
    },
    'POST /api/heartbeat': async () => ({ ok: true }),
    'POST /api/close': async () => {
        setTimeout(shutdown, 200);
        return { ok: true };
    },
};

const pageHtml = await readFile(join(HERE, 'config.html'), 'utf8');
let server;
let expectedHost = '';
let allowedHosts = new Set();

server = createServer(async (req, res) => {
    // Early rejections must still drain the body, or the client sees a connection reset.
    res.on('finish', () => { if (!req.readableEnded) req.resume(); });
    // Reject DNS-rebinding and cross-site requests: only our own loopback host is accepted.
    if (!allowedHosts.has(req.headers.host)) return send(res, 421, { error: 'Bad host' });
    const url = new URL(req.url, `http://${expectedHost}`);
    if (req.method === 'GET' && url.pathname === '/') {
        if (url.searchParams.get('t') !== sessionToken) return send(res, 403, '请重新运行 Configure.cmd 打开设置页。', 'text/plain; charset=utf-8');
        pageLoaded = true;
        lastSeen = Date.now();
        return send(res, 200, pageHtml.replace('__SESSION_TOKEN__', sessionToken), 'text/html; charset=utf-8');
    }
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return send(res, 404, { error: 'Not found' });
    if (!tokenOk(req)) return send(res, 403, { error: 'Forbidden' });
    if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
        return send(res, 415, { error: 'JSON required' });
    }
    lastSeen = Date.now();
    const long = url.pathname === '/api/start' || url.pathname === '/api/stop';
    if (long && busy) return send(res, 409, { ok: false, message: '上一个操作还在进行中。' });
    try {
        if (long) busy = true;
        const body = req.method === 'POST' ? await readJson(req) : {};
        send(res, 200, await handler(body));
    } catch (error) {
        send(res, error.status ?? 500, { ok: false, message: `出错了：${error.message}` });
    } finally {
        if (long) busy = false;
        lastSeen = Date.now();
    }
});

let finished = false;
function shutdown() {
    if (finished) return;
    finished = true;
    server.close();
    readConfig().then(config => {
        const ready = config.exists && statusFromText(config.text).ready;
        process.exit(ensureMode ? 3 : ready ? 0 : 2);
    }).catch(() => process.exit(1));
}

server.listen(fixedPort, '127.0.0.1', () => {
    const { port } = server.address();
    expectedHost = `127.0.0.1:${port}`;
    allowedHosts = new Set([expectedHost, `localhost:${port}`]);
    const pageUrl = `http://${expectedHost}/?t=${sessionToken}`;
    console.log('鲸鲸设置页已打开。如果浏览器没有自动弹出，请复制下面的地址到浏览器：');
    console.log(pageUrl);
    console.log('关闭网页后，此窗口会自动退出。');
    if (!noOpen) spawn('rundll32.exe', ['url.dll,FileProtocolHandler', pageUrl], { detached: true, stdio: 'ignore' }).unref();
    setInterval(() => {
        const limit = pageLoaded ? IDLE_EXIT_MS : FIRST_LOAD_MS;
        if (!busy && Date.now() - lastSeen > limit) shutdown();
    }, 5000).unref();
});
