// Jingjing desktop overlay shell (Electron): transparent always-on-top window that loads the relay's /overlay page.
// Unlike the pywebview window, per-pixel alpha works here, so the panel can be translucent while the portrait stays opaque.
const { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, screen, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OVERLAY_DIR = path.resolve(__dirname, '..');
const RELAY_ORIGIN = process.env.JINGJING_RELAY_ORIGIN || 'http://127.0.0.1:8790';
const ELECTRON_DATA_DIR = process.env.JINGJING_ELECTRON_DATA || path.join(OVERLAY_DIR, 'electron-data');
const STATE_PATH = path.join(ELECTRON_DATA_DIR, 'window-state.json');
const DEFAULT_STATE = { width: 420, height: 520, x: null, y: null, compact: false, panelAlpha: 0.78, alwaysOnTop: true, clickThrough: false };
const COMPACT_SIZE = { width: 260, height: 300 };
const MIN_SIZE = { width: 240, height: 220 };
// The full panel's toolbar needs more room than the portrait-only compact mode.
const MIN_FULL_SIZE = { width: 340, height: 300 };
const SHORTCUT_TOGGLE = 'Control+Alt+J';
const SHORTCUT_CLICK_THROUGH = 'Control+Alt+K';

app.setPath('userData', ELECTRON_DATA_DIR);
// Chimes must play without a click, as the old window did.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Exact origin comparison: prefix checks accept URLs such as http://127.0.0.1:8790@evil.example/.
function isRelayUrl(url) {
    try { return new URL(url).origin === RELAY_ORIGIN; } catch { return false; }
}

let win = null;
let tray = null;
let state = loadState();
let saveTimer = null;
let pointerTask = null;
let quitting = false;

function loadState() {
    try { return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) }; }
    catch { return { ...DEFAULT_STATE }; }
}

function saveStateSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
        fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 4));
    }, 300);
}

function rememberBounds() {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    const bounds = win.getBounds();
    state.x = bounds.x; state.y = bounds.y;
    // Compact mode has its own fixed-ish size; keep the full-mode size for when it returns.
    if (state.compact) { state.compactWidth = bounds.width; state.compactHeight = bounds.height; }
    else { state.width = bounds.width; state.height = bounds.height; }
    saveStateSoon();
}

function visibleBounds(bounds) {
    // Keep the window reachable if a monitor was unplugged since the last run.
    const known = Number.isFinite(bounds.x) && Number.isFinite(bounds.y);
    const display = (known ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay()).workArea;
    const width = Math.min(bounds.width, display.width);
    const height = Math.min(bounds.height, display.height);
    const x = Math.min(Math.max(bounds.x ?? display.x + display.width - width - 24, display.x), display.x + display.width - width);
    const y = Math.min(Math.max(bounds.y ?? display.y + display.height - height - 24, display.y), display.y + display.height - height);
    return { x, y, width, height };
}

function overlayUrl() {
    const params = new URLSearchParams({ size: '20', turns: '3', shell: 'electron', panelAlpha: String(state.panelAlpha) });
    if (state.compact) params.set('compact', '1');
    return `${RELAY_ORIGIN}/overlay?${params}`;
}

function pushState() {
    win?.webContents.send('shell:state', { compact: state.compact, panelAlpha: state.panelAlpha, alwaysOnTop: state.alwaysOnTop, clickThrough: state.clickThrough, visible: win.isVisible() });
    rebuildTrayMenu();
}

