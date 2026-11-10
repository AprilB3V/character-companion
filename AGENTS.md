# Character Companion

## Windows installation

For the public portable release, run
`cmd /d /c install.cmd --portable --non-interactive`.
This requires the published `v0.1.0-rc.3` release assets. It downloads the
Windows x64 package, verifies SHA-256 and the installed file manifest, then
creates local configuration. Git, Node.js and private submodule access are
unnecessary for the portable release. If the release is still a draft,
report that the public package is not available yet.

The commands below describe developer installation from source.

If the user requests installation, use a Git checkout of this repository and
run `cmd /d /c install.cmd --non-interactive` from its root. The installer
requires Git, Node.js 22.18 or later with npm, and existing read access to the
pinned private VideoCohost submodule. It installs locked dependencies without
prompting and preserves the user's configuration.

Treat exit code 0 and `INSTALL_OK` as dependency installation success. Exit 1
means installation failed. Exit 2 means invalid command arguments. Report a
missing prerequisite or denied submodule access as an installation failure.
Do not ask for model credentials in chat or inspect the contents of local
credential files. Installed startup requires model configuration: point the
user to `Configure.cmd` (portable) or `node pet\config-app.mjs` (source), a
local settings page where they enter and test the model settings themselves.
`CharacterCompanion.cmd` also opens it when the configuration is incomplete. Explicit
`CharacterCompanion.cmd -Demo` enables offline fixed responses and labels the
window as a demo. Treat demo success separately from live model verification.

For an optional headless runtime check, run
`powershell -NoProfile -ExecutionPolicy Bypass -File pet/start.ps1 -Installed -NoWindow -Demo`.
Query `http://127.0.0.1:8790/api/status` and check `cl.connected`. Report game
connection separately. See [Windows installation](docs/install.md).

## dsh 版（DeepSeek Harness 插件）

当用户要“这个仓库的 dsh 版”“鲸鲸 dsh 插件”“装到 dsh 里”或类似内容时，按本节操作。dsh 版不需要 CharacterLife 后端，也不需要私有子模块；装好后会多出一个 dsh profile `jingjing`，在里面 agent 担任《Probably Stolen》的店员加助手，并可选配桌面浮窗。身份可以用鲸鲸，也可以沿用用户自己 bot 的人设。

### 第一步：安装前先问用户

用 `ask_user_question` 一次问完下面几项（推荐项放第一个），不要自己替用户决定：

1. **人设**：沿用你自己的 bot 人设（只加上店员和助手的岗位、游戏工具和知识）/ 使用鲸鲸人设。
2. **你的人设从哪来**（只在第 1 项选“沿用”时问）：
   - 用我（当前这个 agent）现在的人设：把你自己系统提示词里的人设部分（名字、性格、说话方式）原样写进 `dsh-plugin/persona.own.md`，不要掺入工具说明、API Key 或个人信息；写完把全文给用户看，确认后再装。
   - 某个 dsh profile 里设置的人设（`system-prompt.personaPrefix`）：问清 profile 名，脚本会自己读取，你不要打开那个配置文件。
   - 用户贴给你或给出文件：贴的文本同样写进 `dsh-plugin/persona.own.md`。
   - 已经写在全局 `~/.dsh/AGENTS.md` 里：所有 profile 都会加载它，不需要复制。
3. **怎么称呼玩家**：可留空。
4. **陪玩时的话量**：normal 适中（推荐）/ quiet 只说要紧事 / lively 多聊一点。
5. **桌面浮窗**：要（推荐）/ 不要，只在 dsh 对话里说话。

选“沿用”时顺带告诉用户：桌面浮窗的立绘和表情仍是鲸鲸的形象，只有台词用他们自己的人设。选鲸鲸、而全局 `~/.dsh/AGENTS.md` 里已有别的人设时，提醒用户两者会同时生效、可能打架。

### 第二步：安装（非交互，直接执行）

