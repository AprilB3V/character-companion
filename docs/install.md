# Windows 安装

便携版发布后，可运行 `install.cmd --portable --non-interactive`，或双击
`install.cmd`。安装器下载 Release 附件，检查 SHA-256 及包内文件清单，
安装到当前用户目录，并打开首次模型配置。便携版包含运行环境。

当前候选版本为 `v0.1.0-rc.4`，公开附件发布前此下载入口不可用。
也可以下载 ZIP 后完整解压，双击 `Configure.cmd` 配置、
`CharacterCompanion.cmd` 启动，以及 `Stop.cmd` 停止。

## 开发者从源码安装

需要 Git、Node.js 22.18 或以上版本及 npm，以及对仓库和私有 VideoCohost 子模块的读取权限。先确认 Git 凭据已配置，再从 Git 检出的仓库根目录执行。

```cmd
install.cmd --non-interactive
```

安装器按仓库记录的版本初始化子模块，并用锁文件安装内核和浮窗的依赖。退出码 `0` 和 `INSTALL_OK` 表示依赖已装好，`1` 表示安装失败，`2` 表示参数无效。权限或下载失败时修复原因后可重试。升级前先停止当前运行的伴侣。

模型配置通过本机设置页完成：便携版双击 `Configure.cmd`（或 `CharacterCompanion.cmd setup`），源码安装运行 `node pet\config-app.mjs`。设置页只监听 `127.0.0.1` 并带一次性令牌，可测试连接、保存、启动与停止。配置写入 `%LOCALAPPDATA%\CharacterCompanion\config\.env.video.local`，保存前备份为 `.env.video.local.bak`；文件或设置行被删除、设置行仍带 `#` 时，设置页会提示并在保存时修复。配置不完整时直接启动 `CharacterCompanion.cmd` 也会自动打开设置页。`CharacterCompanion.cmd setup notepad` 保留手动编辑入口。正常启动会检查配置，保存模型设置后再次启动会重新加载后台服务。离线界面检查使用显式的 `CharacterCompanion.cmd -Demo`，浮窗会标明固定台词演示。

## 启动与验收

```cmd
pet\start.cmd -Installed
```

- **接口**：游戏内启用 JingjingWorldBridge 后，Mod 写入本地 `state.json`。浮窗中转服务读取快照并向 CharacterLife 提交观察事件。工坊安装及游戏内激活请参见 [Mod 说明](../mods/JingjingWorldBridge/README.md)。
- **内核**：CharacterLife API 使用本机端口 8787，控制台使用 8788。
- **浮窗**：Electron 从本机 8790 的中转服务取得展示内容。源码安装的默认入口使用文字输入。

通过 `http://127.0.0.1:8790/api/status` 检查 `cl.connected` 和独立的游戏状态。游戏运行并启用 Mod 后，可在 `/api/game/state` 检查是否读到了快照。协议规划见 [本地连接协议](protocol.md)。

无窗口离线验收可运行 `powershell -NoProfile -ExecutionPolicy Bypass -File pet/start.ps1 -Installed -NoWindow -Demo`。服务状态的 `model.mode` 区分真实模型配置和演示模式，`cl.character` 显示实际角色绑定。结束时执行 `powershell -NoProfile -ExecutionPolicy Bypass -File pet/stop.ps1 -Installed -IncludeCl`。
