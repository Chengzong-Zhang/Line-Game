# LIFELINE 棋谱与复盘协议

状态：设计稿；本文件只定义协议，不改变游戏源码、研究代码或训练流程。  
适用范围：`web/web前端/GameEngine.js` 的 Web 对局、`GameController` 的恢复流程、`OnlineApp`/联机动作日志，以及可明确标注为研究版的 Python 规则状态。

## 1. 目标与不可变约束

棋谱的权威内容是“配置 + 初始状态 + 已接受的动作事件”。棋盘、合法动作、领土、赢家和 UI 文案都是回放得到的结果；导出的派生快照只能用于加速和核验，不能替代动作历史。

协议必须满足：

1. 同一 `engineFamily`、`rulesVersion`、配置和动作前缀，在支持该版本的实现中产生相同的规则状态。
2. Superko 所需的完整历史集合不能被省略。只保存棋盘或 observation digest 的文件不是可验证棋谱。
3. 每个事件有严格顺序、前状态承诺和后状态承诺；任何缺失、重排、重复、篡改或非法事件都使该前缀之后的内容不可验证。
4. 导入先在隔离引擎中完成结构校验和完整回放，全部成功后才替换当前对局；失败不得污染当前棋盘。
5. 自动跳过是规则转移的副作用，不作为用户动作再次写入或再次执行。
6. Worker、AI 搜索、渲染、计时器、网络请求号和 Vue 派生状态不属于公开棋谱的规则状态。

当前协议版本定义为 `schemaVersion: 1`。版本号是整数；不使用“猜测兼容”的小数或缺省版本。

## 2. 术语与状态分层

| 层 | 内容 | 是否权威 |
|---|---|---|
| 配置 | `gridSize`、玩家数/顺序、`startPlayer`、`rulesVersion`、引擎族 | 是 |
| 规则状态 | 棋盘、显式逻辑边、Superko 历史、当前行动方、跳过计数、认输集合、终局标记、`turnCount` | 是 |
| 动作日志 | 已接受的 `move`、`skip`、`resign` 事件及其承诺 | 是 |
| 派生状态 | 合法动作、领土、多边形、分数、赢家、事件说明 | 否，必须可重算 |
| 运行时状态 | `positionRevision`、`territoryStateRevision`、Worker request、Canvas/Vue/网络连接状态 | 否，不进入规则等价判断 |
| 研究观测 | `grid`/`topology`/`topology_history` observation 及 legal mask | 否；它是状态投影，不是恢复凭据 |

研究中的完整规则状态可写成 `x=(B,E^B,E^W,p,k,z)`：物理棋盘、双方逻辑边、历史集合、当前玩家、连续跳过数和终局标记；`turnCount` 是审计字段，不决定规则等价，但仍保存在棋谱中用于检测计数漂移。

## 3. 顶层文档 schema

顶层 JSON 对象的必需字段如下。字段名采用 camelCase；扩展字段必须放在 `extensions` 下，不得改变必需字段含义。

```json
{
  "format": "lifeline-replay",
  "schemaVersion": 1,
  "engineFamily": "web-game-engine",
  "rulesVersion": "territory-v2",
  "engineBuild": {
    "id": "git-commit-or-source-sha256",
    "sourceHash": "sha256:..."
  },
  "config": {
    "gridSize": 9,
    "playerCount": 2,
    "players": ["BLACK", "WHITE"],
    "startPlayer": "BLACK",
    "superko": "enforce",
    "turnTimerEnabled": false,
    "turnTimeLimitSeconds": 60,
    "hintEnabled": false,
    "hintMaxCount": 3
  },
  "initialState": { "stateVersion": 1, "ruleState": { "...": "..." }, "stateHash": "sha256:..." },
  "actions": [],
  "checkpoints": [],
  "terminal": null,
  "integrity": {
    "eventCount": 0,
    "finalEventHash": "sha256:...",
    "finalStateHash": "sha256:...",
    "canonicalDocumentHash": "sha256:..."
  },
  "extensions": {}
}
```

### 3.1 版本与引擎身份

