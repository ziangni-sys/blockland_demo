# 架构（重写版）

本文件是代码层面的总约定。玩法规则见 [DESIGN.md](DESIGN.md)，踩坑记录见 [LESSONS.md](LESSONS.md)，验收场景见 [ACCEPTANCE.md](ACCEPTANCE.md)，里程碑见 [ROADMAP.md](ROADMAP.md)。

## 技术栈

- TypeScript（strict）+ Vite 8 + Vitest 5。运行时依赖只有 `three`（WebGPURenderer + TSL，自动回退 WebGL2）。
- `npm run dev` 开发；`npm test` 无头测试（Node）；`npm run typecheck`；`npm run build` 普通静态站；`npm run build:artifact` 产出单文件 HTML（JS 内联、Worker 走 blob URL）。

## 分层与依赖方向

```
core ─▶ blocks ─▶ voxel ─▶ { worldgen, light, liquid, structures, entities } ─▶ sim ─▶ net/server ─▶ net/host
                     ├──▶ mesh（纯函数，Worker 里跑）──▶ render（three.js）
                     └──▶ net/client（副本、时钟、预测、意图；不引用 sim 的运行时）──▶ client ─▶ ui
art（程序化贴图，纯函数）      save（codec 纯函数 + 存储适配器）
```

硬性规则：

1. **模拟层**（`core blocks voxel worldgen light liquid structures entities sim mesh art` 以及 `save` 的 codec）**不得**引用 DOM、`window`、`three`、`performance`、`Math.random()`、`Date`。它必须能在 Node 里无头步进。随机数一律用 `core/rng.ts`，时间一律用 `world.time`（tick 计数）。
2. **渲染层**（`render/`）只消费 `mesh/types.ts` 的 `MeshData` 和 `render/backend.ts` 里的状态结构，不引用任何模拟对象。换渲染器 = 重写 `render/three/`。
3. `client/` 是唯一同时认识游戏状态和渲染的地方，但它认识的是 `net/client` 的**副本**，不是模拟：页面启动一个服务器（Worker；不行就退到主线程，中间仍然是字节），通过协议连上去，读副本、做插值、把副本翻译成 backend 调用。tick 由服务器自己的时钟驱动。`ui/` 只做 DOM。`net/` 的分层和消息见 [NETCODE.md](NETCODE.md) 第 15 节。
4. 下层不得 import 上层。
5. 数学对象是普通对象（`{x,y,z}` / `{x,y,z,w}`）。**没有全局共享的临时向量**；`out` 参数由调用者持有（LESSONS“临时向量被改写”）。

## 坐标与约定

- 右手系：+X 东，+Y 上，+Z 南。格子 `(x,y,z)` 占据 `[x,x+1)³`。
- 方向 `Dir`：0 +X，1 −X，2 +Y，3 −Y，4 +Z，5 −Z（`core/dirs.ts`）。
- 朝向：`yaw = 0` 看向 −Z，yaw 增大 = 向左转（俯视逆时针）；`pitch > 0` 抬头。前向量 `(-sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch))`。
- 时间：20 TPS，`TICK_DT = 0.05`。渲染在上一 tick 与当前 tick 的状态之间插值。
- 区块 16×128×16；按 16³ 的 section 网格化；海平面 `SEA_LEVEL = 48`。

## 方块

- 一个 cell 是 16 位：低 10 位 id，高 6 位状态（`blocks/cell.ts`）。朝向、液位、层数都在状态位里，**不给朝向开新 id**。
- `blocks/registry.ts` 定义 `BlockDef` 和按 id 索引的扁平表（`SOLID`、`OPAQUE`…）；`blocks/defs.ts` 是方块表，id 稳定（进存档），只追加不重排。
- 硬方块 = `solid`（整格碰撞）；其余是软方块（空气、液体、花草、火把、雪层）。
- 物品：方块物品 id == 方块 id；非方块物品从 1024 起（`blocks/items.ts`）。
- 命名与外观必须原创（README）。

## 统一的体素网格（`voxel/`）

`VoxelGrid`（`voxel/grid.ts`）是世界、船、转子共同的接口：`getCell/setCell`、`toWorld/toLocal`、`dirToWorld/dirToLocal`、`velocityAt`、`worldRotation`、`cellBounds`、`parent`。

