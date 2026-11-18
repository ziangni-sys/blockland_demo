# 联机协议与同步

本文件是 M2.1 工作包 3～9 和 M2.2 工作包 10～14 的实现规格。玩法规则见 [DESIGN.md](DESIGN.md) 的“M2 规则 → 联机”，工作包见 [ROADMAP.md](ROADMAP.md)，验收场景是 [ACCEPTANCE.md](ACCEPTANCE.md) 的 30～37，代码约定照 [ARCHITECTURE.md](ARCHITECTURE.md)。

工作包 2（身体移动和服务器规则拆开；“由客户端驱动”的玩家；移动上报 `MoveReport` 和校正 `Correction`，见 `entities/drive.ts`）在本文里当作已有接口。本文规定它们在网络上怎么走，以及给上报加的两个字段和两处校验改动（第 9 节）。本文的常量都放在 `src/net/protocol.ts`，正文里写名字和取值。结构体包围盒的上限是游戏规则，定义在 `core/constants.ts`（`STRUCTURE_MAX_BOX_CELLS`），`protocol.ts` 引用它（第 7 节）。

## 1. 角色与拓扑

- **服务器** = `Simulation` + `NetServer`（连接、握手、收消息、在 tick 开头把消息交给模拟）+ `Replicator`（每个 tick 结束后给每个客户端打包）。服务器权威：方块、结构体、实体、背包、生命、模式都由它决定。
- **客户端** = `NetClient`（连接）+ `ClientReplica`（世界、胶、结构体、实体的副本，光照在这里算）+ `OwnPlayer`（预测自己的角色）+ 渲染和 UI。副本是被动的数据：客户端从不运行 `StructureManager`、`Fluids`、`BlockUpdates`、`EntityManager` 的规则，只把服务器说的写进 `World`、`StructureGrid`、`GlueStore`。
- 服务器跑在三种地方，代码都是 `ServerHost`（`src/net/host/`）：
  1. **单机**：页面里的一个 Worker。本机客户端通过 `PortTransport`（postMessage 传 `ArrayBuffer`）连进去，所以单机也走完整的编码。Worker 创建失败时，同一个 `ServerHost` 跑在主线程，中间仍然是字节。
  2. **房间**：还是房主页面里那个 Worker。房主主线程管 WebRTC，为每个客人开一个 `MessageChannel`，把数据通道的字节原样转给 Worker（Chrome 不能把 RTCDataChannel 转交给 Worker），并把数据通道的积压报告回去（第 2 节“房间里的积压”）。除此之外 Worker 看到的每个连接都一样。
  3. **以后的 Node 专用服务器**：`ServerHost` + WebSocket 传输 + 文件存储，没有房主玩家，房主命令来自控制台。
- **房主**指运行服务器的那个页面：
  - 世界存在房主浏览器的 IndexedDB 里，由 Worker 读写（第 12 节）。
  - 房主的连接（由宿主标记，不看玩家身份，所以客人冒充不了）可以发房主命令：世界规则、玩家模式、时间、传送、给物品（第 10 节）。
  - 存档、暂停、开关房间、关服是页面和自己的 Worker 之间的**宿主控制消息**（第 15 节），不是游戏协议，客人根本发不出来。
  - 房主自己的玩家记录和别人一样按玩家身份存。房主关页面：服务器存档，给所有客人发 `Kick(shutdown)`，房间结束（DESIGN）。

## 2. 传输接口

```ts
// src/net/transport.ts
export const RELIABLE = 0;   // 可靠、有序
export const UNRELIABLE = 1; // 不可靠、可以乱序
export type Channel = typeof RELIABLE | typeof UNRELIABLE;

export interface Transport {
  readonly open: boolean;
  /** 发一条消息。bytes 被复制或转交，返回后调用者可以重用它。 */
  send(channel: Channel, bytes: Uint8Array): void;
  /** 已交给 send 但还没送进网络的字节数（背压）。 */
  bufferedBytes(channel: Channel): number;
  close(reason?: string): void;
  onMessage: ((channel: Channel, bytes: Uint8Array) => void) | null;
  onClose: ((reason: string) => void) | null;
}
```

- 本端 `close()` 不触发本端的 `onClose`；对端在收到 close 之前已发出的可靠消息全部送达后触发 `onClose`。关闭之后的 `send()` 什么也不做。
- **分帧**：一条传输消息就是一条协议消息，第一个字节是消息 id，后面是载荷，没有长度前缀，传输保证消息边界。不把几条协议消息拼进一条传输消息。
- 可靠通道单条消息最长 `MAX_RELIABLE_BYTES = 4 MiB`，需要时由传输实现自己分片重组。不可靠通道单条最长 `MAX_UNRELIABLE_BYTES = 1150`（一个 UDP 包装得下）；不可靠消息从不分片（丢一片等于全丢），超长是调用方的 bug，`send` 抛错。
- 允许“不可靠通道其实可靠”（Worker、WebSocket）：协议不依赖丢包。
- **回环** `src/net/loopback.ts`：`createLoopbackPair(net: LoopbackNet, up: LinkConditions, down: LinkConditions): { client: Transport; server: Transport }`。
  - `LoopbackNet` 持有一个虚拟时钟和到期队列，测试用 `advanceTo(ms)` 推进；也可以挂到真的 `setTimeout` 上，给浏览器里手动调试延迟用。
  - 传的是字节：`send` 时 `slice()` 一份，绝不传对象。
  - `LinkConditions { latencyMs, jitterMs, loss, bandwidthBytesPerSec?, rtoMs?, seed }`（`rtoMs` 默认 `DEFAULT_RTO_MS = 400`），两个方向各一份。抖动和丢包用自己的 `Rng(seed)`，结果可复现。
  - 每条消息延迟 `latencyMs` + U(0, `jitterMs`)。
  - 不可靠通道：每条独立延迟（会乱序），按 `loss` 丢掉。
  - 可靠通道：不丢、不乱序。按 `loss` 抽中的消息模拟一次 SCTP 重传：送达时间 = min(第 3 条消息的送达时间 + 2 × `latencyMs`, 发出时间 + `rtoMs` + `latencyMs`)，前者是快速重传，后者是重传计时器。“第 3 条消息”是同一方向上在它之后发出、本身没丢的第 3 条消息（两条通道都算），取它在网络上的到达时间（队头阻塞之前的）。重传没有抖动。它挡住后面的可靠消息（队头阻塞）：送达时间 = max(上一条的送达时间, 本条的时间)。
  - 设了 `bandwidthBytesPerSec` 时按字节排队，两条通道共用一个字节队列；丢掉的消息占带宽，重传不占。`bufferedBytes` 反映积压，用来测背压。
- **WebRTC（工作包 10）必须提供**：同一个 `RTCPeerConnection` 上两条数据通道，`'r'`（`ordered: true`）和 `'u'`（`ordered: false, maxRetransmits: 0`），`binaryType = 'arraybuffer'`；可靠通道按 16 KiB 分片，每片前加一个字节（0 整条、1 首片后跟 u32 总长、2 中间、3 末片），这个格式永远不改（第 3 节）；`bufferedBytes` 就是 `bufferedAmount`；ICE 失败、任一通道关闭都触发 `onClose`。信令放在单独的 `Signaller` 接口后面，不属于 `Transport`。
- **房间里的积压**：数据通道在房主主线程，Worker 里的 `PortTransport` 看不到它的 `bufferedAmount`，postMessage 也没有背压。所以主线程为每个客人的每条通道，在 `bufferedamountlow` 时和至少每 100 ms 往这个端口回一条 `{kind: 'backlog', channel, bufferedAmount, seen}`（`seen` = 它从这个端口累计收到的这条通道的字节数）。`PortTransport.bufferedBytes` = 最近一次报告的 `bufferedAmount` + （累计发出的 − `seen`），第一次报告之前是 0。本机客户端的端口没有报告，积压是 0。
- **端口上的帧**（`host/port.ts`，工作包 10 的转发方照这个说）：数据 `{kind: 'msg', channel, data: ArrayBuffer}`（复制一份后转交）；关闭 `{kind: 'close', reason}`，排在已发的消息之后；转发方回报的积压 `{kind: 'backlog', channel, bufferedAmount, seen}`。
- **背压**（服务器每个 tick 给每个客户端打包前检查；阈值按“排多久”算，不按字节）：
  - 每条通道记一个送出速率：（上个 tick 的积压 + 这个 tick 交给 `send` 的 − 现在的积压）/ 50 ms，平滑。
  - 可以推迟的新兴趣（第 5 节）只在可靠积压 ≤ max(8 KiB, 0.1 秒 × 速率) 时发：校正、方块变化、背包前面最多排约 0.1 秒。必须发的照发。
  - 不可靠积压 > max(2 KiB, 3 × 上个 tick 的采样字节)：这个 tick 不发采样（过时的位姿没用）。
  - 可靠积压超过 `MAX_BACKLOG`（8 MiB）持续 10 秒：`Kick(too_slow)`。

## 3. 连接的生命周期

**握手**

1. 传输打开后，客户端在可靠通道发 `Hello`：`build`、`playerKey`、`name`、`viewRadius`。`build` 是 `BUILD_ID`：部署的构建是提交号（Vite `define` 注入），工作区和提交不同时加 `'-dirty-'` 和构建时间（两次这样的构建内容可能不同，不能互连），不在 git 里时是 `'nogit-'` 加构建时间；开发服务器是 `'dev-'` 加服务器的启动时间，测试是 `'test'`。没有单独的协议版本号：消息的布局或含义一变，提交号就变了。永远不改的有三样：可靠通道的分片格式（第 2 节）、`Hello` 开头的消息 id + `str build`、`Refuse` 的布局和它的 reason 1。所以任何两个版本之间都能说清“版本不同”。
2. 服务器检查，不过就回 `Refuse{reason, detail}` 然后关闭：
   - `build` 不同（`build`）。客户端要自己生成原样的区块，方块表和地形生成必须逐位相同。部署后还开着旧页面的人会被拒绝，提示刷新。
   - 名字或身份格式不对、握手前先发了别的消息（`bad_hello`）。
   - 已有 `MAX_PLAYERS = 4` 人（`full`）；房间没开放、只接受本机连接（`closed`）；服务器正在关（`shutting_down`）；客人的身份就是房主自己的（`same_key`：同一个浏览器里开的第二个页面，见下面的“玩家身份”）。
3. 同一个身份已经有连接（房主自己的除外，见上）：新连接顶替旧连接。旧连接收到 `Kick(replaced)`，从此和这个身份无关；服务器在下一个 tick 开头对这个身份做 `sim.leave` + `sim.join`，新连接像第一次加入一样从头同步（和下面的“重连”一样：舵松开、离开载体，位置和背包从记录恢复）。这是“断线了但服务器还没发现时重连”的路径。
4. 不校验种子：客户端不带种子，地形规格由 `Welcome` 给出（`GeneratorSpec`）。

**玩家身份** `PlayerKey`：每个浏览器一个随机 128 位值（32 个十六进制字符），存 localStorage，单机也用它（单机世界以后开放成房间，房主还是同一份记录）。地址参数 `?slot=<名字>` 换用另一份身份（存在 `playerKey:<名字>` 下），给同一个浏览器里的第二个页面和双页面测试（工作包 14）用。`game.ts` 的 `LOCAL_PLAYER_KEY = 'local'` 删掉。身份只发给服务器，服务器从不把任何人的身份发给别人，别人看到的是实体 id 和名字。名字 1～`MAX_NAME_LENGTH = 24` 个字符，去掉控制字符。

**加入顺序**（握手通过后，服务器在下一个 tick 开头处理；对模拟的所有写都在 tick 的流程里）：

1. tick T 开始前：`sim.join(key)`，恢复记录或新建玩家，并立刻把它设成客户端驱动（工作包 2 的 `setDrive`，它提出 cause 为 `drive`、epoch 1 的校正）；新身份由 `ServerHost` 发开局物品（第 17 节第 5 条）；玩家的模拟半径设成 `min(viewRadius, SIM_RADIUS_CAP)`；发 `Welcome`：自己的实体 id、`GeneratorSpec`、`world.time`、`dayOffset`、世界规则、在线玩家表（实体 id、名字、是否房主）、`isHost`、`roomOpen`。
2. tick T 的包：私有区有那条校正（完整的移动状态，含座位）、完整背包、生命等、交互视图。区块快照、兴趣内的结构体和实体都按第 13 节的优先级在预算内发。
3. **就绪区** = 以玩家所在区块为中心的 7×7 列（`READY_CHUNK_RADIUS = 3`）里落在订阅圆内的列（订阅半径很小时圆比 7×7 小，比如验收测试的半径 2、3）。就绪区的快照、就绪区里的实体、加入时兴趣内的全部结构体都发出之后，那个包的全局区带 `ready`。
4. `NetClient` 就绪 = 收到 `Welcome`、收到 `ready`、就绪区的列都已插进副本（标成原样的已经自己生成完）。浏览器的加载界面（`client/session.ts`）另外等中间 5×5 列（同样只算订阅圆内的）的 section 网格化完、每个结构体至少网格化过一次（沿用 `WorldSession.loadingProgress`）；无头客户端没有网格，只看 `NetClient`。然后才开始预测、接受输入、发移动上报。在这之前服务器让这个玩家停在原地（工作包 2 对没有上报的客户端驱动玩家的处理）。

**离开**：客人存档退出时客户端发 `Bye` 再关传输。服务器在下一个 tick 开头 `sim.leave(key)`（松舵、离开载体、记录留下），其他人的包里有玩家表的变化和这个实体的消失。

**掉线**：离开按连接算。一个身份**当前**连接的 `onClose`，或者 `CONNECTION_TIMEOUT_MS = 75000` 内收不到它的任何消息，都按离开处理；已经被顶替的连接后来才报告的关闭和超时不管。客户端用计时器（不跟帧）每秒发一个 `Ping`；后台标签页的计时器可能被浏览器压到一分钟一次，所以超时取 75 秒，真正断开的连接一般先由 WebRTC 的心跳关掉。房主自己的本机连接不算超时（它和服务器在同一个页面里）。没有宽限期：掌舵的人一掉线舵就松开（场景 35，第 17 节第 3 条）。另外，客户端驱动的舵手连续 `STEER_TIMEOUT_TICKS = 40`（2 秒）没有移动上报，服务器松开他的舵：页面切到后台或卡死时，船不会一直开下去。

**重连**：客户端在传输的 `onClose` 之后（WebRTC 的连接心跳在约 30 秒内发现死掉的连接），并且之前没收到 `Kick`，显示“连接中断，正在重连”，重建传输，用同一身份再发 `Hello`。收到 `Kick` 之后不自动重连，只显示原因（否则 `replaced` 会让两个页面互相顶个没完）。只是收不到包不算掉线，只显示第 4 节的卡顿提示：房主的页面在后台时服务器可能一分钟才醒一次，这时重连没有用。客户端丢掉整个副本，像第一次加入一样重来；保留副本就得补上掉线期间的全部变化，4 人房间不值得。服务器那边就是一次离开加一次加入，位置和背包从记录恢复（场景 35）。

## 4. 时间

**服务器的时钟**

- 20 TPS。`ServerHost` 用自己的计时器（Worker 里的 `setTimeout`，按目标时间纠正漂移），不依赖渲染帧，不受客户端的画面、菜单影响。
- 新建或读档之后不跑 tick：第一个握手通过的连接让时钟开始，它在第一个 tick 开头加入。所以房主在读档后的第一个 tick 之前加入（场景 36：还在舵上、还在甲板上）。
- 醒晚了就补跑，一次最多 `MAX_CATCHUP_TICKS = 5` 个 tick，更多的直接丢掉（时间丢了，不压缩）。补跑的每个 tick 照常发自己的包。
- 实际 TPS 按墙上时间算：每次醒来数一数过去 2000 ms 墙上时间里跑了几个 tick（每个 tick 记在跑它的那次醒来），除以窗口长度，最多 TPS（醒得稍晚会让窗口里多数一个 tick，不封顶就会在 20 和 20.5 之间跳）；时钟开始后不满 2000 ms 时，窗口取开始以来的 tick 槽数 × 50 ms。`ServerHost` 在值变了、并且离上次交给 `Replicator` 至少 1000 ms 墙上时间时才交出新值，`Replicator` 把每个新值放进下一个包的全局区。按 tick 数限频不行：5 TPS 时要等 4 秒，而且刚开始受限时量到的小降幅（19）会把真正的低值挡在后面，场景 37 的 3 秒就做不到。
- 单机暂停：页面先停本机客户端（`NetClient.setPaused(true)`：帧照样应用到达的包，但时钟不走、副本不重新摆位姿，画面上什么都不动；不停的话转子会一直按 `rotorTick` 转下去），再用宿主控制让 Worker 停 tick；恢复时反过来，先让 Worker 继续，再 `setPaused(false)`，它重置客户端的 `ServerClock`（暂停的那段墙上时间不能当成延迟）。

