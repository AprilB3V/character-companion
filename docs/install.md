# Windows 源码安装

需要 Git、Node.js 22.18 或以上版本及 npm，以及对仓库和私有 VideoCohost 子模块的读取权限。先确认 Git 凭据已配置，再从 Git 检出的仓库根目录执行。

```cmd
install.cmd --non-interactive
```

安装器按仓库记录的版本初始化子模块，并用锁文件安装内核和浮窗的依赖。退出码 `0` 和 `INSTALL_OK` 表示依赖已装好，`1` 表示安装失败，`2` 表示参数无效。权限或下载失败时修复原因后可重试。升级前先停止当前运行的伴侣。

也可以双击 `install.cmd`。成功后会打开首次配置文件 `%LOCALAPPDATA%\CharacterCompanion\config\.env.video.local`。取消三个 `DEEPSEEK_*` 设置行的注释并填入模型参数，即可使用真实模型。留空时内核使用模拟回复，可用于离线检查。配置和聊天数据库保留在当前用户目录。

## 启动与验收

```cmd
pet\start.cmd -Installed
```

- **接口**：游戏内启用 JingjingWorldBridge 后，Mod 写入本地 `state.json`。浮窗中转服务读取快照并向 CharacterLife 提交观察事件。工坊安装及游戏内激活请参见 [Mod 说明](../mods/JingjingWorldBridge/README.md)。
- **内核**：CharacterLife API 使用本机端口 8787，控制台使用 8788。
- **浮窗**：Electron 从本机 8790 的中转服务取得展示内容。源码安装的默认入口使用文字输入。

通过 `http://127.0.0.1:8790/api/status` 检查 `cl.connected` 和独立的游戏状态。游戏运行并启用 Mod 后，可在 `/api/game/state` 检查是否读到了快照。协议规划见 [本地连接协议](protocol.md)。

无窗口验收可直接运行 `powershell -NoProfile -ExecutionPolicy Bypass -File pet/start.ps1 -Installed -NoWindow`。结束时执行 `powershell -NoProfile -ExecutionPolicy Bypass -File pet/stop.ps1 -Installed -IncludeCl`。