- `format` 必须等于 `lifeline-replay`。
- `schemaVersion: 1` 只表示棋谱容器格式，不表示规则版本。
- `rulesVersion` 当前允许 `territory-v1`、`territory-v2`，必须与 `GameEngine` 的值逐字一致。规则实现发生变化时，即使 JSON 结构不变也必须升规则版本或更换 `engineFamily`。
- `engineFamily: web-game-engine` 表示由 Web `GameEngine` 回放；研究 Python 实现使用独立值，例如 `research-lifeline-rl`，不可仅凭字段名互相加载。
- `engineBuild.id` 在导出时必须是可追溯的提交、发布构建 ID 或源文件 SHA-256；缺失时可以作为“结构可读”导入，但不能标记为 exact verification。
- 不支持的 schema 或 rules 版本必须 fail closed：可展示文件元数据和“需要升级/兼容包”，不得执行动作、不得把未知字段当成已知动作。

### 3.2 配置

`config` 是创建引擎的唯一来源：

- `gridSize` 必须为当前引擎支持范围内的整数；Web 当前为 5–15，OnlineApp UI 默认选项为 6–15，二者不应混写成同一约束。
- `playerCount` 为 2 或 3；`players` 必须是稳定顺序的 `BLACK`、`WHITE`、可选 `PURPLE`，长度与玩家数相同。
- `startPlayer` 必须属于 `players`。初始角点由规则实现按玩家数推导，不从 UI 棋盘图片推断。
- `superko` 必须显式写出 `enforce`；研究版允许另有 `observe`，但 `observe` 只能标为研究/反事实棋谱，不能冒充 Web 正式棋局。
- 计时器、提示开关和提示次数保留为可复盘元数据。计时器本身不改变规则；只有服务器/控制器真正接受的 `skip` 才进入动作日志。
- 联机 `playerId`、用户名、房间号可放在 `extensions.online`，不作为规则身份；规则身份使用颜色。

## 4. 规则状态与规范化表示

`initialState` 和每个检查点的 `ruleState` 使用以下可 JSON 化表示。数组必须按规定排序后再哈希；禁止直接序列化 JS `Map`、`Set`、Python `frozenset` 或对象地址。

```json
{
  "stateVersion": 1,
  "configHash": "sha256:...",
  "gridEntries": [[0, 0, 1], [8, 0, 3]],
  "edges": {
    "BLACK": ["0,0|0,1"],
    "WHITE": [],
    "PURPLE": []
  },
  "historyKeys": [
    {
      "nextPlayer": "BLACK",
      "occupied": [[0, 0, 1], [8, 0, 3]],
      "edges": { "BLACK": [], "WHITE": [], "PURPLE": [] }
    }
  ],
  "currentPlayer": "BLACK",
  "gameOver": false,
  "consecutiveSkips": 0,
  "resignedPlayers": [],
  "turnCount": 0
}
```

规范化规则：

- `gridEntries` 只列非空点，按三角坐标的引擎索引顺序排序；点状态使用 `PointState` 数字值。
- `edges[player]` 使用端点坐标升序后以 `|` 连接，边集合按字符串排序。边必须对应当前双方节点和规则允许的连线；不能只由当前棋盘重新猜边。
- `historyKeys` 必须包含初始键及所有已接受落子后的键，按稳定的 canonical JSON 排序；键中至少包含 `nextPlayer`、非空棋盘和所有玩家的逻辑边。若某规则版本的历史键还包含其他规则字段，必须全部包含。
- `currentPlayer`、`gameOver`、`consecutiveSkips`、`resignedPlayers`、`turnCount` 必须与引擎结果一致。`resignedPlayers` 去重并按玩家顺序保存。
- `territories`、polygon、`legalMoves`、`winner` 不放在 `ruleState`；它们在 checkpoint/terminal 中可作为派生审计副本，但验证器必须重算。
- `positionRevision`、territory cache revision 不属于跨实现状态等价；可以在 `diagnostics` 记录，不能作为回放失败依据。

`stateHash = SHA-256(canonicalJson(ruleState))`。canonical JSON 固定 UTF-8、排序键、无多余空白、有限数值；实现必须记录哈希算法名称，禁止使用语言内置随机 hash。

## 5. 动作事件

`actions` 只保存成功提交的规则动作，序号从 1 开始，不能跳号。推荐事件形状：

