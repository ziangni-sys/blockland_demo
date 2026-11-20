# 架构（重写版）

本文件是代码层面的总约定。玩法规则见 [DESIGN.md](DESIGN.md)，踩坑记录见 [LESSONS.md](LESSONS.md)，验收场景见 [ACCEPTANCE.md](ACCEPTANCE.md)，里程碑见 [ROADMAP.md](ROADMAP.md)。

## 技术栈

- TypeScript（strict）+ Vite 8 + Vitest 5。运行时依赖只有 `three`（WebGPURenderer + TSL，自动回退 WebGL2）。
- `npm run dev` 开发；`npm test` 无头测试（Node）；`npm run typecheck`；`npm run build` 普通静态站；`npm run build:artifact` 产出单文件 HTML（JS 内联、Worker 走 blob URL）。

## 分层与依赖方向

```
core ─▶ blocks ─▶ voxel ─▶ { worldgen, liquid, structures ─▶ entities } ─▶ sim ─▶ net/server ─▶ net/host
           │         └──▶ light ─▶ net/client（副本、时钟、预测、意图；不引用 sim 的运行时）──▶ client ─▶ ui
           └──▶ mesh（纯函数，Worker 里跑；voxel 只取类型）──▶ render（three.js）
art（程序化贴图，纯函数）      save（codec 纯函数 + 存储适配器；运行时只引用 core、blocks；structures 用它的 save/cells）
```

硬性规则：

1. **模拟层**（`core blocks voxel worldgen light liquid structures entities sim mesh art` 以及 `save` 的 codec）**不得**引用 DOM、`window`、`three`、`performance`、`Math.random()`、`Date`。它必须能在 Node 里无头步进。随机数一律用 `core/rng.ts`，时间一律用 `world.time`（tick 计数）。
2. **渲染层**（`render/`）只消费 `mesh/types.ts` 的 `MeshData` 和 `render/backend.ts` 里的状态结构，不引用任何模拟对象。换渲染器 = 重写 `render/three/`。
3. `client/` 是唯一同时认识游戏状态和渲染的地方，但它认识的是 `net/client` 的**副本**，不是模拟：页面启动一个服务器（Worker；不行就退到主线程，中间仍然是字节），通过协议连上去，读副本、做插值、把副本翻译成 backend 调用。tick 由服务器自己的时钟驱动。`ui/` 只做 DOM。`net/` 的分层和消息见 [NETCODE.md](NETCODE.md) 第 15 节。
4. 下层不得 import 上层。三个扫描测试守着依赖方向：`tests/core/layering.test.ts`（`src/net`、`src/client` 以外的目录：每个目录能引用哪些目录、模拟层的模块级缓存、禁用的全局），`tests/net/layering.test.ts`（`src/net`），`tests/client/no-simulation.test.ts`（`src/client`）。
5. 数学对象是普通对象（`{x,y,z}` / `{x,y,z,w}`）。**没有全局共享的临时向量**；`out` 参数由调用者持有（LESSONS“临时向量被改写”）。
6. **形状只有一套查询**：值上的在 `blocks/shapes.ts`，网格上的在 `voxel/parts.ts`、`voxel/shape.ts`、`voxel/raycast.ts`。各系统不自己判断“这一格是不是整格实心”。问“这一格有没有硬材质”可以只看第一部件的 id：带缺口的部件都是可切的材质，可切的材质都是硬的。

## 坐标与约定

- 右手系：+X 东，+Y 上，+Z 南。格子 `(x,y,z)` 占据 `[x,x+1)³`。
- 方向 `Dir`：0 +X，1 −X，2 +Y，3 −Y，4 +Z，5 −Z（`core/dirs.ts`）。
- 朝向：`yaw = 0` 看向 −Z，yaw 增大 = 向左转（俯视逆时针）；`pitch > 0` 抬头。前向量 `(-sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch))`。
- 时间：20 TPS，`TICK_DT = 0.05`。渲染在上一 tick 与当前 tick 的状态之间插值。
- 区块 16×128×16；按 16³ 的 section 网格化；海平面 `SEA_LEVEL = 48`。
- 八分格 `o = ox | oy << 1 | oz << 2`：某一位为 1 表示在那个轴的正半边。半格坐标 `h = 2·格坐标 + 八分格在这个轴上的那一位`（[SHAPES.md](SHAPES.md) 第 1.1 节）。

## 方块

