// Server-side messages of the configuration page in Chinese and English.
// The page sends its language in the X-Config-Lang header; anything other than "en" falls back to Chinese.

const MESSAGES = {
    zh: {
        'key.required': '请填写 API Key（本机模型如 Ollama 可留空）',
        'key.badChars': 'API Key 含有中文、全角或不可见字符，请重新复制',
        'url.protocol': '地址需以 http:// 或 https:// 开头',
        'url.credentials': '地址里不能包含账号密码',
        'url.invalid': '地址格式不正确，例如 https://api.deepseek.com',
        'model.spaces': '模型名不能包含空格',
        'problem.missingFile': '配置文件不存在（第一次使用或被删除），保存后会自动创建。',
        'problem.commented': '以下设置前面还有 #，程序会当作注释忽略：{keys}。已帮你读出原值，点“保存”即可修复。',
        'problem.missingLines': '模型设置行已被删除，填写后保存会自动补回。',
        'problem.missingToken': '内部通信令牌缺失或损坏，保存时会自动重新生成。',
        'problem.bom': '文件带有 BOM 头，会让第一行失效，保存时会自动去掉。',
        'test.timeout': '连接超时',
        'test.unreachable': '无法连接：{code}',
        'test.checkNetwork': '{reason}。请检查地址、网络或代理。',
        'test.checkLocal': '{reason}。本机模型服务好像没有运行：请先启动 Ollama（或 LM Studio 等），再测试。',
        'test.ok': '连接成功（{ms} ms）',
        'test.http': 'HTTP {status}。{hint}',
        'hint.401': 'API Key 无效或已过期。',
        'hint.403': '账号无权限使用该模型，或模型尚未开通。',
        'hint.404': '地址或模型名不对：地址一般到 /v1 或 /api/v3 为止，不要带 /chat/completions。本机模型请确认已下载该模型（例如 ollama pull qwen3:8b）。',
        'hint.429': '请求过多或余额不足。',
        'hint.notChat': '返回内容不是 Chat Completions 格式，请确认地址是否兼容 OpenAI。',
        'form.fix': '请先修正标红的项目。',
        'save.notReady': '保存后的配置仍未通过检查，请检查填写内容。',
        'save.ok': '已保存。',
        'start.ok': '鲸鲸已启动（或已用新配置重新加载）。',
        'start.failed': '启动失败，请查看下方输出和日志目录。',
        'stop.ok': '已停止。',
        'stop.failed': '停止时出现问题。',
        'busy': '上一个操作还在进行中。',
        'error': '出错了：{message}',
    },
    en: {
        'key.required': 'Enter an API key (local models such as Ollama need none)',
        'key.badChars': 'The API key contains full-width or invisible characters; copy it again',
        'url.protocol': 'The address must start with http:// or https://',
        'url.credentials': 'The address must not contain a user name or password',
        'url.invalid': 'Not a valid address, e.g. https://api.openai.com/v1',
        'model.spaces': 'The model name must not contain spaces',
        'problem.missingFile': 'No configuration file yet (first run, or it was deleted). Saving creates it.',
        'problem.commented': 'These settings start with # and are ignored as comments: {keys}. Their values were read back for you; click Save to fix it.',
        'problem.missingLines': 'The model settings were removed from the file. Fill them in and save to restore them.',
        'problem.missingToken': 'The internal token is missing or damaged. A new one is generated on save.',
        'problem.bom': 'The file starts with a BOM, which breaks its first line. Saving removes it.',
        'test.timeout': 'Timed out',
        'test.unreachable': 'Could not connect: {code}',
        'test.checkNetwork': '{reason}. Check the address, your network or proxy.',
        'test.checkLocal': '{reason}. The local model server does not seem to be running: start Ollama (or LM Studio etc.) and test again.',
        'test.ok': 'Connected ({ms} ms)',
        'test.http': 'HTTP {status}. {hint}',
        'hint.401': 'The API key is invalid or expired.',
        'hint.403': 'Your account cannot use this model, or the model is not enabled.',
        'hint.404': 'Wrong address or model name: the address usually ends at /v1, without /chat/completions. For local models, make sure the model is downloaded (e.g. ollama pull qwen3:8b).',
        'hint.429': 'Too many requests, or no credit left.',
        'hint.notChat': 'The reply is not in Chat Completions format. Is this an OpenAI-compatible address?',
        'form.fix': 'Fix the fields marked in red first.',
        'save.notReady': 'The saved configuration would still not pass the check. Please review your entries.',
        'save.ok': 'Saved.',
        'start.ok': 'Jingjing is running (or reloaded with the new settings).',
        'start.failed': 'Start failed. See the output below and the log folder.',
        'stop.ok': 'Stopped.',
        'stop.failed': 'Something went wrong while stopping.',
        'busy': 'The previous action is still running.',
        'error': 'Error: {message}',
    },
};

export function pickLang(value) {
    return String(value ?? '').toLowerCase().startsWith('en') ? 'en' : 'zh';
}

export function t(lang, key, params = {}) {
    const table = MESSAGES[lang] ?? MESSAGES.zh;
    const template = table[key] ?? MESSAGES.zh[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

export function listJoin(lang, items) {
    return items.join(lang === 'en' ? ', ' : '、');
}
