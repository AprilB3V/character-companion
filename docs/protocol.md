# 本地连接协议（草案 v0）

> 状态：草案，尚未实现。现行链路是读取器写 `state.json`、浮窗中转轮询后投递给 CL（见 `pet/README.md`“游戏世界事件”）。阶段一按本草案改造。

后端是唯一中心；游戏适配 mod 与桌宠都是客户端。换游戏只需按本协议再写一个适配器。

## 传输与发现

- 后端在 `127.0.0.1` 开 WebSocket，只监听本机；默认端口固定，被占用时自动换端口。
- 后端启动后把实际端口写入 `%APPDATA%/CharacterCompanion/endpoint.json`：`{ "port": 8787, "protocol": 1, "pid": 1234 }`。客户端读不到时回退默认端口。
- 鉴权：endpoint.json 同时写入一次性随机 `token`，客户端握手时带上；文件只对当前用户可读。

## 消息

JSON，每条带 `type` 与 `protocol`。

```json
{ "protocol": 1, "type": "hello", "role": "game", "client": "jingjing-world-bridge/1.1.0", "game": "probably-stolen", "token": "..." }
{ "protocol": 1, "type": "welcome", "server": "characterlife/…", "accepted": true }
```

协议版本不兼容时后端回 `{ "type": "welcome", "accepted": false, "reason": "protocol" }`，mod 在游戏内提示“请更新整合包”。

### mod → 后端

| type | payload |
| --- | --- |
| `heartbeat` | 无 |
| `npc_dialogue` | `npc`、`text`、`line_index` |
| `npc_action` | `npc`、`action` |
| `credit_change` | `delta`、`balance_before`、`balance_after`、`reason` |
| `transaction` | `kind`（buy/sell）、`item`、`price`、`counterparty` |
| `scene` | `scene`、`shop_open` |

事件字段与现行 `data/game-events/*.jsonl` 一致，便于迁移。

### 后端 → mod

| type | payload |
| --- | --- |
| `companion_speaking` | `speaking: true/false`，供游戏内显示小提示 |

指令类消息留到以后。

### 后端 ↔ 桌宠

沿用现有通道（台词、表情差分、说话状态），见 `vendor/CharacterLife-VideoCohost/examples/video-cohost/contract/`。

## 断线

客户端每隔几秒重试；mod 在游戏内只提示一次“请先打开启动器”，不刷屏。
