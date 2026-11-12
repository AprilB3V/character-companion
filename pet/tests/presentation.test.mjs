import assert from 'node:assert/strict';
import test from 'node:test';
import { Presentation, parseReplay, normalizeConfig, captionHoldMs, CAPTION, DIALOG_LINES } from '../presentation-model.mjs';

test('five states select portraits and keep thinking visible without dialogue', () => {
    const model = new Presentation();
    assert.equal(model.snapshot(0).emotion, 'neutral');
    for (const [state, emotion] of [['listening', 'curious'], ['thinking', 'thinking'], ['speaking', 'smug'], ['yield', 'panic'], ['idle', 'smug']]) {
        model.accept({ type: 'overlay', state, ...(state === 'speaking' ? { text: '你好', emotion: 'smug' } : {}) }, 0);
        const view = model.snapshot(0);
        assert.equal(view.state, state);
        assert.equal(view.emotion, emotion);
        if (state === 'thinking') {
            assert.equal(view.indicator, '……');
            assert.equal(view.text, '');
        }
    }
});

test('yield freezes the visible character and late stream events cannot resume it', () => {
    const model = new Presentation();
    model.accept({ type: 'start', turn: 1, emotion: 'smug' }, 0);
    model.accept({ type: 'delta', turn: 1, text: '一二三四五六七八九十' }, 0);
    assert.equal(model.snapshot(60).text, '一二三');
    model.accept({ type: 'yield', turn: 1 }, 60);
    model.accept({ type: 'delta', turn: 1, text: '不该出现' }, 100);
    model.accept({ type: 'end', turn: 1, text: '一二三四五六七八九十不该出现' }, 110);
    assert.equal(model.snapshot(300).text, '一二三');
    assert.equal(model.snapshot(300).mouth, 'closed');
});

test('long dialogue pages into dialog-sized pages and idle does not cut off a half sentence', () => {
    const model = new Presentation({ dialogWidth: 240, fontSize: 40 });
    model.accept({ type: 'overlay', state: 'speaking', text: '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸' }, 0);
    model.accept({ type: 'overlay', state: 'idle' }, 50);
    assert.equal(model.snapshot(50).state, 'speaking');
    assert.ok(model.snapshot(1500).lines.length <= DIALOG_LINES);
    assert.equal(model.snapshot(8000).state, 'idle');
    assert.equal(model.snapshot(8000).text, '');
});

test('inner OS stays hidden unless enabled and resets for a new turn', () => {
    const model = new Presentation();
    model.accept({ type: 'thought', result: { emotion: 'stubborn', innerOS: '心里想的话' } }, 0);
    assert.equal(model.snapshot(0).innerOS, '');
    model.configure({ showInnerOS: true });
    assert.equal(model.snapshot(0).innerOS, '心里想的话');
    model.accept({ type: 'thinking', turn: 2 }, 10);
    assert.equal(model.snapshot(10).innerOS, '');
});

test('replay accepts contract JSONL, preserves gaps and handles appended sessions', () => {
    const events = parseReplay([
        { type: 'overlay', state: 'thinking', mono: 100, wall: '2026-11-02T00:00:00.100Z' },
        { type: 'overlay', state: 'speaking', text: '你好', mono: 2100, wall: '2026-11-02T00:00:02.100Z' },
        { type: 'overlay', state: 'idle', mono: 10, wall: '2026-11-02T00:00:04.000Z' },
    ].map(JSON.stringify).join('\n'));
    assert.deepEqual(events.map(item => item.time), [0, 2000, 3900]);
    assert.throws(() => parseReplay('{nope}'), /line 1/);
    assert.throws(() => parseReplay('{"type":"overlay","state":"thinking"}'), /timestamp/);
});

test('config rejects nonfinite dimensions and clamps unsafe volume', () => {
    const config = normalizeConfig({ fontSize: NaN, volume: 8, portraitWidth: -1 });
    assert.equal(config.fontSize, 44);
    assert.equal(config.volume, 1);
    assert.ok(config.portraitWidth > 0);
});

