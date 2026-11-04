import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createPresentationServer, findBrowser } from '../render-overlay.mjs';

test('browser uses contract, renders transparent states, replays and switches inner OS', { timeout: 60000 }, async () => {
    const server = await createPresentationServer();
    const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(server.url + '/presentation?export=1');
        await page.waitForFunction(() => window.presentationReady);
        const log = await readFile(new URL('../presentation-demo.jsonl', import.meta.url), 'utf8');
        await page.evaluate(log => window.jingjingPresentation.loadReplay(log), log);
        for (const [time, state, emotion] of [[0, 'idle', 'neutral'], [700, 'listening', 'curious'], [2000, 'thinking', 'thinking'], [3800, 'speaking', 'smug'], [8600, 'yield', 'panic'], [11000, 'idle', 'stubborn']]) {
            const view = await page.evaluate(time => window.jingjingPresentation.renderAt(time), time);
            assert.equal(view.state, state);
            assert.equal(view.emotion, emotion);
        }
        const hidden = await page.evaluate(() => window.jingjingPresentation.renderAt(3000));
        assert.equal(hidden.innerOS, '');
        await page.evaluate(() => window.jingjingPresentation.configure({ showInnerOS: true }));
        const visible = await page.evaluate(() => window.jingjingPresentation.renderAt(3000));
        assert.equal(visible.innerOS, '先看看账本再夸你。');
        const alpha = await page.evaluate(() => {
            const context = document.getElementById('stage').getContext('2d');
            return [context.getImageData(0, 0, 1, 1).data[3], context.getImageData(960, 540, 1, 1).data[3]];
        });
        assert.equal(alpha[0], 0);
        assert.ok(alpha[1] >= 250, 'the character remains opaque after filtered scaling');
        await page.evaluate(() => window.jingjingPresentation.renderAt(3600));
        assert.equal(await page.locator('#stage').getAttribute('data-mouth'), 'open');
        await page.evaluate(() => window.jingjingPresentation.renderAt(3630));
        assert.equal(await page.locator('#stage').getAttribute('data-mouth'), 'closed');
        const contract = await (await page.request.get(server.url + '/presentation-contract.mjs')).text();
        assert.ok(contract.includes('normalizeEmotion'));
        assert.ok(!contract.includes('export interface'));
        assert.deepEqual(errors, []);
    } finally {
        await browser.close(); await server.close();
    }
});

test('settings keyboard and director hotkeys emit the expected local action', { timeout: 60000 }, async () => {
    const server = await createPresentationServer();
    const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
    try {
        const page = await browser.newPage();
        let director;
        await page.route('**/api/director', async route => {
            director = route.request().postDataJSON();
            await route.fulfill({ contentType: 'application/json', body: '{"message":"已发送"}' });
        });
        await page.route('**/events*', route => route.fulfill({ contentType: 'text/event-stream', body: ': test\n\n' }));
        await page.goto(server.url + '/presentation');
        await page.waitForFunction(() => window.presentationReady);
        assert.equal(await page.locator('#controls').isVisible(), false);
        await page.keyboard.press('F2');
        assert.equal(await page.locator('#controls').isVisible(), true);
        await page.keyboard.press('Control+Shift+O');
        assert.equal(await page.locator('#innerToggle').isChecked(), true);
        await page.keyboard.press('Control+Shift+1');
        await page.waitForFunction(() => document.getElementById('notice').textContent.includes('导演：'));
        assert.deepEqual(director, { event: 'director:shop_closed' });
        await page.locator('[data-config=fontSize]').fill('54');
        await page.locator('[data-config=fontSize]').dispatchEvent('change');
        await page.locator('#save').click();
        await page.reload();
        await page.waitForFunction(() => window.presentationReady);
        assert.equal(await page.evaluate(() => window.jingjingPresentation.config.fontSize), 54);
    } finally { await browser.close(); await server.close(); }
});