```json
{
  "seq": 7,
  "type": "move",
  "actor": "BLACK",
  "point": [2, 3],
  "preStateHash": "sha256:...",
  "postStateHash": "sha256:...",
  "preTurnCount": 3,
  "postTurnCount": 4,
  "effects": {
    "autoSkippedPlayers": []
  },
  "prevEventHash": "sha256:...",
  "eventHash": "sha256:..."
}
```

`eventHash` 定义为 `SHA-256(canonicalJson({ ...eventWithoutEventHash, prevEventHash }))`；首事件的 `prevEventHash` 为固定字符串 `GENESIS`。`eventWithoutEventHash` 不得包含验证时才生成的字段，避免同一事件因对象字段顺序或本地时间不同而产生不同哈希。

事件类型：

| `type` | 必需字段 | 语义 |
|---|---|---|
| `move` | `actor`、`point` | 当前行动方在合法坐标落子；包含攻击/清除/连线等全部规则副作用 |
| `skip` | `actor` | 当前行动方主动跳过一次；由 `skipTurn()` 执行 |
| `resign` | `actor`、可选 `target` | `target` 默认为 `actor`；正式棋谱要求二者相同，除非扩展声明有裁判代认输 |

`actor` 必须等于事件执行前的 `currentPlayer`，除非是明确声明的裁判扩展；不能信任网络 payload 中的颜色覆盖引擎当前行动方。`point` 必须是两个整数且属于当前三角棋盘。事件 `effects` 和 `pre/post` 承诺都是验证字段，不是额外动作。

当前联机服务的 `player_move`、`player_skip`、`player_resign` 在导出时转换为本协议的 `move`、`skip`、`resign`；`playerId` 进入非规则元数据。服务器重复认输记录应在适配时去重并报告，而不是静默生成第二个成功事件。

非法尝试不进入 `actions`。若需要复盘“用户点过非法点”，放在非权威的 `attempts` 扩展中，记录 `seqCandidate`、输入、预期 `reason`（如 `INVALID_MOVE`、`SUPERKO_VIOLATION`、`GAME_OVER`）；验证器不得执行它，也不得让它改变事件序号。

### 5.1 自动跳过

落子后，当前引擎会检查无合法动作、已认输玩家和认输终局，并可能自动切换或增加 `consecutiveSkips`。这些转移不再追加 `skip` 事件、不增加用户动作数；验证器从同一个规则调用自然得到它们，并把实际自动跳过玩家写入可选 `effects.autoSkippedPlayers` 供比对。主动 `skip` 仍只记录一条事件。

## 6. 终局摘要

未终局时 `terminal` 必须为 `null`。终局时必须包含：

```json
{
  "status": "completed",
  "reason": "all_remaining_players_skipped",
  "lastEventSeq": 14,
  "winner": "BLACK",
  "scores": { "BLACK": 8, "WHITE": 5, "PURPLE": 0 },
  "resignedPlayers": [],
  "finalStateHash": "sha256:...",
  "turnCount": 10,
  "verified": false
}
```

`reason` 至少区分 `all_remaining_players_skipped`、`resignation` 和 `unknown_legacy`。`winner` 为玩家颜色、`DRAW` 或 `null`；分数和 polygon 必须由终局规则重算。`verified` 只有独立验证器完成全量回放、最终状态承诺和摘要比对后才能为 `true`；导出程序不能仅因为自己写出了文件就填写 `true`。

## 7. 导出、写入和检查点

### 7.1 原子写入

本地自动保存应保留一个已提交版本和一个临时写入版本：先写临时文件、刷新并关闭、计算完整哈希，再原子替换已提交文件；替换失败应保留旧版本并报告。不能把半写 JSON 当作可恢复棋谱。若使用 JSONL 日志，最后一条必须有完整换行、长度和 `eventHash`，不完整尾记录只能隔离，不能自动拼接。

### 7.2 检查点格式

长棋谱可每 32 个已接受事件、每次显著恢复点以及终局写 checkpoint。每个 checkpoint 至少有：

```json
{
  "atEventSeq": 32,
  "prefixEventHash": "sha256:...",
  "ruleState": { "stateVersion": 1, "...": "..." },
  "stateHash": "sha256:...",
  "historyDigest": "sha256:...",
  "createdBy": "replay-writer-v1"
}
```