test('next turn still shows every page, hurried, unless an explicit yield interrupts', () => {
    const model = new Presentation({ dialogWidth: 240, fontSize: 40 });
    model.accept({ type: 'overlay', state: 'speaking', text: '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸' }, 0);
    model.accept({ type: 'overlay', state: 'idle' }, 5000);
    model.accept({ type: 'overlay', state: 'thinking' }, 5100);
    // Pages already on screen longer than hurryMs flip at once; every character was shown.
    assert.equal(model.snapshot(5100).charSerial, 20);
    assert.equal(model.snapshot(5100).state, 'thinking');
});

test('a relay idle event cannot erase the connection error before it is read', () => {
    const model = new Presentation();
    model.accept({ type: 'error', turn: 1, text: '连接失败' }, 0);
    model.accept({ type: 'overlay', state: 'idle', text: 'error' }, 1);
    assert.equal(model.snapshot(70).text, '连接失');
});

test('cancelled turns never resume from late end or delta', () => {
    const model = new Presentation();
    model.accept({ type: 'start', turn: 1 }, 0);
    model.accept({ type: 'delta', turn: 1, text: '旧句' }, 0);
    model.accept({ type: 'cancel', turn: 1 }, 10);
    model.accept({ type: 'end', turn: 1, text: '旧句' }, 20);
    assert.equal(model.snapshot(100).text, '');
    assert.equal(model.snapshot(100).state, 'idle');
});

test('wall timestamps preserve session gaps even when the new mono increased', () => {
    const events = parseReplay([
        { type: 'overlay', state: 'idle', mono: 100, wall: '2026-11-02T00:00:00.100Z' },
        { type: 'overlay', state: 'thinking', mono: 500, wall: '2026-11-02T00:01:00.500Z' },
    ].map(JSON.stringify).join('\n'));
    assert.equal(events[1].time, 60400);
});

test('several queued turns retain every character and duration estimation has no side effects', () => {
    const model = new Presentation({ dialogWidth: 240, fontSize: 40 });
    const text = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸';
    for (const [time, event] of [
        [0, { type: 'overlay', state: 'speaking', text }], [5000, { type: 'overlay', state: 'idle' }],
        [5100, { type: 'overlay', state: 'thinking' }], [6100, { type: 'overlay', state: 'speaking', text }],
        [11100, { type: 'overlay', state: 'idle' }], [11200, { type: 'overlay', state: 'thinking' }],
    ]) model.accept(event, time);
    assert.equal(model.completionTime(11200), 11200);
    assert.equal(model.completionTime(11200), 11200);
    assert.equal(model.snapshot(20000).charSerial, 40);
    assert.equal(model.snapshot(20000).state, 'thinking');
});

test('yield of a pending turn freezes the currently visible portrait immediately', () => {
    const model = new Presentation({ dialogWidth: 240, fontSize: 40 });
    model.accept({ type: 'start', turn: 1 }, 0);
    model.accept({ type: 'delta', turn: 1, text: '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸' }, 0);
    model.accept({ type: 'end', turn: 1 }, 1);
    model.accept({ type: 'user', turn: 2 }, 5100);
    model.accept({ type: 'start', turn: 2 }, 5200);
    model.accept({ type: 'delta', turn: 2, text: '下一轮' }, 5300);
    model.accept({ type: 'end', turn: 2, text: '下一轮' }, 5400);
    const text = model.snapshot(5500).text;
    model.accept({ type: 'yield', turn: 2 }, 5500);
    assert.equal(model.snapshot(5500).state, 'yield');
    assert.equal(model.snapshot(10000).text, text);
});