在本文件所在目录（仓库根目录或便携包根目录）运行，按回答追加参数：

```
node dsh-plugin/scripts/install.mjs --model-from auto --persona <jingjing|own> [人设来源] [--player-name <称呼>] --chatty <normal|quiet|lively> --float <on|off>
```

| 回答 | 参数 |
| --- | --- |
| 使用鲸鲸 | `--persona jingjing` |
| 沿用：当前 agent 的人设、贴的文本或文件 | `--persona own --own-persona-file <文件路径>` |
| 沿用：某个 profile 的人设 | `--persona own --own-persona-from <profile 名>`；全局补丁层用 `global` |
| 沿用：已在全局 AGENTS.md | `--persona own --own-persona-from none` |
| 称呼留空 | 不加 `--player-name` |

- 选择会保存在 `dsh-plugin/local.json`，人设文本保存为 `dsh-plugin/persona.own.md`（都不进 git）。以后要改设置，只带要改的参数重跑脚本即可，没带的参数保持上次的选择；改完让用户重启 `dsh jingjing`。
- 输出里的 `settings:` 一行是最终生效的设置，可以复述给用户确认。
- 失败原因如果是 profile 里没有 `personaPrefix`，改问用户要文本或文件，走 `--own-persona-file`。
- 如果根目录下有 `runtime/node/node.exe`，用它代替 `node`。
- 不要运行 `install.cmd`，它最后会 `pause` 等待按键。
- 成功的标志是输出 `INSTALL_OK`，退出码为 0。失败时输出 `INSTALL_FAILED: <原因>`，退出码为 1；把原因原样告诉用户，不要反复重试。
- 脚本会新建或更新 dsh profile `jingjing`，路径是 `%USERPROFILE%\.dsh\profiles\jingjing`，或 `$DSH_HOME\profiles\jingjing`。脚本会写入 dsh 目录，dsh 可能会就此请求用户批准，这属于正常情况。
- `--model-from auto`：新建 profile 时，从用户的 `web` profile 只复制模型相关的三行配置；没有 web profile 就用 dsh 默认配置（`DEEPSEEK_API_KEY`）。已存在的 profile 配置一律不改。不要读取或打印这些配置文件的内容。
- 浮窗端口自动选择：优先 8790，被占用（例如旧版 relay 在运行）时依次换 8795–8799。输出里的 `float-window port` 就是最终选定的端口。

### 浮窗依赖（可选）

浮窗需要 `pet/node_modules/electron/dist/electron.exe`。

- 便携包自带，不用处理。
- 仓库检出里没有时，在 `pet/` 下运行 `npm ci`（会联网下载约 100 MB），然后告诉用户已安装。
- 用户选了 `--float off` 时跳过这一步，agent 照常在 dsh 对话里工作。

### 安装后告诉用户

1. 先关掉当前的 dsh 会话，再双击 `dsh-plugin\start.cmd`。它会在单独的窗口启动 `dsh jingjing`（Web 界面在浏览器打开），并打开浮窗。也可以手动运行 `dsh jingjing`。
2. 在《Probably Stolen》里订阅并启用读取模组 Jingjing World Bridge：https://steamcommunity.com/sharedfiles/filedetails/?id=3835039157 。载入存档后，agent 就能读到游戏数据。
3. 在 Web 界面说“开始陪玩”。
4. 长时间陪玩建议给模型提供方配置无限重试，做法见 `dsh-plugin/README.md`。

不要替用户启动第二个 dsh，也不要在当前会话里切换 profile。

### 验证（可选）

运行 `node --test "dsh-plugin/tests/*.test.mjs"` 应该全部通过。要确认 profile 能正确组合，运行 `dsh --profile jingjing --dump-config`，输出里应包含 `serverName: jingjing`。

<!-- Same text ships as AGENTS.md in the portable package (docs/releases/dsh-edition-agents.md); keep both in sync. -->
