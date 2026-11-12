# 鲸鲸浮窗：语音输入，文字输出

> 本文是浮窗的开发记录，沿用原开发机的目录布局。新仓库的目录结构和路径配置见仓库根目录 [README](../README.md) 和 [`local.example.ps1`](local.example.ps1)。文中提到的 `*-verification.json`、`data/*.sqlite` 等本地验证产物和数据未收入仓库。

浮窗直接收音，由本地 SenseVoice 识别，再交给 CharacterLife。无需启动 Open-LLM-VTuber，不加载 TTS 或 Live2D。

```text
浮窗麦克风 → relay.mjs:8790 → 本地 SenseVoice:8791
                   ↓ 识别文字
              CharacterLife:8787 → 文字回复、长期记忆
                   ↓
              浮窗 / OBS / 对话记录
```

## 启动与使用

双击本目录的 `start.cmd`。脚本会检查并启动 CL、语音识别、中转和置顶浮窗。

1. 点击浮窗右上角「开启麦克风」，按系统提示允许收音。
2. 正常说话，说完停顿约 0.9 秒，识别文字会自动发给鲸鲸。
3. 鲸鲸回复时暂不提交新录音，回复结束后继续听；只输出文字，不合成人声。
4. 再次点击「关闭麦克风」停止收音。底部有音量条、收音状态和 CL 记忆数量。
5. 点击「记录」查看、搜索、刷新历史，按「返回」或 Esc 退出记录面板。
6. 底部「阈值」打开收音设置。默认起音阈值 −34 dBFS，连续起音 200 ms、最短有效讲话 400 ms、停顿发送 900 ms；设置可保存，重启仍生效。

### 浮窗外壳（Electron，2026-11-04 起默认）

`start.cmd` 默认用 `shell/main.cjs` 启动 Electron 透明窗口；`start.cmd -LegacyWindow` 仍可用旧的 pywebview 窗口。

- **移动**：按住头像/名字，或直接按住立绘拖动。
- **缩放**：拖窗口四边或四角（右下角有缩放提示）。立绘与对话框随窗口尺寸自适应。
- **紧凑模式**：工具栏 ◱ 或双击立绘，只留立绘；鼠标移入时右上角出现 麦克风 / 展开 / 更多 / 隐藏。麦克风开着时左下角有绿点。
- **隐藏**：工具栏 ✕ 或 Alt+F4 隐藏到托盘；`Ctrl+Alt+J` 或单击托盘图标呼出。退出用托盘菜单「退出浮窗」。
- **更多（⋯ 或托盘右键）**：置顶、鼠标穿透（`Ctrl+Alt+K` 切换，穿透时无法点击浮窗）、面板背景透明度（全透明 / 45% / 78% / 不透明）、重置位置。
- 面板背景可半透明，立绘保持不透明。位置、尺寸、模式保存在 `electron-data/window-state.json`。

立绘动态（`presentation-painter.mjs`）：呼吸起伏、约 4 秒一次的眨眼（偶尔连眨）、说话时轻微摇摆、开口说话时小跳一下、思考时歪头并显示跳动省略号、在听时前倾并显示音量条、被打断时抖一下、表情切换 160 ms 淡入淡出；桌面浮窗另有身后上浮的小气泡和地面阴影（离线导出不画这两项）。系统开启“减少动态效果”时全部停用。

### 流式文字

浮窗默认请求 CL 原生 `/v1/messages` 的流式模式。模型生成时，仅将结构化输出中顶层 `reply` 的文字增量推给浮窗；不会逐字展示 JSON、记忆候选或模型思考内容。完整输出通过原有解析后，才提交记忆与状态。中断或不完整结构不会写入半条记忆。

`/api/chat` 仍返回最终 JSON；中途增量通过 `/events` 显示。兼容不支持流式的旧 CL 时会退回完整回复。旧 OpenAI 兼容端点的分块方式不等同于这里新增的原生模型流。

### 识别自修正

识别出的文字发给鲸鲸前，中转会先做两步修正：

1. **词表替换**：按 `data/asr-glossary.json` 的 `replacements` 把常见误识别替换掉，比如“一平如洗”替换为“一贫如洗”。文件修改后下一句就生效，不用重启。
2. **模型纠错**：`llm` 为 `true` 时，用 `.env.video.local` 里配置的同一个模型，只修同音字、近音词和专有名词，并关闭思考模式。专有名词提示来自词表的 `hints` 和知识库第三层关键词。模型回答问题、改动过大、超时（6 秒）或调用失败时，都保留词表修正后的文字。实测每句增加约 1–4 秒延迟，也会产生模型费用；不想要这一步就把 `llm` 改成 `false`。