**打上 tick 的东西**

- 每个可靠包：`tick` 表示包里描述的是这个 tick 结束时的状态。包里的校正、转子状态、最终位姿都隐含是这个 tick。
- 每条采样消息：`tick`。
- 移动上报带 `viewTick`：客户端走这一步时给结构体设的 `renderTick`（向下取整）。服务器按 `seq` 的顺序用上报，不按 tick；它用最近一条被应用的上报算这个客户端的**画面延迟** `viewLag = 当前 tick − viewTick`（第 9、10 节）。意图不带 tick。
- 私有区的 `moveAck`：这个 tick 里工作包 2 最后接受的移动上报的序号（见下面的“转子时间”）。
- `Pong` 带服务器当时的 tick。

**客户端的时钟** `ServerClock`（`src/net/client/clock.ts`）

- **到达时间线** `arrivalTick(now)`：每收到一个包或一条采样记一个样本 `s = tick − now·TPS/1000`。目标 offset = 最近 2 秒样本里最大的那个（延迟最小的）。实际用的 offset 以不超过 ±10% 的速度追向目标（时间轴不倒退、不跳）。目标比 offset 大 10 个 tick 以上时 offset 直接跳到目标；小 10 个 tick 以上时 arrivalTick 停住，等差回到 10 以内再按 −10% 追；小 40 个 tick（2 秒的窗口）以上时（房主长时间卡住后恢复），offset 直接跳到目标：arrivalTick 和 rotorTick 往回跳这一次，renderTick 不倒退，停住直到 arrivalTick − D 追上；跳之前发出的移动上报不再用来量 rotorLead，随下一个 moveAck 重新量。（只在 10 个 tick 处两个方向都跳的话，每秒醒一次、补跑 5 个 tick 的房主会让 arrivalTick 每秒往回锯 15 个 tick。）`arrivalTick = now·TPS/1000 + offset`，约等于“服务器现在的 tick − 单程延迟”。
- **往返时间** `rtt`：每秒一个不可靠的 `Ping{clientMs}`，服务器收到立刻回 `Pong{clientMs, tick}`（在消息回调里回，不等 tick），取最近 5 次的最小值。
- **插值延迟** `D`（单位 tick）：`D = clamp(1 + 2·jitter + lossTicks, 1.2, 8)`。
  - `jitter` 是最近 2 秒**采样消息**的到达样本相对目标 offset 的平均偏差；没有采样时为 0。可靠包不算：它们被队头阻塞时成批迟到，会把 D 顶到 8。
  - `lossTicks`：采样丢失率 `p` > 1% 时为 `ceil(log 0.01 / log p) − 1`，否则 0（5% 时 1，20% 时 2，使连续丢掉的采样超过 D 的概率不到 1%）。丢失率按采样消息的序号 `seq` 的空缺算（采样只在有东西动时才发，不能按 tick 的空缺算）。
  - D 每帧最多变 0.02。单机（Worker）里 D 约 1.3～1.5；150 ms 往返加 5% 丢包时约 3。
- **显示时间** `renderTick = min(arrivalTick − D, 最新一个已应用的包的 tick)`：船的位姿、所有实体（包括别的玩家）、昼夜都在这个时间显示。可靠通道卡在重传上时采样还在来，没有这个上限，显示时间会越过还没应用的包：船越过还不知道的 pivot 变化，实体的载体还没生成。第一个包应用之前 `renderTick` 不动（−∞），也不摆任何位姿：否则第一个包丢了、等重传时采样照样来、时间轴已同步，它会不受上限地往前走，又因为不减小，停在之后应用的包前面。昼夜 = `mod(renderTick + dayOffset, DAY_TICKS) / DAY_TICKS`，只用服务器给的时间（LESSONS“天空的昼夜和游戏时间不一致”）。
- **转子时间** `rotorTick = arrivalTick + rotorLead`：转子的显示和预测都用它，要等于自己现在发出的移动上报**在服务器上被应用**的那个 tick（那个 tick 的第 3 步把转子推到这个角度，第 5、6 步拿它判推开和挤压）。这样叶片推人时，客户端预测的推开和服务器看到的是同一个角度，服务器不会把还没来得及被推开的人判成挤伤。`rotorLead` 是量出来的，不是算出来的：客户端记下最近 64 条上报发出时的 `arrivalTick`；包里的 `moveAck = s` 变了时，样本 = 包的 tick − 发出 s 时的 `arrivalTick`，它包含单程延迟、等下一个 tick 开始的时间和 `moves.ts` 的排队。`rotorLead` 像 D 一样每帧最多变 0.02，差超过 4 个 tick 时直接跳；第一个样本之前取 `rtt·TPS/1000 + 1.5`。`rotorTick` 本来就超前于收到的包，不受上面那个上限限制。代价见第 17 节第 6 条。
- **离散的变化**（方块、结构体和实体的出现与消失、背包……）一收到就生效，不等显示时间（第 5 节）。
- **自己的角色**按客户端自己的固定步长时钟（`FixedStepClock`，20 Hz）预测，显示的是“现在”（第 9 节）。

**卡顿提示**（场景 37，服务器没有暂停时）：

- 全局区报告的 TPS 低于 15，或者 `HOST_STALL_MS = 1500` 内收不到包、但 `Pong` 还在来：显示“房主的服务器运行受限（页面可能在后台）”。
- 包和 `Pong` 都 1500 ms 没来：显示“连接不稳定”（客人自己的链路断了，不怪房主）。
- TPS 回到 15 以上、包又在来：提示消失。

## 5. 每个 tick 的包

服务器每个 `sim.tick()` 之后调用 `replicator.endTick()`，给每个客户端在可靠通道上发**恰好一个** `TickBatch`。没有内容也发（4～6 字节，tick < 2^21，约 29 小时）：它既是心跳，也是客户端时钟的样本来源。另外在不可靠通道上发零到几条 `Samples`（第 7、8 节）。

`Replicator` 的变化收集是连续的：两个 tick 之间发生的变化（`ServerHost` 在 tick 之间生成区块时清掉的胶、加入时载入的区块）算进下一个包。

**包里的区段**，按应用顺序（空的区段用位掩码省掉，布局见第 14 节）：

| 位 | 区段 | 内容 |
|---|---|---|
| 0 | `unsubscribe` | 退订的区块 |
| 1 | `snapshots` | 区块快照：新订阅的，和一个 tick 里改了太多格的已订阅区块 |
| 2 | `chunkDeltas` | 已订阅区块的格子变化和世界胶变化 |
| 3 | `structureRemoves` | 消失或离开兴趣的结构体，每个都列出（子在父前） |
| 4 | `structureSpawns` | 新出现、新进兴趣、需要整体重发的结构体（父在子前） |
| 5 | `structureDeltas` | 结构体的格子、胶、字段变化 |
| 6 | `structureRests` | 刚停下的船的最终位姿 |
| 7 | `entityDespawns` | 消失或离开兴趣的实体 |
| 8 | `entitySpawns` | 新出现或新进兴趣的实体 |
| 9 | `entityUpdates` | 非运动字段的变化；刚停下的实体的最终状态 |
| 10 | `private` | 只给这个玩家：校正、背包、生命等、交互视图、带收件人的事件、意图确认号、移动上报确认号 |
| 11 | `events` | 兴趣内的世界事件 |
| 12 | `globals` | 昼夜偏移、世界规则、玩家表变化、TPS、`ready`、`roomOpen` |

**必须发的**（背压时也整段发）：对客户端已有的东西的变化——0、2、3、5、6、7、9、10、11、12，已订阅区块的重发快照，结构体的整体重发，以及**这个 tick 里新出现**在兴趣内的结构体和实体的生成（组装出的船、启动的转子、掉落物、点燃的爆破箱、下落的沙子：它们和同一个 tick 的格子变化必须同包）。**可以推迟的**：因为玩家移动或刚加入而进入兴趣的东西——新订阅的区块快照、早就存在的结构体和实体的生成，按第 13 节的优先级在预算内发。推迟中的东西客户端不知道，它的变化也不发：区块的增量和这一列的世界事件只发给快照已经在之前的包里发出的客户端，结构体和实体同理；轮到它时发的是那时的全量状态，自然含之前的变化。

**客户端怎么应用**：每帧最先做的事，是按顺序把所有已经完整收到的包逐个应用，每个包从头到尾一次应用完（区段按上表顺序）；然后插入收到的采样；然后走客户端的固定步（预测、上报）；最后渲染。所以一个服务器 tick 的全部变化在客户端的同一帧里生效。

- 立刻生效的是格子、胶、生成和移除、字段、私有状态、事件。**位姿**——`structureRests` 的最终位姿、`entityUpdates` 位 0 的最终状态、生成记录里的位姿——作为这个包的 tick 的采样插进采样环，和不可靠的采样一样按 `renderTick` 显示；直接套用的话，停下的船会比它插值中的运动早 D 个 tick 跳到终点。最终位姿和生成记录里的位姿都是“停住”的采样：服务器只在位姿变了时发采样，所以从它的 tick 起没变，直到下一条采样的前一个 tick，插值从下一条采样的前一个 tick 开始，不从它自己的 tick 开始（否则停了一分钟的船会提前一分钟开始慢慢挪，兔子转身会提前好几个 tick 开始转；静止时进入兴趣的船或物品，过一会儿才被推动，也会提前最多 D 个 tick 动起来）。在动的东西下一条采样就在下一个 tick，结果不变；只有生成之后紧接着的那条采样丢了时，它在生成记录的位姿上多停一个 tick。
- 页面隐藏时没有 `requestAnimationFrame`（后台的房主页面、切到后台的客人）：客户端在消息回调里逐个应用完整收到的包（不网格化、不预测），包不会堆起来；回到前台时网格化照常处理脏的 section。

**为什么方块不会重复或消失**

- 组装（tick T）：世界里被带走的格子清空（区段 2 的增量或重发快照）和船的生成（区段 4，状态是 T 结束时的，含这些格子）在同一个包里。任何一帧都不会两边都有、或两边都没有。补水改的就是这些格子，发的是它们的最终值。
- 方块化、停靠：结构体的移除（3）和落回世界的格子（2）在同一个包里，同时被放下的人的校正在 10 里，也是同一帧。船上的转子停下：转子移除 + 船的格子变化（5）。
- 船上启动转子：船的格子变化 + 转子生成。世界里的转子随船组装：船生成 + 转子整体重发（换了父结构体），同一个包。
- 爆炸：各网格的格子移除和掉落物生成同包。落地的沙子：实体消失和世界格子出现同包。
- 一个格子在一个 tick 里变了几次只发最后的值，结构体同理。客户端看到的永远是某个 tick 结束时的完整状态。
- 网格化本来就是异步的（区块 section 在 Worker 里网格化，小结构体同步网格化，见 `client/structures.ts`）。这一层和 M1 单机一样，协议不改变它。

**和区块快照的先后**

- 快照描述发出它的那个包的 tick 结束时的状态。同一个包里不再有这个区块的增量；以后的包里的增量都在它之后。重发快照同样替换这一列的格子和胶。
- 标成原样的区块要客户端自己生成（异步）。生成完之前收到的这个区块的增量，按收到的顺序排队，生成完、插进副本之前全部应用，然后才画、才参与碰撞。这期间这一列不显示，所以看不到不一致。
- 客户端每收到一列的快照就给这一列一个新的代号。退订丢掉这一列排队的增量，并作废在途的生成；生成结果带的代号不是当前的就扔掉；任何快照（包括重发）替换这一列所有等待中的状态。否则“原样快照 → 退订 → 改动 → 重新订阅（格子快照）→ 旧的生成才完成”会把生成的格子加上旧增量盖在新快照上，永远错下去。
- 退订之后这个区块的增量不再发；以后重新订阅时发新的快照。
- 一个 tick 里改了超过 `CHUNK_RESEND_CELLS = 1024` 格的已订阅区块，不发增量，在区段 1 里重发这一列。结构体超过 `STRUCTURE_RESEND_CELLS = 1024` 格时整体重发。阈值按“增量约 2 字节一格、一列的快照中位数约 2.0 KB”取。

## 6. 区块

**兴趣**（服务器端，`src/net/server/interest.ts`）

- 订阅半径 `r` = 客户端的 `viewRadius`（渲染距离 + 1，见 `game.ts loadRadiusFor`；上限 `MAX_VIEW_RADIUS = 17`）。判据和 `ChunkManager` 一样，圆：`dx² + dz² ≤ r² + r`，中心是服务器上这个玩家脚下的区块。
- 玩家所在的列或订阅半径变了就重算（同一个 tick 至多一次）。新进圆的列按距离排进这个客户端的待发队列；已订阅的列离开 `r + 2`（和 `ChunkManager.unloadMargin = 2` 一样的回差）立即退订；待发队列里已经出圆的直接删掉。（不能按固定节拍重算：两次重算之间玩家走出去的那几格会让已订阅的列超出第 7 节保证用的距离。）
- **订阅不等服务器加载**。服务器回答它对这一列的了解：已加载且 `modified` → 发格子；没加载但在 `chunks.stash` 里 → 把存档字节解码后按网络格式发，解不开就回答原样；其他（从没加载过、加载了但没改过）→ 原样。这总是对的：
  - 没加载的区块不会变（`World.setCell` 在未加载区块上什么也不做）；
  - 服务器以后加载它，载入的格子和告诉客户端的一样（存档字节，或同一个生成器的输出；存档字节解不开时 `ChunkManager` 也是重新生成）；
  - 加载时发生的变化（液体重新排程后的流动、加载时清胶 `pruneGlueInBox`）都经过 `setCell` 和胶的事件，作为增量发给订阅者。
- 所以客户端的显示半径可以比服务器的模拟半径大：服务器只在每个玩家周围 `min(viewRadius, SIM_RADIUS_CAP = 10)` 内加载和模拟（第 17 节第 2 条），更远的是静止的快照。默认渲染距离 8（半径 9）时两者一样。

**快照** `ChunkSnapshot { cx, cz, cells: 'pristine' | CellVolume, glue: number[] }`

- `cells`：原样标记（客户端用 `Welcome` 里的 `GeneratorSpec` 自己生成），或者整列 16×128×16 的格子（第 14 节的 `CellVolume`，顺序 `lx | lz<<4 | y<<8`，和 `Chunk.cells` 一样）。改过的区块实测中位数约 2.0 KB，p90 约 2.85 KB；只被玩家改了几处的地形列中位数 2.6～2.7 KB。
- `glue`：规范端（坐标较小的那一格，`GlueStore` 的规范键）在这一列里的所有世界胶面，每面一个数 `lx | lz<<4 | y<<8 | axis<<15`。原样的区块也可能有胶：在天然的石头上涂胶不改格子。
- 不在快照里：光照（客户端自己算）、待处理的方块 tick（只在服务器）、实体和结构体（走各自的兴趣）。

**增量** `ChunkDelta { cx, cz, cells: Array<[index, Cell]>, glue: Array<[face, added]> }`

- `index` 升序，同一格只发这个 tick 结束时的值。
- 胶面只发这个 tick 结束时的状态（加了又去掉 → “去掉”）；客户端按集合语义应用（已经不在就忽略）。
- 来源：`world.onCellChange` 和 `worldGlue.onChange`。区块随加载进来的格子不经过 `setCell`，不产生增量，也不需要。
- 只发给这一列的快照已经发出的客户端（第 5 节）。

