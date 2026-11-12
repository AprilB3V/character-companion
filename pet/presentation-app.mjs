import { Presentation, normalizeConfig, parseReplay, dialogHeight } from './presentation-model.mjs';
import { PortraitPainter } from './presentation-painter.mjs';

const params = new URLSearchParams(location.search);
const exportMode = params.get('export') === '1';
const desktopProfile = params.get('profile') === 'desktop';
const storageKey = desktopProfile ? 'jingjing.presentation.desktop' : 'jingjing.presentation';
const canvas = document.getElementById('stage');
const controls = document.getElementById('controls');
const notice = document.getElementById('notice');
let saved = {};
try { saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}'); } catch { /* Defaults remain usable without storage. */ }
if (saved?.layoutVersion !== 2) {
    // Migrate the original right-aligned layout while keeping audio and privacy preferences.
    for (const key of ['portraitX', 'portraitY', 'portraitWidth', 'portraitHeight', 'dialogX', 'dialogY', 'dialogWidth']) delete saved?.[key];
}
const queryConfig = {};
for (const key of ['width', 'height', 'portraitX', 'portraitY', 'portraitWidth', 'portraitHeight', 'dialogX', 'dialogY', 'dialogWidth', 'fontSize', 'volume', 'typeMs']) {
    if (params.has(key)) queryConfig[key] = Number(params.get(key));
}
if (params.has('innerOS')) queryConfig.showInnerOS = params.get('innerOS') === '1';
if (params.has('sound')) queryConfig.sound = params.get('sound') === '1';
if (params.has('assetMode')) queryConfig.assetMode = params.get('assetMode');
if (params.has('name')) queryConfig.name = params.get('name');
const profileDefaults = desktopProfile ? { width:480, height:240, portraitWidth:230, portraitHeight:230, dialogX:24, dialogY:124, dialogWidth:432, fontSize:20, ambient:true } : {};
// fit=1 (desktop overlay): the stage follows the frame size; the portrait fills it and the dialog sits over her feet.
const fitMode = desktopProfile && params.get('fit') === '1' && !exportMode;
const LAYOUT_KEYS = ['width', 'height', 'portraitX', 'portraitY', 'portraitWidth', 'portraitHeight', 'dialogX', 'dialogY', 'dialogWidth', 'fontSize'];
// A font size the user saved (or passed in the URL) wins over the automatic one.
let userFontSize = Number.isFinite(queryConfig.fontSize) ? queryConfig.fontSize : Number.isFinite(saved?.fontSize) ? saved.fontSize : null;
function fitLayout() {
    const width = Math.max(160, Math.round(innerWidth));
    const height = Math.max(160, Math.round(innerHeight));
    const fontSize = userFontSize ?? Math.min(22, Math.max(16, Math.round(width / 22)));
    return {
        width, height, fontSize,
        portraitX: 4, portraitY: 6, portraitWidth: width - 8, portraitHeight: height - 10,
        dialogX: 10, dialogWidth: width - 20, dialogY: Math.round(height - dialogHeight(fontSize) - 10),
    };
}
if (fitMode) for (const key of LAYOUT_KEYS) delete saved?.[key];
let config = normalizeConfig({ ...profileDefaults, ...(exportMode ? {} : saved), ...queryConfig, ...(fitMode ? fitLayout() : {}) });
// Layouts saved for the two-line dialog can push the three-line box past the bottom edge: lift it back in.
if (config.dialogY + dialogHeight(config.fontSize) > config.height) config.dialogY = Math.max(0, Math.round(config.height - dialogHeight(config.fontSize) - 10));
config.reducedMotion = !exportMode && matchMedia('(prefers-reduced-motion: reduce)').matches;
const painter = new PortraitPainter(canvas, config);
let model = new Presentation(config, text => painter.measureText(text));
let replay = null;
let replayIndex = 0;
let replayTime = 0;
let replayEnd = 0;
let playing = false;
let lastFrame = performance.now();
let stream = null;
let audioContext = null;
let lastCharSerial = 0;
let lastBeepAt = -Infinity;