- `World`（`voxel/world.ts`）：区块存储、光照存储、**唯一的方块改动钩子** `onCellChange`、待处理方块 tick 队列 `TickQueue`、网格脏标记（用 `takeDirtySections()` 取）。未加载位置 `getCell` 返回 `CELL_UNLOADED`（实心、不可破坏）；`y<0` 是界岩，`y≥128` 是空气。
- `StructureGrid`（`voxel/sgrid.ts`）：结构体的稠密存储 + 位姿。`父空间点 = position + rotate(rotation, 局部点 − pivot)`；可嵌套（`parent` 是另一个 `StructureGrid`）。每 tick 移动前先 `snapshotPose()`，渲染用 `renderPose(alpha)`。
- 胶（`structures/glue.ts` 的 `GlueStore`）按面存储，世界一份、每个结构体一份。所有增删都经过存储并发出变更事件；格子变化时由 `StructureManager` 的钩子按“至少一侧是可涂胶方块”的规则清理。
- 射线、盒体相交、推出向量等查询**只写一份**，对任意 `VoxelGrid` 生效（`voxel/raycast.ts`、`voxel/shape.ts`）。实体的身体永远是**世界轴对齐的盒子**；对旋转的网格，把盒子变换到网格局部空间做 OBB-格子 SAT。站立 / 推开 / 附着 / 挤压四种判定用同一个盒子定义，只是内缩量不同，且附着盒严格在推开盒之内（LESSONS“携带与实体”第一条）。

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

## 网格与渲染

- `mesh/mesher.ts`：纯函数 `buildMesh(MeshInput): MeshData`，世界 section 与结构体共用；带 1 格边距，做面剔除、AO、平滑光照、液面高度。`mesh/worker.ts` 是 Worker 入口。
- 贴图：`art/` 程序化绘制每个 tile（16×16 RGBA），顺序即 `TILE_NAMES` 的层号，上传为纹理数组。
- `render/backend.ts`：`RenderBackend` 接口；`render/three/` 是 three.js 实现。结构体网格以局部坐标上传，每帧只更新位姿。

## 存档

`save/`：codec（纯函数，区块 RLE、tick 队列、结构体、胶水、实体）+ 存储适配器（`MemoryStorage` 给测试，`IdbStorage` 给浏览器）。新世界必须清空一切全局状态（LESSONS“同种子开新世界”）—— 模拟层**不允许模块级可变状态**，一切状态挂在 `Simulation` 实例上。

存档不向后兼容：格式一变就提高 `SAVE_VERSION`，解码器只读当前版本，旧档给出提示后拒绝打开，不写迁移代码。

## 测试

- 单元测试放 `tests/<模块>/`；验收场景放 `tests/acceptance/`，一条场景一个 `describe`，全部无头。
- 修 bug 先写复现测试；每轮修改后跑全量 `npm test` 和 `npm run typecheck`。
- 浏览器冒烟：`scripts/e2e-smoke.mjs`（Playwright，headless Chromium 走 WebGL2 回退）。

## 联机（M2.1 已完成）和后面的变化

- **模拟就是服务器**。模拟层里没有“本地玩家”：`sim/players.ts` 是玩家注册表，每个玩家有自己的控制器、交互状态和视图；`sim/rules.ts` 是按世界决定的规则；和玩家有关的事件都带收件人。`tests/sim/single-player-guard.test.ts` 会拦住 `src/` 里重新出现的单玩家假设。
- **身体移动和服务器规则分开**。`entities/body.ts` 的 `BodyMover` 只管身体怎么动，不含规则、随机数和事件，服务器和客户端跑同一份；`entities/manager.ts` 是服务器的规则；`entities/drive.ts` 是“由客户端驱动”的玩家：服务器接受相对脚下结构体的移动上报，检查后采用，自己动了玩家时发校正。
- **单机和联机走同一套协议**。`net/` 下面：协议和编码、服务器端的同步（变化收集、兴趣、每个 tick 一个包）、服务器宿主（连接、时钟、存读档、Worker 入口）、客户端（副本、时钟、区块装载、自己角色的预测、意图、背包预测）。规格、消息和模块布局都在 [NETCODE.md](NETCODE.md)。
- **验收测试跑两遍**：直接驱动模拟一遍，经由真正的客户端和服务器（零延迟、锁步）再一遍，两种模式的 tick 数相同，每个测试结束时副本必须和服务器一致。

- **材质 + 形状**：格子值加上“缺口”位和多部件标志；按 id 查的实心 / 不透明表由统一的形状查询取代。
