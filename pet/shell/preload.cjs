// Narrow bridge for the overlay page: window commands out, shell state in.
const { contextBridge, ipcRenderer } = require('electron');

const COMMANDS = new Set(['hide', 'minimize', 'compact', 'clickThrough', 'alwaysOnTop', 'panelAlpha', 'moveStart', 'resizeStart', 'pointerEnd', 'menu', 'state']);

contextBridge.exposeInMainWorld('jingjingShell', {
    send: (command, value) => { if (COMMANDS.has(command)) ipcRenderer.send('shell:command', command, value); },
    onState: callback => {
        const listener = (_event, state) => callback(state);
        ipcRenderer.on('shell:state', listener);
        return () => ipcRenderer.removeListener('shell:state', listener);
    },
});