检查点必须包含完整 `historyKeys`，不能只保存 board/observation。恢复流程先验证配置、前缀哈希和检查点格式；在“可信检查点”模式下还必须用独立规则实现从初态回放到该点一次，之后才可从该点回放尾部。未经验证的 checkpoint 只能作为加速候选，不能成为完成证明。

恢复成功条件是：前缀事件数、`prefixEventHash`、`stateHash`、`historyDigest`、`turnCount` 和最终摘要全部一致。旧 checkpoint、不同配置、不同引擎族或不同 rules version 不得拼接。已完成事件保留；损坏尾部进入隔离区并留下恢复报告，不覆盖原始证据。

## 8. 导入校验与逐步重放

导入按以下顺序 fail closed：

1. 限制文件大小、读取 UTF-8、解析 JSON；拒绝重复顶层对象、NaN/Infinity 和不可序列化值。
2. 校验 `format`、`schemaVersion`、必需字段、字段类型、配置范围、玩家顺序和 `rulesVersion`/`engineFamily` 支持情况。
3. 规范化配置和 `initialState`，校验 `configHash`、初始状态哈希和初始历史键；不允许把缺失历史当作空集合。
4. 顺序检查 `seq`、`prevEventHash`、`eventHash`、点坐标、玩家身份和事件结构；未知事件类型直接拒绝，不跳过继续播放。
5. 在隔离 `GameEngine` 上逐事件执行。每步执行前比较 `preStateHash`，执行后比较 `postStateHash`、事件序号、`turnCount`、`currentPlayer`、自动跳过副作用和 `historyKeys`。
6. 事件耗尽后重算终局、领土、分数和赢家，与 `terminal`、`integrity.finalStateHash` 比较；未终局不得接受 completed 摘要。
7. 所有检查通过后一次性替换当前控制器状态；任一步失败，保留当前对局并返回包括 `eventSeq`、错误类别、期望/实际摘要的诊断。

逐步复盘使用“状态索引 + 动作前缀”：首步显示初始状态，下一步只执行一个尚未执行事件，上一步从最近已验证 checkpoint 或初态重新回放到目标序号。每个展示快照都重新生成派生合法动作、领土和赢家；时间轴跳转不能直接把一个未验证的 UI snapshot 当作规则状态。

当前 `GameEngine.replayBatch(callback)` 已提供事务语义：在隔离引擎中同步执行，失败不提交，成功才复制状态。协议实现应在其外层补齐逐事件 hash、schema 和摘要校验，而不是直接把任意对象传给 callback。

## 9. 损坏、未知版本和降级行为

| 情况 | 处理 | 是否可继续操作当前局 |
|---|---|---|
| JSON/UTF-8/大小错误 | 标记 `CORRUPT_CONTAINER`，保留原文件 | 可以 |
| 缺字段、类型错、哈希错 | 标记 `SCHEMA_ERROR`/`INTEGRITY_ERROR` | 可以 |
| 事件非法或回放失败 | 精确指出首个失败 `seq`，拒绝整个导入 | 可以 |
| 未知 `schemaVersion` | 只读元数据，提示升级；不猜测迁移 | 可以 |
| 已知旧 schema | 先用显式 migrator 生成内存中的 v1，再完整回放；不覆盖原件 | 可以 |
| 未知 `rulesVersion`/`engineFamily` | 只读展示基本信息，禁止声称可重放 | 可以 |
| 缺 `engineBuild` | 可兼容回放但标 `NON_EXACT_BUILD`；不能标 exact | 可以 |
| 完整前缀 + 损坏尾部 | 仅在尾部完整性证明成立时恢复到最后 checkpoint，并保留隔离尾部 | 可以 |
| 导入时 Worker 失败/迟到 | 规则回放仍以主线程结果为准；丢弃过期 Worker 结果 | 可以 |

不得为“让文件能打开”而删除未知事件、截断中间事件、补默认 `rulesVersion`、重算并覆盖原哈希，或把服务端元数据当成规则裁决。

## 10. 与内部 worker snapshot 的边界

### 10.1 可复用内容