test('caption hold is about 9 chars per second, clamped, with a bonus on the last page', () => {
    assert.equal(captionHoldMs('一二'), CAPTION.minMs);
    assert.equal(captionHoldMs('一'.repeat(36)), 4600);
    assert.equal(captionHoldMs('一'.repeat(200)), CAPTION.maxMs);
    assert.equal(captionHoldMs('一'.repeat(36), { last: true }), 5600);
    assert.equal(captionHoldMs('一'.repeat(36), { last: true, hurry: true }), CAPTION.hurryMs);
});

test('a reply is cut at the last sentence end that still fits one dialog page', () => {
    // Default overlay: (1400 - 64) / 44 = 30 chars per line, three lines = 90.
    const model = new Presentation();
    assert.equal(model.maxLines(), DIALOG_LINES);
    const first = '一'.repeat(58) + '二。';
    const second = '三'.repeat(20) + '。';
    model.accept({ type: 'start', turn: 1 }, 0);
    model.accept({ type: 'delta', turn: 1, text: first + second + '后面这句真的放不下了。' }, 0);
    model.accept({ type: 'delta', turn: 1, text: '流式后续也不该出现。' }, 5000);
    model.accept({ type: 'end', turn: 1, text: first + second + '后面这句真的放不下了。流式后续也不该出现。' }, 5000);
    model.snapshot(30000);
    assert.equal(model.charSerial, 81);
    assert.equal(model.snapshot(30000).state, 'idle');
});

test('closing quotes stay with their sentence and a reply that fits is shown whole', () => {
    const model = new Presentation({ dialogWidth: 464, fontSize: 40 });
    const text = '她说“别急。”' + '一'.repeat(20) + '。';
    model.accept({ type: 'overlay', state: 'speaking', text }, 0);
    model.accept({ type: 'overlay', state: 'idle' }, 1);
    model.snapshot(60000);
    assert.equal(model.charSerial, [...text].length);
    const cut = new Presentation({ dialogWidth: 464, fontSize: 40 });
    cut.accept({ type: 'overlay', state: 'speaking', text: '她说“别急。”' + '一'.repeat(30) + '。' }, 0);
    cut.accept({ type: 'overlay', state: 'idle' }, 1);
    cut.snapshot(60000);
    assert.equal(cut.charSerial, 7);
});

test('a streamed sentence that already overflows is dropped before the rest arrives', () => {
    const model = new Presentation({ dialogWidth: 464, fontSize: 40 });
    model.accept({ type: 'start', turn: 1 }, 0);
    model.accept({ type: 'delta', turn: 1, text: '好。' + '二'.repeat(29) }, 0);
    model.snapshot(20000);
    model.accept({ type: 'delta', turn: 1, text: '还在说。' }, 20000);
    model.accept({ type: 'end', turn: 1, text: '好。' + '二'.repeat(29) + '还在说。' }, 20000);
    model.snapshot(60000);
    assert.equal(model.charSerial, 2);
});

test('review: a stream pausing near the edge never spills onto a second page', () => {
    const model = new Presentation({ dialogWidth: 464, fontSize: 40 });
    model.accept({ type: 'start', turn: 1 }, 0);
    model.accept({ type: 'delta', turn: 1, text: '一'.repeat(28) + '。一' }, 0);
    model.snapshot(20000);
    model.accept({ type: 'delta', turn: 1, text: '二三' }, 20000);
    model.accept({ type: 'end', turn: 1, text: '' }, 20000);
    let maxLines = 0;
    for (let time = 20000; time < 60000; time += 50) maxLines = Math.max(maxLines, model.snapshot(time).lines.length);
    assert.ok(model.charSerial <= 30, `shown ${model.charSerial}`);
    assert.ok(maxLines <= DIALOG_LINES);
});