**退订**：客户端 `world.removeChunk`（光照引擎自己发现缺了的区块并重算邻居边界，见 `light/engine.ts` 头注释“WHICH CHUNKS EXIST”），删掉这一列的网格，删掉规范端在这一列里的世界胶面。

**客户端的区块装载**（`src/net/client/chunks.ts`，取代现在的 `client/chunkstream.ts` 的拉取逻辑）：订阅表和每列的代号、原样区块的生成请求（经 `ChunkSource` 接口：浏览器里是地形 Worker 池，测试里是同步生成器）、等待生成时的增量队列（第 5 节）、插入时调 `LightEngine.initChunk`。客户端从不自己决定加载或卸载哪一列。

**格子值的格式**（为 M2.3 留好）

- 网络上一个格子是 `Cell`：一个 varuint `v`。低 16 位是现在的格子（id 10 位 + 状态 6 位）；16～23 位是 M2.3 的“缺口”（哪几个八分格空着）；第 24 位 `CELL_MULTI_BIT` 表示这一格还有第二个部件，为 1 时紧跟一个 varuint，就是第二个部件（同样的 id + 状态 + 缺口）。所有值都小于 2²⁵（ROADMAP M2.3）。
- 整格方块的值和现在完全相同：空气 1 字节，id < 128 且无状态的方块 1 字节，其余 2～3 字节。
- M2.1 的副本还是 16 位存储：编码端断言 `v < 2¹⁶`；解码端遇到 `v ≥ 2¹⁶` 按协议错误断开（绝不截断）。M2.3 只改两端的存储，协议字节不变。
- 网络格式不复用存档的区块编码：`encodeChunk` 的调色板是 u16，外面还有 magic、版本和 CRC。网络上照搬它的调色板游程算法，调色板项换成 `Cell`，不要外壳（可靠通道保证完整）。

## 7. 结构体

**兴趣**

- 包围球：球心是根结构体 pivot 的世界位置（世界转子用轴心）。半径取最大的：pivot 到格子包围盒最远角的距离；世界转子的扫掠球半径；每个子转子的轴心到根 pivot 的距离加它的扫掠球半径（风车叶片可以伸出船很远）。扫掠球半径 = hypot(扫掠半径, 沿轴最远的距离)，量法就是 `StructureManager.measureSweep`：工作包 4 把它导出成 `structures/rotor.ts` 的纯函数，manager 和 `interest.ts` 都调它，不另写一份。
- 球到玩家所在区块中心的水平距离减去半径 ≤ `(r + 4)·16` 时进入兴趣，> `(r + 6)·16` 时退出。挂在船上的转子跟着根结构体进出。
- 这个判据保证：结构体只要有一格落在某个已订阅区块（包括还在回差里、离开 `r` 但没到 `r + 2` 的）的范围里，它就在兴趣内——这样的格子离玩家所在区块中心最远约 `(r + 3.2)·16`。所以组装、停靠时不会出现“格子走了船没来”。

**生成记录** `StructureRecord`（全量，包的 tick 结束时的状态）

- `kind`、`id`、`parentId`（0 = 世界）。
- 格子：紧凑包围盒 + 盒内的 `CellVolume`（顺序 `(x−minX) + (z−minZ)·sx + (y−minY)·sx·sz`，和存档相同）。木板船体的游程很长：2934～3700 格的木板船实测整条记录约 1.2～1.35 KB（每格约 0.3～0.4 字节），本文的估算用这个数。按存档的量法（每格 2 字节，3700 格 8.8 KB）估算是上限，各处另列。
- 盒子的上限：结构体的紧凑包围盒体积 ≤ `STRUCTURE_MAX_BOX_CELLS = 2^21`（比如 128 × 128 × 128），这是游戏规则（DESIGN“组装与方块化”）：组装（collect/assembly，预览同样）拒绝超出的结构体（toast），往结构体上放方块使盒子超出时同样拒绝，船上的转子停下时会让船的盒子超出的格子掉落；存档和网络用同一个上限（`protocol.ts` 的 `MAX_STRUCTURE_BOX_CELLS` 就是它）。所以服务器上的每个结构体都发得出去，客户端按它拒绝更大的盒子。
- 位姿：`pivot`、`position`、`rotation`，f64（生成时要精确，携带从这里开始算）。
- 胶：`GlueStore.toArray()` 的规范顺序，坐标差分编码。
- 转子：`bearing xyz`、`axis`、`baseRotation`、`angle`、`angularSpeed`（f64）、`sails`、`frozen`。
- 船：`helm xyz`、`forward`、`throttle`、`rudder`（f32）、`helmsmanId`（实体 id）。
- 不发：hull、质量、惯量、`asleep`、`restTicks`、船的 `sails`。
- **什么时候发**：进入兴趣；新出现；整体重发。整体重发的情况：一个 tick 改了超过 1024 格；坐标系不连续地变了——换父结构体（组装时世界转子挂到船上，停靠时船上的转子改挂世界），或转子的 `baseRotation`、`bearing`、`position` 变了。服务器每个 tick 比较每个结构体的 `(parentId, bearing, baseRotation, 转子的 position)` 和上次发出的，变了就重发。客户端收到认识的 id 就用新的替换旧的（id 不变，采样环保留），不认识的 id 就是生成；生成时丢掉缓冲里这个 id 的、tick 不晚于记录的采样（离开兴趣之前迟到的旧采样）。
- 父结构体总在子结构体前面，按深度排，不按 id：随船组装的转子 id 比船小。

**增量** `StructureDelta { id, cells?, glue?, pivot?, helm?, control?, rotor? }`

- `cells`：局部坐标（相对上一个做差分）+ `Cell`，同一格只发最终值。来源 `grid.onCellChange`，包括物理子步里被夹毁的格子。
- `glue`：面 + 加或去，来源 `structure.glue.onChange`。
- `pivot`：船的格子变了以后，动力学把 pivot 挪到新的质心（`setPivotKeepingPose`），`position` 同时跳一下。发新的 pivot（f64）。客户端收到后，把缓冲里这个包的 tick 之前的采样换算到新 pivot：`position += rotate(rotation, newPivot − oldPivot)`；之后迟到的、更早的采样直接丢掉。船的位姿插值的两端只用 tick 不晚于最新已应用包的采样（`renderTick` 不超过已应用的包还不够：插值也读 `renderTick` 之后的那条采样，中间那条丢了时它可能晚于已应用的包、已经用了新 pivot）；右端点没有这样的采样时停在左端点（和“超过最新的采样就停住”一样）。所以用新 pivot 的采样不会在 pivot 到达之前被画出来。
- `helm`：helm xyz、`forward`、`helmsmanId`。`control`：`throttle`、`rudder`。
- `rotor`：`angle`、`angularSpeed`、`sails`、`frozen`，指这个包的 tick 结束时。帆数或冻结变了就发，另外每 `ROTOR_RESYNC_TICKS = 100` 发一次做保险。

**收集**：`Replicator` 在结构体出现时（每个 tick 比较 `structures.all()` 的引用，变了再按身份比，和 `Simulation.syncStructures` 一样）挂 `grid.onCellChange` 和 `glue.onChange`，消失时摘掉。一个 tick 里新出现的结构体只发生成记录，它出现之前那个 tick 里的格子事件不需要；同一个 tick 里出现又消失的结构体什么也不发（世界格子的变化照常收集）。

**移除**：结构体没了或离开兴趣。服务器把每个要删的 id 都列出来（离开兴趣的船连同它的子转子，子在父前），客户端只删列出的，不级联。停靠时船被删、船上的转子改挂世界（区段 4 的整体重发），转子不在移除表里，它的采样环和站在它上面的实体的采样都留着。删一个结构体之前，客户端把缓冲里以它为载体的实体采样换到它的父空间（用它在各条采样的 tick 的位姿：船用采样环，转子用转子推演），载体改成它的父结构体或 0，和 pivot 变化的换算一样；否则别的玩家、掉落物会消失，或者把船的局部坐标当世界坐标画到组装的地方去。一条采样一直有效到下一条，载体在这期间还在动，所以被携带的采样还在它到下一条采样（最后一条：到移除那个包的 tick）之间的每个 tick 按载体当时的位姿各换算一条（不超过 `SAMPLE_BUFFER_TICKS`）；只换算采样自己的 tick 的话，站着的人会在一帧里跳约 0.24 格。

**位姿流**（不可靠，`Samples`）

- 只有船有位姿流。每个 tick 算出每条船量化后的位姿（`Pos32`×3 + `Rot64`，第 14 节），和上个 tick 的不同就给兴趣内的客户端各发一条采样（约 22 字节）。从“在变”变成“和上个 tick 相同”（睡着、冻结、停住）时，在可靠包的 `structureRests` 里发一次最终位姿，然后停发。睡着和冻结不需要单独的标记。
- 客户端每条船一个采样环（`SAMPLE_BUFFER_TICKS = 32`），在 `renderTick` 线性插值（旋转用 slerp）。`renderTick` 超过最新的采样就停在最新的（不外推）；早于最早的就用最早的；停住的采样（`structureRests` 的最终位姿、生成记录的位姿）见第 5 节，插值从下一条采样的前一个 tick 开始。环保留最新采样之前 32 tick，加窗口起点之前的一条（窗口起点处插值的左端），加不晚于最新已应用包的最新一条（可靠通道卡住、采样还在来时显示的就是它）。还不认识的 id 的采样先存 32 tick，等生成记录（可靠通道慢时采样可能先到）。
- 位置是 pivot 在父空间里的位置（`StructureGrid.position` 的含义），所以客户端必须和服务器用同一个 pivot（见上）。不改成“局部原点的平移”：格子坐标就是组装时的世界坐标，原点可能离船几千格，在那个原点上插值转动会把船甩出去。

**转子**：没有位姿流。客户端从最近一次的转子状态（tick、`angle`、`angularSpeed`、`sails`、`frozen`）出发，用 `advanceRotor` 一个 tick 一个 tick 推到 `rotorTick`，小数部分在相邻两个 tick 的角度之间插值；`frozen` 时不动（`holdRotor`）。最多推到转子状态之后 400 tick（保险：兴趣内的转子每 `ROTOR_RESYNC_TICKS` 重发一次状态）。`advanceRotor` 是确定的，同样的起点、同样的步数得到同样的角度，定期重同步只是保险。转子停下（方块化）就是一次移除加格子增量。

**嵌套**：船上的转子的 `position`、`baseRotation` 在船的局部空间。客户端组合位姿时，船用 `renderTick`，转子的自转用 `rotorTick`（`StructureGrid.renderPose` 本来就按父结构体组合）。一个 tick 里组合两个时间没有问题：转子相对船只有自转。

**掌舵**：`helmsmanId`、`helm`、`forward`、`throttle`、`rudder` 是结构体字段，每个人都有。舵手的油门和方向来自他的移动上报里的输入轴（工作包 2），服务器的 `Hands.steer` 照旧读 `input.forward/strafe`。舵的读数（`HelmView`）客户端自己算：`throttle`、`rudder` 来自字段，帆数 = 子转子的 `sails` 之和，航速 = 最新两条位姿采样的水平速度（位移除以 tick 差；前一条是停住的采样时按一个 tick 算）；最新一条是停住的采样（`structureRests` 的最终位姿或生成记录的位姿）时为 0。所以私有状态里没有舵的读数。

**客户端自己推导**：`analyzeHull`（`grid.version` 变了才算，0.8～2.1 ms）→ 船体信息、干区（渲染时裁掉船舱里的水、自己的游泳和浮力采样、桶的射线）；网格；转子能不能编辑（`angularSpeed ≠ 0`）；舵的读数。

## 8. 实体

种类和标签同 `entities/manager.ts` 的 `KIND_TAG`：1 player、2 item、3 falling、4 tnt、5 rabbit。

**兴趣**：有载体的实体，载体在这个客户端的结构体兴趣内、生成记录已经发出，它就在兴趣内（结构体兴趣比区块订阅远，船还看得见时船上的人和东西不能先消失）。没有载体的实体，脚下的区块（`floor(x) >> 4, floor(z) >> 4`）已被这个客户端订阅、快照已经发出。回差来自区块订阅和结构体兴趣本身。这样世界里的掉落物、下落的沙子和产生它们的格子变化总在同一个客户端那里同时出现。自己的实体不在实体流里（自己预测，服务器的意见走校正）。

**生成记录** `EntityRecord`：`id`、`kind`、`carrierId`、位置（`Pos32`，有载体时是载体的局部坐标，否则世界坐标）、`yaw`，再按种类：

- player：`pitch`、标志（潜行、疾跑、飞行、死亡、着地）、`steeringShipId`、手持物品（选中格的物品 id，工作包 12 画手持物）。名字来自玩家表（实体 id → 名字）。
- item：物品 id 和数量。
- falling：`Cell`。
- tnt：剩余引信（tick），客户端自己倒数，用来闪烁。
- rabbit：没有别的。

**运动采样**（不可靠，`Samples`）：`id`、`kind`、`carrierId`、位置、`yaw`，玩家另加 `pitch` 和标志。带种类是为了不靠副本就能解码：采样可能比生成记录先到、比消失晚到。规则和船一样：每个 tick 量化后和上个 tick 不同才发；停下来时在可靠包的 `entityUpdates` 里发一次最终状态。采样属于消息的 tick。

**其他字段的变化**（可靠，`entityUpdates`）：掉落物合并后的数量；TNT 引信和客户端倒数的不一致（现在的规则里连锁爆炸是生成新的 TNT，不会改短已有的引信，留给以后的规则）；玩家的标志、掌舵、手持物品。

**消失** `entityDespawns`：死亡、被捡起、被合并、离开兴趣都一样。

**在载体坐标系里插值**：每个实体一个采样环。相邻两条采样的载体相同 → 在载体局部空间插值，再用载体在 `renderTick`（转子用 `rotorTick`）的位姿变到世界；载体不同 → 各自用它的载体在它自己的 tick 的位姿（转子也用那个 tick）变到世界，再插值。停住的采样（`entityUpdates` 位 0 的最终状态、生成记录里的状态）和船一样，插值从下一条采样的前一个 tick 开始（第 5 节）。这就是 `client/interp.ts` 的 `interpolateCarried` 现在做的事。站在行驶的船上的人，上报和采样都是相对船的，所以在每个人的屏幕上都相对甲板静止（场景 31）。载体被删时缓冲里的采样怎么办见第 7 节“移除”。

**远程玩家的位置来源**：服务器上就是这个玩家最近一次被应用的移动上报（工作包 2）。上报的到达有抖动，一个 tick 收到两条、下个 tick 一条没有，直接用会让别人看到他一顿一顿。所以 `src/net/server/moves.ts` 给每个玩家一个上报队列：

- 收到时：`seq` 不大于已经收到过的最大 `seq` 的丢掉（乱序迟到的），其余排在队尾，所以队列按 `seq` 有序，服务器上的位置不会往回走。
- 每个 tick 开头交给工作包 2 一条：交出前先丢掉 epoch 不是当前的（校正之前发出的），它们不占交出的名额。队列超过 2 条时这个 tick 交两条追上，超过 10 条丢最旧的。工作包 2 处理时还会再检查一次 epoch 和 `seq`。
- 代价是这个玩家在服务器上多约 1 个 tick 的延迟（`rotorLead` 量的就包含它）。丢包或丢掉的上报不会把两次摔落合成一次，见第 9 节的 `landings`。
- 另外保留最近 `MOVE_HISTORY = 40` 条收到的上报（`seq`、载体、脚的位置、潜行），给意图找眼睛（第 10 节）。

**离散变化比运动早**：离散变化一收到就生效，运动按 `renderTick` 显示，所以沙子落地、TNT 爆炸会比它们的运动早 D 个 tick（沙子少画最后一两个 tick 的下落）。接受；把整个包推迟到 `renderTick` 再应用，会让自己放的方块也晚 D 个 tick 出现。

## 9. 自己的角色

**私有状态**（包的 `private` 区，只发给这个玩家，每项变了才发）