**游戏语料**：`data/asr-corpus/` 下的每个 `.txt` 是一份词表，每行一个词，`#` 开头的行是注释。现有的 `probably-stolen-zh.txt` 有 1035 个《深空当铺》中文专有名词，包括物品、NPC、出身、天赋、关系网升级、机制和界面名称，是从本机游戏自带的简体中文字符串表提取的。这些是游戏原文，只留在本机，不要提交或发布。每句话只会挑出与它字面重合度高的最多 60 个词，作为模型纠错的提示；修改语料后需要重启中转才生效。

浮窗里会在你的话下面显示“识别原文”，OBS 透明模式下隐藏。发生修正的句子会追加记录到本机的 `data/asr-corrections.jsonl`，方便补充词表；这个文件不上传。CL 收到的是修正后的文字。

### 降低底噪触发

- 起音阈值向右调高，更难被底噪触发；轻声漏识别时向左调低。
- 需要持续达到起音阈值才开始记录，过短声音不提交；结束阈值比起音低 6 dB，减少语句中途截断。
- 已关闭浏览器自动增益，保留噪声抑制和回声消除，避免自动增益把安静背景抬高。
- 先开启麦克风，再点「校准底噪（2秒）」并保持安静。校准期间不发送语音，结束后按底噪较高分位值加 10 dB 设置起音阈值，并自动保存。
- 手动调整后点击「保存设置」。偏好保存在 `data/microphone-settings.json`，校准仅在当前设备上操作时进行，不会后台自动打开麦克风。

浮窗默认 480×360；按住头像或名字拖动。Alt+F4 关闭窗口并释放麦克风，后台服务继续运行。

停止中转、识别和窗口：`powershell -NoProfile -File .\stop.ps1`。
一并停止鲸鲸专用 CL：在上条命令末尾增加 `-IncludeCl`。

首次实际麦克风收音需要在本机手动测试；已有录音的本地识别和完整文字链路已验证。
如果没有识别文字，检查输入设备、系统麦克风权限、静音状态以及底部音量条。

## CL 记忆

- 继续使用原来的鲸鲸身份 `jingjing-video`，现有实例为 `inst_001`；不会因打开浮窗而另建角色。
- 长期记忆仍保存在 CL 数据目录（`CHARACTERLIFE_DIR`）下的 `data/jingjing-video/characterlife.db`。
- 直接调用 CL 原生 `/v1/messages`，沿用身份解析、记忆检索、候选写入、持久化与快照流程。
- 鲸鲸实例启用适度宽松的记录策略：明确偏好、习惯、计划、称呼、共同经历说过一次即可提出记录，不要求反复确认或专门说“记住”。具体但普通的信息也可记录，每轮最多三条，显著度可用 0.3–0.6；相同记忆不重复。
- 不确定的内容保持推测；角色人格、来源标记和权限规则不变。其他 CL 部署默认策略不变。
- 每轮最多检索 8 条、1800 字记忆，原配置为 5 条、900 字。
- 对话记录与长期记忆不同：逐轮文字保存在 `data/conversations.sqlite`；模型按上述策略选择长期记忆，未将每句闲聊当作事实。

## 本地资源与配置

- Node.js ≥ 22.13，本机 v26.7.0。
- 旧版浮窗（`-LegacyWindow`）使用已安装 pywebview 的 `pythonw.exe`，可用 `JINGJING_WINDOW_PYTHON` 指定。
- 识别服务目前复用 `../Open-LLM-VTuber/.venv/Scripts/python.exe` 中已经安装的依赖，以及其 `models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/` 模型目录；不导入或运行 Open-LLM-VTuber 源码。
- 如需迁移资源，可设置 `JINGJING_ASR_PYTHON` 和 `JINGJING_ASR_MODEL_DIR`，依赖版本见 `requirements-speech.txt`。
- CL 凭据继续从 CL 数据目录下的 `.env.video.local` 读取，仅在服务端使用，不写入网页或对话记录。
- 音频仅在本机内存中处理，不保存录音文件。ASR 输出的文字交给 CL 和其已配置的模型。
- 自定义上游地址可设置 `CL_URL`；识别服务地址可设置 `ASR_URL`（手动运行中转时生效）。