function resize() {
    // Fit mode renders at device resolution so the sprite stays crisp on high-DPI screens.
    const pixelRatio = fitMode ? Math.min(3, devicePixelRatio || 1) : 1;
    canvas.width = Math.round(config.width * pixelRatio);
    canvas.height = Math.round(config.height * pixelRatio);
    painter.config = config;
    model.configure(config);
}
resize();
if (fitMode) {
    let fitFrame = 0;
    addEventListener('resize', () => {
        cancelAnimationFrame(fitFrame);
        fitFrame = requestAnimationFrame(() => { config = normalizeConfig({ ...config, ...fitLayout() }); resize(); });
    });
}

function resetModel() {
    model = new Presentation(config, text => painter.measureText(text));
    replayIndex = 0;
    lastCharSerial = 0;
}

function renderAt(time) {
    if (replay) {
        if (time < replayTime) resetModel();
        while (replayIndex < replay.length && replay[replayIndex].time <= time) {
            const event = replay[replayIndex++];
            model.accept(event, event.time);
        }
        replayTime = time;
    }
    const view = model.snapshot(time);
    painter.paint(view);
    canvas.dataset.state = view.state;
    canvas.dataset.emotion = view.emotion;
    canvas.dataset.mouth = view.mouth;
    return view;
}

function beep(view, now) {
    if (view.charSerial === lastCharSerial) return;
    lastCharSerial = view.charSerial;
    if (!config.sound || !audioContext || audioContext.state !== 'running' || now - lastBeepAt < 25) return;
    lastBeepAt = now;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.value = 660;
    gain.gain.setValueAtTime(config.volume, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.025);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(); oscillator.stop(audioContext.currentTime + 0.03);
}

async function unlockAudio() {
    if (!config.sound || exportMode) return;
    audioContext ??= new AudioContext();
    await audioContext.resume();
}
document.addEventListener('pointerdown', () => void unlockAudio());

function frame(now) {
    const elapsed = Math.min(100, now - lastFrame);
    lastFrame = now;
    if (replay && playing) replayTime = Math.min(replayEnd, replayTime + elapsed);
    const view = renderAt(replay ? replayTime : now);
    beep(view, now);
    if (replay) document.getElementById('seek').value = replayTime;
    if (replay && replayTime >= replayEnd) playing = false;
    requestAnimationFrame(frame);
}

function loadReplay(text) {
    replay = parseReplay(text);
    resetModel();
    replayTime = 0;
    // Calculate the tail from the same engine so long paged replies are not cut short.
    for (const event of replay) model.accept(event, event.time);
    replayEnd = model.completionTime(replay.at(-1)?.time ?? 0) + 1000;
    resetModel();
    stream?.close(); stream = null;
    playing = !exportMode;
    document.getElementById('seek').max = replayEnd;
    notice.textContent = `已加载 ${replay.length} 条事件；按日志时间回放。`;
    renderAt(0);
}

function connect() {
    replay = null;
    resetModel();
    stream?.close();
    stream = new EventSource('/events?presentation=1');
    stream.onopen = () => { notice.textContent = '已连接实时事件。'; };
    stream.onerror = () => { notice.textContent = '连接中断，正在重连。'; };
    stream.onmessage = message => {
        try {
            const event = JSON.parse(message.data);
            // Old SSE history belongs in the history panel, not a new performance.
            if (event.at && Date.now() - event.at > 3000) return;
            if (event.type === 'presentation') {
                if (event.event.type === 'thought' || event.event.type === 'asr' || (event.event.type === 'overlay' && ['idle', 'listening'].includes(event.event.state))) model.accept(event.event, performance.now());
            } else model.accept(event, performance.now());
        } catch (error) { notice.textContent = error.message; }
    };
}

