#!/usr/bin/env node
// Regenerate install.cmd / start.cmd with CRLF line endings (cmd.exe needs them; editors and shells mangle them).
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Prefer the portable package's bundled Node when the plugin sits inside it.
const head = [
    '@echo off',
    'setlocal',
    String.raw`cd /d "%~dp0"`,
    String.raw`set "NODE=node"`,
    String.raw`if exist "..\runtime\node\node.exe" set "NODE=..\runtime\node\node.exe"`,
];
const install = [
    ...head,
    String.raw`rem Usage: install.cmd [--persona jingjing^|own] [--own-persona-file f ^| --own-persona-from profile] [--player-name n] [--chatty quiet^|normal^|lively] [--float on^|off] [--port auto^|8790] [--model-from auto^|web] [--profile jingjing]`,
    String.raw`"%NODE%" scripts\install.mjs %*`,
    'if errorlevel 1 (echo. & echo Install failed. & pause & exit /b 1)',
    'if not defined JINGJING_NO_PAUSE pause',
];
const start = [...head, String.raw`"%NODE%" scripts\start.mjs %*`, 'if errorlevel 1 pause'];
writeFileSync(join(ROOT, 'install.cmd'), `${install.join('\r\n')}\r\n`);
writeFileSync(join(ROOT, 'start.cmd'), `${start.join('\r\n')}\r\n`);
console.log('wrote install.cmd, start.cmd');