`AIStateProtocol.serializeEngineState(engine)` 已覆盖许多恢复所需的内部字段：`gridSize`、`playerCount`、`startPlayer`、`rulesVersion`、`positionRevision`、`activePlayers`、`gridEntries`、三方 edges、`historyHashes`、`consecutiveSkips`、`resignedPlayers`、`currentPlayer`、`gameOver` 和 `turnCount`。这些字段可作为生成公开 `ruleState` 的输入，经规范化、版本化、哈希后再写出。

`isWorkerResultCurrent`/`isWorkerResultForRequest` 的 revision、rules version、current player 检查可复用于丢弃过期异步结果。`GameEngine.applyTerritoryCache` 的 revision 检查可继续保护显示缓存。

### 10.2 不可直接复用的内容

- `AIStateProtocol` 当前没有公开棋谱的 `schemaVersion`、`engineFamily`、canonical hash、事件链或导入错误分类；它是内部 Worker transport，不是长期文件格式。
- `serializeEngineState` 中的 `positionRevision` 是运行时计数，不能作为跨实现规则身份；`engine` 引用、request ID、Worker session 和 deferred cache 更不能落盘。
- Worker 只计算显示用 territory；`territoryPending`、polygon、`displayArea` 和迟到结果不改变落子合法性或 Superko 历史。终局分数必须由主规则引擎同步结算。
- `getSnapshot()` 是 UI/网络视图，含 `legalMoves`、territories 和 `winner`，但没有完整 Superko history 与显式内部边的稳定公开 schema，不能单独作为可恢复棋谱。

边界原则：公开棋谱重放依赖“动作日志 + 规则引擎”；Worker snapshot 只作为短生命周期加速缓存。二者都可有自己的版本和哈希，但不能互相冒充。

## 11. 当前接口可复用之处与缺口

| 现有入口 | 可复用 | 需要协议层补充 |
|---|---|---|
| `GameEngine` | `playMove`、`skipTurn`、`resignPlayer`、`getSnapshot`、`getWinner`、`getLegalMoves`、`replayBatch`、Superko/自动跳过/终局规则 | 公开稳定的 `exportRuleState`/`stateHash`；把内部 Map/Set 转成规范格式；记录终止原因 |
| `GameController.restoreMatchState` | 创建候代引擎、顺序回放 `player_move/player_skip/player_resign`、失败保留原引擎、成功后替换 | 版本/哈希/actor/前后状态校验；当前 action 形状没有 event chain；当前把同意重复认输视为可继续，协议需明确处理 |
| `GameController` 动作接口 | `_applyMove`、`skipTurn`、`resignPlayer`、`_setLastAction` 可生成 accepted event | 区分用户事件与自动跳过；持久化完整事件而非仅最后动作 |
| `OnlineRoomSync` | `matchState = settings + phase + actions` 的单一快照协调；失败锁定 authoritative snapshot | 后端 matchState 增加 schema/rules/build/hash/checkpoint；服务端当前只转发动作，不做完整规则裁决 |
| `OnlineApp`/`OnlineAppState` | `normalizeGameSettings`、`matchPhase`、房间设置、重连快照、server timestamp 防倒退 | 本地棋谱与房间状态分离；计时器/提示/连接状态只作元数据；导入前后保持当前局不变 |
| `AIStateProtocol`/TerritoryWorker | 序列化字段和过期响应防护 | 不能直接作为公开格式；补 schema、canonicalization、integrity 和长期兼容策略 |
| Python `LifelineGame`/`LifelineEnv` | `GameSnapshot`、`serialize_state`、`state_fingerprint`、`replay`、legal mask、`history` 校验思路 | 研究版与 Web 版的玩家数、字段命名、`superko_mode`、规则版本不同；必须通过独立 parity fixture 后才能宣称跨实现一致 |

研究版 `serialize_state` 的 schema 1/2/3、canonical JSON 和 SHA-256 fingerprint 是本协议检查点设计的参考，但不直接等同于 Web `schemaVersion: 1`。研究 observation 的 `grid`、`topology`、`topology_history` 只能用于分析投影；其中 history digest 不能反向恢复完整历史键。

## 12. 必须覆盖的回放测试场景

以下测试均应断言“当前局是否被污染”、首个失败事件、规则状态 hash 和必要的派生摘要；至少覆盖 Web v1/v2 与 2/3 人配置中适用的组合。