- `correction`：工作包 2 的 `Correction`（`takeCorrection`）。服务器自己移动了这个玩家时提出：加入（cause `drive`）、传送、复活、坐上舵、松开舵、被停靠或方块化放下（`release`）、挤压或卡住时挪位、爆炸击退（`knock`）、换成生存模式结束飞行、校验失败（`check:…`）、死亡。字段：`epoch`（提高过的）、`cause`（工作包 2 的字符串，原样发，调试和测试用）、`carrierId`、载体局部的位置（f64）、相对载体的速度、`yaw`、`pitch`、飞行、着地、座位（`seatShipId` + 船局部的座位坐标，或者没有）。状态取提出它的那个 tick 结束时的（工作包 2 在实体那一步的末尾结算），一个 tick 里提出几次只发一条，带最后的 epoch：加入的那个 tick 里有人在出生点脚下组装出船，校正里就已经是这条船的局部坐标。
- `inventory`：变了就发整个背包（快捷栏 9 格、背包 27 格、副手、光标、选中格，约 100 字节）。只发变化的格子省不了多少，背包预测反正要整份。
- `vitals`：`health`、`maxHealth`（f32）、`air`、`maxAir`、`dead`、`mode`。
- `view`：交互视图里只有服务器算得出的部分：
  - `mining`：正在挖的格子（网格 id + 坐标 + `sub`）和进度（u8）。客户端只在自己的准星目标就是这一格时画裂纹。
  - `gluing`：限时涂胶的面和进度，同上。
  - `preview`：组装预览：网格 id、种类、格子集合用包围盒 + 位图编码（4000 格的预览约 1～2 KB）。服务器上的预览对象换了才发（`preview.cells` 的身份只在 `setPreview` 里变）。
  - `conflicts`：停靠冲突格（世界坐标），内容变了才发（空列表每个 tick 都是新数组，要按内容比）。
  - `hint`：准星下的提示（`Message`），变了才发。
  - 准星目标本身不发，客户端自己算（第 10 节）。
- `events`：带收件人的事件：toast、受伤、死亡、拾取、松舵。
- `ack`：服务器到这个 tick 为止处理完的最大意图序号（背包预测，第 10 节）。
- `moveAck`：这个 tick 里工作包 2 最后接受的移动上报的序号（第 4 节“转子时间”）。

为此 `InteractionView` 改两个字段（工作包 7）：`breakProgress` 换成 `mining: { gridId, x, y, z, sub, progress } | null`，`glueProgress` 换成 `gluing: { gridId, x, y, z, face, sub, progress } | null`。`sub` 是部件或八分格（M2.3、M2.4 用，M2.1 是 0）。客户端的叠加层从它们和本地目标组合出原来的显示。

**移动上报和校正**（结构是工作包 2 的，这里定网络上的走法和两个新字段）

- 客户端每个客户端 tick 发一条 `MoveReport`（不可靠，约 57 字节）：工作包 2 的字段——`seq`、`epoch`、`carrierId`（0 = 无）、载体局部的位置（f64）、相对载体的速度、`yaw`、`pitch`、着地、潜行/疾跑/飞行、输入轴 forward/strafe（i8，×127）和 sneak——再加两个：
  - `viewTick`（第 4 节）。工作包 2 的校验用常量 `REPORT_MAX_LAG = 0.4` 秒容忍客户端的结构体副本落后多少（换载体时的位移余量、被携带时和世界重叠的余量），改成用这条上报实际的 `clamp((当前 tick − viewTick)/TPS, REPORT_MAX_LAG, 2)` 秒。换载体时（从行驶的船跳进水里、从码头登上行驶的船）客户端按 `viewTick` 的船位姿换算，服务器按当前的，两者差船速乘这段延迟；往返约 200 ms 以上，0.4 秒就不够了。
  - `landings`（u8，回绕）：客户端的身体落地的次数。工作包 2 应用一条上报时，`landings` 比上一条被应用的多出的次数（按 256 取模）减去这条上报自己的落地（它是空中之后第一条着地的算 1，否则 0），大于 0 就是有落地没看到（丢包、队列丢弃）：到目前为止跟踪的摔落就此结束，按已经累计的高度判（不算空缺里那段下落，所以只会比真实的低），从这条上报重新开始。否则落在台阶上的两次 3 格下落，中间着地的上报都丢了，会被合成一次 6 格摔伤。
  - 这两个字段和这两处改动归工作包 6，在工作包 2 合并后做。
  - 位置用 f64：f32 在一万格外精度只有千分之一格，脚踩在方块顶上也可能被量化进方块。
- 服务器收到后交给 `moves.ts`（第 8 节）。有非有限数的上报按校验失败处理，回校正。上报的载体在服务器上已经没了，工作包 2 也按校验失败（`check:carrier`）回校正。
- 校正在包的私有区里，和同一个 tick 的其他变化一起生效。客户端立刻采用校正的状态，换成新的 epoch，之后的上报带新 epoch；路上还带旧 epoch 的上报会被服务器丢掉，这段时间（约一个 RTT）服务器让玩家停在校正的状态（工作包 2）。不需要重放输入：客户端本来就是自己移动的权威，服务器只在它自己动了这个玩家时才说话。爆炸击退也是这样：服务器停一个往返，客户端从校正里的速度开始飞出去。
- 显示：校正和预测的差小于 1 格时，在载体坐标系里用 100 ms 混过去（只是画面，模拟状态立刻是校正值）；大于 1 格直接跳，相机一起跳；超过 48 格（复活、远距离传送）重新进加载界面，等新位置的就绪区在副本里就位（沿用 `game.ts checkTeleport`，判据改成看副本）。

**在行驶的船上，预测和校正怎么配合**

1. 预测在副本上跑工作包 2 的身体移动代码。每个客户端 tick：先把副本里所有船的位姿设到这一步的 `renderTick`、转子设到 `rotorTick`，再走一步。`StructureCache` 用相邻两步的位姿算携带量、转角和载体速度，和服务器上一样。渲染前再把位姿设到帧的时间。顺序和服务器一样：先动结构体，再携带，再自己移动、推开（LESSONS“每个 tick 的顺序”）。
2. 站在船上时，上报的是相对船的位置，服务器用它自己当前的船位姿换算。船自身的运动、客户端看到的船比服务器晚多少，都不会造成校正（审计第 7 条：按世界坐标上报，8 格/秒的船在 150 ms 下差约 1.2 格）。
3. 校正也是相对载体的，在客户端显示的那条船上直接生效，不用补偿船的延迟。
4. 只有和“别的东西”的关系受延迟影响：换载体，船上的人和码头、和另一条船、和别的船上的转子。这些靠工作包 2 的服务器校验留余量（换载体的余量、携带时和世界重叠的余量，延迟按 `viewTick` 量；挤压判定的滞回）。自己船上的转子、世界里的转子用 `rotorTick`，和服务器一致。
5. 舵手：座位由校正给出。坐着时客户端按副本里船的位姿跟随座位（工作包 2 的 `syncSeat`），上报带输入轴。被推离座位、座位进了世界方块由服务器判断，以校正下达。
6. 跟着船转的视角（`carriedYaw`）是客户端预测的一部分，服务器不发。
7. **停靠和方块化时被放下的人跟着取整走**。停靠和转子方块化会把结构体取整到最近的轴对齐姿态，最多转 45° 并平移半格。现在的 `releaseRiders` 只把人留在原来的世界坐标：取整后人可能悬空或嵌进方块，离旋转中心远的人会差好几格，达不到场景 32 的“没有人掉穿或被瞬移”。所以服务器提交停靠、方块化时，把被放下的人也用同一个取整变换搬过去（新位置 = 取整后的位姿 ∘ 他原来在载体里的局部坐标），然后发 cause 为 `release` 的校正。改动在模拟层：`entities/manager.ts releaseRiders` 接一个可选的变换，`structures/manager.ts` 的 `dockShip`、`stopRotor` 把取整变换传进去。归工作包 6，在工作包 2 合并之后做。

## 10. 意图

**客户端怎么选目标**

- 三种射线（普通、胶、桶）从 `sim/interact.ts` 抽成纯函数模块 `sim/rays.ts`：参数是网格列表、船和它们的船体信息、起点、方向、射线种类；`REACH` 一起搬过去。服务器和客户端用同一份。
- 第一人称用眼睛射线。越肩和正面视角用相机射线（相机位置、相机朝向），只接受离眼睛不超过 `REACH` 的命中——够不着的服务器反正会拒绝，这样目标框画出来的都能操作。DESIGN“视角”里“准星目标、放置和挖掘始终按第一人称的视线算”这一条随工作包 7 改掉。
- 目标框客户端自己画，不等服务器。

**目标的格式**：`Target { gridId, x, y, z, face, sub, cell }`，网格局部坐标；`sub` 同第 9 节（M2.1 是 0）；`cell` 是客户端看到的那一格的值。目标的任何一项变了（包括那一格被换成别的方块）都算目标变了。每个带目标的意图和 `Aim` 还带 `moveSeq`：发出它时最近一条已发出的移动上报的序号。眼睛就是那条上报的脚的位置加眼高（看潜行），在那条上报的载体坐标系里，所以意图不另带眼睛、载体和 tick。

**服务器的校验**（`src/net/server/intents.ts`，对每个带目标的意图）

1. 网格存在（`gridById`）；格子的 id 和 `cell` 的 id 相同（客户端看见的就是服务器上的这一块：A 右键舵轮的路上 B 把它挖了换成圆石，A 的右键不会作用到圆石上，创造模式的左键也不会挖掉 A 没见过的方块）；格子满足当前手持物品那条射线的谓词：普通射线 `targetable`；胶射线可瞄准且是硬方块；桶射线可瞄准或液体源，并且世界液体源不能在船体排开的地方（`displacedByHull`，DESIGN“结构体里没有液体”）。
2. 够得着：眼睛取 `moveSeq` 那条上报（`moves.ts` 的历史，第 8 节）；不在历史里（丢了、太旧）就取最新的一条。把眼睛从那条上报的载体坐标系用服务器当前的位姿换到目标网格的局部空间，到目标格子最近点的距离 ≤ `REACH + REACH_SLACK + min(5, (|v_rel|·viewLag + |v_own|·m)/TPS)`，`REACH_SLACK = 0.5`。
   - `viewLag` 是这个玩家当前的画面延迟（第 4 节，最近一条被应用的上报的），不是意图的年龄。
   - `v_rel` 是眼睛所在的载体（或世界）和目标网格在眼睛处的相对速度（`velocityAt`）。同一个网格、或者目标就在自己脚下的船上时为 0；人在 10 格/秒的船上、目标在码头、画面延迟 300 ms 时余量 3 格。
   - `v_own` 是那条上报里相对载体的速度。`m` 在用的正是 `moveSeq` 那条时为 1（客户端在两步之间瞄准），否则为 `viewLag`。
   - 这样服务器不需要保存结构体的位姿历史，眼睛也不用另外校验：它就是服务器校验过的上报，载体不同、刚下船也一样算。
3. 不检查遮挡（朋友之间不防作弊）。

任何一条不过，这个意图的目标就当作“无”。DESIGN 多玩家规则里“两人同时点同一个面，第二块会放在第一块上”随工作包 7 改成“第二块被拒绝（位置被占）”：第二个人的目标还是原来那个面，那一格已经被占了。

**持续的瞄准**：`Aim` 在客户端的目标变了时发，每个客户端 tick 最多一条，走可靠通道——要和按下、松开保持顺序，限时涂胶、按住挖掘、预览保持、提示都靠它。`Aim` 带两个目标：use 射线的（随手持物品）和挖掘射线的（永远是普通射线），两者相同时只发一个。服务器存为这个玩家“声称的瞄准”，每个 tick 开头重做第 1、2 条，眼睛取最新的一条上报（`m = viewLag`），不过就当作“无”（挖掘、限时涂胶随之取消）。

Hands 的改动（工作包 7）：客户端驱动的玩家（工作包 2 的标志）用声称的瞄准代替 `castRay`——`hit`、`mineHit`、`buildView` 里的那次射线、`pickBlock`；不是客户端驱动的玩家（测试里脚本控制的）照旧自己投射线。按下类意图带的目标在那个 tick 里优先于声称的瞄准。

**意图一览**（都走可靠通道，都带同一个递增的 `seq`）

| 意图 | 字段 | 服务器做什么 | 客户端立刻预测吗 |
|---|---|---|---|
| `Aim` | use 目标、挖掘目标、`moveSeq` | 存为声称的瞄准 | 目标框：是 |
| `Use` | `slot`、`sneak`、use 目标或无、`moveSeq` | `slot` 写进选中格，`sneak` 写进 input（这个 tick 里优先于移动上报里的 sneak：`beforeTick` 先交上报、后交意图）；校验目标；`usePresses++`、`input.use = true`；第 1 阶段按原来的右键优先级执行 | 否 |
| `UseRelease` | — | `input.use = false` | — |
| `Attack` | `slot`、挖掘目标或无、`moveSeq` | 同上，`attackPresses++`、`input.attack = true` | 否 |
| `AttackRelease` | — | `input.attack = false` | — |
| `SwapHands` | — | `swapPresses++` | 是 |
| `SelectSlot` | `slot` 0～8 | 选中格 | 是 |
| `PickBlock` | use 目标、`moveSeq` | 校验后 `Hands.pickBlock(目标)` | 是 |
| `InvClick` | `area`、`index`、`button` 0/2、`shift` | 范围检查后 `inventory.slotClick` | 是 |
| `CreativePick` | `item`、`shift` | 创造模式、物品存在才 `creativePick` | 是 |
| `DropCursor` | — | `dropCursorStack()` | 光标清空：是；掉落物：等服务器 |
| `CloseInventory` | — | 光标放回背包，放不下的扔出去（`game.ts closeInventory` 的逻辑搬进新的 `PlayerControl.closeInventory()`） | 是 |
| `ReleaseHelm` | — | 在掌舵就 `stopSteering`。打开背包时客户端发（场景 21） | 否（校正） |
| `Respawn` | — | 死了才 `respawn` | 否（校正） |
| `SetViewRadius` | `r` 0～17 | 订阅半径；模拟半径 `min(r, SIM_RADIUS_CAP)` | — |
| `HostCommand` | 见下 | 只接受房主的连接 | 否 |

`HostCommand` 的种类：`SetRules { rules: WorldRules }`（`defaultMode`、`dropsEnabled`）；`SetPlayerMode { entityId（0 = 自己）, mode }`；`SetDayTime { t }`；`Teleport { x, y, z }`（自己，调试）；`Give { item, count }`（自己，调试）；`Kick { entityId }`（工作包 11）。客人发来的回一个 toast `toast.host.only`（新的消息键）。单机暂停菜单里切模式 = `SetPlayerMode(自己)` + `SetRules(worldRulesFor(mode))`，和现在一样连世界规则一起切。暂停、存档、关服不在这里，它们是宿主控制消息：只有房主页面需要，客人发不了，Node 服务器有自己的控制台。`window.__blocklands` 的 `setDayTime`、`teleport`、`give` 改发这些命令。

**应用顺序**：服务器把每个连接收到的意图按 `seq` 排队，在下一个 tick 开头、`sim.tick()` 之前按 `seq` 应用。一个玩家一个 tick 最多应用到第一个“按下”类意图（`Use`、`Attack`、`SwapHands`）为止，或者 `INTENTS_PER_TICK = 16` 条（`Aim` 不算），后面的留到下一个 tick。这样每次按下都作用在它自己带的目标和当时的手持物品上，不会被同一个 tick 里更晚的 `Aim` 或背包操作改掉；每秒 20 次按下足够（创造模式连点约 10 次/秒）。

- 意图从不丢。可靠通道重传之后、客人断线十秒之后，几百条意图会一起到，照样按上面的规则排着应用（`Aim` 只是覆盖，很便宜）。丢掉一条 `AttackRelease`，服务器就会一直按着左键，创造模式下准星扫到哪挖到哪。排队超过 `INTENT_QUEUE_LIMIT = 1024` 条才断开（`Kick(protocol_error)`）。
- 死了的玩家：按下类意图、`PickBlock`、`ReleaseHelm` 消耗掉不执行，其余照常（松开、`Aim`、背包操作、`Respawn`）。死亡和复活时服务器清掉 `input.use`、`input.attack`（工作包 7）。