更换头像：替换 `assets/jingjing-avatar.png` 后重开浮窗。

## OBS

浏览器源网址：

```text
http://127.0.0.1:8790/overlay?bg=transparent&size=28&turns=2
```

默认浮窗现使用阶段 7 立绘呈现；透明模式隐藏按钮和状态栏，保留立绘与对话框，不会请求麦克风。旧的纯文字视图可加 `view=text`。

参数：`size=20` 字号；`turns=3` 最近轮数；`you=0` 隐藏用户文字；`name=鲸鲸` 角色名。

以上 `size/turns/you` 仅控制旧文字视图。立绘视图使用下节的参数。

## 阶段 7：差分立绘与离线渲染

已接入基于用户参考图重绘的鲸鲸正面透明立绘（开/闭口两帧），并保存正/侧/背三视图到 `assets/jingjing/design/three-view-v1.png`。当前默认居中、等比例缩放；F2 面板可点击“居中立绘”。旧版右侧布局会自动迁移。尚缺的情绪差分暂用 neutral 同嘴型立绘，素材与生成记录见 `assets/jingjing/README.md`。

主浮窗 `/overlay` 保留麦克风、记录、阈值设置，在内容区嵌入立绘。独立透明页面（OBS 浏览器源建议 1920×1080）：

```text
http://127.0.0.1:8790/presentation
http://127.0.0.1:8790/presentation?controls=1
```

代码更新后需要重启中转，并重新打开或刷新浮窗。

- idle：当前情绪、闭嘴，隐藏对话框；listening：curious；thinking：thinking 与可见的“……”气泡；speaking：情绪差分、逐字显示、两帧嘴型和轻微浮动；yield：panic、立即停字，可在旁边补“……你先说”。
- 普通下一轮等待当前句子的全部分页显示结束；显式 yield/cancel 可立即中断。每页最多两行，从开始显示起停留约 `字数 / 5 + 1` 秒。默认 1080p 字号 44，1080p 及以上下限 40。
- **F2** 显示/隐藏设置。先点击立绘区域让其获得键盘焦点。位置、尺寸、字号、内心 OS、提示音与音量可调整并保存。桌面小窗和独立 1080p 页面分别保存布局。网址参数优先于保存值。
- **Ctrl+Shift+O** 切换内心 OS；默认隐藏，打开后使用灰色斜体思考气泡。
- **Ctrl+Shift+1/2/3/4** 分别发出 `director:shop_closed/apprentice/trial/own_shop`。只在实时模式发出导演事件；回放模式禁用，避免回放改动后台。热键仅在页面获得焦点时有效。
- 逐字提示音默认关闭，可开启并调节音量；浏览器需要一次点击才允许播放。离线导出不含提示音和人声。
- 素材放在 `assets/jingjing/<emotion>_<open|closed>.png`，8 个 emotion 直接来自阶段 1 契约。缺图显示带 emotion、mouth、state 标签的占位色块。分层模式设置 `assetMode=layered` 并提供 `body.png`；脸部须与身体同尺寸、同锚点，保留透明区域。见该素材目录的说明。

网址可设置 `portraitX/portraitY/portraitWidth/portraitHeight/dialogX/dialogY/dialogWidth/fontSize/width/height/typeMs/volume`，以及 `innerOS=1`、`sound=1`、`assetMode=layered`。所有坐标以配置画布为基准，页面保持比例缩放。示例：

```text
http://127.0.0.1:8790/presentation?portraitX=1450&dialogY=760&fontSize=48&innerOS=0
```

F2 面板的“五状态演示”加载 `presentation-demo.jsonl`；也可选择本机 `data/events/<日期>.jsonl`，播放、暂停或拖动进度。不请求模型、不读取真实记忆、不请求麦克风。加载后断开实时 SSE；“回到实时”恢复连接。日志按 `mono` 回放，跨重启时结合 `wall` 恢复时间间隔；系统时钟跳变超过 250ms 也会被视为时间基准变化。日志错误会指出行号。日志起点归零，正常 thinking 延迟保留；剪辑时可修改独立日志去掉等待，显式 yield 仍按中断处理。

### 后台导出透明 PNG / ProRes 4444

只需 Node、阶段 1 契约文件和本机 Chrome/Edge，不必启动 CL、ASR 或中转。首次执行 `npm install --ignore-scripts`。也可设置 `JINGJING_CHROMIUM` 指向浏览器可执行文件。

