import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC_FILES = new Set(['presentation.html', 'presentation-app.mjs', 'presentation-model.mjs', 'presentation-painter.mjs', 'presentation-demo.jsonl']);
const CONTRACT_PATH = join(HERE, '../vendor/CharacterLife-VideoCohost/examples/video-cohost/contract/types.ts');

export async function servePresentation(request, response) {
    if (request.method !== 'GET') return false;
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    let file = path.slice(1);
    if (path === '/presentation' || path === '/stage7') file = 'presentation.html';
    let content;
    let mime;
    if (path === '/presentation-contract.mjs') {
        content = stripTypeScriptTypes(await readFile(CONTRACT_PATH, 'utf8'));
        mime = 'text/javascript';
    } else if (STATIC_FILES.has(file)) {
        content = await readFile(join(HERE, file));
        mime = file.endsWith('.html') ? 'text/html' : file.endsWith('.mjs') ? 'text/javascript' : 'application/x-ndjson';
    } else if (/^\/assets\/jingjing\/(?:body|(?:smug|disgust|panic|stubborn|serious|curious|thinking|neutral)_(?:open|closed|blink))\.png$/.test(path)) {
        try { content = await readFile(join(HERE, file)); }
        catch { response.writeHead(404); response.end(); return true; }
        mime = 'image/png';
    } else return false;
    response.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`, 'Cache-Control': 'no-cache' });
    response.end(content);
    return true;
}
