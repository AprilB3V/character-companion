# 语料（corpus）

角色在具体游戏里的“常识”和说话示例。只放已脱敏、可公开的整理结果；原始数据库、录音转写和游戏原文都不进仓库。

| 路径 | 内容 | 是否提交 |
| --- | --- | --- |
| `game/probably-stolen.md` | 游戏要点：基础玩法、派系、关键机制、物价参考、常见梗 | 是，人工整理 |
| `samples/dialogues.jsonl` | 少量对话示例：主播原话（语音识别结果）→ 鲸鲸回复、情绪、决策、内心 OS | 是，人工挑选 |
| `manifest.json` | 最近一次导出的来源规模、规则版本、各文件条数、脱敏命中数 | 是，脚本生成 |
| `generated/` | 导出的原始素材：记忆摘要、物价观察、对话候选 | 否（gitignore） |

## 更新流程

1. 导出（只读打开数据库，不修改原数据）：

   ```bash
   node tools/export-corpus.mjs --db <CL 数据目录>/data/jingjing-video/characterlife.db --events <浮窗目录>/data/events
   ```

2. 对照 `corpus/generated/` 的新内容，手工更新 `game/*.md` 和 `samples/dialogues.jsonl`。物价只收实际成交或账面差额，标注来源类别。
3. 提交前扫描，必须输出 `Clean`：

   ```bash
   node tools/scan-sensitive.mjs
   ```

4. 用 PR 提交，在 diff 中复核新增内容。

## 脱敏规则

规则在 `tools/redact.mjs`，导出和扫描共用同一套（`RULES_VERSION` 写进 manifest）：

- 密钥与令牌：`sk-…`、GitHub token、AWS key、Bearer、`*_API_KEY=` / `*_TOKEN=` 赋值、私钥块、40 位以上十六进制串。
- 个人信息：邮箱、手机号、Steam ID、本机用户目录名。
- 本机名单：`tools/redact.local.json`（不提交）里列出的真名、账号、昵称，统一替换为 `[NAME]`。格式见 `tools/redact.local.example.json`。
- 数据库中的身份、绑定码、会话、账本等表整表不读；带 `promise` 标签的原话记忆、运行 ID 标签不导出。

## 收录边界

- 不收游戏原文台词、字符串表、解包素材，只写自己归纳的机制和数值。
- 不写配方、制法等现实中可能有害的细节。
- 剧情向内容只写派系存在，不写剧情走向。