- 格子由至多两个**部件**组成，部件 = 材质（id + 状态）+ 它占的八分格（DESIGN“材质与形状”）。
- **格子值**（`blocks/cell.ts`）：0～9 位 id，10～15 位状态，16～23 位第一个部件的缺口（哪几个八分格空着），第 24 位 `CELL_MULTI_BIT` 表示还有第二个部件。存缺口而不存占用，所以整格方块的值小于 2¹⁶，就是 id + 状态。`getCell` 返回的就是它，总小于 2²⁵（V8 的小整数，读它的热路径不分配）。第二个部件的值（同样的 id + 状态 + 缺口，小于 2²⁴）另用 `getPart2` 读。朝向、液位、层数都在状态位里，**不给朝向开新 id**。
- **整格内容**（packed）= 格子值 + 第二部件 × 2²⁵，小于 2⁴⁹，双精度里精确。凡是“把一个格子当成一个数”的地方都用它：`setCell` 的参数、变更事件的新旧值、`forEachCell`、`getPacked`、协议和存档里的 `Cell`、粘连谓词、射线结果和目标里的 `cell`。对它做位运算（`& ID_MASK` 等）读到的是第一部件。
- **每 tick 运行的代码不构造、不传递双部件格子的整格内容**：它 ≥ 2³¹，在 V8 里是堆上的数，传给没被内联的函数每次装箱。这类代码读 `getCell` 和 `getPart2` 再查表（现成的入口是 `voxel/parts.ts` 的 `solidFillAt`、`solidAtHalf`）；按整格内容的查询只给一次性的工作用：组装的泛洪、放置、挖掘、编解码（[SHAPES.md](SHAPES.md) 第 4.4 节）。
- 一格的内容只有一种合法写法：带缺口的部件必须是可切的材质（`CUTTABLE`），两个部件不重叠，含编号最小的被占八分格的那个部件在前（[SHAPES.md](SHAPES.md) 第 1.3 节）。`setCell` 对 ≥ 2¹⁶ 的值检查这些（`voxel/parts.ts checkCanonical`，不合法抛 `RangeError`）；第 24 位为 1 而没带第二部件的值（漏拷了第二部件）在 `setCell`、编解码、按形状或按接触判断的函数里都抛错，不会悄悄丢数据；只读 id 的判断（能不能连进结构体、能不能涂胶、掉落什么）不查。不可信的格子（网络、存档、平地生成器的层、调试命令）进入存储之前过 `blocks/shapes.ts cellProblem`。
- `blocks/registry.ts` 定义 `BlockDef` 和按 id 索引的扁平表（`SOLID`、`OPAQUE`、`CUTTABLE`…），它们是**材质**的性质；`blocks/defs.ts` 是方块表，id 稳定（进存档），只追加不重排。几何一律从形状查询取：`blocks/shapes.ts` 有按 256 种占用掩码在加载时算好的表（体积、质心、盒子分解、面的象限覆盖、24 个旋转）和值上的查询（占用、面的覆盖、合并与拆分、旋转、`cellProblem`）。
- 硬 = 材质的 `solid`；其余是软方块（空气、液体、花草、火把、雪层）。不能切的硬方块（舵轮、轴承、螺旋桨、仙人掌、沙、砾石、爆破箱、界岩）永远按整格算。
- 物品：方块物品 id == 方块 id；非方块物品从 1024 起（`blocks/items.ts`）。
- 命名与外观必须原创（README）。

## 统一的体素网格（`voxel/`）

`VoxelGrid`（`voxel/grid.ts`）是世界、船、转子共同的接口：`getCell/getPart2/setCell`、`toWorld/toLocal`、`dirToWorld/dirToLocal`、`velocityAt`、`worldRotation`、`cellBounds`、`parent`。`setCell` 写整格内容，一次写入只发一次变更事件。`voxel/parts.ts` 在它上面给出整格的读写和部件操作：`getPacked`、`copyCell`、`solidFillAt`、`solidAtHalf`（点查询只收半格整数坐标，不提供收小数的版本）、`removePartAt`、`addPartAt`，以及留给凿子的 `removeOctantAt`、`restoreOctantAt`。对一格的任何修改都是“读整格内容 → 用 `blocks/shapes.ts` 算出新内容 → 一次 `setCell`”，钩子不会看到改到一半的格子。

