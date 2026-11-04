# 鲸鲸游戏世界接口

面向本机 Probably Stolen `VERSION 100-Rev6`。使用游戏内置 `IMod` 加载器，无需修改原版 DLL。每两秒在 Unity 主线程读取一次并原子写入 `Mods/JingjingWorldBridge/state.json`。

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
