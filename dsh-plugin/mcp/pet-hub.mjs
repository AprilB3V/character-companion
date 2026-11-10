import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { servePresentation } from '../../pet/presentation-http.mjs';

const PET_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../pet');
const RETRY_MS = 3000;
const MAX_BODY = 64 * 1024;

function isLoopbackHost(host) {
    const name = String(host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    return ['127.0.0.1', 'localhost', '::1'].includes(name);
}

function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
}

/**
 * Speaks the old relay's overlay protocol (SSE /events + /api/chat + /api/status) so the
 * existing Electron float window works unchanged, with dsh as the brain instead of CL.
 */
export class PetHub {
    constructor({ port = 8790, onChat = () => {}, status = () => ({}), log = () => {} } = {}) {
        this.port = port;
        this.onChat = onChat;
        this.statusProvider = status;
        this.log = log;
        this.clients = new Set();
        this.turn = 0;
        this.listening = false;
        this.lastError = null;
        this.server = http.createServer((req, res) => {
            this.handle(req, res).catch(() => { if (!res.headersSent) sendJson(res, 500, { error: '本地服务暂时不可用。' }); else res.end(); });
        });
        this.server.on('listening', () => {
            this.listening = true;
            this.lastError = null;
            this.log(`pet hub listening on 127.0.0.1:${this.port}`);
        });
        this.server.on('error', error => {
            this.listening = false;
            this.lastError = error.code ?? error.message;
            // The dsh MCP probe process or an old relay may hold the port briefly; keep trying.
            if (error.code === 'EADDRINUSE') setTimeout(() => this.listen(), RETRY_MS).unref();
        });
    }

    listen() {
        if (this.listening) return;
        this.server.listen(this.port, '127.0.0.1');
    }

    close() {
        for (const client of this.clients) client.end();
        this.server.close();
    }

    broadcast(event) {
        const data = `data: ${JSON.stringify({ ...event, at: Date.now() })}\n\n`;
        for (const client of this.clients) client.write(data);
    }

    /** Show the thinking indicator for a batch she is considering; returns the turn to answer on. */
    think() {
        const turn = ++this.turn;
        this.broadcast({ type: 'thinking', turn });
        return turn;
    }

    /** She considered it and chose to stay quiet: drop the indicator. */
    silent(turn) {
        this.broadcast({ type: 'silent', turn });
    }

    say(text, emotion = 'neutral', pendingTurn = null) {
        const turn = pendingTurn ?? ++this.turn;
        this.broadcast({ type: 'start', turn, emotion });
        this.broadcast({ type: 'delta', turn, text });
        this.broadcast({ type: 'end', turn, text, emotion });
        return { delivered: this.clients.size > 0, viewers: this.clients.size, turn };
    }

    showUser(text) {
        this.broadcast({ type: 'user', turn: ++this.turn, text });
    }

    async handle(req, res) {
        if (!isLoopbackHost(req.headers.host)) return sendJson(res, 403, { error: '只接受本机访问。' });
        const path = new URL(req.url, 'http://127.0.0.1').pathname;
        if (await servePresentation(req, res)) return;
        if (req.method === 'GET' && (path === '/' || path === '/overlay')) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
            return res.end(await readFile(join(PET_DIR, 'overlay.html')));
        }
        if (req.method === 'GET' && path === '/voice-input.mjs') {
            res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
            return res.end(await readFile(join(PET_DIR, 'voice-input.mjs')));
        }
        if (req.method === 'GET' && path === '/assets/jingjing-avatar.png') {
            const avatar = await readFile(join(PET_DIR, 'assets', 'jingjing-avatar.png')).catch(() => null);
            if (!avatar) { res.writeHead(404); return res.end(); }
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
            return res.end(avatar);
        }
        if (req.method === 'GET' && path === '/events') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
            res.write(': connected\n\n');
            this.clients.add(res);
            req.on('close', () => this.clients.delete(res));
            return;
        }
        if (req.method === 'GET' && path === '/history') return sendJson(res, 200, { conversations: [] });
        if (req.method === 'GET' && path === '/api/status') {
            return sendJson(res, 200, { cl: { connected: false }, asr: { ready: false, disabled: true },
                model: { ready: true, mode: 'dsh', model: 'dsh' }, ...this.statusProvider() });
        }
        if (req.method === 'POST' && path === '/api/chat') {
            let size = 0;
            const chunks = [];
            for await (const chunk of req) {
                size += chunk.length;
                if (size > MAX_BODY) return sendJson(res, 413, { error: '消息太长。' });
                chunks.push(chunk);
            }
            let text = '';
            try { text = String(JSON.parse(Buffer.concat(chunks).toString('utf8')).text ?? '').trim(); } catch { /* handled below */ }
            if (!text) return sendJson(res, 400, { error: '消息为空。' });
            this.showUser(text);
            // onChat may return a notice, e.g. when no companion loop is listening.
            const extra = this.onChat(text.slice(0, 2000)) ?? {};
            return sendJson(res, 200, { ok: true, queued: true, ...extra });
        }
        if (path.startsWith('/api/')) return sendJson(res, 503, { error: 'dsh 版暂不支持此功能（语音输入、导演台）。' });
        res.writeHead(404);
        res.end();
    }
}