- **三层存储**（`blocks/cell.ts` 的 `CellLayers`，区块、结构体、网格化输入、协议、存档共用）：基础层 `Uint16Array`（id + 状态）、缺口层 `Uint8Array`、第二部件层 `Uint32Array`。后两层在第一次写入需要它们的格子时才分配，之后不释放（区块活着的时候；结构体到下一次重新分配存储为止），所以层不是 `null` 不等于里面有非零项；交出层的地方（`Chunk.layers()`、`copyBox`、`storage()`）对全 0 的层给 `null`，摘要和编码只看非零项。层的引用只在下一次对这一列或这个结构体的 `setCell` 之前有效。只有整格方块的区块只有基础层，每格 2 字节，读一格就是读一个 16 位数。
- `World`（`voxel/world.ts`）：区块存储（三层）、光照存储、**唯一的方块改动钩子** `onCellChange`、待处理方块 tick 队列 `TickQueue`、网格脏标记（用 `takeDirtySections()` 取）。未加载位置 `getCell` 返回 `CELL_UNLOADED`（实心、不可破坏）；`y<0` 是界岩，`y≥128` 是空气。只改缺口或第二部件也发变更事件；钩子按“内容变了”处理，不按“id 变了”。
- `StructureGrid`（`voxel/sgrid.ts`）：结构体的稠密存储（三层，随盒子 `resize`、`grow` 一起搬）+ 位姿。`父空间点 = position + rotate(rotation, 局部点 − pivot)`；可嵌套（`parent` 是另一个 `StructureGrid`）。每 tick 移动前先 `snapshotPose()`，渲染用 `renderPose(alpha)`。`copyBox` 拷出一个盒子的三层（结构体记录、网格快照），`loadBox` 整个换成一个盒子（客户端的生成记录），`storage()` 给逐格扫描的船体物理，`layered` 表示分配了另外两层。
- 胶（`structures/glue.ts` 的 `GlueStore`）按格面存储，世界一份、每个结构体一份。所有增删都经过存储并发出变更事件。存留的规则在 `structures/stick.ts`：格子变化时 `StructureManager` 的钩子调 `pruneGlueAt`，两条规则——面的两侧都不再有可涂胶、并且在这个面上有材质的格子，就去掉（`glueFaceKept`）；一格还在、但不再和对面接触（`cellsTouch` 由真变假），也去掉。区块加载时 `pruneGlueInBox` 只用第一条。组装时的搬移和落回方块时的清理在 `structures/assembly.ts`：落回时去掉落下的格子和原有方块之间的胶（[SHAPES.md](SHAPES.md) 第 10.2、11.2、11.3 节）。
- 射线、盒体相交、推出向量等查询**只写一份**，对任意 `VoxelGrid` 生效（`voxel/raycast.ts`、`voxel/shape.ts`）。碰撞只看硬材质的占用：八个八分格都占满的格子按格子跑整格的算法，部分格子按八分格在半格网格上跑同一套算法，推出时挨着部分格子的整格也按八分格算。区块没有另外两层、结构体不是 `layered` 时只走整格的算法，层是 `null` 还是全 0 结果相同。射线命中到八分格，结果带命中的部件。实体的身体永远是**世界轴对齐的盒子**；对旋转的网格，把盒子变换到网格局部空间做 OBB-格子 SAT。站立 / 推开 / 附着 / 挤压四种判定用同一个盒子定义，只是内缩量不同，且附着盒严格在推开盒之内（LESSONS“携带与实体”第一条）。
- 船体分析（`structures/hull.ts analyzeHull`）把格子分成实心、舱底、密封、敞开，部分格子按八分格分（`HULL_MIXED`）；浮力、干区、实体的液体采样、桶的射线和爆炸都从它取，客户端在副本上自己算。

## 模拟 tick 的顺序（`sim/`）

每个 tick 严格按此顺序（LESSONS：“先移动结构体，再把被携带的实体同步到新位置，最后做推开和挤压判定”）：

1. `world.time++`；按玩家编号从小到大，依次应用每个玩家的输入产生的动作（放置、挖掘、使用、涂胶、组装、掌舵）。后一个玩家看到的是前一个玩家动作之后的世界。
2. 到期的方块 tick（液体、下落方块检查）。
3. 结构体：所有结构体 `snapshotPose()`；机械结构体按机构推进；物理结构体分子步积分（子步内转子姿态插值）；嵌套子结构跟随父结构。
4. 被携带的实体同步到载体的新位姿（位置 + 绕 Y 的转角）。
5. 实体自身运动（输入 / AI / 重力），与世界做扫掠碰撞，与结构体做 SAT 推出。
6. 推开与挤压判定；站立检测决定附着 / 脱离。
7. 事件派发；为每个已加入的玩家各生成一份交互视图。光照不在服务器上算：玩法从不读光照，它只在客户端的副本上计算。

世界尚未加载完的区域：实体与结构体物理冻结（LESSONS“船被弹飞”）。

