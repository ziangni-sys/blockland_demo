# 架构（重写版）

本文件是代码层面的总约定。玩法规则见 [DESIGN.md](DESIGN.md)，踩坑记录见 [LESSONS.md](LESSONS.md)，验收场景见 [ACCEPTANCE.md](ACCEPTANCE.md)，里程碑见 [ROADMAP.md](ROADMAP.md)。

## 技术栈

- TypeScript（strict）+ Vite 8 + Vitest 5。运行时依赖只有 `three`（WebGPURenderer + TSL，自动回退 WebGL2）。
- `npm run dev` 开发；`npm test` 无头测试（Node）；`npm run typecheck`；`npm run build` 普通静态站；`npm run build:artifact` 产出单文件 HTML（JS 内联、Worker 走 blob URL）。

## 分层与依赖方向

```
core ─▶ blocks ─▶ voxel ─▶ { worldgen, light, liquid, structures, entities } ─▶ sim ─▶ client ─▶ ui
                     └──▶ mesh（纯函数，Worker 里跑）──▶ render（three.js）
art（程序化贴图，纯函数）      save（codec 纯函数 + 存储适配器）
```

硬性规则：

1. **模拟层**（`core blocks voxel worldgen light liquid structures entities sim mesh art` 以及 `save` 的 codec）**不得**引用 DOM、`window`、`three`、`performance`、`Math.random()`、`Date`。它必须能在 Node 里无头步进。随机数一律用 `core/rng.ts`，时间一律用 `world.time`（tick 计数）。
2. **渲染层**（`render/`）只消费 `mesh/types.ts` 的 `MeshData` 和 `render/backend.ts` 里的状态结构，不引用任何模拟对象。换渲染器 = 重写 `render/three/`。
3. `client/` 是唯一同时认识模拟和渲染的地方：驱动 tick、做插值、把模拟状态翻译成 backend 调用。`ui/` 只做 DOM。
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
- 射线、盒体相交、推出向量等查询**只写一份**，对任意 `VoxelGrid` 生效（`voxel/raycast.ts`、`voxel/shape.ts`）。实体的身体永远是**世界轴对齐的盒子**；对旋转的网格，把盒子变换到网格局部空间做 OBB-格子 SAT。站立 / 推开 / 附着 / 挤压四种判定用同一个盒子定义，只是内缩量不同，且附着盒严格在推开盒之内（LESSONS“携带与实体”第一条）。

## 模拟 tick 的顺序（`sim/`）

每个 tick 严格按此顺序（LESSONS：“先移动结构体，再把被携带的实体同步到新位置，最后做推开和挤压判定”）：

1. `world.time++`；应用玩家输入产生的动作（放置、挖掘、使用、涂胶、组装、掌舵）。
2. 到期的方块 tick（液体、下落方块检查）。
3. 结构体：所有结构体 `snapshotPose()`；机械结构体按机构推进；物理结构体分子步积分（子步内转子姿态插值）；嵌套子结构跟随父结构。
4. 被携带的实体同步到载体的新位姿（位置 + 绕 Y 的转角）。
5. 实体自身运动（输入 / AI / 重力），与世界做扫掠碰撞，与结构体做 SAT 推出。
6. 推开与挤压判定；站立检测决定附着 / 脱离。
7. 光照增量更新、事件派发。

世界尚未加载完的区域：实体与结构体物理冻结（LESSONS“船被弹飞”）。

## 网格与渲染

- `mesh/mesher.ts`：纯函数 `buildMesh(MeshInput): MeshData`，世界 section 与结构体共用；带 1 格边距，做面剔除、AO、平滑光照、液面高度。`mesh/worker.ts` 是 Worker 入口。
- 贴图：`art/` 程序化绘制每个 tile（16×16 RGBA），顺序即 `TILE_NAMES` 的层号，上传为纹理数组。
- `render/backend.ts`：`RenderBackend` 接口；`render/three/` 是 three.js 实现。结构体网格以局部坐标上传，每帧只更新位姿。

## 存档

`save/`：codec（纯函数，区块 RLE、tick 队列、结构体、胶水、实体）+ 存储适配器（`MemoryStorage` 给测试，`IdbStorage` 给浏览器）。新世界必须清空一切全局状态（LESSONS“同种子开新世界”）—— 模拟层**不允许模块级可变状态**，一切状态挂在 `Simulation` 实例上。

## 测试

- 单元测试放 `tests/<模块>/`；验收场景放 `tests/acceptance/`，一条场景一个 `describe`，全部无头。
- 修 bug 先写复现测试；每轮修改后跑全量 `npm test` 和 `npm run typecheck`。
- 浏览器冒烟：`scripts/e2e-smoke.mjs`（Playwright，headless Chromium 走 WebGL2 回退）。