**被拒绝时客户端看到什么**

- 玩法上的拒绝（位置被占、转子在转、没胶、舵有人、停靠被挡……）：和单机一样的 toast，来自私有区的事件。
- 校验失败（够不着、目标过时、网格不存在）：没有提示（客户端的目标可能只是过时了），动作按“没有目标”执行或什么也不做，调试面板计数。
- 预测过的背包操作服务器得出了不同结果：确认号到了以后背包回到服务器的状态（见下）。
- 客人发房主命令：toast `toast.host.only`。

**哪些立刻预测，哪些等服务器**

- **立刻**：自己的移动和视角（工作包 6）；目标框；背包操作——点格子、创造模式拿取、换副手、选格、中键选取、关背包时放回光标。背包操作是 `Inventory` 上的纯函数，结果只取决于背包本身（中键选取还看副本里那一格是什么），客户端算得出同样的结果。做法：`InventoryPredictor` 保存服务器最后给的背包和还没确认的操作（`seq > ack`），显示的背包 = 在服务器的背包上重放未确认的操作；服务器的背包或 `ack` 一到就重算。中键选取先把 `Hands.pickBlock` 里改背包的部分抽成纯函数 `pickBlockInto(inv, item, creative)`（`entities/inventory.ts`）。
- **等服务器**：放置、挖掘（包括裂纹进度）、使用舵轮/轴承/爆破箱、涂胶、桶、组装预览、停靠、复活、换模式、松舵。它们改世界或影响别人，或者依赖只有服务器有的状态（预览、引信、别人的动作先后）。多人时每次点击要等一个往返（通常 60～200 ms）才看到方块；单机（Worker）里不到一帧。预测放置和挖掘需要逐次回滚，见第 17 节第 4 条。

## 11. 世界事件

- `blockBroken`、`blockPlaced`（网格 id + 局部坐标 + `Cell`）、`explosion`（位置、威力）、`sound`（名字 + 位置）。
- 走可靠包的 `events` 区，和同一个 tick 的方块变化一起生效（粒子和方块对得上）。不走不可靠通道：量很小，丢了就和方块对不上。
- 兴趣：世界事件所在的列的快照已经发给这个客户端（和区块增量同一条规则）；结构体上的事件要求结构体在兴趣内（客户端用自己副本的位姿换到世界）。
- `structureAdded`、`structureRemoved` 不再作为事件发，由结构体的生成和移除代替。
- `Replicator` 订阅 `sim.events`：带收件人的事件（`eventPlayer(ev) !== null`）只进收件人的私有区，世界事件按上面的兴趣分给各客户端。

## 12. 房主的存档

- 存档在服务器所在的 Worker 里做（Worker 里能用 IndexedDB）：`ServerHost.save()` = `exportSave(sim)` + `WorldMeta`，写进 `IdbStorage`，测试用 `MemoryStorage`。现在 `client/saves.ts` 里的存档排队（同时只存一份）搬过去；主菜单的世界列表仍由页面读同一个数据库。
- 什么时候存：
  - 模拟运行满 `AUTOSAVE_TICKS = 600`（30 秒，暂停不计）；
  - 宿主控制 `save`（单机打开暂停菜单时，和 M1 一样）；
  - 新世界创建后立刻存一次；
  - 关服 `shutdown { save: true }`：只有存成功才关，失败就报告并继续运行（LESSONS“保存失败仍然退出，进度丢失”）。
- 存什么：和现在一样的 `SaveBundle`——改过的区块，`sim`、`ticks`、`glue`、`structures`、`entities`、`players` 几个 blob（名字表 `SAVE_BLOBS` 在 `sim/persist.ts`），另加 `generator` blob（版本号 + `GeneratorSpec`）；没有 `generator` 的存档是 `meta.seedHash` 的地形世界（现在 `game.ts` 写的就是这种）。`players` 里是这个世界见过的每个玩家的记录，按 PlayerKey：在线的按存档时的状态，离开的按离开时的状态。客人不需要提前登记，第一次加入就有记录。
- 存储不能持久时（IndexedDB 打不开，退回内存）Worker 照样存、照样报 `saved { ok: true }`，但 `ready` 里说明 `persistent: false` 和原因，页面照 M1 提示玩家。新世界在存储打开之后才报 `ready`。
- 新世界的示例风车船（`placeExampleShip`）和开局物品由 `ServerHost` 放，不再由 `game.ts` 放。
- `WorldMeta.mode` 改存世界规则的默认模式（世界列表显示用）。
- 客人永远收不到：任何人的 PlayerKey；别人的记录（背包、生命、出生点）；存档本身；随机数状态；待处理的方块 tick；兴趣外改过的区块；别人手上在做的事（挖掘进度、预览、涂胶进度）。客人在自己的浏览器里只存 PlayerKey 和名字（localStorage），不存世界。

## 13. 带宽

估算假设：20 TPS；每条 WebRTC 消息约 80 字节开销（IP 20 + UDP 8 + DTLS 约 29 + SCTP 公共头 12 + DATA 块头 16）；4 人房间。

**平常**（4 人站在同一条行驶的风车船上，附近 6 只兔子），一个客人：

- 下行可靠：每 tick 一个包，大多只有 6～30 字节，偶尔有提示、背包、方块变化；平均按 20 + 80 字节 × 20 = 2 KB/s。
- 下行不可靠：1 条船 22 B + 3 个人 × 21 B + 约 2 只正在跳的兔子 × 18 B + 头 4 B ≈ 125 B，加开销约 205 B × 20 ≈ 4 KB/s。
- 合计约 6 KB/s（50 kbit/s）。房主上行，3 个客人约 18 KB/s（150 kbit/s）。
- 上行：移动上报 57 + 80 字节 × 20 ≈ 2.7 KB/s，加上 `Aim` 和点击不到 3.2 KB/s。房主下行约 10 KB/s。

**加入**：数据量 = 订阅半径内改过的区块（中位约 2.0 KB，p90 约 2.85 KB；玩家轻度改动的列 2.6～2.7 KB）+ 结构体（木板船实测每格约 0.3～0.4 字节，4000 格约 1.5 KB；按存档量法的上限约 9.4 KB）+ 实体（约 25 B 一个）+ 原样区块的标记（约 6 B × 半径 9 时约 280 列 ≈ 1.7 KB）。

- 出生点附近 30 个轻度改动的区块、3 条船：约 80 + 2 + 2 ≈ 84 KB（船按存档量法的上限 12 KB 时约 94 KB）。
- 最坏：半径 9 内 280 列全改过，约 560～800 KB。
- 快照预算 `SNAPSHOT_BUDGET = 16 KB/tick`（320 KB/s）是上限；推迟的新兴趣只在可靠积压不到 0.1 秒的送出量时发（第 2 节），所以实际速度就是房主上行送得出的速度，校正和方块变化前面不会排上几秒。就绪区最多 49 列，最坏约 140 KB：320 KB/s 下约 0.45 秒，1 Mbit/s 上行约 1.1 秒。

**3700 格的船在四个人旁边组装**（每个客人）：

- 第一下右键：只有点击的人收到预览，包围盒位图约 1 KB。
- 组装那个 tick：世界里清掉 3700 格，分布在 3～6 列，每列几百格，低于重发线，走增量：排好序的 index 差分 1 字节 + 格子值 1～2 字节，最多约 2.5 B/格；船的生成实测约 1.2～1.35 KB（按存档量法的上限 8.8 KB）；补水改的就是这些格子的最终值，不另算。实测一个包 7～9 KB（全按上限估约 18 KB）。
- 房主一次发 3 份约 21～27 KB，1 Mbit/s 上行约 0.2 秒送完（按上限 54 KB 约 0.45 秒；客人在收到这个包的那一帧同时看到格子消失和船出现）。
- 之后每 tick 一条 22 B 的位姿采样。

**全速飞过没去过的地方**（创造模式疾飞 18 格/秒 = 1.125 区块/秒）：圆形的兴趣每秒新进约 2 × 半径 × 速度列，半径 9 约 20 列/秒，半径 17 约 38 列/秒。没去过的区块是原样的，每列约 6 字节，不到 0.3 KB/s。代价在生成：客户端半径 9 约 20 × 2.3 ms ≈ 46 ms/s（地形 Worker 池）；服务器只到 `SIM_RADIUS_CAP = 10`，约 23 列/秒 ≈ 53 ms/s（`ServerHost` 在 tick 之间同步生成，每 tick 预算 6 ms ≈ 2.6 列 = 52 列/秒，刚好跟得上）。飞过改过的区块时半径 9 约 20 × 2.0 KB = 40 KB/s（全是轻度改动的列时约 54 KB/s）。

**大面积流水**（溃坝）：这个游戏的水每 tick 平均只改几格到几十格（实测平均约 4 格，峰值约 130 格）。稀疏时每列增量的头占主要部分，约 3～3.5 B/格；格子密集时约 2.5 B/格。即使按峰值算也只有约 8 KB/s。

**超预算时的优先级**（每个客户端、每个 tick）：

1. 必须发、整段发：私有区（校正在最前）、已有对象的变化、这个 tick 新出现的结构体和实体、退订、事件、全局区（第 5 节）。
2. 剩下的预算按顺序给推迟的新兴趣：结构体生成（近的先，父在子前）→ 实体生成（近的先）→ 区块快照（近的先）。
3. 采样另算：不可靠积压超过第 2 节的线时整个 tick 不发；一个 tick 的采样超过 4 条消息（约 4.6 KB）时，近的先发，其余轮到下一个 tick。

**服务器对每个客户端的限制**：

- 上行单条消息 ≤ `MAX_CLIENT_MESSAGE_BYTES = 2048` 字节，`Hello` ≤ `MAX_HELLO_BYTES = 512` 字节。
- 意图：不丢，按第 10 节每 tick 应用；排队超过 `INTENT_QUEUE_LIMIT = 1024` 条断开。
- 移动上报：队列上限 10（第 8 节）。
- `viewRadius` ≤ 17；名字 ≤ `MAX_NAME_LENGTH = 24` 个字符；身份 ≤ `MAX_PLAYER_KEY_LENGTH = 128`。
- 可靠积压 > 8 MiB 持续 10 秒：`Kick(too_slow)`。
- 握手之后解不开的消息、未知的消息 id、第二个 `Hello`、消息到达的通道和它规定的通道不同：`Kick(protocol_error)`（握手之前的错误回 `Refuse(bad_hello)`）。客户端收到 M2.1 存不下的格子值（≥ 2¹⁶）同样按协议错误断开。

`Replicator` 从一开始就按客户端、按区段统计发出的字节数（调试面板显示），工作包 13 用它调预算。

## 14. 编码

全部用 `src/save/bytes.ts` 的 `ByteWriter`、`ByteReader`。解码出错时 `ByteReader` 抛 `SaveFormatError`，解码函数包成 `ProtocolError`，连接按 `protocol_error` 断开。每个完整消息的解码函数最后调 `expectEnd()`（只读 `Hello` 开头 `build` 的 `readHelloBuild` 除外）。编解码是纯函数，只看字节，不看副本；没有模块级的临时对象（LESSONS“临时向量被改写”）。

- 所有格子坐标和区块坐标（包括差分累加后的，以及预览盒子的远角）|v| ≤ `MAX_COORD = 2^28`，超出按协议错误。
- 范围超出布局规定的值域（枚举、标志位、视距 0～17、选中格 0～8、按键 0/2）按协议错误，不夹到范围内。
- 解码时 RLE 是不按输入比例分配内存的地方之一：结构体的盒子 sx·sy·sz ≤ `MAX_STRUCTURE_BOX_CELLS`（= `STRUCTURE_MAX_BOX_CELLS` = 2^21，第 7 节）；一个 `TickBatch` 里所有 `CellVolume` 合计 ≤ `MAX_BATCH_CELLS = 2^25` 格（1024 列）。编码端同样拒绝，`Replicator` 打包时不得超过（超过的快照推到下一个包）。另一处是预览位图（见 `PrivateState` 位 3）。

**基本类型**

| 名字 | 写法 |
|---|---|
| `vu` / `vi` / `str` | `varuint` / `varint` / `string`（bytes.ts 的约定） |
| `u8` `u16` `u32` `i32` `f32` `f64` `bool` | bytes.ts 的同名方法 |
| `i8` / `i16` | 用 `u8` / `u16` 写补码，读时做符号扩展（`net/codec.ts` 的小函数，bytes.ts 没有） |
| `Cell` | `vu v`；`v & CELL_MULTI_BIT` 时再一个 `vu` 第二部件（第 6 节） |
| `Pos32` | `i32 round(v × 512)`：1/512 格，范围 [−4 194 304, +4 194 304)，正好是世界的坐标范围 |
| `Rot64` | 4 × `i16 round_half_away_from_zero(q × 32767)`，读出后归一化 |
| `Ang16` | `u16`：角度 /(2π) × 65536 取模 |
| `Pose` | `Pos32 ×3` + `Rot64`（20 字节） |
| `Target` | `vu gridId, vi x, vi y, vi z, u8 face, u8 sub, Cell cell` |
| `OptTarget` | `u8 有无` + `Target` |
| `Stack` | `vu (item + 1，0 = 空)`，非空时再 `vu count` |
| `Message` | `str key, vu n`，每个参数 `str name, u8 tag`（0 数字后跟 `f64`，1 文字后跟 `str`）。没有参数时解码出的 `Message` 不带 `params`；参数名重复按协议错误 |
| `CellVolume(n)` | `u8 enc`；0 = 调色板：`vu P`（1..n）、`P × Cell`、游程 `vu token` 直到覆盖 n 格，`token = (len − 1) × 2^B + idx`，`B` = `P − 1` 的位数（用乘除，不用位运算：结构体的盒子可以很大）；1 = 原样：`n × Cell`。调色板超过 `PALETTE_LIMIT = 4096` 项时用 1 |
| `GlueList` | `vu n`，每面 `vi dx, vi dy, vi dz, u8 axis`，和前一面的坐标差（从 0,0,0 起），规范顺序 |
| `GeneratorSpec` | `u8 kind`：0 地形 `u32 seed`；1 平地 `u32 seed, vu n, n × (vu cell, vu thickness)`；2 虚空 `u32 seed`。生成器类加一个 `spec()` 方法给出它 |

**客户端 → 服务器**

| id | 消息 | 通道 | 布局 | 大小 |
|---|---|---|---|---|
| 0x01 | `Hello` | 可靠 | `str build, str playerKey, str name, u8 viewRadius`（开头的 id + `build` 永不改） | ~60 B |
| 0x02 | `Bye` | 可靠 | — | 1 B |
| 0x03 | `Ping` | 不可靠 | `u32 clientMs` | 5 B |
| 0x10 | `MoveReport` | 不可靠 | `vu seq, vu epoch, vu viewTick, vu carrierId, f64×3 pos, f32×3 vel, f32 yaw, f32 pitch, u8 flags`（0 着地 1 潜行 2 疾跑 3 飞行 4 输入 sneak）`, i8 forward, i8 strafe, u8 landings` | ~57 B |
| 0x20 | `Aim` | 可靠 | `vu seq, vu moveSeq, OptTarget use, bool mineSame, [OptTarget mine]`（两个目标相同时必须用 `mineSame`：标志为假又重复同一个目标按协议错误） | 6～40 B |
| 0x21 | `Use` | 可靠 | `vu seq, vu moveSeq, u8 slot, u8 flags`（0 sneak）`, OptTarget` | 7～24 B |
| 0x22 | `UseRelease` | 可靠 | `vu seq` | 2～4 B |
| 0x23 | `Attack` | 可靠 | `vu seq, vu moveSeq, u8 slot, OptTarget` | 6～23 B |
| 0x24 | `AttackRelease` | 可靠 | `vu seq` | 2～4 B |
| 0x25 | `SwapHands` | 可靠 | `vu seq` | 2～4 B |
| 0x26 | `SelectSlot` | 可靠 | `vu seq, u8 slot` | 3～5 B |
| 0x27 | `PickBlock` | 可靠 | `vu seq, vu moveSeq, Target` | ~20 B |
| 0x28 | `InvClick` | 可靠 | `vu seq, u8 area`（0 hotbar 1 inventory 2 offhand）`, u8 index, u8 button, bool shift` | ~7 B |
| 0x29 | `CreativePick` | 可靠 | `vu seq, vu item, bool shift` | ~6 B |
| 0x2A | `DropCursor` | 可靠 | `vu seq` | |
| 0x2B | `CloseInventory` | 可靠 | `vu seq` | |
| 0x2C | `ReleaseHelm` | 可靠 | `vu seq` | |
| 0x2D | `Respawn` | 可靠 | `vu seq` | |
| 0x2E | `SetViewRadius` | 可靠 | `vu seq, u8 r` | |
| 0x30 | `HostCommand` | 可靠 | `vu seq, u8 kind` + 载荷：0 `SetRules`（`u8 mode, bool drops`）；1 `SetPlayerMode`（`vu entityId, u8 mode`）；2 `SetDayTime`（`f32 t`）；3 `Teleport`（`f64×3`）；4 `Give`（`vu item, vu count`）；5 `Kick`（`vu entityId`） | |

