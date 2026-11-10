# 鲸鲸 dsh 插件（jingjing-dsh）

把玩家自己的 dsh（DeepSeek Harness）agent 变成鲸鲸：《Probably Stolen》的“店员 + 助手”。完整 agent 能力不做裁剪，不设剧透栅栏。

引擎由 dsh 负责，本插件不包含 CL 内核。插件只带三样东西：

| 部分 | 文件 | 作用 |
| --- | --- | --- |
| 人设 | `persona.md`（鲸鲸角色）或玩家自己的人设 + `role.md`（店员/助手岗位、陪玩规则）+ 知识库第一层与吐槽钩子 | 覆盖部署级人设 `system-prompt.personaPrefix`，标准 preset 的工具保持完整 |
| MCP 服务 `jingjing` | `mcp/server.mjs` | `game_status`、`game_inventory`、`game_recent`、`kb_lookup`、`wait_for_event`、`pet_say` |
| 浮窗接口 | `mcp/pet-hub.mjs` | 实现旧 relay 的浮窗协议（`/events` SSE、`/api/chat`、`/api/status`），`pet/` 里的 Electron 浮窗不用改 |

游戏数据仍然来自读取模组 JingjingWorldBridge 写出的 `state.json`，复用 `pet/game-world.mjs`；知识库复用 `pet/knowledge/` 和术语表。

## 安装

前提：

- 已安装 dsh（`npm i -g @deepseek-ai/dsh`），并配好模型 Key
- `pet/` 下已有 Electron：仓库运行过安装脚本，或者直接用便携包

```bat
cd character-companion\dsh-plugin
install.cmd --port 8790 --model-from web
```

| 参数 | 说明 |
| --- | --- |
| `--profile` | 目标 profile，默认 `jingjing`；不能用 web、headless 等内置名字 |
| `--port` | 浮窗端口，默认 8790。旧版 relay 开着时改用别的端口，如 8795 |
| `--persona` | `jingjing`（默认）用鲸鲸人设；`own` 沿用玩家自己的 bot 人设，只叠加岗位、工具和知识 |
| `--own-persona-file` / `--own-persona-from` | `own` 模式的人设来源：文本文件，或某个 profile（`global` 为全局补丁层）的 `system-prompt.personaPrefix`；`none` 表示人设已在全局 `AGENTS.md` 里 |
| `--player-name` | 对玩家的称呼，可空 |
| `--chatty` | 陪玩话量：`quiet` / `normal`（默认）/ `lively` |
| `--float` | `on`（默认）/ `off`；关掉后不开浮窗，陪玩台词直接写在对话里 |
| `--model-from` | 新建 profile 时，从另一个 profile 只复制模型相关的三行配置（agent-default-model、llm-pi-ai、llm-deepseek）；不加则使用 dsh 默认配置（`DEEPSEEK_API_KEY`） |

安装脚本会依次：

1. 生成 `patches/jingjing.patch.yml`，写入本机绝对路径和端口（这个文件不提交）
2. 写 profile 的 `package.json`，以 `link:` 指向本目录
3. 新建 profile 的 `cordis.patch.yml`；已经存在时不动，原有模型配置不会被覆盖
4. 运行 `dsh plugin install`，并写入 `local.json` 供启动脚本使用

dsh agent 也能自己完成安装：在仓库或便携包根目录对 dsh 说“我想要这个仓库的dsh版”，它会按根目录 `AGENTS.md` 里的步骤执行。`install.cmd` 和 `start.cmd` 由 `scripts/write-cmd.mjs` 生成（为了保证 CRLF 换行），不要手工编辑。

安装选项保存在 `local.json`，`own` 模式的人设文本保存为 `persona.own.md`（都不提交）；重跑时没带的参数沿用上次的选择。

改了 `persona.md`、`role.md` 或知识库后，重跑 `install.cmd`（或者只跑 `node scripts\build-patch.mjs`），再重启 dsh。

长时间陪玩建议给模型提供方配置无限重试，否则一次超时就会让循环停下。在 profile 的 `cordis.patch.yml` 里，对应提供方下面加：

```yaml
        retryPolicy:
          mode: always
```

## 使用