test('embedded desktop profile keeps saved layout and still receives memory state', { timeout: 60000 }, async () => {
    const server = await createPresentationServer();
    const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 480, height: 360 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error' && /ReferenceError/.test(message.text())) errors.push(message.text()); });
        const html = await readFile(new URL('../overlay.html', import.meta.url), 'utf8');
        const voice = await readFile(new URL('../voice-input.mjs', import.meta.url), 'utf8');
        await page.route('**/overlay', route => route.fulfill({ contentType: 'text/html', body: html }));
        await page.route('**/voice-input.mjs', route => route.fulfill({ contentType: 'text/javascript', body: voice }));
        await page.route('**/api/**', route => route.fulfill({ contentType: 'application/json', body: '{"cl":{"connected":true,"memories":7},"asr":{"ready":true}}' }));
        await page.route('**/events*', route => route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'end', turn: 1, text: '你好', state: { memories: 7 }, at: Date.now() })}\n\n` }));
        await page.goto(server.url + '/overlay');
        const iframe = page.frameLocator('iframe');
        await iframe.locator('#stage').waitFor();
        await page.waitForFunction(() => document.querySelector('iframe').contentWindow.presentationReady);
        assert.equal(await page.locator('#memoryState').textContent(), 'CL 记忆 7 条');
        await iframe.locator('#stage').click({ position: { x: 10, y: 10 } });
        await page.keyboard.press('F2');
        await iframe.locator('[data-config=fontSize]').fill('24');
        await iframe.locator('[data-config=fontSize]').dispatchEvent('change');
        await iframe.locator('#save').click();
        await page.reload();
        await page.waitForFunction(() => document.querySelector('iframe')?.contentWindow.presentationReady);
        assert.equal(await page.evaluate(() => document.querySelector('iframe').contentWindow.jingjingPresentation.config.fontSize), 24);
        assert.deepEqual(errors, []);
    } finally { await browser.close(); await server.close(); }
});

test('layered PNG assets composite a transparent face over the body', { timeout: 60000 }, async () => {
    const server = await createPresentationServer();
    const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        const fixtures = await page.evaluate(() => {
            const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8;
            const context = canvas.getContext('2d');
            context.fillStyle = '#00ff00'; context.fillRect(0, 0, 8, 8);
            const body = canvas.toDataURL().split(',')[1];
            context.clearRect(0, 0, 8, 8); context.fillStyle = '#ff0000'; context.fillRect(0, 0, 4, 4);
            return { body, face: canvas.toDataURL().split(',')[1] };
        });
        await page.route('**/assets/jingjing/*.png', route => {
            const name = route.request().url().split('/').at(-1);
            if (!['body.png', 'neutral_closed.png'].includes(name)) return route.fulfill({ status: 404, body: '' });
            return route.fulfill({ contentType: 'image/png', body: Buffer.from(name === 'body.png' ? fixtures.body : fixtures.face, 'base64') });
        });
        await page.goto(server.url + '/presentation?export=1&assetMode=layered&portraitX=1400&portraitY=360&portraitWidth=400&portraitHeight=400');
        await page.waitForFunction(() => window.presentationReady);
        const pixels = await page.evaluate(() => {
            window.jingjingPresentation.renderAt(0);
            const context = document.getElementById('stage').getContext('2d');
            return [[1450, 400], [1750, 700]].map(([x, y]) => [...context.getImageData(x, y, 1, 1).data]);
        });
        assert.deepEqual(pixels, [[255, 0, 0, 255], [0, 255, 0, 255]]);
    } finally { await browser.close(); await server.close(); }
});

test('default and desktop portraits are centered without stretching the artwork', { timeout: 60000 }, async () => {
    const server = await createPresentationServer();
    const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
    try {
        for (const [profile, width, height] of [['', 1920, 1080], ['&profile=desktop', 480, 240]]) {
            const page = await browser.newPage({ viewport: { width, height } });
            await page.goto(server.url + '/presentation?export=1' + profile);
            await page.waitForFunction(() => window.presentationReady);
            const result = await page.evaluate(() => {
                window.jingjingPresentation.renderAt(0);
                const canvas = document.getElementById('stage');
                const context = canvas.getContext('2d');
                const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
                let left = canvas.width, right = -1, top = canvas.height, bottom = -1;
                for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
                    if (data[(y * canvas.width + x) * 4 + 3] <= 16) continue;
                    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
                }
                return { left, right, top, bottom, assetCount: window.jingjingPresentation.assetCount };
            });
            assert.ok(result.assetCount >= 2, 'both neutral mouth frames are loaded');
            assert.ok(Math.abs((result.left + result.right + 1) / 2 - width / 2) <= 2, 'visible artwork is horizontally centered');
            assert.ok(Math.abs((result.top + result.bottom + 1) / 2 - height / 2) <= 2, 'visible artwork is vertically centered');
            const aspect = (result.right - result.left + 1) / (result.bottom - result.top + 1);
            assert.ok(aspect > 0.79 && aspect < 0.83, 'source silhouette ratio is preserved');
            await page.close();
        }
    } finally { await browser.close(); await server.close(); }
});