模式的编号 0 = creative、1 = survival（和 `save/codec.ts` 的 `MODES` 同序）。

**服务器 → 客户端**

| id | 消息 | 通道 | 布局 |
|---|---|---|---|
| 0x81 | `Welcome` | 可靠 | `vu entityId, GeneratorSpec, vu worldTime, vu dayOffset, u8 defaultMode, bool drops, bool isHost, bool roomOpen, vu n, n × (vu entityId, str name, bool host)` |
| 0x82 | `Refuse` | 可靠 | `u8 reason, str detail`（布局和 reason 1 永不改）。reason：1 build、2 bad_hello、3 full、4 closed、5 shutting_down、6 same_key |
| 0x83 | `Kick` | 可靠 | `u8 reason, str detail`。reason：1 replaced、2 too_slow、3 protocol_error、4 shutdown、5 kicked、6 timeout |
| 0x84 | `Pong` | 不可靠 | `u32 clientMs, vu tick` |
| 0x85 | `TickBatch` | 可靠 | `vu tick, u16 sections`，然后按位序排列的区段（下表）。解码后列表类的区段总是数组（不在包里的是空数组） |
| 0x86 | `Samples` | 不可靠 | `vu tick, vu seq`（每个客户端各自递增，用来算丢失率）`, vu nShips, nShips × (vu id, Pose), vu nEntities, nEntities × EntitySample`；超过 1150 字节就拆成几条，每条自成一体、`seq` 连续（`packSamples`） |

**`TickBatch` 的区段**

| 位 | 布局 |
|---|---|
| 0 unsubscribe | `vu n, n × (vi cx, vi cz)` |
| 1 snapshots | `vu n`，每列 `vi cx, vi cz, u8 kind`（0 原样，1 格子）`, [CellVolume(32768)], vu nGlue, nGlue × vu face`（`face` 的位布局见第 6 节“快照”） |
| 2 chunkDeltas | `vu n`，每列 `vi cx, vi cz, vu nCells, nCells × (vu index 与上一个的差, Cell), vu nGlue, nGlue × vu (face + added × 2^17)` |
| 3 structureRemoves | `vu n, n × vu id`（子在父前） |
| 4 structureSpawns | `vu n, n × StructureRecord` |
| 5 structureDeltas | `vu n, n × StructureDelta` |
| 6 structureRests | `vu n, n × (vu id, Pose)` |
| 7 entityDespawns | `vu n, n × vu id` |
| 8 entitySpawns | `vu n, n × EntityRecord` |
| 9 entityUpdates | `vu n, n × EntityUpdate` |
| 10 private | `PrivateState` |
| 11 events | `vu n, n × WorldEvent` |
| 12 globals | `u8 mask`：0 `vu dayOffset`；1 `u8 mode, bool drops`；2 `vu n, n × (u8 op`（0 加入 1 离开）`, vu entityId, [str name, bool host])`；3 `vu tps×10`；4 ready（无载荷）；5 `bool roomOpen` |

**记录**

- `StructureRecord`：`u8 kind`（0 ship 1 rotor）`, vu id, vu parentId, vi minX, vi minY, vi minZ, vu sx, vu sy, vu sz, [CellVolume(sx·sy·sz)，盒子为空时没有], f64×3 pivot, f64×3 position, f64×4 rotation, GlueList`；转子再加 `vi bx, vi by, vi bz, u8 axis, f64×4 baseRotation, f64 angle, f64 angularSpeed, vu sails, bool frozen`；船再加 `vi hx, vi hy, vi hz, u8 forward, f32 throttle, f32 rudder, vu helmsmanId`。头约 130 字节 + 格子 + 胶。
- `StructureDelta`：`vu id, u8 mask`；位 0 `vu n, n × (vi dx, vi dy, vi dz, Cell)`（与上一格的差，从 0,0,0 起）；位 1 `vu n, n × (vi dx, vi dy, vi dz, u8 axis + added × 4)`；位 2 `f64×3 pivot`；位 3 `vi hx, vi hy, vi hz, u8 forward, vu helmsmanId`；位 4 `f32 throttle, f32 rudder`；位 5 `f64 angle, f64 angularSpeed, vu sails, bool frozen`。
- `EntityRecord`：`vu id, u8 kind, vu carrierId, Pos32×3, Ang16 yaw`；player 再加 `i16 pitch`（round_half_away_from_zero(pitch/(π/2)×32767)）`, u8 flags`（0 潜行 1 疾跑 2 飞行 3 死亡 4 着地）`, vu steeringShipId, vu heldItem+1`；item `vu item, vu count`；falling `Cell`；tnt `vu fuse`；rabbit 无。
- `EntitySample`：`vu id, u8 kind, vu carrierId, Pos32×3, Ang16 yaw`，`kind` 是 player 时再加 `i16 pitch, u8 flags`。约 18～21 字节。
- `EntityUpdate`：`vu id, u8 mask`；位 0 最终状态（同 `EntitySample` 去掉 id，含 `kind`）；位 1 `vu item, vu count`；位 2 `vu fuse`；位 3 `u8 flags, vu steeringShipId, vu heldItem+1`。
- `PrivateState`：`u8 mask`，按位依次：
  - 0 `Correction`：`vu epoch, str cause, vu carrierId, f64×3 pos, f32×3 vel, f32 yaw, f32 pitch, u8 flags`（0 飞行 1 着地）`, vu seatShipId, [f64×3 seat]`（只在 `seatShipId ≠ 0` 时有；f64 的理由同第 9 节的位置）。约 75 字节，坐着时约 100 字节。
  - 1 背包：`u8 selected, HOTBAR_SLOTS × Stack, MAIN_SLOTS × Stack, Stack offhand, Stack cursor`（9 格和 27 格）。80～120 字节。
  - 2 `f32 health, f32 maxHealth, vu air, vu maxAir, bool dead, u8 mode`。约 14 字节。
  - 3 视图：`u8 mask`；0 `u8 有无, [vu gridId, vi x, vi y, vi z, u8 sub, u8 progress]`；1 `u8 有无, [vu gridId, vi x, vi y, vi z, u8 face, u8 sub, u8 progress]`；2 `u8 有无, [vu gridId, u8 kind, vi minX, vi minY, vi minZ, vu sx, vu sy, vu sz, ceil(sx·sy·sz/8) 字节位图]`（位序同 `CellVolume` 的格子顺序，第 i 格是第 i>>3 字节的第 i&7 位）；3 `vu n, n × (vi dx, vi dy, vi dz)`；4 `u8 有无, [Message]`。
    - 预览的格子数 ≤ `MAX_PREVIEW_CELLS`（= max(`SHIP_MAX_CELLS`, `ROTOR_MAX_CELLS`) = 4000），盒子体积 ≤ `MAX_STRUCTURE_BOX_CELLS`（位图最多 256 KiB，放得进一条消息），远角 ≤ `MAX_COORD`；超出时编码端抛错、解码端按协议错误，在分配之前检查。编码端总是发紧凑包围盒，盒子外的位必须为 0。服务器只为游戏会组装的结构体（或缺帆的转子）做预览，它们都在这两个上限之内（第 7 节）。
  - 4 事件：`vu n`，每个 `u8 type`：0 toast `Message, u8 kind`（0 info 1 warn 2 error）；1 受伤 `f32 amount, str cause`；2 死亡 `str cause`；3 拾取 `vu item, vu count`；4 松舵 `str cause`。
  - 5 `vu ack`。
  - 6 `vu moveAck`。
- `WorldEvent`：`u8 type`；0 blockBroken、1 blockPlaced：`vu gridId, vi x, vi y, vi z, Cell`；2 explosion：`f32×3, f32 power`；3 sound：`str name, f32×3`。

**大小估计**（实测）：空包 4～6 字节（tick < 2^21，约 29 小时）；平常的包 6～60 字节；原样快照 6 字节 + 每个胶面 3 字节；改过的快照中位约 2.0 KB（p90 约 2.85 KB，最大可到 4.8 KB；玩家轻度改动的列中位 2.6～2.7 KB；调色板游程和存档相同，比存档编码小 17～29 字节）；区块增量每列约 6 字节 + 每格 2～4 字节；结构体生成约 130 字节 + 格子（木板船实测每格约 0.3～0.4 字节，3700 格整条约 1.2～1.35 KB；按存档的量法每格 2.4 字节是上限）+ 每个胶面 3～7 字节；结构体增量约 3 字节 + 每格约 5 字节；采样消息约 5 字节 + 每条船 22 字节 + 每个实体 18～21 字节；校正约 75 字节（坐着时约 100）；预览位图最多 256 KiB（盒子上限 2^21 格）。

**版本**：没有单独的协议版本号，`BUILD_ID` 相同才能连（第 3 节）。不做兼容：版本不同就拒绝连接。

## 15. 模块布局

```
src/net/
  protocol.ts     常量、消息 id、所有消息的 TS 类型（纯数据）、BUILD_ID          工作包 3
  codec.ts        编解码：基本类型、Cell、CellVolume、GlueList、各消息、ProtocolError、readHelloBuild、packSamples  工作包 3
  transport.ts    Transport 接口、通道常量                                      工作包 3
  loopback.ts     LoopbackNet、createLoopbackPair、LinkConditions               工作包 3
  server/
    replicator.ts Replicator：变化收集、每个客户端的记账（订阅、已发状态、私有状态）、打包、预算、背压   工作包 4
    capture.ts    世界格子、世界胶、结构体格子/胶/字段、实体的变化收集               工作包 4
    interest.ts   区块圆、结构体包围球、实体兴趣、回差                              工作包 4
    moves.ts      移动上报的排队、过滤、交给工作包 2、历史；舵手超时                  工作包 6
    intents.ts    意图的排队、校验和执行（写 input、声称的瞄准、调 PlayerControl）   工作包 7
  host/
    netserver.ts  NetServer：连接表、握手、顶替、Refuse/Kick、收消息排队、tick 开头的分发   工作包 8
    host.ts       ServerHost：Simulation + NetServer + Replicator、时钟、补跑、tick 之间的区块生成、存读档、宿主控制   工作包 8
    control.ts    宿主控制消息（页面 ↔ 自己的 Worker，结构化克隆对象）              工作包 8
    port.ts       PortTransport：MessagePort 上的 Transport，积压按转发方的报告算   工作包 8
    worker.ts     Worker 入口（唯一碰 self/postMessage 的文件）                  工作包 8
  client/
    apply.ts      ReplicaState（区块经 ReplicaColumns、世界胶、结构体和实体的数据与服务器给的最新位姿、私有状态、玩家表）+ applyBatch；只是数据，没有时钟、光照、采样环   工作包 4
    netclient.ts  NetClient：连接、握手、加入、就绪、重连、消息分发、frame(now)、隐藏时的应用   工作包 5
    clock.ts      ServerClock：arrivalTick、rtt、D、renderTick、rotorLead、rotorTick   工作包 5
    replica.ts    ClientReplica：在 ReplicaState 上加 LightEngine、采样环、转子推演、hull 缓存   工作包 5
    chunks.ts     ClientChunks（实现 ReplicaColumns）：订阅表和代号、原样区块的生成（ChunkSource）、等待中的增量队列   工作包 5
    predict.ts    OwnPlayer：在副本上跑工作包 2 的移动、上报、校正、显示混合        工作包 6
    intents.ts    目标选择（眼睛/相机射线）、Aim 和意图的发送、序号               工作包 7
    inventory.ts  InventoryPredictor                                          工作包 7
src/sim/rays.ts   三种射线的纯函数（从 interact.ts 抽出），REACH                  工作包 7
tests/net/digest.ts   两边状态的摘要和比较                                       工作包 4
tests/net/harness.ts  NetHarness、HeadlessClient（真的 NetClient）、RawClient      工作包 8，5 和 8 合并时接上真的客户端（6、7 给 HeadlessClient 加预测和意图）
tests/net/e2e-*.test.ts  经整套真的代码的端到端测试；e2e-scenes.ts 是它们共用的场景  5 和 8 合并时
```

**各工作包还要改的现有文件**

- 工作包 4：`src/sim` 只加 `ChunkManager.stashedCells(cx, cz)`（解码暂存的列但不恢复，解不开返回 null；`net/server` 不能引用存档编码）。`structures/rotor.ts` 导出扫掠的量法，`StructureManager` 改用它（第 7 节）。`codec.ts` 加 `encodeSnapshotPiece`、`encodeStructureRecordPiece`、`encodeTickBatch(batch, pieces)`：输出和 `encodeServerMessage` 逐字节相同；`encodeTickBatch` 不限长度，由调用方对照 `MAX_RELIABLE_BYTES`。`Replicator` 每列每个版本只编码一次快照，字节在客户端之间共享（编码一列约 0.14 ms）。
- 工作包 5：只在 `src/net/client` 里，不碰 `client/`。`ReplicaState` 的区块部分改成经 `ReplicaColumns` 应用（`has/unsubscribe/snapshot/delta` 和 `world`，由 `ClientChunks` 实现）；“副本有这一列”指已订阅（可能还在生成），引用检查按订阅表做。别处直接用 `ReplicaState` 时自己构造一个 `ClientChunks`。
- 工作包 6：`entities/manager.ts`、`structures/manager.ts` 的“被放下的人跟着取整走”（第 9 节第 7 条）；工作包 2 的上报加 `viewTick`、`landings` 和对应的两处校验改动（第 9 节）。都在工作包 2 合并后做。
- 工作包 7：`sim/interact.ts`（声称的瞄准、`mining`/`gluing`、射线抽走）、`sim/view.ts`（`InteractionView` 的两个字段）、`sim/players.ts`（`closeInventory`、声称的瞄准的入口、死亡和复活时清按键）、`sim/messages.ts`（`toast.host.only`）、`entities/inventory.ts`（`pickBlockInto`）。
- 工作包 8：`client/workerfactory.ts` 加服务器 Worker：`createServerWorker()` 和 `createServerWorkerFromDataUrl()`（不透明来源的沙箱），都是异步的，第一次用时才用动态 import 载入 Worker 的代码（单独一个 chunk，游戏的主 chunk 不背它）；单文件构建内联，同现在的模式。`ServerHost` 的存档排队照 `client/saves.ts` 写；生成器类加 `spec()`，`worldgen/generator.ts` 加 `generatorFromSpec`（`GeneratorSpec` 也搬到那里，`protocol.ts` 转出）；开局物品在 `sim/starter.ts`。`client/serverprobe.ts` 是浏览器里检查服务器 Worker 的探针（`scripts/e2e-server-worker.mjs` 调它，页面这边是真的 `NetClient`）。浏览器游戏还不用服务器。
- 工作包 9：浏览器游戏在这一个工作包里整体切换，之前的工作包都不让它坏。`client/game.ts`、`client/session.ts` 改成永远“创建服务器 Worker → `NetClient` 经 `PortTransport` 连接”；`client/view.ts`、`structures.ts`、`meshing.ts`、`uistate.ts`、`debug.ts` 改读 `ClientReplica`（接口由工作包 5 给出：`world`、`worldGlue`、`structures()`、`entities(renderTick)`、`ownState`、`dayTime`）；删掉 `client/chunkstream.ts` 和 `client/saves.ts` 的存档排队；`sim/simulation.ts`、`sim/chunks.ts` 把 `LightEngine` 从服务器拿掉（审计：玩法从不读光照；服务器的区块共用一份只读的光照数组，每列省 32 KB）；`tests/acceptance` 的 `TestWorld` 和全部验收测试的改写（第 16 节）；`scripts/e2e-smoke.mjs`。

