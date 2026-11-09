import { getModelStatus } from './model-status.mjs';

const modelStatus = getModelStatus();
if (!modelStatus.ready) {
    throw new Error('Model configuration is required. Run Configure.cmd, save the settings, and start again.');
}
if (modelStatus.mode === 'demo') {
    // Explicit demo runs must remain offline even if real credentials exist.
    process.env.DEEPSEEK_API_KEY = '';
    process.env.JINGJING_THINKING = '0';
    process.env.CHARACTERLIFE_THINK_API_KEY = '';
}
await import('../vendor/CharacterLife-VideoCohost/examples/video-cohost/start-server.ts');