放置的目标格和放下之后这一格的内容由纯函数 `sim/placement.ts planPlacement` 决定，只有服务器知道的检查（世界边界、结构体上限、身体重叠、消耗物品）留在 `sim/interact.ts`。需要支撑的方块的规则在 `sim/support.ts`，放置和方块更新共用。

## 网格与渲染

- `mesh/mesher.ts`：纯函数 `buildMesh(MeshInput): MeshData`，世界 section 与结构体共用；带 1 格边距，做面剔除、AO、平滑光照、液面高度。`mesh/worker.ts` 是 Worker 入口。`MeshInput` 带三层（`cells`、`holes`、`part2`），盒子里没有部分格子时后两层是 `null`，交给 Worker 的任务里只有基础层。
- 按面决定走哪条路径：一个面所在的格子和它前面一层的 9 格都不是部分格子时，发整个面的一个四边形，和只有整格方块的世界逐字节相同；否则按八分格的面发，每个要画的四分之一面单独一个 0.5 × 0.5 的四边形，不合并；遮蔽和平滑光照按前方半层的八分格取样。液体贴着部分格子的面按象限裁（[SHAPES.md](SHAPES.md) 第 8 节）。
- 叠加层（目标框、裂纹、组装预览、停靠冲突、胶面）按占用掩码画：目标框是被瞄准的部件的轮廓，胶面只画在两侧露出或盖住的那几个象限上（[SHAPES.md](SHAPES.md) 第 8.6 节）。
- 贴图：`art/` 程序化绘制每个 tile（16×16 RGBA），顺序即 `TILE_NAMES` 的层号，上传为纹理数组。
- `render/backend.ts`：`RenderBackend` 接口；`render/three/` 是 three.js 实现。结构体网格以局部坐标上传，每帧只更新位姿。

## 存档

`save/`：codec（纯函数，区块、tick 队列、结构体、胶水、实体）+ 存储适配器（`MemoryStorage` 给测试，`IdbStorage` 给浏览器）。新世界必须清空一切全局状态（LESSONS“同种子开新世界”）—— 模拟层**不允许模块级可变状态**，一切状态挂在 `Simulation` 实例上。

存档不向后兼容：格式一变就提高 `SAVE_VERSION`（现在是 4），解码器只读当前版本，旧档给出提示后拒绝打开，不写迁移代码。各个块（结构体、实体……）的载荷变了，自己的版本号也加 1。

- 区块的格子和协议共用一份编码（`save/cells.ts`）：`Cell` 是一个格子的整格内容（一两个 varuint），`CellVolume` 是三层的格子体（调色板加游程，或逐格）。编解码只查布局；解码出的每个格子再过 `cellProblem`，CRC 正确而内容不合法的存档不会把未注册的 id 或重叠的部件带进世界。
- 结构体存非空格子的稀疏游程，每格一个 `Cell`；下落方块实体带的格子只能是整格方块。

## 测试

- 单元测试放 `tests/<模块>/`；验收场景放 `tests/acceptance/`，一条场景一个 `describe`，全部无头。
- 修 bug 先写复现测试；每轮修改后跑全量 `npm test` 和 `npm run typecheck`。
- 浏览器冒烟：`scripts/e2e-smoke.mjs`（Playwright，headless Chromium 走 WebGL2 回退）。

## 联机（M2.1 已完成）和后面的变化

- **模拟就是服务器**。模拟层里没有“本地玩家”：`sim/players.ts` 是玩家注册表，每个玩家有自己的控制器、交互状态和视图；`sim/rules.ts` 是按世界决定的规则；和玩家有关的事件都带收件人。`tests/sim/single-player-guard.test.ts` 会拦住 `src/` 里重新出现的单玩家假设。
- **身体移动和服务器规则分开**。`entities/body.ts` 的 `BodyMover` 只管身体怎么动，不含规则、随机数和事件，服务器和客户端跑同一份；`entities/manager.ts` 是服务器的规则；`entities/drive.ts` 是“由客户端驱动”的玩家：服务器接受相对脚下结构体的移动上报，检查后采用，自己动了玩家时发校正。
- **单机和联机走同一套协议**。`net/` 下面：协议和编码、服务器端的同步（变化收集、兴趣、每个 tick 一个包）、服务器宿主（连接、时钟、存读档、Worker 入口）、客户端（副本、时钟、区块装载、自己角色的预测、意图、背包预测）。规格、消息和模块布局都在 [NETCODE.md](NETCODE.md)。
- **验收测试跑两遍**：直接驱动模拟一遍，经由真正的客户端和服务器（零延迟、锁步）再一遍，两种模式的 tick 数相同，每个测试结束时副本必须和服务器一致。