test('review: line breaks count toward the page, not just characters', () => {
    const model = new Presentation({ dialogWidth: 464, fontSize: 40 });
    model.accept({ type: 'overlay', state: 'speaking', text: ('一'.repeat(8) + String.fromCharCode(10)).repeat(3) + '一' }, 0);
    model.accept({ type: 'overlay', state: 'idle' }, 1);
    let maxLines = 0;
    for (let time = 0; time < 60000; time += 50) maxLines = Math.max(maxLines, model.snapshot(time).lines.length);
    assert.ok(maxLines <= DIALOG_LINES);
});

test('review: a sentence end shown before the next sentence arrives still decides on the whole next sentence', () => {
    const model = new Presentation({ dialogWidth: 464, fontSize: 40 });
    model.accept({ type: 'start', turn: 1 }, 0);
    model.accept({ type: 'delta', turn: 1, text: '好。' }, 0);
    model.snapshot(20000);
    model.accept({ type: 'delta', turn: 1, text: '二'.repeat(35) + '。' }, 20000);
    model.accept({ type: 'end', turn: 1, text: '' }, 20000);
    model.snapshot(60000);
    assert.equal(model.charSerial, 2);
    const late = new Presentation({ dialogWidth: 464, fontSize: 40 });
    late.accept({ type: 'start', turn: 1 }, 0);
    late.accept({ type: 'delta', turn: 1, text: '好。' }, 0);
    late.snapshot(20000);
    late.accept({ type: 'delta', turn: 1, text: '”再见。' }, 20000);
    late.accept({ type: 'end', turn: 1, text: '' }, 20000);
    late.snapshot(60000);
    assert.equal(late.charSerial, 6, 'a closing quote arriving late stays with its sentence');
});

test('a reply with no sentence end is cut hard at the page with an ellipsis', () => {
    const model = new Presentation();
    model.accept({ type: 'overlay', state: 'speaking', text: '一'.repeat(150) }, 0);
    model.accept({ type: 'overlay', state: 'idle' }, 1);
    model.snapshot(60000);
    assert.equal(model.charSerial, CAPTION.hardCap);
    assert.equal(model.snapshot(60000).state, 'idle');
});

test('a stream that stops exactly at the page edge keeps its last character', () => {
    const model = new Presentation({ dialogWidth: 464, fontSize: 40 });
    model.accept({ type: 'start', turn: 1 }, 0);
    model.accept({ type: 'delta', turn: 1, text: '一'.repeat(29) }, 0);
    model.snapshot(20000);
    model.accept({ type: 'end', turn: 1, text: '一'.repeat(29) + '二' }, 20000);
    model.snapshot(60000);
    assert.equal(model.charSerial, 30);
    assert.equal(model.lines(model.page).length <= DIALOG_LINES, true);
});

test('a short reply stays at least the minimum hold plus the last-page bonus', () => {
    const model = new Presentation();
    model.accept({ type: 'overlay', state: 'speaking', text: '嗯。' }, 0);
    model.accept({ type: 'overlay', state: 'idle' }, 1);
    assert.equal(model.snapshot(CAPTION.minMs + CAPTION.lastPageBonusMs - 10).state, 'speaking');
    assert.equal(model.snapshot(CAPTION.minMs + CAPTION.lastPageBonusMs + 10).state, 'idle');
});

test('a next turn mid-reply hurries the remaining pages to at most hurryMs each', () => {
    const model = new Presentation({ dialogWidth: 240, fontSize: 40 });
    model.accept({ type: 'overlay', state: 'speaking', text: '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸' }, 0);
    model.accept({ type: 'overlay', state: 'idle' }, 1);
    model.accept({ type: 'overlay', state: 'thinking' }, 300);
    assert.equal(model.snapshot(300).state, 'speaking');
    // Three pages, each typed then held for at most a second.
    const done = model.completionTime(300);
    assert.ok(done <= 3 * CAPTION.hurryMs + 600, `finished at ${done}`);
    assert.equal(model.snapshot(done + 1).charSerial, 20);
    assert.equal(model.snapshot(done + 1).state, 'thinking');
});
