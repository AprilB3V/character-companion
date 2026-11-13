# Character Companion · 鲸鲸

> A desktop companion powered by [CharacterLife](https://github.com/AprilB3V/CharacterLife): it watches your game, remembers what happened, and talks back. First character: Jingjing, a migrating AI whale living in the cash register of *Probably Stolen*.

鲸鲸是一条在不同游戏之间洄游的 AI 鲸，是你在《Probably Stolen》（深空当铺）里的搭档。她看得见你的账本、库存、你在哪、伤得怎样，听得见你说话；经验丰富、嘴上不饶人，真出事时会一边损你一边提醒你。

这个仓库是“角色伴侣”的通用外壳：浮窗桌宠、游戏适配 mod、角色包和语料分开存放，换角色、换游戏只换对应的那一层。背后的记忆、身份与主动搭话由 CharacterLife 负责。

## 现状

开发中，还不是给玩家的整合包。目前可用：

- **桌宠浮窗**（`pet/`）：Electron 透明窗口，语音输入（本地 SenseVoice）→ CharacterLife → 流式文字与表情差分；可缩放、托盘隐藏、鼠标穿透。
- **游戏读取 mod**（`mods/JingjingWorldBridge/`）：《Probably Stolen》官方 mod 接口 + Harmony，只读资金、库存、台词与交易，不改存档、不代替玩家操作。
- **角色包**（`characters/jingjing/`）：人设、知识库、术语表、立绘表情帧的索引。
- **语料**（`corpus/`）：脱敏后的游戏要点、物价参考和对话示例，可用脚本重新导出更新。

路线图和“两步上手”整合包计划见 [docs/plan.md](docs/plan.md)，本地连接协议草案见 [docs/protocol.md](docs/protocol.md)。

## 目录

```
pet/                 desktop overlay (Electron shell, relay, speech service, presentation)
mods/                game adapters; JingjingWorldBridge for Probably Stolen
characters/jingjing/ character pack index
corpus/              desensitized game notes and dialogue samples
tools/               corpus export and sensitive-data scan
vendor/              CharacterLife video cohost (git submodule, includes the CharacterLife kernel)
docs/                plan and protocol
```

## Windows 安装

公开便携版本发布后，Harness 可在仓库根目录运行 `install.cmd --portable --non-interactive`，或手动双击 `install.cmd`。便携包包含运行环境。开发者源码安装命令、首次配置和游戏接入说明见 [Windows 安装](docs/install.md)。候选版本及验收进度见 [发布检查单](docs/releases/readiness.md)。

## 开发者运行

需要 Windows、Node.js ≥ 22.13、带语音依赖的 Python 环境（`pet/requirements-speech.txt`）和 SenseVoice 模型，以及一份 CharacterLife 模型配置（`.env.video.local`，不在仓库中）。

```bash
git clone --recurse-submodules https://github.com/AprilB3V/character-companion.git
```

```bash
cd character-companion/pet && npm install
```

复制 `pet/local.example.ps1` 为 `pet/local.ps1` 填好本机路径，然后运行 `pet/start.cmd`。详细说明见 [pet/README.md](pet/README.md)。

离线测试：

```bash
cd pet && node --test tests/game-world.test.mjs tests/asr-correction.test.mjs tests/history.test.mjs tests/voice.test.mjs tests/proactive-runner.test.mjs tests/presentation.test.mjs
```

## 隐私

- 所有服务只监听本机；API Key 只在本机服务端使用。
- 对话记录、记忆数据库、令牌文件都在 `.gitignore` 中；提交前运行 `node tools/scan-sensitive.mjs`。

## 许可

原创部分采用 [MIT](LICENSE)。鲸鲸形象参考与提示词来自社区项目 [deepseek-whale-girl](https://github.com/TreapGoGo/deepseek-whale-girl)（MIT），游戏名称与内容归其权利人所有，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目为非官方作品，与 DeepSeek 及《Probably Stolen》开发商无关。