**顺序**：3 → 4 → 5 → 8 → 6 → 7 → 9，6 还要等工作包 2 合并。4 的测试只用 `apply.ts`；5 的测试回放构造的包，或者经 harness 连真的服务器；6、7 的服务器部分挂在 8 的 `NetServer.beforeTick` 上（`ServerHostOptions.sinks` 的 `MoveSink`、`IntentSink`），用 harness 测。

**依赖方向**

```
core ─▶ blocks ─▶ voxel ─▶ {worldgen, light, liquid, structures, entities} ─▶ sim ─▶ net/server ─▶ net/host
                                     │                                               ▲
                                     └────────────▶ net/client ◀── net/{protocol, codec, transport, loopback}
                                                        │
                                                        ▼
                                                     client ─▶ ui
```

- `net/protocol`、`codec`、`transport`、`loopback`：只引用 `core`、`blocks`、`save/bytes`，以及 `sim/view.ts`、工作包 2 的上报和校正、`worldgen/generator.ts` 的 `GeneratorSpec` 的**类型**。不引用任何模拟的运行时代码，不碰 DOM。
- `net/server`：可以引用 `sim`、`structures`、`entities`、`voxel` 和上面四个基础模块。
- `net/host`：可以引用 `net/server`、`sim`、`save`、`worldgen`。只有 `host/worker.ts`、`host/port.ts` 碰 Worker 和 MessagePort 的 API。
- `net/client`：可以引用 `voxel`、`blocks`、`light`、`structures`（`Ship`/`Rotor`/`StructureGrid`/`GlueStore` 数据类、`hull`、`rotor`）、`entities`（工作包 2 的身体移动、`Inventory`、实体数据类）、`worldgen`（生成器）、`sim/view.ts`、`sim/messages.ts`、`sim/rays.ts` 和基础模块。**不能**引用 `sim/simulation`、`interact`、`players`、`chunks`、`persist`，不能引用 `net/server`、`net/host`，不碰 DOM（这样整个客户端逻辑能在 Node 里无头跑）。
- `client`：引用 `net/client`；只有 `workerfactory.ts`（和主线程退路）引用 `net/host` 的运行代码；其余 `client` 模块可以引用 `net/host/port`（`PortTransport`）和 `net/host/control` 的类型。
- `tests/net/layering.test.ts` 扫描 import，拦住违反上面规则的引用（同 `tests/sim/single-player-guard.test.ts` 的做法）。

**服务器一个 tick**（`ServerHost.tickOnce()`）：`netServer.beforeTick()`（超时；离开和顶替；握手通过的加入；然后按玩家实体 id、到达顺序把排队的上报全部交给 `moves.receive`，再把排队的意图全部交给 `intents.receive`，然后 `moves.beforeTick()`、`intents.beforeTick()`）→ `sim.tick()` → `replicator.endTick()` → `netServer.afterTick()`（踢掉太慢的客户端）。上报和意图在到达时只排队，过滤是 `moves.ts`、`intents.ts` 的事。两次 tick 之间：处理到达的消息（只排队，`Ping` 立刻回）、按时间预算生成区块（`sim.chunks.wanted()` + `loadColumn`，和现在 `ChunkStreamer` 喂 `provide()` 一样在 tick 之外做，`syncChunks` 只留给测试）。

**宿主控制消息**（`host/control.ts`，页面 → Worker）：`create { meta, options: { generator?, exampleShip? } }`、`load { worldId }`、`connect { port, local }`（每个连接一个 MessagePort，本机客户端 `local = true`，它就是房主连接）、`pause { paused }`（只在房间没开放时接受，不接受时报 `error { what: 'pause' }`）、`save`、`openRoom` / `closeRoom`（工作包 11；`openRoom` 让暂停的服务器继续，`closeRoom` 现在只改标志、不踢客人）、`shutdown { save }`。Worker → 页面：`ready { meta, persistent, reason }`（`reason` 在能持久时为 null，否则同 `openBestStorage` 的 code）、`saved { ok, code }`、`status { tps, players }`（变了才发，每秒最多一次）、`error { what, message }`（tick 里抛出的异常报 `what: 'tick'` 并停住时钟）、`closed`。

**无头联机测试的组装**（`tests/net/harness.ts`，一个进程里）

- `NetHarness`：一个 `LoopbackNet`（虚拟时钟）、一个真的 `ServerHost`（计时器是网络队列上的事件，区块生成按个数预算而不是毫秒，`MemoryStorage`）。`h.sim` 就是服务器的 `Simulation`，测试直接在上面搭场景、驱动服务器上的机器人。
- `addClient(key, conditions = {up?, down?}, opts = {local?, name?, viewRadius?, build?, genDelayMs?, start?, transport?, record?})` 返回 `HeadlessClient`：真的 `NetClient` 和它的 `ClientReplica`；`openTransport` 每次拨一条新的回环链路接到 `ServerHost`（重连时再拨）；`ChunkSource` 用 `Welcome` 的 `GeneratorSpec` 同步生成（`genDelayMs` 时在网络队列上延后回答，像 Worker 池）。harness 给每个客户端每 16.7 ms 一帧（各自的相位）、每秒一次 heartbeat（页面的计时器，页面隐藏时照样走）。`addRawClient` 返回 `RawClient`：只发测试让它发的（原始字节、Hello 之前的消息、沉默、迟到的关闭），只给 `NetClient` 不会犯的错用。
- 工作包 6、7 往 `HeadlessClient` 上加：`frame(now)` 先 `NetClient.frame`，然后是预测（副本上的 `OwnPlayer`，经 `NetClient.sendMoveReport` 上报）和意图（`NetClient.send`）；保持的输入（`forward`、`strafe`、`jump`、`sneak`）和与 `PlayerControl` 同名的脚本接口（`lookAtCell`、`aimAt`、`use`、`attack`、`hold`、`mine`……）是这个类的字段和方法，`stopInput()` 松开它们；校正、背包、确认号从 `onBatch` 来。
- 链路：每条链路数两端发出和收到的可靠消息，`quiesce()` 靠它知道还有没有在途的。客户端的 `conditions` 对象就是回环每次发送时读的那个，改它立刻改当前链路。`sever(c)`：当前链路两端都失败（两端的 `onClose` 都触发，像 ICE 失败）；`crash(c)`：页面死了，从客户端这端关传输、不发 `Bye`，不再有帧和 heartbeat；`inject(c, …)`：从服务器那端直接给客户端发原始字节（出错的服务器）。
- `run(ms)`、`runUntil(cond)`、`ticks(n)`：推进虚拟时间，服务器每 50 ms 一个 tick，消息在到期时送达。`wakeEveryMs`（后台页面的计时器只在整秒醒）、`timerLateMs`、`stallServer(ms)`。`quiesce()`：停掉输入，跑到没有在途的上行消息再加 10 个 tick；然后停住服务器的时钟，把在途消息全部送达、可见的客户端全部应用（每个副本都在服务器的最后一个 tick）；之后的 `run`/`runUntil` 让时钟继续。
- `tests/net/digest.ts`：每列格子的 CRC32、胶面集合、结构体（格子、胶、字段、pivot、同一 tick 的位姿）、实体（位置容差）的摘要；`compareReplica(server, client)` 返回不一致的列表。`track(c)`：服务器在每个 tick 后按 `Replicator.clientView` 记下被改过的列和结构体、实体的摘要，客户端应用完同一个 tick 的包（`NetClient.onBatch`）后比较，用来做逐 tick 的一致性检查；还在生成的列两边都不算，位姿（连同实体的载体：动着的实体换载体走采样）不比（`NetClient` 一帧里先应用所有的包再插采样，到某个包时最新的位姿可能早一个 tick 或已经晚一个 tick）。每帧还检查 `renderTick` 不超过最新已应用的包，不对的也记进 `mismatches`。全量比较（`compareNow`，含位姿）在 `quiesce()` 之后做；在丢包的链路上，先等船停住（停下时最终位姿走可靠通道），否则还在动的船的最后一条采样可能丢了。`history` 选项记下最近 2400 个 tick 的船位姿、转子角度、实体位置，给按 `renderTick` 的显示检查用。
- 除了传输、计时器、区块来源这三样，全部是产品代码。

**工作包 10～14 接在哪里**：10 实现 `Transport`（`WebRtcTransport`）和 `Signaller`，房主页面把数据通道转发到 `connect` 进来的端口，并往端口回报积压（第 2 节）；11 用 `Refuse`/`Kick` 的原因、`Hello` 的名字、全局区的玩家表、`NetClient` 的重连、地址参数 `?slot=` 和宿主控制的 `openRoom`；12 读 `ClientReplica` 里玩家实体的标志、手持物品、掌舵和玩家表的名字；13 调 `SNAPSHOT_BUDGET`、背压的线、D 的公式，用 `Replicator` 的字节统计；14 两个页面（第二个用 `?slot=`）加一个本地信令。

## 16. 测试计划

各工作包自己的单元测试：

- 3：每种消息的往返（随机内容，编码再解码深度相等）；截断、乱改字节只抛 `ProtocolError`，不崩、不分配巨大内存；盒子正好 `STRUCTURE_MAX_BOX_CELLS` 的结构体记录和预览往返，多一格两端都拒绝；`Cell` 在 M2.1 拒绝 ≥ 2¹⁶；`CellVolume` 对真实地形区块的大小不超过存档编码 + 4 字节；回环的顺序、丢包率、SCTP 重传模型的队头阻塞和带宽限制。
- 4：`Replicator` 挂在一个 `Simulation` 上，传输换成记录器，包解码后 `applyBatch` 到 `ReplicaState`，在组装、停靠（船上带风车）、转子启停、爆炸、溃坝、区块进出兴趣的脚本场景里逐 tick 比较摘要。
- 5：录下的包序列回放到 `ClientReplica`；时钟在抖动、丢包、补跑突发下不倒退、D 收敛；可靠通道卡住时 `renderTick` 不越过已应用的包；原样区块生成期间的增量排队、退订再订阅时作废在途的生成；载体被删时别人的位置连续。
- 6：校正之后队列里旧 epoch 的上报不被应用、乱序的上报不让位置倒退；两次落地之间的上报全丢不产生摔伤；从行驶的船跳进水里、从码头登上行驶的船，往返 150 ms 和 400 ms 都不被校正；`rotorLead` 收敛到服务器实际应用上报的 tick。
- 7：目标格的方块换了，意图按“无目标”执行；边走边按住挖掘不中断（单机、150 ms，走、疾跑、疾飞）；一阵延迟之后成批到达的意图里，松开照样生效。
- 8：被顶替的旧连接迟到的关闭不影响新连接；收到 `Kick` 的客户端不重连；房间里的 `PortTransport` 按转发方的报告算积压，慢链路上推迟的快照不让校正排队超过约 0.1 秒；页面隐藏时本机客户端照样应用包。

**验收场景**

| 场景 | 测试 |
|---|---|
| 30 单机走同一套协议 | `tests/acceptance` 加 `TestWorld`：`sim`（服务器的 Simulation，用来搭场景、读结果）、`me`、`tick(n)`。`me.input`（保持的输入：forward、strafe、sneak、jump、yaw、pitch）、`me.player`（服务器上的实体，只读）、`me.lookAtCell/aimAt/useOn/mine/hold/teleport/...`。“直接”模式下 `me` 包着 `sim.soloPlayer`；“联机”模式下输入和瞄准交给 `HeadlessClient`（经预测和意图），传送、换模式走房主命令，链路零延迟，`tick()` 按锁步走：客户端一帧（输入、预测、发送）→ 送达 → 服务器一个 tick → 送达 → 客户端应用，D 固定为 1；这时每个 tick 正好一条上报，`moves.ts` 的队列总是空的，tick 数和直接模式一样。工作包 9 把验收测试和 helper 全部改成用 `w.me`（现在 14 个文件里有 459 处 `soloSim`/`soloPlayer`、141 处直接写 `input` 或调 `teleport`），并加一个守卫测试，拦住 `tests/acceptance` 里的 `soloPlayer` 和对 `.input.` 的写。vitest 加一个 project 用联机模式再跑一遍全部验收测试（`npm test` 两种都跑），每个测试结束后 `compareReplica` 必须为空。浏览器冒烟测试经 Worker 跑单机，两种渲染器。 |
| 31 两人在行驶的船上 | 两个客户端，往返 150 ms、抖动 20 ms、丢包 5%；船以油门 1、舵 0.5 转圈 60 秒；两人都站着不动。断言：每个客户端上，对方在 `renderTick` 的载体局部位置和服务器上的差 < 0.05 格；加入以后没有收到 cause 以 `check:` 开头或为 `crush` 的校正；没有 `crush` 受伤事件；自己的载体局部位置漂移 < 0.01。再跑一遍两人在甲板上来回走：校正次数 0。 |
| 32 停靠时有人在甲板上 | A 掌舵（船斜着 30° 行驶后停靠），B 站在离 pivot 最远的甲板角上；延迟同 31。断言：停靠后两人都在世界方块上着地；B 的世界位置等于取整变换后他原来的甲板位置（差 < 0.05）；没有下落超过 0.6 格；没有受伤；两端摘要一致。 |
| 33 同一区块里同时放和挖 | 两个客户端（30 ms；120 ms + 5% 丢包），按固定种子在同一个 16×16 范围里随机放置、挖掘 30 秒。逐 tick 比较被改过的列的摘要；`quiesce()` 后两个副本和服务器全量一致。 |
| 34 中途加入 | 服务器上：一处刚溃的坝、一条在开的船、一架在转的风车。B 加入，从 `ready` 起逐 tick 比较 B 的摘要（区块、胶、结构体格子；同一 tick 的转子角度差 < 1e-9）。然后 A 组装一条木筏再停靠：B 的每一帧里，“世界里的木板数 + 结构体里的木板数”不变（不重复、不消失）。再用 3700 格的船做一遍。 |
| 35 掌舵的人断线 | A 掌舵油门 1，直接关掉 A 的传输（不发 `Bye`）：一个 tick 内（`onClose`）以及只停发上报的变体里 2 秒内（`STEER_TIMEOUT_TICKS`），舵松开、`throttle = 0`。A 用同一身份重连：位置、背包等于离开时的记录。 |
| 36 存档、重开、再加入 | `ServerHost` + `MemoryStorage`：A 在船上时存档、关服；新的 `ServerHost` 读档，A 在第一个 tick 前加入（单机房主的情况）：位置、背包、所在的船、掌舵都接着。另一个变体：A 在第一个 tick 之后才加入（客人的情况）：位置和背包恢复，船没动时仍站在船上（船开走了的情况见第 17 节之后的“已知的不一致”）。 |
| 37 房主在后台 | 虚拟计时器每 1000 ms 才唤醒一次服务器：服务器每次补 5 个 tick，全局区的 TPS（按墙上时间）< 15，客户端 3 秒内显示“服务器受限”；只断客人的链路时显示“连接不稳定”；恢复正常唤醒后提示消失。另测：房主的客户端停止发帧和上报时服务器照常 tick，客人看到船在走。浏览器里的后台测试放进工作包 14。 |

**LESSONS 里联机可能带回来的坑**

