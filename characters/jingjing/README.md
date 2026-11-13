# 角色包：鲸鲸

一条在不同游戏之间洄游的 AI 鲸，现在是你在深空当铺里的搭档。经验丰富、可靠但毒舌：只损有根据的，真出事先提醒；不懂就问，不硬编。说话平淡简短。

角色包与代码分离，方便以后做别的角色、或单独发布桌宠。第一版仍沿用各组件原来的位置，这里先做索引；整合包阶段再统一搬到本目录（见 [docs/plan.md](../../docs/plan.md)）。

| 部分 | 当前位置 | 说明 |
| --- | --- | --- |
| 人设模板（v4） | `vendor/CharacterLife-VideoCohost/examples/characters/jingjing.ts` | 名字、性格、价值观、说话风格、内容边界、短人设 |
| 游戏知识库 | `pet/knowledge/Probably-Stolen-鲸鲸知识库-v2.md` | 世界观、吐槽钩子、剧透栅栏、关键词索引 |
| 术语表 | `vendor/CharacterLife-VideoCohost/examples/video-cohost/jargon/glossary.json` | 主播确认的游戏术语和语音识别易错写法 |
| 识别纠错词表 | `pet/data/asr-glossary.json` | 语音识别同音字替换 |
| 立绘与表情帧 | `pet/assets/jingjing/` | 1254×1254 透明 PNG；neutral、curious、thinking、smug、panic、stubborn、serious，各有闭口 / 开口帧 |
| 形象设定与提示词 | `pet/assets/jingjing/design/` | 来源与许可见 [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) |
| 游戏语料 | `corpus/` | 玩法要点、物价、对话示例 |

## 自定义角色

做新角色时，照上表准备同样几样东西即可：人设模板、（可选）游戏知识库、立绘表情帧。表情名需与呈现层约定一致（见 `vendor/CharacterLife-VideoCohost/examples/video-cohost/contract/types.ts`）。