const FIELD_LABELS = {
    portraitX: '立绘 X', portraitY: '立绘 Y', portraitWidth: '立绘宽度', portraitHeight: '立绘高度',
    dialogX: '对话框 X', dialogY: '对话框 Y', dialogWidth: '对话框宽度', fontSize: '字号（1080p 建议 ≥40）',
};
for (const [key, label] of Object.entries(FIELD_LABELS)) {
    const element = document.createElement('label');
    element.textContent = label;
    const input = document.createElement('input');
    input.type = 'number'; input.value = config[key]; input.dataset.config = key;
    // In fit mode the layout follows the window; only the font size stays adjustable.
    if (fitMode && key !== 'fontSize') { input.disabled = true; input.title = '浮窗自适应窗口大小，拖动窗口边缘调整'; }
    input.addEventListener('change', () => {
        config = normalizeConfig({ ...config, [key]: Number(input.value) });
        if (key === 'fontSize') userFontSize = config.fontSize;
        if (fitMode) config = normalizeConfig({ ...config, ...fitLayout() });
        input.value = config[key]; resize();
    });
    element.append(input); document.getElementById('fields').append(element);
}
function updateToggles() {
    document.getElementById('innerToggle').checked = config.showInnerOS;
    document.getElementById('soundToggle').checked = config.sound;
    document.getElementById('volume').value = config.volume;
}
updateToggles();
document.getElementById('innerToggle').onchange = event => { config.showInnerOS = event.target.checked; model.configure(config); };
document.getElementById('soundToggle').onchange = event => { config.sound = event.target.checked; model.configure(config); void unlockAudio(); };
document.getElementById('volume').oninput = event => { config.volume = Number(event.target.value); model.configure(config); };
document.getElementById('save').onclick = () => {
    try { localStorage.setItem(storageKey, JSON.stringify({ ...config, layoutVersion: 2 })); notice.textContent = '设置已保存在本机。'; }
    catch { notice.textContent = '设置无法保存；可用网址参数设置。'; }
};
document.getElementById('centerPortrait').onclick = () => {
    config = normalizeConfig({ ...config, portraitX: (config.width - config.portraitWidth) / 2, portraitY: (config.height - config.portraitHeight) / 2 });
    for (const input of document.querySelectorAll('[data-config]')) input.value = config[input.dataset.config];
    resize();
    notice.textContent = '立绘已居中；点击保存设置可保留。';
};
document.getElementById('replayFile').onchange = async event => {
    try { if (event.target.files[0]) loadReplay(await event.target.files[0].text()); }
    catch (error) { notice.textContent = error.message; }
};
document.getElementById('demo').onclick = async () => {
    try { loadReplay(await (await fetch('/presentation-demo.jsonl')).text()); }
    catch (error) { notice.textContent = error.message; }
};
document.getElementById('live').onclick = connect;
document.getElementById('play').onclick = () => { playing = !playing; };
document.getElementById('restart').onclick = () => { resetModel(); replayTime = 0; playing = true; };
document.getElementById('seek').oninput = event => {
    const time = Number(event.target.value);
    if (time < replayTime) resetModel();
    renderAt(time); playing = false;
};
const DIRECTOR_KEYS = { Digit1: 'director:shop_closed', Digit2: 'director:apprentice', Digit3: 'director:trial', Digit4: 'director:own_shop' };
document.addEventListener('keydown', async event => {
    if (exportMode || event.repeat) return;
    if (event.code === 'F2') {
        event.preventDefault(); controls.hidden = !controls.hidden;
        // The overlay page lays a drag layer over this frame; it steps aside while the settings are open.
        if (parent !== window) parent.postMessage({ type: 'jingjing:controls', open: !controls.hidden }, location.origin);
        return;
    }
    if (!event.ctrlKey || !event.shiftKey || event.altKey) return;
    if (event.code === 'KeyO') {
        event.preventDefault(); config.showInnerOS = !config.showInnerOS; model.configure(config); updateToggles(); return;
    }
    const directorEvent = DIRECTOR_KEYS[event.code];
    if (!directorEvent || replay) return;
    event.preventDefault();
    try {
        const response = await fetch('/api/director', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: directorEvent }) });
        const result = await response.json();
        notice.textContent = response.ok ? `导演：${result.message}` : `导演：${result.error}`;
    } catch { notice.textContent = '导演：连不上中转。'; }
});

await document.fonts.ready;
await painter.loadAssets();
window.jingjingPresentation = {
    loadReplay,
    renderAt,
    configure: async input => {
        config = normalizeConfig({ ...config, ...input }); resize(); await painter.loadAssets();
    },
    snapshot: () => model.snapshot(replay ? replayTime : performance.now()),
    accept: (event, now = performance.now()) => model.accept(event, now),
    get config() { return config; },
    get replayEnd() { return replayEnd; },
    get assetCount() { return painter.images.size; },
};
if (!exportMode) {
    controls.hidden = params.get('controls') !== '1';
    connect(); requestAnimationFrame(frame);
}
window.presentationReady = true;