| 坑 | 测试 |
|---|---|
| 携带与实体（贴船游泳被拎上船、甲板边缘掉下去、离开甲板仍被拖着、贴墙走被判挤伤） | g5 的携带场景在联机模式（场景 30）和 150 ms + 5% 丢包下各跑一遍，断言同单机 |
| 每个 tick 的顺序（推开用了上一 tick 的位置） | `predict.test.ts`：转圈的船上零输入站 200 个客户端 tick，载体局部位置不变；预测里位姿设置先于移动 |
| 站在行驶的船上被风车误推、误判挤伤 | 船上带风车，玩家站在叶片扫过的高度边缘，150 ms：没有 `crush` 校正和受伤（`rotorTick` 预测） |
| 死亡、打开界面、暂停后状态错乱 | 掌舵时死亡：校正的 cause 是 `death`、载体 0；死时按着左键、复活后服务器不再挖；打开背包发 `ReleaseHelm`；单机暂停：服务器停、客户端不预测，甲板上的人和掉落物 60 秒内不动 |
| 舵手穿过方块 | 掌舵把座位开进码头方块：服务器松舵并发校正，延迟下客户端不卡在方块里 |
| 组装、停靠、方块化时方块重复或消失 | 场景 34 的守恒检查，加上转子在船上停下、爆炸炸到船上的轴承（场景 13）的联机版 |
| 停靠时站在转盘上的人被瞬移 | 场景 32 的转盘变体：船上的转盘停下时站在上面的人跟着取整 |
| 胶的存储（移动、旋转后键要重算） | 组装、转 90° 停靠、转子启停后世界胶和结构体胶的摘要两端一致 |
| 同种子开新世界，上一局的胶还在 | 断开后在同一个页面开新世界：新副本的胶为空（副本随连接整个丢弃） |
| 读档后液体冻在半路 | 场景 34 的溃坝部分：读档后加入，水继续流，两端一致 |
| 临时向量被改写 | 一个进程里三个客户端交替解码（harness 本身），摘要一致；编解码没有模块级可变状态（layering 测试顺带扫 `let` 的模块级声明） |
| 测试在高负载下超时、游戏时间变慢 | 服务器时钟和渲染无关：harness 里客户端不出帧时服务器照常 tick；补跑上限 5 |
| 监听器在回调里取消订阅 | `Replicator` 在爆炸的批处理里（转子方块化、船被删）收集变化：不漏、不重复 |
| 光照引擎必须是第一个监听器 / 区块卸载后留下“鬼光” | 副本的光照在增量、退订再订阅之后和对同样格子的全量重算一致 |
| 天空的昼夜和游戏时间不一致 | `SetDayTime` 之后客户端的昼夜和服务器的差不超过 D 个 tick |
| 某个区块网格化失败，加载界面永远卡住 | 损坏的快照：客户端以协议错误断开并显示原因，不停在加载界面；原样区块生成失败沿用现在的退路 |
| 存档写得出、读不回（两边大小限制不一致） | 4000 格的船、盒子正好 `STRUCTURE_MAX_BOX_CELLS` 的结构体、调色板 4096 项、一个包 `MAX_BATCH_CELLS` 格、4 MiB 消息在编码和解码两边的上限相同（往返测试）；游戏、存档、网络用同一个盒子上限 |
| 界岩能直接放到船上 | `Use` 意图把界岩放到船上被拒绝（意图走同一个 `place`） |
| 船被弹飞（未加载区块当成实心） | 预测：副本里还没插入的区块旁边，自己的角色冻结而不是被推开 |
| 盒子坐标是无穷大时查询永不结束 | 带 NaN、Infinity 的移动上报和意图：服务器回校正或忽略，不卡住 |
| 距离判断偏差（参考点不一致） | 够得着的判断两边用同一个眼睛（上报的脚 + 眼高）和同一个格子最近点；兴趣两边都按脚下的区块 |
| 保存失败仍然退出 | `shutdown { save: true }` 遇到存储报错：服务器不关，页面收到 `saved { ok: false }` |

## 17. 负责人已经决定的事

负责人在 2026-11-18 确认：下面六条都按建议做。

1. **客人能不能自己切换创造 / 生存？** 建议：不能，只有房主能改别人的模式（`SetPlayerMode`）。代价：房主要有一个玩家列表来改（工作包 11 的界面，很小）。反过来让客人自己切，生存房间就没有意义了。
2. **服务器在每个玩家周围只模拟 10 个区块（显示仍可到 17）？** 建议：是（`SIM_RADIUS_CAP = 10`）。代价：10 区块以外看得见的水不流、沙不落、世界里的风车不转（周围的区块没加载，转子冻结），直到有人走近；M1 里看得见的风车都在转，这一点比较容易注意到。不设上限的话，4 个人各开 16 的渲染距离、分散在各处时，房主 Worker 里约 4 × 960 列 × 64 KB ≈ 250 MB，每有一个人加入还要多生成约 2 秒。这和 DESIGN 里“区块围绕每个玩家按各自的视距加载”不同，要改那一条。
3. **掉线就是离开，没有宽限期；舵手 2 秒没有上报就松舵？** 建议：是。代价：网络卡两秒的舵手会丢掉舵，他的身体在别人那里消失，重连后从记录恢复。反过来留 10～30 秒的“掉线中”身体，要给玩家注册表加一个状态，而且这段时间船会无人驾驶地开着。
4. **放置和挖掘不在客户端预测？** 建议：M2.1、M2.2 都不做。代价：联机时每次点击要一个往返（通常 60～200 ms）才看到方块变化，单机不受影响。要做的话，每次点击都要能在服务器不同意时（位置被占、别人先挖了）回滚，约 300～500 行加测试。两台机器试玩之后再定。
5. **每个第一次进入某个世界的玩家（包括客人）都发开局物品？** 建议：是。代价：生存世界里客人白得一套木板、舵轮、轴承和胶。不发的话，客人在生存世界里两手空空。
6. **转子按“现在”显示（`rotorTick`，第 4 节）？** 建议：是。自己的角色被叶片推开时，客户端和服务器用同一个角度，站在风车旁、船上不会被误判挤伤（LESSONS“站在行驶的船上被风车误推”）。代价：叶片推船、扫过别的玩家时，画面上叶片比它们超前 ω·(D + rotorLead)/TPS 弧度，`rotorLead` ≈ RTT·TPS/1000 + 1.5。转速 1 弧度/秒时：往返 150 ms、D = 3 约 0.37 弧度（10 格长的叶片尖端约 3.7 格）；往返 800 ms（单程 400 ms）、D = 4 约 1.1 弧度（约 60°，叶尖约 10 格）。只有叶片碰到船或别人时看得出来，风车自己转、船上的风车跟着船走都正常。反过来按 `renderTick` 显示，画面上叶片还没碰到你你就被推开了，差的角度一样，而且显示和预测要各推一份转子。

## 18. 实现时补定的规则

下面几条是实现和审查各工作包时定下来的，正文没写或写得不够的地方以这里为准。

### 工作包 4（服务器端同步）

- **整组发送**（第 5、7 节）：新出现的结构体连同它的根结构体和兄弟转子一起整组发。根结构体在客户端已有它或它的任一转子时，按退出线判断兴趣。
- **携带时的 yaw**（第 7、8 节）：实体有载体时，yaw 是相对载体世界朝向（`headingOf(载体的世界旋转)`）的，和移动上报一样。载体被删时，客户端除了换算位置，还要把 yaw 加上被删载体的世界朝向、减去父结构体的世界朝向。
- **世界事件**（第 11 节）：只发给这个包之前就已有那一列或那个结构体的客户端。同一个包里刚生成的结构体上的事件不发，生成记录里已经有那一格。
- **实体的推迟**（第 8、13 节）：脚下区块在本包才发出快照的实体，用快照之后剩下的预算发，预算不够就在后面的包里发。
- **采样的先后**（第 13 节）：采样超过 4 条消息时，上个 tick 被挤掉的先发，然后近的先发。被挤掉之后不再动的不补采样，它的最终位姿走可靠的 `structureRests` 或最终状态。
- **放不下的重发**（第 13、14 节）：放不进 `MAX_BATCH_CELLS` 的必须发的重发快照，改发整列的增量。
- **必须发的内容超限**（第 5、13 节）：必须发的内容超过 `MAX_BATCH_CELLS` 或 `MAX_RELIABLE_BYTES` 时，这个客户端按 `too_slow` 断开，不再给它发包。正常玩法到不了这个量。
- **TPS**（第 4 节）：不在 `Welcome` 里，新客户端在第一个包的全局区收到。
- **客户端应用包时的检查**（第 14 节）：下面这些都是协议错误，在改副本之前检查。
  - 应用 `StructureDelta` 之后结构体的紧凑包围盒超过 `MAX_STRUCTURE_BOX_CELLS`。
  - 引用副本没有的载体或父结构体。
  - 删父结构体而它的子结构体还在（同一个包里没有改挂）；子结构体排在父结构体之后删。
  - 同一区段里同一列或同一个 id 出现两次。
  - 船带父结构体；给转子发 rest、helm、control；给船发 rotor；给别的种类的实体发数量、引信、玩家字段；生成自己的实体。
  - 位姿和转子、舵的浮点数不是有限数。
  - 例外：不可靠采样的载体在副本里没有时，忽略这条采样（它可能先于生成或晚于删除到达）。
- **交互视图**（第 9 节）：工作包 7 之前，`mining` 和 `gluing` 由 `Replicator.viewUpdate` 从现在的 `breakProgress`、`glueProgress` 和目标格推出来。工作包 7 把 `InteractionView` 改成直接给出这两个字段后，删掉这两处推导；意图确认号由工作包 7 通过 `ClientFeed.intentAck` 提供，移动上报确认号由工作包 6 通过 `ClientFeed.moveAck` 提供。

### 工作包 5 和 8（客户端、服务器宿主，以及两者合并）

- **副本里的位姿**（第 7 节）：结构体网格上的位姿是显示位姿（`ClientReplica.setPoses(renderTick, rotorTick)` 写入）；服务器给的最新位姿另存在 `ReplicaStructure.pose`（和它的 tick `poseTick`）。船的线速度和角速度取 `setPoses` 时夹住 `renderTick` 的两条采样。`entities(renderTick)` 里以转子为载体的实体用最近一次 `setPoses` 的 `rotorTick`。
- **显示时间**（第 4 节）：`renderTick` 在一个连接内不减小；`setPaused(false)` 让它重新开始。
- **丢失率**（第 4 节）：按最近 200 个采样 `seq` 算，期望的条数不到 40 时取 0。
- **卡顿提示**（第 4 节）：“`Pong` 还在来”= 最近 2500 ms 内收到过 `Pong`（每秒一个 `Ping`，丢一个 `Pong` 不算断）。
- **Ping 和 Welcome 的先后**（第 3 节）：客户端在收到 `Welcome` 之后才发 `Ping`（`Hello` 之后马上发的 `Ping` 可能在不可靠通道上越过 `Hello`，被当成 `bad_hello`）。服务器对已通过握手、还没 `Welcome` 的连接收到的 `Ping` 照样回 `Pong`。早于 `Welcome` 到达的 `Samples` 忽略（它们可能越过重传中的 `Welcome`）；`Welcome` 之前的 `TickBatch`、第二个 `Welcome` 是协议错误。
- **就绪区的中心**（第 3 节）：取最新校正的位置所在的列（载体局部坐标用载体在校正那个包的 tick 的位姿换算）；圆用 `Hello` 的 `viewRadius`。
- **重连**（第 3 节）：传输关闭（没有 `Refuse`、`Kick`）后状态是“连接中断，正在重连”，直到新的 `Welcome`。传输至多每 2 秒建一次（`RECONNECT_RETRY_MS`；连接活过 2 秒则立即重建，`openTransport` 失败时 heartbeat 每 2 秒再试），不退避。`Hello` 发出后 `CONNECTION_TIMEOUT_MS` 内没有 `Welcome`，客户端关闭传输，按重连处理。codec 或副本的协议错误结束连接并显示原因（状态 `failed`），不重连。
- **页面隐藏**（第 5 节）：每条消息在消息处理里应用，之后推进时钟（`ServerClock.advance`）并更新光照；采样环在插入时修剪，所以什么都不会堆起来。
- **实体的采样**（第 8 节）：不认识的 id 的实体采样和船的一样先存 32 tick，生成时丢掉 tick 不晚于生成记录的。
- **世界事件**（第 11 节）：`ReplicaState.events` 只放最后一个包的事件。一帧可以应用好几个包，消费者在 `NetClient.onBatch` 里读每个包的 `batch.events` 和私有事件。
- **握手**（第 3 节）：检查的顺序是 `build` → `bad_hello` → `shutting_down` → `closed` → `same_key` → `full`。名字去掉控制字符（C0、DEL、C1）后要剩 1～24 个码点；身份是 1～128 个 0x21～0x7E 的字符。`same_key` 只对非本机的 `Hello`；新的本机连接顶替旧的本机连接。握手 75 秒还没完成的连接回 `Refuse(bad_hello)`。`Bye` 立刻结束连接（服务器关它那端），之后到的不管。
- **满员**（第 3 节）：按模拟里（经这个服务器加入）的玩家加上已握手、等待加入的身份计；当前连接已结束、下个 tick 才离开的玩家仍占位，所以同一个 50 ms 里来的第五个身份被拒绝。重连、顶替的身份不重复计。
- **超时和意图洪水**（第 3、13 节）：超时在每个 tick 开头检查，暂停的服务器不让任何人超时。两个 tick 之间排队的意图超过 `INTENT_QUEUE_LIMIT`，tick 之前就 `Kick(protocol_error)`；`IntentSink.receive` 返回 false 时也是。
- **宿主控制的顺序**（第 15 节）：命令按发出的顺序一条一条执行。`connect` 可以紧跟任何命令发出（读档、存档还在进行时）；Worker 收到 `connect` 时就接管端口但不启动它，在它被执行之前到达的消息（包括关闭）留在端口里，执行时按顺序交给连接。
- **积压的第一次报告**（第 2 节）：转发方在端口接上时立刻回报一次（`bufferedAmount` 0、`seen` 0），之后照常。否则在第一次报告之前积压按 0 算，和本机的端口分不开，加入的头几个包是盲发的。
- **已知的缺口**（第 2、13 节）：可靠积压的检查通过之后，一个 tick 的推迟内容可以用满 `SNAPSHOT_BUDGET`（16 KB），所以“校正、方块变化前面最多排约 0.1 秒”在约 160 KB/s 以下不成立（64 KB/s 实测排 200～250 ms）。改法是每个 tick 推迟的新兴趣最多发 min(`SNAPSHOT_BUDGET`, max(8 KiB, 0.1 秒 × 速率)) 字节；`Replicator` 还没有这样做，留给工作包 13。

## 附：有意不做的，以及什么时候需要

- 快照压缩（deflate）：房主上行慢到加入要等十几秒时再加（浏览器的 `CompressionStream` 是异步的，要改打包流程）。
- 服务器端的位姿历史和延迟补偿：现在用相对速度乘延迟的余量。出现大量“够得着却被拒绝”的反馈时再做。
- 船的客户端预测：负责人已决定不做。
- 采样相对已确认状态的差分压缩、按带宽自适应的兴趣范围：超过 4 人或带宽成为瓶颈时（工作包 13 先看统计）。
- 遮挡校验和其他防作弊：只在朋友之间玩，等有公开房间时再说。
- 断线重连时保留副本：重新加入的等待成为抱怨点时。
- 别人的挖掘裂纹、别人的组装预览：试玩时想要再加，是私有视图的一部分广播出去。
- 服务器端嵌套的地形 Worker：Node 专用服务器、更多玩家或更大的模拟半径时。
- 中继服务器、WebSocket 传输、Node 专用服务器：M2.2 之后（`Transport` 接口已经留好）。
- 玩家身份是持有即可用的令牌（发给房主是明文）：一个恶意的房主可以拿客人的身份去别人的房间冒充他。朋友之间接受，以后改成密钥对。

**场景 36 和玩家记录**（已定）：玩家记录除了世界坐标，还存离开时所在的载体 id 和载体里的局部坐标。再加入时载体还在、那个位置站得下，就放回船上；否则用世界坐标。这样“在朋友的船上下线，回来还在船上”。读档后第一个 tick 还没加入的人仍按“存档时已离开”处理（松舵、船停），但记录里的载体保留。改动在 `sim/players.ts`，归工作包 6。

第 17 节的六条负责人已确认按建议做。