function createWindow() {
    const size = state.compact
        ? { width: state.compactWidth ?? COMPACT_SIZE.width, height: state.compactHeight ?? COMPACT_SIZE.height }
        : { width: state.width, height: state.height };
    const bounds = visibleBounds({ x: state.x, y: state.y, ...size });
    win = new BrowserWindow({
        ...bounds,
        minWidth: (state.compact ? MIN_SIZE : MIN_FULL_SIZE).width,
        minHeight: (state.compact ? MIN_SIZE : MIN_FULL_SIZE).height,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        resizable: true,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: state.alwaysOnTop,
        skipTaskbar: false,
        title: '鲸鲸',
        icon: path.join(OVERLAY_DIR, 'assets', 'jingjing-avatar.png'),
        webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    // At 150% scaling a new transparent window comes out ~2px larger than asked; reapplying the bounds corrects it,
    // otherwise the saved size creeps up on every restart.
    win.setBounds(bounds);
    // 'screen-saver' level stays above full-screen-windowed games.
    if (state.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');
    if (state.clickThrough) win.setIgnoreMouseEvents(true, { forward: true });
    win.loadURL(overlayUrl());
    win.webContents.on('did-fail-load', () => setTimeout(() => win && !win.isDestroyed() && win.loadURL(overlayUrl()), 2000));
    win.webContents.on('did-finish-load', pushState);
    // The preload bridge must only ever serve the relay page: block navigation anywhere else.
    win.webContents.on('will-navigate', (event, url) => { if (!isRelayUrl(url)) event.preventDefault(); });
    win.webContents.on('will-redirect', (event, url) => { if (!isRelayUrl(url)) event.preventDefault(); });
    // A drag must never outlive the page that started it.
    win.webContents.on('render-process-gone', () => stopPointerTask());
    win.webContents.on('did-start-navigation', () => stopPointerTask());
    win.on('hide', () => stopPointerTask());
    win.on('moved', rememberBounds);
    win.on('resized', rememberBounds);
    win.on('show', pushState);
    win.on('hide', pushState);
    win.on('close', event => {
        // Closing hides to the tray; quit from the tray menu.
        if (quitting) return;
        event.preventDefault();
        win.hide();
    });
}

function toggleVisible(force) {
    if (!win) return;
    const show = force ?? !win.isVisible();
    if (show) { win.showInactive(); if (state.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver'); }
    else win.hide();
}

function setCompact(compact) {
    if (!win || state.compact === compact) return;
    rememberBounds();
    state.compact = compact;
    const current = win.getBounds();
    const size = compact
        ? { width: state.compactWidth ?? COMPACT_SIZE.width, height: state.compactHeight ?? COMPACT_SIZE.height }
        : { width: state.width, height: state.height };
    // Anchor the bottom-right corner, where the portrait's feet sit.
    const minimum = compact ? MIN_SIZE : MIN_FULL_SIZE;
    win.setMinimumSize(minimum.width, minimum.height);
    size.width = Math.max(size.width, minimum.width);
    size.height = Math.max(size.height, minimum.height);
    win.setBounds(visibleBounds({ x: current.x + current.width - size.width, y: current.y + current.height - size.height, ...size }));
    saveStateSoon();
    pushState();
}

function setClickThrough(enabled) {
    state.clickThrough = enabled;
    win?.setIgnoreMouseEvents(enabled, { forward: true });
    saveStateSoon();
    pushState();
}

function setAlwaysOnTop(enabled) {
    state.alwaysOnTop = enabled;
    win?.setAlwaysOnTop(enabled, 'screen-saver');
    saveStateSoon();
    pushState();
}

function setPanelAlpha(alpha) {
    state.panelAlpha = Math.min(1, Math.max(0, Number(alpha) || 0));
    saveStateSoon();
    pushState();
}

function resetPosition() {
    state.x = null; state.y = null;
    const bounds = win.getBounds();
    win.setBounds(visibleBounds({ x: null, y: null, width: bounds.width, height: bounds.height }));
    toggleVisible(true);
}

function menuTemplate() {
    const alphaItems = [[0, '全透明'], [0.45, '45%'], [0.78, '78%（默认）'], [0.96, '不透明']].map(([value, label]) => ({
        label, type: 'radio', checked: Math.abs(state.panelAlpha - value) < 0.01, click: () => setPanelAlpha(value),
    }));
    return [
        { label: win.isVisible() ? `隐藏鲸鲸\t${SHORTCUT_TOGGLE}` : `显示鲸鲸\t${SHORTCUT_TOGGLE}`, click: () => toggleVisible() },
        { label: '紧凑模式（只看立绘）', type: 'checkbox', checked: state.compact, click: item => setCompact(item.checked) },
        { label: '置顶', type: 'checkbox', checked: state.alwaysOnTop, click: item => setAlwaysOnTop(item.checked) },
        { label: `鼠标穿透\t${SHORTCUT_CLICK_THROUGH}`, type: 'checkbox', checked: state.clickThrough, click: item => setClickThrough(item.checked) },
        { label: '面板背景', submenu: alphaItems },
        { type: 'separator' },
        { label: '重置位置', click: resetPosition },
        { label: '重新加载', click: () => win.loadURL(overlayUrl()) },
        { type: 'separator' },
        { label: '退出浮窗', click: () => { quitting = true; app.quit(); } },
    ];
}

function rebuildTrayMenu() {
    if (!tray || !win) return;
    tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
    tray.setToolTip(state.clickThrough ? '鲸鲸（鼠标穿透中）' : '鲸鲸');
}

function createTray() {
    const icon = nativeImage.createFromPath(path.join(OVERLAY_DIR, 'assets', 'jingjing-avatar.png')).resize({ width: 32, height: 32 });
    tray = new Tray(icon);
    tray.on('click', () => toggleVisible());
    rebuildTrayMenu();
}

// Window drag and resize follow the system cursor from the main process, so they keep working over the
// portrait iframe and on transparent windows, where native edge resizing is unreliable on Windows.
function startPointerTask(kind, edge) {
    stopPointerTask();
    const start = screen.getCursorScreenPoint();
    const origin = win.getBounds();
    const [minWidth, minHeight] = win.getMinimumSize();
    const timer = setInterval(() => {
        if (!win || win.isDestroyed()) return stopPointerTask();
        const cursor = screen.getCursorScreenPoint();
        const dx = cursor.x - start.x;
        const dy = cursor.y - start.y;
        // setPosition grows the window ~1px per call at fractional display scaling (150%); always pin the size.
        if (kind === 'move') { win.setBounds({ x: origin.x + dx, y: origin.y + dy, width: origin.width, height: origin.height }); return; }
        let { x, y, width, height } = origin;
        if (edge.includes('e')) width = Math.max(minWidth, origin.width + dx);
        if (edge.includes('s')) height = Math.max(minHeight, origin.height + dy);
        if (edge.includes('w')) { width = Math.max(minWidth, origin.width - dx); x = origin.x + origin.width - width; }
        if (edge.includes('n')) { height = Math.max(minHeight, origin.height - dy); y = origin.y + origin.height - height; }
        win.setBounds({ x, y, width, height });
    }, 16);
    // Safety net: never keep following the cursor if the renderer missed pointerup.
    pointerTask = { timer, guard: setTimeout(stopPointerTask, 30000) };
}

function stopPointerTask() {
    if (!pointerTask) return;
    clearInterval(pointerTask.timer);
    clearTimeout(pointerTask.guard);
    pointerTask = null;
    rememberBounds();
}

ipcMain.on('shell:command', (event, command, value) => {
    if (!win || event.sender !== win.webContents || !isRelayUrl(event.senderFrame?.url ?? '')) return;
    switch (command) {
        case 'hide': toggleVisible(false); break;
        case 'minimize': win.minimize(); break;
        case 'compact': setCompact(Boolean(value)); break;
        case 'clickThrough': setClickThrough(Boolean(value)); break;
        case 'alwaysOnTop': setAlwaysOnTop(Boolean(value)); break;
        case 'panelAlpha': setPanelAlpha(value); break;
        case 'moveStart': startPointerTask('move'); break;
        case 'resizeStart': if (/^(n|s|e|w|ne|nw|se|sw)$/.test(String(value))) startPointerTask('resize', String(value)); break;
        case 'pointerEnd': stopPointerTask(); break;
        case 'menu': Menu.buildFromTemplate(menuTemplate()).popup({ window: win }); break;
        case 'state': pushState(); break;
    }
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
    app.on('second-instance', () => toggleVisible(true));
    app.whenReady().then(() => {
        // The overlay needs the microphone for voice input; nothing else is granted ('media' would also cover the camera).
        session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
            const audioOnly = permission === 'media' && Array.isArray(details.mediaTypes) && details.mediaTypes.length > 0 && details.mediaTypes.every(type => type === 'audio');
            callback(audioOnly && isRelayUrl(details.requestingUrl ?? contents.getURL()));
        });
        session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => permission === 'media' && details?.mediaType === 'audio' && isRelayUrl(requestingOrigin));
        // Links such as the 立绘 settings page open as plain windows instead of inside the overlay.
        app.on('web-contents-created', (_event, contents) => contents.setWindowOpenHandler(({ url }) => ({
            action: isRelayUrl(url) ? 'allow' : 'deny',
            overrideBrowserWindowOptions: { width: 960, height: 640, autoHideMenuBar: true, title: '鲸鲸 · 立绘设置' },
        })));
        createWindow();
        createTray();
        globalShortcut.register(SHORTCUT_TOGGLE, () => toggleVisible());
        globalShortcut.register(SHORTCUT_CLICK_THROUGH, () => setClickThrough(!state.clickThrough));
    });
    app.on('before-quit', () => { quitting = true; stopPointerTask(); rememberBounds(); });
    app.on('will-quit', () => {
        globalShortcut.unregisterAll();
        clearTimeout(saveTimer);
        try { fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true }); fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 4)); } catch { /* best effort */ }
    });
    app.on('window-all-closed', () => { /* stays in the tray */ });
}