1. 空棋谱：验证初始角点、`startPlayer`、初始 history key 和初始 state hash。
2. 普通合法落子：单步 move 的 actor、坐标、turnCount、currentPlayer 和前后 hash。
3. 三人轮转：`BLACK → WHITE → PURPLE` 顺序、三方 edge 输出和玩家配置绑定。
4. 攻击/清除：落在线段上导致对方节点/线段清除时，board、edges、history 和终局前分数一致。
5. 保护区、三点限制或占用点非法：非法尝试不增加 `seq`、`turnCount`、history 或 revision 的规则部分。
6. 非法坐标与越界坐标：拒绝负数、非整数、三角棋盘外点，且导入不替换当前局。
7. Superko witness：重放 n=6 研究见证，最后候选动作得到 `SUPERKO_VIOLATION`；若它是 `attempts`，不得变成成功事件。
8. history 篡改：删除或修改一个历史键后，在首次受影响动作处失败，不能只比较当前棋盘。
9. 主动单次 skip：连续跳过数和行动方改变正确，且只产生一个 `skip` 事件。
10. 连续 skip 终局：每个剩余玩家各跳过一次后 `gameOver`、`reason`、winner/score 正确。
11. 无合法动作自动跳过：引擎产生的自动跳过不重复写入、不被复盘器二次执行，`effects` 与结果一致。
12. 当前玩家认输：`resign` 使认输集合、剩余玩家、currentPlayer、终局摘要一致。
13. 三人认输：两人认输与最后一名存活玩家的 winner/score 逻辑正确；重复认输被拒绝或按适配规则报告。
14. 终局后追加动作：任何 move/skip/resign 都在首个越界事件失败，终局状态保持不变。
15. 事件重排、重复、漏号和错误 `prevEventHash`：在结构/链校验阶段拒绝。
16. 任意 `preStateHash`/`postStateHash`/final hash 不匹配：报出期望与实际值，当前对局不变。
17. checkpoint 等价：从初态完整回放与从最近已验证 checkpoint 续播得到相同 ruleState、history 和 terminal。
18. checkpoint 与配置不匹配：改变 grid、startPlayer、rules 或 history 后 fail closed，不拼接不同来源。
19. 原子保存损坏尾：模拟临时文件、半条 JSONL、旧提交文件，恢复到最后完整提交并保留隔离尾部。
20. 未知 schema/rules/build：未知版本只读提示；已知规则但 build 缺失只能得到 `NON_EXACT_BUILD`，不能误报 exact。
21. 过期 Territory Worker 结果：在落子或重放后注入旧 revision 结果，棋盘/分数不被覆盖。
22. 联机重连快照：相同 settings+actions 两次恢复相同；坏快照保留原棋局并保持联机锁定，随后有效权威快照可解锁。
23. Web/研究边界：同一固定动作前缀分别由声明的 engine family 回放；字段/规则不同必须拒绝跨族 exact，而不是仅比较 board。
24. 旧格式迁移：只对有明确迁移器的旧 schema 做内存迁移，迁移前原文件字节和旧 hash 保留，迁移后重新全量验证。

## 13. 验证输出与完成判据

验证器应输出机器可读 receipt，至少包含 `format`、schema/rules/build、输入 hash、event count、first failure、checkpoint used、final state hash、terminal hash、`exact`、`recovered` 和时间戳。`exact=true` 的必要条件是：版本受支持、完整动作链通过、全部前后状态通过、Superko history 完整、终局摘要通过、没有未解释自动转移和没有未验证 Worker/派生字段依赖。

“文件能打开”“棋盘看起来一样”“合法动作 mask 一样”“Worker 返回成功”均不是回放完成证明。研究训练 checkpoint、模型 RNG、经验回放和实验 receipt 仍属于研究运行协议；它们可以通过 `extensions.research` 关联，但不能伪装成棋谱规则 checkpoint。

## 14. 现阶段结论

当前代码已经具备可复用的确定性转移、Superko、自动跳过、事务回放和联机动作日志基础；尚不具备长期兼容棋谱所需的公开 schema、稳定规范化 state、逐事件哈希链和独立 exact receipt。首版实现应先完成“导出 → 隔离导入 → 全量回放 → 终局比对 → 原子提交”的小闭环，再接入时间轴、检查点加速和研究 witness 展示。