在本目录执行（cmd）：

```bat
node render-overlay.mjs --log presentation-demo.jsonl --out renders\my-render --fps 24 --ffmpeg <path-to>\ffmpeg.exe
```

`renders` 父目录应先存在，输出目录必须是新目录，防止覆盖旧素材。省略 `--ffmpeg` 只导出 RGBA PNG 序列。可用 `--config config.json` 提供与页面相同的配置；用 `--duration 秒数` 显式裁切。默认自动等全部分页和排队轮次显示完，再追加 1 秒。不要把显式短时长用于完整对白交付。

输出包括 `frames/%06d.png`、可选 `overlay.mov`（ProRes 4444 alpha）、`events.jsonl`、`config.json`、`dialogue.txt`、`manifest.json` 与 `review.md`。画面层是可重渲染的浮窗覆盖层，日志与文本独立保留；改字或改立绘后只重渲染浮窗，不触碰游戏底片。导出配置不继承浏览器 localStorage，默认不显示内心 OS、不播放提示音。

验收样例：`renders/stage7-final/`，1920×1080、24fps、11.5 秒、276 帧。已检查 PNG 的 RGBA 和 MOV 解码后的 alpha；Shotcut GUI 已识别 MOV 的 1920×1080 ProRes 与 11.5 秒时长，MLT 后台叠加彩色底图通过。`shotcut-alpha-check.mlt` 与 `shotcut-composite.png` 为导入/叠加证据。剪映导入与叠加未验证，不宣称通过。

回归测试：`npm test`；只验证呈现：`npm run test:presentation`。包含五状态、逐字/嘴型、长句与连续轮次、打断、跨会话日志、透明画布、热键、内心 OS 及嵌入浮窗配置持久化。

## 验证

- `node --test tests/*.test.mjs`
- CL：在 `../vendor/CharacterLife-VideoCohost/vendor/characterlife` 下运行 `npm test` 与 `npm run typecheck`。
- 实际模型记忆写入和 CL 重启后的回忆结果：`direct-memory-verification.json`。
- 实际模型首增量时间、增量数量、最终文字一致性：`streaming-verification.json`。
- 切换前的 CL 一致性备份：`data/cl-before-direct-voice.sqlite`。

旧的 `/v1/chat/completions` 转发接口保留兼容；`/demo` 只演示显示，不写入真实对话记录。

## 鲸鲸游戏知识库 v2

已接入 `knowledge/Probably-Stolen-鲸鲸知识库-v2.md`，原始文件来自 Downloads，保留原件。CL 每轮读取本目录的副本：常驻世界观、收银终端身份、表达参考与剧透范围，并从用户话语及当前游戏观察中匹配第三层关键词或别名。

知识库作为参考资料进入模型上下文，不写入核心人格，不伪装成用户发言，不批量写入长期记忆。机制数值保留“静态分析、未在游戏内验证”的来源限制；第二层的示例资金、交易、治安、击杀等不会被当作真实事件，实际数据仍来自游戏接口。

`剧情:需已见过` 的条目默认不注入。后续在这份副本的「已见过清单」中手动追加对应派系或角色的已见事件，相关条目才会在命中时附加；普通聊天提及不会自动解锁剧情。每轮重新读取文件，编辑后下一轮生效。不要删除文档原有的层级标题。可用 `JINGJING_KNOWLEDGE_PATH` 为 CL 指定其他知识库路径。

加载信息写入 `cl.stdout.log`；测试在 CL 目录执行 `node --test tests/jingjing-knowledge.test.ts`。

## 游戏世界事件：Probably Stolen

```text
游戏只读模组 → Mods/JingjingWorldBridge/state.json（每 2 秒原子更新）
    → 浮窗 game-world.mjs → CL /v1/world/events（kind: observation）
    → 下一轮对话的外部观察资料区
```

模组已安装在游戏的 `Mods/JingjingWorldBridge`。首次在游戏「模组」菜单审阅并启用 **Jingjing World Bridge**，允许本地文件能力；按游戏提示重启并载入存档。启动浮窗后可直接询问鲸鲸「我现在有多少钱，有什么物品？」。不会主动产生聊天回复或伪造用户发言。