1. 双击 `start.cmd`。它会在单独的窗口里启动 `dsh <profile>`（Web 界面自动在浏览器里打开），并打开 Electron 浮窗。浮窗对话框默认放大到 4 行、160 字；用环境变量 `JINGJING_CAPTION_LINES` 和 `JINGJING_CAPTION_CHARS` 可以调整。
2. 在 Web 界面对鲸鲸说“开始陪玩”。之后她会循环等待事件：游戏里有值得说的事、或者你在浮窗里打字时，她就用 `pet_say` 在浮窗里开口，并切换表情。
3. 同一台机器同时只能有一个 `dsh jingjing` 占用浮窗端口。后启动的那个会一直等端口空出来，在此期间她的话只出现在 Web 对话里。旧版 relay（`pet/start.cmd`）同样占用 8790。

### 环境变量（MCP 服务）

| 变量 | 默认 |
| --- | --- |
| `JINGJING_PET_PORT` | `8790` |
| `JINGJING_PET` | 设为 `0` 时关闭浮窗服务 |
| `JINGJING_GAME_STATE_PATH` | `%LOCALAPPDATA%\CharacterCompanion\probably-stolen\state.json`，以及旧版放在 Mods 目录下的路径 |
| `JINGJING_KB_PATH` / `JINGJING_GLOSSARY_PATH` | 仓库内的知识库与术语表 |

注意：dsh 启动 stdio MCP 时会清洗环境变量。要传这些变量，请写进 patch 中 `mcp-jingjing` 行的 `config.env`。

## 后续：游戏操作（未实现，接口预留）

读取模组目前只写不读，所以鲸鲸只能看、不能动。开放操作的计划如下：

1. **指令通道**：MCP 服务把指令追加到 `%LOCALAPPDATA%\CharacterCompanion\probably-stolen\commands.jsonl`，每条带 `id`、`action`、`args`；模组轮询执行后，把结果写回 `state.json` 的 `commandResults`。这样延续“文件即协议”，不需要在模组里开端口。
2. **简单操作**（如挪货、上架、报价）：新增工具 `game_act`，直接下发。
3. **申请制操作**（如化学制药整套流程）：新增工具 `game_request`，只生成申请，在浮窗或 dsh 里弹出确认，玩家点同意后才写入指令通道。审批走 dsh 的 approval/permission 机制，或由插件自己的 `tools.guard` 守卫拦截（写法参考 qq-agent-presets 的 qq-tool-restrict）。审批状态由 MCP 服务保存，模型无法自己批准自己。
4. 新工具上线后，同步删掉 `role.md` 中“目前还不能直接操作游戏”那句。

## 测试

```bat
node --test tests\*.test.mjs
```

覆盖范围：知识库解析与检索、事件队列、游戏快照读取与事件去重、MCP stdio 握手与工具调用、浮窗 SSE 协议。

已在本机实测：

- 用 headless profile 叠加本 patch，真模型能并行调用 `kb_lookup` 和 `game_status` 并据实回答
- 浮窗页面能由插件驱动显示台词并切换表情

2026-11-10 游戏实测（第 194 天存档，dsh Web + Electron 浮窗连 8795）：

- 陪玩循环跑通：`wait_for_event` 能收到来客进出、柜台摆货、NPC 对话、成交和浮窗打字，`pet_say` 能在浮窗里发言
- 第一轮暴露的问题：开场前先查了 6 个工具，约 50 秒；玩家的话被埋在事件里，约 1 分钟才回；台词太长；游戏里的水质叫法（幽灵水、铁锈水）和知识库对不上
- 已修：玩家的话立即返回并排在最前；`wait_for_event` 附带 `now` 摘要；人设改为速度优先、每次一句；补了同义词；`pet_say` 超过 45 字时返回提醒
- 第二轮：开场缩短到 2 个工具、约 15 秒，事件到达后直接开口。开场白仍有约 70 字。`pet_say` 的长度提醒是这轮之后才加的，还没实测

- 第三轮：长度提醒有效，触发一次后每句都在 30 字左右；玩家的话排在最前，下一步就回。第 13 步时模型请求连续超时 5 次，整轮失败。为此在本机 jingjing profile 的 `ark-coding` 提供方加了 `retryPolicy.mode: always`，这属于 profile 配置，不在插件里
- 第四轮：用户自己开的 `dsh jingjing` 与测试实例同时运行，后启动的那个抢不到浮窗端口；那个满血 agent 随即开始自己排查系统。已修：`pet_say` 返回占用原因和“不要排查”的提示，人设也加了对应规则（重启后生效）

尚未实测：

- 同一台机器同时开两个 `dsh jingjing` 时，浮窗服务只能有一个；目前没有实例间的协调

- 长时间陪玩时的上下文增长（每步约 3 万 token，靠 dsh 压缩兜底）
- 浮窗打字在修复后的响应速度
