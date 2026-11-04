# 鲸鲸游戏世界接口

面向本机 Probably Stolen `VERSION 100-Rev6`。使用游戏内置 `IMod` 加载器，无需修改原版 DLL。每两秒在 Unity 主线程读取一次并原子写入 `%LOCALAPPDATA%\CharacterCompanion\probably-stolen\state.json`（1.2.0 起；与安装位置无关，工坊订阅也能用。1.1 写在游戏 `Mods/JingjingWorldBridge/` 下，浮窗两处都会找，读最近写入的那份）。

读取资金、存档槽、周目 ID，以及玩家拥有的物品名称、标识、数量、库存位置。覆盖主库存、柜台、后仓、展示柜、暗仓、文件区、播放器、自动贩卖设备、雇员库存和外出口袋；递归读取容器内容，排除顾客未成交物品、已售区、垃圾区和查看界面的虚拟物品。同时记录游戏写入对话记录的每句完整台词（柜台与电话，最多保留 40 句，单句截断到 180 字），说话人取自游戏显示的名字，店主自己的台词标为 player。不读取鉴定真伪、隐藏估价，也不执行买卖或修改存档。

```powershell
# Build and install with the existing .NET Framework compiler and game assemblies.
powershell -NoProfile -File .\build.ps1 -Install
# Run the production collector against minimal game/Unity test doubles.
powershell -NoProfile -File .\test.ps1
```

安装目录为游戏的 `Mods/JingjingWorldBridge`，只部署 DLL 和 manifest。首次使用需在游戏模组菜单审阅并启用 `Jingjing World Bridge`，允许声明的本地文件能力；如游戏提示重启则重启，然后载入存档。不会代替用户确认游戏自带的模组信任提示。

浮窗读取接口：`GET http://127.0.0.1:8790/api/game/state`。未载入、读取失败或超过 15 秒没有新快照时返回 HTTP 503 和 `state: null`。正常时返回 HTTP 200 和完整快照，`connected` 单独表示最近一次 CL 事件投递是否成功。

CL 端配置与事件说明见 [`pet/README.md`](../../pet/README.md)。自动化测试覆盖采集逻辑和文件到 CL 的完整通道；实际游戏载入和游戏内数量对照仍需验证。

## 创意工坊测试包

```powershell
# Build, then stage content + preview + SteamCMD item file under workshop/stage (gitignored). Default visibility: private.
powershell -NoProfile -File .\workshop\prepare.ps1
```

上传需用自己的 Steam 账号手动执行脚本最后打印的 `steamcmd ... +workshop_build_item ...` 命令。首次上传会创建新条目并打印 ID；之后更新带上 `-PublishedFileId <ID>`。改为公开：`-Visibility 0`。

验收步骤：

1. 删除或停用游戏目录 `Mods\JingjingWorldBridge` 里手动安装的旧版（同一 ID，避免重复加载）。
2. 订阅自己的私有条目，等待下载；在游戏模组窗口启用并允许“本地文件”能力，重启后载入存档。
3. 确认 `%LOCALAPPDATA%\CharacterCompanion\probably-stolen\state.json` 每两秒更新，`capturedAt` 递增、资金与游戏一致。
4. 浮窗 `GET http://127.0.0.1:8790/api/game/state` 返回 200。
