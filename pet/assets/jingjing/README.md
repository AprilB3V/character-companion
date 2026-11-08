# 差分立绘

放入 `<emotion>_<mouth>.png`。emotion：smug、disgust、panic、stubborn、serious、curious、thinking、neutral；mouth：open、closed。

已接入参考图重绘的 `neutral_closed.png` 和 `neutral_open.png`，均为 1254×1254 RGBA 透明立绘。`design/three-view-v1.png` 为白底正/侧/背三视图设定稿，生成提示词和参考来源见 `design/generation-prompts.md`。

缺少某种情绪差分时，优先使用 neutral 的同嘴型立绘；连 neutral 也缺失时才显示占位色块。目前只有 disgust 没有独立差分（见下方 v2 表情帧），不将基础立绘冒充完整差分套件。

立绘默认水平、垂直居中，按实际可见轮廓等比例缩放，忽略外围透明留白；两帧共享轮廓边界和锚点。设置面板可点击“居中立绘”，再点“保存设置”。旧版右侧布局会自动迁移，音量与内心 OS 偏好保留。

分层模式：增加 `body.png`，设置 `assetMode=layered`。脸部差分使用与身体相同尺寸的透明画布、相同锚点；身体和脸部共同按立绘宽高缩放。缺少身体或脸部时回退占位块。各情绪两张嘴型应保持相同尺寸。

## v2 表情帧（2026-11-04）

已接入 13 帧：`neutral_blink`，以及 curious / thinking / smug / panic / stubborn / serious 各一对 `_closed` / `_open`。另有可选 `<emotion>_blink.png`：某情绪没有自己的眨眼帧时，那个表情不眨眼（目前只有 neutral 眨眼）。disgust 尚未生成，回退到 neutral。

状态与表情：在听 → curious，思考 → thinking，被打断 → panic；说话时用 CL 返回的 emotion。

**来源。** Codex 内置 image_gen 以 neutral 立绘为编辑对象生成原图，存于 `v2-staging/raw/`（提示词见 `v2-staging/tools/prompts.json`）。这类原图会把全身轻微重画一遍，直接换帧会跳，所以只取脸部改动贴回 neutral 底图：

- 脚本：`v2-composite/tools/composite.py`；批量重建：在 jingjing-overlay 目录运行 `bash assets/jingjing/v2-composite/tools/build.sh thinking smug ...`。
- 闭口帧：先做脸部合成（框 (395,455)–(865,715)，用开运算去掉头发线条的重绘漂移）；再补嘴部框 (540,580)–(720,690) 和眉毛带 (440,455)–(820,512)，这两步不做开运算，保留细线条的嘴型和眉毛。
- 旧眉修复已于 2026-11-08 从 11 月 5 日修正版同步到本仓库，并补修 smug。stubborn、serious 和 smug 的原始眉毛位于刘海区域，原合成框未覆盖它们，导致新旧眉毛同时显示。脚本为这三种表情增加 `oldbrows` 步骤，使用框 (440,400)–(820,462) 替换旧眉区域。闭口和开口共六帧均使用修正版。
- 开口帧：以同情绪闭口帧为底，只合成嘴部，说话时眼睛不闪。
- 脚本会断言每次合成框外与底图逐字节一致。stubborn、serious 和 smug 的允许编辑区域还包含上述旧眉区域。

`v2-staging/` 根目录的 `neutral_blink.png`、`curious_closed.png` 是 Codex 早先未合成的原图副本，其清单已标为 rejected，不要使用。修改表情时回到 raw 原图重新生成，再跑 build.sh，不要直接改合成结果。

可复用原件、用户参考图及三视图归档到：`AccountOperations/素材库/图片/角色立绘/鲸鲸_v001/`；v2 表情帧、原图与合成脚本归档到 `鲸鲸_v002_表情帧/`。均采用复制归档，保留原始图片。