- 资金来自 `PlayerStore.playerCash`；库存只统计玩家拥有的物品，包含容器内物品，按标识、名称与位置汇总数量。柜台上顾客未成交物品、已售物品和垃圾不计入。
- 读取主库存、前后柜台、后仓、展示柜、暗仓、文件区、播放器、自动贩卖设备、雇员库存、外出口袋。未接入其他场景或地面散落物品，不读取隐藏估价或真伪。
- 首次发送快照；资金/库存变化时发送新观察，附资金差额和数量变化。库存移动也可能表现为位置增减，不能据此推断交易原因。跨周目或存档不计算收益。
- 相同内容去重；每 10 秒刷新一次当前快照，以便 CL 重启后恢复。失败使用相同事件 ID 重试，由 CL 幂等接收。观察存于 CL 内存，不自动成为长期记忆。
- 游戏退出、主菜单、模组禁用或快照超过 15 秒未更新时，当前状态为未知。模型资料也检查过期与分页完整性，避免沿用旧余额。
- 读取模组 1.4 起，还会报告玩家所在位置、伤情、难度、拾荒、议价和晨报：
    - **位置**（`playerLocation`）：取自 `MapUIManager.Current`、地图和结算界面，不再用游戏里那个只有“在店里/在博士店”两个值的旧字段。同一个地点停留满 5 秒才算到达，在地图上快速切换不会触发。
        - 出门、回店、走进夜间地点时各发一个事件。
        - 第一次去某地、今晚再次去同一地点，都会单独标出来。
        - 在夜间地点时，对面的人是那家店的店主（记为 `hostName`），不会报成“来客到店”。
    - **伤情**（`playerState`）：分健康、轻伤、重伤，以及伤情是否稳定；伤势变化时发事件。
    - **拾荒**：拾荒结果单件估值达到 50 记为“捡到好东西”（`scav:find`）；受伤单独发事件。
    - **议价**：打折、加价、勒索、威胁都会上报，附带游戏掷骰的结果（对方接受或拒绝）。
    - **晨报**：游戏早上那页“昨夜发生了什么”。
    - **难度**：每局报一次，难度改变时再报；附带游戏自己的规则说明，例如零售加价 15%。
- 来客按来访编号排序：每位来客先报到店，再报台词，下一位到之前先报上一位离开。名字显示为 Customer 的台词会标上当时在柜台前的来客。同一位来客重复的固定台词会标注“这句刚才说过”。
- CL 的 `world_jingjing_video` 只开启观察，不提供游戏动作能力。世界 token 独立保存在 `data/game-world-token.txt`，由 CL 首次启动生成，不返回给网页；可用 `JINGJING_WORLD_TOKEN` 覆盖，CL 与中转需设置一致。

读取接口（只监听本机）：

```text
GET http://127.0.0.1:8790/api/game/state
```

正常返回 HTTP 200，例如：

```json
{
    "enabled": true,
    "ready": true,
    "connected": true,
    "capturedAt": 1800000000000,
    "lastSentAt": 1800000000000,
    "error": null,
    "state": {
        "schemaVersion": 1,
        "source": "probably-stolen",
        "sessionId": "game-session-id",
        "capturedAt": 1800000000000,
        "ready": true,
        "saveSlot": 1,
        "runId": "run-id",
        "cash": 1200,
        "items": [{ "id": "item-id", "name": "物品名", "location": "store", "quantity": 2 }]
    }
}
```

无有效游戏数据时返回 HTTP 503、`ready: false`、`state: null`；这不影响语音与普通聊天。`/api/status` 增加 `game` 状态。`connected` 表示 CL 投递结果，与 `ready`（本地数据是否新鲜有效）分别报告。

自定义游戏位置：为中转设置 `JINGJING_GAME_STATE_PATH`，指向对应 `state.json`。采集超过 1000 类物品会返回不可用，不悄悄漏报。单条物品标识和名称在桥接中各限制为 48 字；CL 模型资料最多 12000 字，超长时明确标记剩余页面已省略，完整的规范化清单仍可通过读取接口取得。

模组源码和构建脚本：[`mods/JingjingWorldBridge/`](../mods/JingjingWorldBridge/)。重新构建安装：

```powershell
powershell -NoProfile -File ..\mods\JingjingWorldBridge\build.ps1 -Install
```

验证：浮窗目录执行 `node --test tests/*.test.mjs`；CL 目录执行 `npm test`、`npm run typecheck`；模组目录执行 `powershell -NoProfile -File .\test.ps1`。端到端测试使用临时游戏快照、真实 CL HTTP 接口和测试模型，不访问真实模型或真实记忆库。游戏内采集及数量对照尚未实测。
