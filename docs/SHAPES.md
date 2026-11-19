# 形状系统（材质 + 形状）

本文件是 M2.3 工作包 P1～P10 的实现规格，并给出 M2.4（凿子与半砖）的接口。玩法规则见 [DESIGN.md](DESIGN.md) 的“材质 + 形状”和“凿子”，工作包和格子表示见 [ROADMAP.md](ROADMAP.md) 的“M2.3”，验收场景是 [ACCEPTANCE.md](ACCEPTANCE.md) 的 38～47，代码约定照 [ARCHITECTURE.md](ARCHITECTURE.md)，联机部分以 [NETCODE.md](NETCODE.md) 为准（本文第 13 节列出对它的改动）。

各工作包由不同的人在各自的检出里实现，彼此只通过本文约定的接口对接。本文里的 TypeScript 签名就是契约：名字、参数顺序、返回值的含义都照写。行号指提交 `c20ea8e`（M2.2 合并后的 `main`）。

不考虑向后兼容：旧存档拒绝打开，不写迁移代码，不留旧路径。

**术语**

| 词 | 含义 |
|---|---|
| 八分格（octant） | 一个格子沿三个轴各切一半得到的 8 个半格立方体之一 |
| 部件（part） | 一种材质（方块 id + 状态）加上它在这一格里占的八分格 |
| 整格方块 | 占满 8 个八分格的单个部件；数值和 M1 的格子值完全相同 |
| 部分格子 | 有部件、但实心八分格不满 8 个的格子 |
| 占用掩码（fill） | 8 位，第 o 位为 1 表示八分格 o 被占 |
| 缺口（holes） | 8 位，`holes = ~fill & 0xff`；存的是缺口 |
| 象限（quadrant） | 格子的一个面切成 2×2 的四分之一 |
| 半格网格 | 间距 0.5 的整数网格：半格坐标 `h = 2·格坐标 + 八分格在该轴的那一位` |
| 格面 / 内面 | 八分格的面落在格子边界上叫格面，落在格子中间（0.5 处）叫内面 |
| 硬 | 材质的 `SOLID[id] === 1` |

## 1. 格子值

### 1.1 八分格编号

八分格 `o = ox | oy << 1 | oz << 2`，`ox, oy, oz ∈ {0, 1}`：第 `axis` 位（`Axis` 的 0 x、1 y、2 z）为 1 表示在这个轴的正半边。八分格 `o` 在格子局部坐标里占 `[ox/2, ox/2 + 0.5) × [oy/2, oy/2 + 0.5) × [oz/2, oz/2 + 0.5)`。

常用的占用掩码：下半 `0x33`，上半 `0xcc`，−X 半 `0x55`，+X 半 `0xaa`，−Z 半 `0x0f`，+Z 半 `0xf0`。

### 1.2 三种数值

```ts
// src/blocks/cell.ts（P1）
export const ID_MASK = 0x3ff;          // 不变
export const STATE_SHIFT = 10;         // 不变
export const STATE_MASK = 0x3f;        // 不变
export const HOLES_SHIFT = 16;
export const HOLES_MASK = 0xff;
export const CELL_MULTI_BIT = 1 << 24; // net/protocol.ts 改为从这里转出，不再自己定义
export const PART_MASK = 0xffffff;
export const PART_LIMIT = 1 << 24;     // 部件值 < 2^24
export const CELL_LIMIT = 1 << 25;     // getCell 的返回值 < 2^25
export const PACK_SCALE = 2 ** 25;     // packed = cell + part2 * PACK_SCALE
export const FULL_LIMIT = 1 << 16;     // 值 < 2^16：没有缺口、没有第二部件
```

| 名字 | 位 | 取值范围 | 在哪里出现 |
|---|---|---|---|
| **部件值** `Part` | 0～9 id，10～15 状态，16～23 缺口 | < 2²⁴ | 第二部件层；`partAt` 的结果；事件里“被挖掉 / 放下的部件” |
| **格子值** | 部件值（第一部件）+ 第 24 位 `CELL_MULTI_BIT`（这一格还有第二部件） | < 2²⁵ | `VoxelGrid.getCell` 的返回值，只有它是热路径读的 |
| **整格内容** `Packed` | `格子值 + 第二部件 × 2²⁵` | < 2⁴⁹，双精度里精确 | 其余所有“把一个格子当成一个数”的地方：`setCell` 的参数、变更事件的新旧值、`forEachCell`、`getPacked`、协议里的 `Cell`、粘连谓词的参数、`GridHit.cell`、`Target.cell` |

- 没有第二部件的格子，三种数值相等。整格方块就是今天的 16 位值：`makeCell(id, state)` 不变，地形生成、`& ID_MASK` 的查表、现有测试都不受影响。
- 对整格内容做位运算读的是第一部件：`packed & ID_MASK`、`(packed >>> 16) & 0xff`、`packed & CELL_MULTI_BIT` 都正确（位运算取低 32 位）。不带掩码的 `packed >>> 16` 不行。
- 为什么不让 `getCell` 直接返回整格内容：ROADMAP 已定“所有格子值小于 2²⁵”，碰撞、液体、光照的循环里读到的必须是小整数。双部件格子很少，第二部件另外取。
- **绊线**：`getCell` 对双部件格子返回带 `CELL_MULTI_BIT` 的值。凡是接受整格内容的函数（`setCell`、第 3 节的全部查询、按接触判断的粘连谓词、编码器），遇到“第 24 位为 1 而第二部件为 0”一律抛 `RangeError`；唯一的例外是 `cellProblem`（第 3.4 节），它从不抛错，把这种值作为一种不合法的原因返回。所以漏拷第二部件的代码（`dst.setCell(x, y, z, src.getCell(x, y, z))`）第一次碰到双部件格子就报错，不会悄悄丢数据。要拷整格用 `getPacked` 或 `copyCell`（第 4.4 节）。
- 绊线之外只有两类函数，它们**只读 id 位**（`& ID_MASK`），传什么都不抛错：按 id 查表的老代码（`SOLID[c & ID_MASK]` 这一类），以及掉落函数 `dropItemOf` / `dropCountOf` / `spawnBlockDrop`（第 9.5 节）和 `canGlue` / `holdsGlue`（第 10.2 节）。这样它们在各自的工作包合并前后，对旧的调用处都不会报错（第 16.3 节）。

```ts
// src/blocks/cell.ts（P1）
export function makeCell(id: number, state?: number): number;                 // 不变：整格方块
export function makePart(id: number, state: number, holes: number): number;   // 带缺口的部件值
export function partHoles(part: number): number;      // (part >>> 16) & 0xff
export function withState(part: number, state: number): number;   // 只换状态位，保留缺口和第 24 位
export function withHoles(part: number, holes: number): number;   // 只换缺口
export function packCell(cell: number, part2: number): number;    // cell + part2 * PACK_SCALE；两者对不上（见绊线）时抛错
export function cellPrimary(packed: number): number;  // packed % PACK_SCALE，含 CELL_MULTI_BIT（等于 getCell 的值）
export function cellSecond(packed: number): number;   // Math.floor(packed / PACK_SCALE)，没有则 0
```

现有的 `withState`（cell.ts:26）会丢掉缺口，照上面改；`cellId`、`cellState` 不变。

### 1.3 规范形式与不变量

一个格子的内容只有一种合法写法。`cellProblem`（第 3.4 节）按下面逐条检查，所有不可信的格子都要过它；`setCell` 对 `>= FULL_LIMIT` 的内容检查 I1～I6，不合法抛 `RangeError`（`< FULL_LIMIT` 的内容走今天的路径，不检查，见第 3.4 节）。

| 编号 | 不变量 |
|---|---|
| I1 | **id 为 0 当且仅当值为 0**。空格子就是 `AIR = 0`；“id 为 0 而带状态、缺口或第二部件”的值不存在（例如 `0x0400`）。`StructureGrid.count`、`cellBounds()`、射线的包围盒裁剪和客户端的 `cell === AIR` 判断都建立在这一条上。 |
| I2 | 部件的缺口不等于 `0xff`。八分格全缺的部件不存在：凿掉最后一个八分格，这个部件就没了（第 4.4 节）。 |
| I3 | 缺口不为 0 的部件，材质必须可切（`CUTTABLE[id] === 1`，见 1.4）。 |
| I4 | `CELL_MULTI_BIT` 为 1 当且仅当第二部件不为 0。第二部件本身不带第 24 位，id 不为 0。 |
| I5 | 双部件格子里，两个部件的材质都可切、缺口都不为 0，占用掩码不相交。 |
| I6 | **顺序**：第一部件是含有“这一格里编号最小的被占八分格”的那个部件。两个部件不相交，所以顺序唯一；它只由几何决定，和放置先后无关，方块化合并时谁先到结果都一样。 |
| I7 | 推论：格子里只要有带缺口的部件或第二部件，第一部件的 id 就是硬材质（可切的材质都是硬的）。液体、方块更新、下落方块里“下方 `SOLID[id]`”这类按 id 的判断因此对部分格子仍然成立（第 9 节逐条说明）。 |
| I8 | 一格最多两个部件（玩家看得见的规则，见第 17 节问题 10）。 |

- **同材质的两个部件不合并**。一个部件对应一个物品：一格里放两块木板半砖用掉 2 个木板，分别挖掉各返还 1 个。这样的格子几何上是满的，但它是双部件格子（`getCell` 带第 24 位），不是整格方块。反过来，一个部件被凿成不相连的几块仍是一个部件。
- **到两个部件上限时**：两个部件都被凿小之后，格子里可以还有空的八分格，几何上放得下第三个部件，但存储只有两个位置，所以照样拒绝。往已有两个部件的格子里放半砖被拒绝，提示用单独的消息键 `toast.place.twoParts`（“这一格已经有两个部件了”），不用“有东西挡着”：玩家看到的是空位。方块化、停靠时合并后会超过两个部件的，后果和冲突相同，提示同样说明原因（第 11.3 节）。ROADMAP 里“现有的两种工具下，一格最多两个部件”这句话不成立（放下半砖凿到只剩八分格 0，再放上半砖凿到只剩八分格 2，+X 一侧的半格就空着），P10 把它改成“存储只放两个部件，第三个被拒绝”。
- 旋转会改变哪个部件含最小的八分格，所以旋转之后要重新定顺序（`rotatePacked` 自己做，第 2.5 节）。脚本验证过：3025 对不相交的占用掩码，每一对都有某个旋转会让顺序对调。
- 界面和协议里从不用“第几个部件”指部件，一律用“含八分格 o 的那个部件”（第 6 节）：部件的先后会因为凿、挖、旋转而对调。

### 1.4 哪些方块能切

```ts
// src/blocks/registry.ts（P1）
export const CUTTABLE: Uint8Array; // 按 id；registerBlock 时填
```

`CUTTABLE[id] === 1` 当且仅当：`shape === 'cube'`、`solid`、不是重力方块（`gravity`）、不是功能方块（`func === 'none'`）、不是爆破箱（`explosive`）、挖得动（不是 `unbreakable`）。按现在的方块表：

- 能切：岩石、碎岩、泥土、草皮、黑曜岩、三种矿石、黏土、积雪、冰、两种原木、两种木板、两种树叶、玻璃、石砖、红砖、砂岩砖、铁块、晶石灯、八色绒布、帆布。
- 不能切：空气、液体、沙、砾石、界岩、舵轮、轴承、螺旋桨、火把、爆破箱、仙人掌、花草、雪层、未加载哨兵。

不能切的方块永远是整格的单个部件（缺口 0、没有第二部件、不能和别的部件同格）。爆破箱和晶石灯的取舍见第 17 节问题 4。

`SOLID`、`OPAQUE`、`LIGHT_OPACITY`、`EMIT`、`LIQUID`、`REPLACEABLE`、`GRAVITY_BLOCK` 保留，含义改为**材质**的性质；几何一律从第 3 节的形状查询取。从没被读过的 `UNBREAKABLE` 表删掉。

## 2. 几何表

全部是 `src/blocks/shapes.ts`（P1）在模块加载时算好的常量表，按占用掩码（0～255）索引。表是只读的，不是用到时才填的缓存。下面每张表都给了校验值：对表的字节做 FNV-1a（32 位，初值 `0x811c9dc5`，乘数 `0x01000193`）。P1 的测试照本节的文字独立再算一遍并核对校验值。参考实现和校验值由本文作者的脚本算出（脚本不进仓库）。

### 2.1 体积与质心

```ts
export const FILL_VOLUME: Uint8Array;   // [fill] = 被占八分格数 0..8
export const CENTROID: Float64Array;    // [fill * 3 + axis] = 被占八分格中心的平均值，格子局部 0..1；fill = 0 时为 0.5
export const HALF_FILL: readonly number[]; // [dir] = 这一侧的 4 个八分格：[0xaa, 0x55, 0xcc, 0x33, 0xf0, 0x0f]
export const DROP_POINT: Float64Array;  // [fill * 3 + axis] = 这个占用的部件被去掉时，掉落物出现在哪（格子局部 0..1）
```

例：`0x33`（下半）体积 4，质心 (0.5, 0.25, 0.5)；`0x3f`（下半加 −Z 侧上方两个，楼梯）体积 6，质心 (0.5, 5/12, 5/12)；`0xfe` 体积 7，质心 (15/28, 15/28, 15/28)。

`DROP_POINT`：`fill` 为 `0xff`（和 0）时是格子中心 (0.5, 0.5, 0.5)，和 M1 一样；否则是**编号最小的被占八分格的中心** `(0.25 + 0.5·ox, 0.25 + 0.5·oy, 0.25 + 0.5·oz)`。不用质心：部件可以不连通、不是凸的，质心会落在同格的另一个部件里（八分格 0 和 7 的质心是格子中心；楼梯 `0x3f` 的质心处，0.25 见方的物品有一部分在八分格 6、7 里）。部件被去掉之后它原来占的八分格是空的，掉落物（边长 0.25，中心在这个点上）整个落在半格见方的八分格里。例：`0x33` → (0.25, 0.25, 0.25)；`0xcc` → (0.25, 0.75, 0.25)；`0x80` → (0.75, 0.75, 0.75)。

### 2.2 盒子分解

```ts
export const BOX_COUNT: Uint8Array;  // [fill] = 盒子数 0..4
export const BOXES: Uint8Array;      // [fill * 24 + k * 6 + (0..5)] = x0, y0, z0, x1, y1, z1，半格单位 0..2；没用到的项为 0
```

把占用掩码拆成互不重叠、合起来正好等于它的轴对齐盒子，个数最少。

- **真实的最大值是 4**。对 256 种掩码穷举：需要 0、1、2、3、4 个盒子的分别有 1、27、130、88、10 种，一共 591 个盒子。需要 4 个的是 `0x69 0x6b 0x6d 0x79 0x96 0x97 0x9e 0xb6 0xd6 0xe9`（两种“棋盘”和在它上面加一个八分格的）。允许盒子互相重叠也降不到 4 以下。
- “每次取含最小八分格的最大盒子”的贪心法在 16 种掩码上不是最少的，所以表按下面的搜索定义：
  1. 候选盒子共 27 个：每个轴取 0（低半 `[0,1)`）、1（高半 `[1,2)`）、2（整个 `[0,2)`），编码 `rx + 3·ry + 9·rz`。排序：体积大的在前，体积相同按编码从小到大。
  2. 对盒子数 k = 1, 2, 3, 4 依次尝试；深度优先，每一步必须盖住“剩下的八分格里编号最小的那个”，按上面的顺序试候选盒子（盒子必须完全落在剩下的八分格里）；找到的第一个解就是结果，盒子按选中的先后排列。
- 例（`[x0,y0,z0→x1,y1,z1]`）：`0x33` → `[0,0,0→2,1,2]`；`0x3f` → `[0,0,0→2,2,1] [0,0,1→2,1,2]`；`0x17` → `[0,0,0→2,1,1] [0,1,0→1,2,1] [0,0,1→1,1,2]`；`0x69` → `[0,0,0→1,1,1] [1,1,0→2,2,1] [1,0,1→2,1,2] [0,1,1→1,2,2]`。
- 校验值：`BOX_COUNT` 为 `0xff6a7052`，`BOXES` 为 `0xb0400b5f`。
- 谁用：相机避障、预览和冲突的着色盒、测试里的对照实现。碰撞用八分格（第 5 节），网格化按面的象限发面（第 8 节），都不依赖这张表的具体拆法。

### 2.3 面的象限覆盖

面 `d`（`Dir`）的轴 `a = d >> 1`；另外两个轴按编号从小到大记作 `u < v`（a = 0 时 u = y、v = z；a = 1 时 u = x、v = z；a = 2 时 u = x、v = y）。象限 `q = hu | hv << 1`，`hu`、`hv` 是它在 u、v 轴上的那一半（0 低、1 高）。

```ts
export const FACE_COVER: Uint32Array;  // [fill]：第 (d * 4 + q) 位 = 面 d 的象限 q 后面那个八分格被占
export function faceCover(fill: number, dir: Dir): number;    // (FACE_COVER[fill] >>> (dir * 4)) & 15
export function quadrantOctant(dir: Dir, q: number): number;  // 面 dir 的象限 q 紧贴的那个八分格
export function isCellFace(octant: number, face: Dir): boolean; // 八分格的这个面在格子边界上
```

- 面 `d` 的象限 `q` 紧贴的八分格：第 a 位 = (`d` 是正方向 ? 1 : 0)，第 u 位 = `hu`，第 v 位 = `hv`。逐个方向列出（q = 0, 1, 2, 3）：+X `1 3 5 7`，−X `0 2 4 6`，+Y `2 3 6 7`，−Y `0 1 4 5`，+Z `4 5 6 7`，−Z `0 1 2 3`。
- **同一个象限编号在面的两侧指的是空间里同一块正方形**：格子 A 的面 `d` 的象限 `q`，就是它在 `d` 方向的邻居 B 的面 `d ^ 1` 的象限 `q`。所以“两格在共享面上接触”就是 `faceCover(fillA, d) & faceCover(fillB, d ^ 1) !== 0`，“面被完全盖住”就是覆盖等于 15。
- `isCellFace(o, f)` = `((o >> (f >> 1)) & 1) === ((f & 1) ^ 1)`。
- 例：`FACE_COVER[0x33] = 0x33f055`（下半砖：+Y 为 0，−Y 为 15，±X 为 5，±Z 为 3）；`FACE_COVER[0xcc] = 0xcc0faa`；`FACE_COVER[0x01] = 0x101010`；`FACE_COVER[0xff] = 0xffffff`。校验值（每项按小端 4 字节）：`0x8c5fbde5`。

### 2.4 24 个旋转

旋转就是 `structures/orient.ts` 的 `GridRot`（+X、+Y、+Z 三个轴的像 `ax, ay, az`）。`blocks` 层不能引用 `structures`，所以表按三个像来索引：

```ts
export function rotIndex(ax: Dir, ay: Dir): number;  // 0..23 = ax * 4 + (ay 在“不在 ax 轴上的 4 个方向”里按 Dir 从小到大的名次)
export const ROT_FILL: Uint8Array;                   // [rot * 256 + fill] = 旋转后的占用掩码
export function rotateFill(fill: number, ax: Dir, ay: Dir): number;
```

- 八分格 `o` 的像：把它的中心相对格子中心的偏移 `(ox − ½, oy − ½, oz − ½)` 用 `rotVec` 转过去，按三个分量的正负读出新的编号。这和 `rotCellPos` 转格子中心是同一个变换，所以形状和格子位置、胶面一起转。
- 编号顺序：`0:(0,2,4)`（恒等）`1:(0,3,5) 2:(0,4,3) 3:(0,5,2) 4:(1,2,5) 5:(1,3,4) 6:(1,4,2) 7:(1,5,3) 8:(2,0,5) 9:(2,1,4) 10:(2,4,0) 11:(2,5,1) 12:(3,0,4) 13:(3,1,5) 14:(3,4,1) 15:(3,5,0) 16:(4,0,2) 17:(4,1,3) 18:(4,2,1) 19:(4,3,0) 20:(5,0,3) 21:(5,1,2) 22:(5,2,0) 23:(5,3,1)`（括号里是 `ax, ay, az`）。
- 例：绕 +Y 向左转四分之一圈（+X 到 −Z）是 22 号，八分格 0..7 的像是 `4 0 6 2 5 1 7 3`；`0x55`（−X 半）变成 `0xf0`（+Z 半），`0x33`（下半）不变，`0x01` 变成 `0x10`。绕 +X 把 +Y 转到 +Z 是 2 号，`0x33` 变成 `0x0f`。
- 脚本验证过：24 个旋转各是八分格的一个置换、互不相同；`rotateFill` 对 `rotCompose`、`rotInverse` 满足复合和求逆；面的覆盖跟着 `rotDir` 走。256 种掩码在旋转下只有 23 种不同的形状（含空和满）。
- 校验值：`ROT_FILL` 为 `0x70650245`。

### 2.5 状态旋转和形状旋转怎么合在一起

```ts
// src/blocks/shapes.ts（P1）
export function rotatePart(part: number, ax: Dir, ay: Dir, az: Dir): number;
export function rotatePacked(packed: number, ax: Dir, ay: Dir, az: Dir): number;
// src/structures/orient.ts（P2 改）：rotCell 的参数和返回值都是整格内容
export function rotCell(r: GridRot, packed: number): number; // = rotatePacked(packed, r.ax, r.ay, r.az)
```

- `rotatePart`：状态位和缺口各转各的，互不影响。状态按 `stateKind`：`'axis'` 的低 2 位换成 `dirAxis(转过去的轴方向)`，`'facing'` 的低 3 位换成转过去的方向（就是现在 `rotCell` 的规则），其它不动；缺口换成 `~ROT_FILL[rot][~holes & 0xff] & 0xff`。id 不变。
- `rotatePacked`：两个部件各自 `rotatePart`，再按 I6 重新定顺序。
- 现在的 `rotCell` 经过 `makeCell`，会把原木的缺口和第 24 位削掉；改成上面这样之后，`rotCell(r, makeCell(B.STONE))` 仍等于 `makeCell(B.STONE)`。

## 3. 形状查询

“所有系统通过同一套形状查询取数据”（DESIGN）。查询分两层，都只有一份：

- **值上的查询**在 `src/blocks/shapes.ts`（P1）：纯函数，参数是整格内容，不认识网格。`blocks` 层以上的任何模块都能用，包括网格化的 Worker 和协议的校验。
- **网格上的查询**在 `src/voxel/`（P2 的 `parts.ts`，P3 的 `shape.ts`，P8a 的 `raycast.ts`）：对任意 `VoxelGrid` 生效。

各系统不许自己再写“这一格是不是整格实心”的判断。P1 加一个扫描测试 `tests/core/layering.test.ts`，把 ARCHITECTURE 的依赖方向对 `src/net` 以外的目录检查一遍，并拦住模拟层里“用到时才填”的模块级缓存；允许的引用关系和判定规则在第 16.2 节 P1 里逐条给出（现在只有 `net`、`mesh`、`client` 和 `entities/body.ts` 有这类检查）。

**全域性**：第 3.1、3.2 节的查询和 3.3 节的 `mergeProblem`，对任何通过了 `Cell` 布局检查（第 13.1 节）的值都有定义、不抛错，包括语义上不合法的值（两个部件重叠、缺口出现在不能切的材质上、id 没注册）。它们只按位解释参数：部件 `p` 的占用就是 `~partHoles(p) & 0xff`，材质的性质查按 id 的表（表长 1024，没注册的 id 查到 0，即不硬、不透明、不可切）。会抛错的只有绊线（1.2）和明说“要求……否则抛错”的 `mergeCells`、`canonCell`、`withOctant`。服务器拿客户端发来的 `Target.cell` 调 `partAt`（第 6.2 节）靠的就是这一条。

### 3.1 占用

```ts
// src/blocks/shapes.ts（P1）。参数 c 都是整格内容；getCell 的返回值在没有第 24 位时可以直接传。
export function solidFill(c: number): number;   // 被硬材质占的八分格（两个部件的并）
export function opaqueFill(c: number): number;  // 被不透明材质（OPAQUE[id]）占的八分格
export function cellFill(c: number): number;    // “这一格被占了哪些八分格”：空气 0；可切的材质按部件的并；其它任何方块（液体、模型、不能切的硬方块）0xff
export function partCount(c: number): 0 | 1 | 2;
export function partAt(c: number, octant: number): number;  // 含这个八分格的部件值；这个八分格空着则 0
export function otherPart(c: number, octant: number): number; // 同一格里的另一个部件值，没有则 0
export function volume8(c: number): number;     // 硬材质占的八分格数 0..8（质量、帆数、浮力都从它来）
```

- 快速路径写在每个函数的第一行：`c < FULL_LIMIT` 时，`solidFill` 返回 `SOLID[c & ID_MASK] ? 0xff : 0`，`opaqueFill` 同理查 `OPAQUE`。整格方块和空气只查一次表，和今天一样。
- 不是硬材质的方块（空气、液体、火把、花草、雪层）`solidFill` 为 0。不能切的硬方块（舵轮、轴承、螺旋桨、仙人掌、沙、爆破箱）`solidFill` 为 `0xff`：它们的碰撞和粘连沿用整格，和 M1 一样。
- `partAt(c, o)`：第一部件的 id 不为 0、并且它的缺口里没有第 `o` 位，返回第一部件的值；否则第二部件不为 0、并且它的缺口里没有第 `o` 位，返回第二部件的值；否则 0。所以对整格的单部件方块（含模型方块）在任何八分格上都返回这个方块的值，对空气返回 0。`otherPart` 返回两个部件里不是 `partAt` 的那个。
- 碰撞、光照、船体物理的内层循环不调这些函数，而是直接读存储层再查表（各节给出写法），结果必须和这里的定义一致；各包用“直接扫描的结果等于经 `getPacked` + 本节函数的结果”的测试钉住。

### 3.2 面的覆盖

```ts
export function solidCover(c: number, dir: Dir): number;   // 4 位：faceCover(solidFill(c), dir)
export function opaqueCover(c: number, dir: Dir): number;  // 4 位：faceCover(opaqueFill(c), dir)
export function topCovered(c: number): boolean;            // solidCover(c, PY) === 15
export function cellsTouch(a: number, b: number, dirAtoB: Dir): boolean; // solidCover(a, d) & solidCover(b, d ^ 1) !== 0
// 光照（第 7.1 节给出定义；引擎的内层循环自己查表，对照实现和测试调这几个）
export function lightOpacity(c: number): number;                         // op(c)，0..15
export function lightEmit(c: number): number;                            // emit(c)，0..15
export function lightOpen(a: number, b: number, dirAtoB: Dir): boolean;  // (opaqueCover(a, d) | opaqueCover(b, d ^ 1)) !== 15
export function emitInto(dst: number, src: number, dirDstToSrc: Dir): number; // src 的发光部件隔着这个面直接照进 dst 的光，0..15
```

| 问题 | 谓词 | 谁用 |
|---|---|---|
| 光能不能过两格之间的面 | `lightOpen(a, b, d)`：两侧的不透明覆盖合起来没有盖满这个面。只看一侧不够：并排的下半砖和上半砖各盖一半，合起来是封死的 | 光照（第 7 节） |
| 邻居把我这个面的哪些象限挡住了 | `opaqueCover(邻居, d ^ 1)`，模型方块另见第 8.2 节 | 网格化 |
| 能不能当火把、花草、雪层、舵轮的底 | `topCovered(下方)` | 放置、方块更新、安装面（第 9、10 节） |
| 两格在这个面上接触吗 | `cellsTouch(a, b, d)` | 粘连、胶（第 10 节） |

### 3.3 合成与拆分

改一个格子的内容都经过这几个函数，保证结果是规范形式。参数和返回值都是整格内容。

```ts
export const MERGE_OK = 0;       // 可以合并
export const MERGE_OVERLAP = 1;  // 占用重叠（目标是不能切的硬方块也算）
export const MERGE_LIMIT = 2;    // 合并后超过两个部件
export function mergeProblem(dest: number, incoming: number): 0 | 1 | 2;
export function mergeCells(dest: number, incoming: number): number;   // 要求 mergeProblem 为 0，否则抛错
export function canonCell(partA: number, partB: number): number;      // 由至多两个部件值（可以为 0）组成规范的整格内容
export function withoutOctant(c: number, octant: number): number;     // 凿掉一个八分格；部件被凿空就去掉它
export function withoutPartAt(c: number, octant: number): number;     // 去掉含这个八分格的部件
export function withOctant(c: number, partOctant: number, octant: number): number; // 给含 partOctant 的部件补上 octant
```

- `mergeProblem(dest, incoming)`，按顺序判断：
  1. `solidFill(dest) === 0`（目标是空气、液体或软方块）→ `MERGE_OK`。覆盖还是拒绝由调用方决定；这时 `mergeCells` 返回 `incoming`。
  2. `cellFill(dest) & cellFill(incoming) !== 0` → `MERGE_OVERLAP`。不能切的方块 `cellFill` 是 `0xff`，所以整格方块、模型方块（火把、舵轮……）和任何有部件的格子都算重叠：模型和整块永远不和部件同格。
  3. `partCount(dest) + partCount(incoming) > 2` → `MERGE_LIMIT`。
  4. 否则 `MERGE_OK`。
- `canonCell` 的两个部件重叠、或有一个带缺口而材质不可切时抛错。
- `withoutOctant`、`withoutPartAt`：剩下的那个部件自动成为第一部件（I6）；格子里没有部件了就是 `AIR`。对整格的单部件方块，`withoutPartAt` 的结果是 `AIR`。
- `withOctant` 要求 `octant` 在整格里空着、`partOctant` 有部件；补满 8 个之后就是整格方块（缺口 0）。

### 3.4 校验

```ts
export function cellProblem(c: number): string | null; // 合法返回 null，否则是给日志看的英文原因
```

检查：值是 < 2⁴⁹ 的非负整数；I1～I6（含“id 为 0 的值只能是 0”）；两个部件的 id 都已注册，并且都不是 `B.UNLOADED`（1023，`getCell` 对未加载位置的读数：它是读数，从不是内容）；状态位对这个 `stateKind` 合法的检查沿用现有做法（不新增）。它是所有“不可信的格子”进入存储、进入副本之前的同一道关：网络客户端应用包里的每一处格子（快照、增量、结构体记录和增量、下落方块实体带的格子、`blockBroken` / `blockPlaced` 事件带的部件值，都抛 `ReplicaError`）、存档解码（`SaveFormatError`）、平地生成器的层（经 `generatorSpecProblem`：构造时 `RangeError`，客户端收到 `Welcome` 时按协议错误断开，主机读存档时 `SaveFormatError`，第 13.2 节）、调试命令（第 14.1 节）。

`setCell` 自己只检查 I1～I6（I3、I5 查 `CUTTABLE` 表），不查 id 是否注册；`c < FULL_LIMIT` 时完全跳过，走今天的路径。这个范围里唯一可能不合法的是“id 为 0 而状态不为 0”，可信的代码从不产生它（M1 也不检查），不可信的来源由 `cellProblem` 拦住。

## 4. 存储

### 4.1 三层

```ts
// src/blocks/cell.ts（P1）：一块稠密格子体的三层，区块、结构体、网格化输入、协议、存档共用
export interface CellLayers {
  /** id + 状态，16 位。下标顺序由持有者定（区块：lx | lz << 4 | y << 8；盒子：(x-minX) + (z-minZ)*sx + (y-minY)*sx*sz）。 */
  base: Uint16Array;
  /** 第一部件的缺口。null = 全为 0。 */
  holes: Uint8Array | null;
  /** 第二部件的部件值。null = 没有双部件格子。part2[i] !== 0 时 holes[i] !== 0。 */
  part2: Uint32Array | null;
}
```

- 基础层就是现在的 `Uint16Array`，含义不变。`CELL_MULTI_BIT` 不存，读的时候由 `part2[i] !== 0` 得出。
- 缺口层和第二部件层**按需分配**：第一次写入带缺口（或第二部件）的格子时分配并清零。每层带一个非零项计数。
- **分配了就不再释放**：一个 `Chunk` 对象活着的时候，它的层不会因为计数回到 0 而被拿掉；`StructureGrid` 的层只在整个存储重新分配时（`resize`、`grow`、`loadBox`）才按计数决定带不带。所以 `null` 意味着“全为 0”，反过来不成立：全为 0 的层可以还在。凡是把层交出去的地方都按计数归一：`Chunk.layers()`、`StructureGrid.copyBox()`、`storage()` 对计数为 0 的层给 `null`；带层构造 `Chunk`、解码、`loadBox` 时，全为 0 的层按 `null` 收下。摘要和编码只看非零项（第 13 节），所以“`null`”和“全 0”产出相同的字节和哈希。这样做的原因有三个：层的引用一旦不是 `null` 就一直有效，不会出现“释放之后再分配、旧引用漏掉新缺口”；同一格反复凿、补不会每次分配 32 KB + 128 KB；一个 tick 中途不会有数组被拿走。代价是这个区块在被卸载之前一直走带层的路径（结果相同，只是每格多读一两个数组）。
- **引用的规则**（对三层、对 `storage()` 都一样）：`chunk.holes`、`chunk.part2`、`StructureGrid` 的层引用，以及“它是 `null`”这个事实，只在下一次对这个区块 / 网格的 `setCell` 之前有效。跨过一次写入要重新读：写入可能刚把 `null` 变成一个数组，结构体的写入还可能换掉整个存储。只读的循环（碰撞、光照、网格快照、船体分析）在循环开头取一次即可。
- 第二部件层用 `Uint32Array`（每格 4 字节，一次读出整个部件值）。拆成 16 位 + 8 位能省 1 字节，但每条复制路径要多带一层，不值。
- **内存**：没有部分方块的区块和现在一样（基础 64 KB + 光照 32 KB）。有缺口层多 32 KB，有第二部件层再多 128 KB。结构体按**存储盒**算：每格 2 字节，缺口层 +1，第二部件层 +4，即三层都有时是只有基础层时的 3.5 倍。紧凑包围盒上限 2²¹ 格，三层合计 4 + 2 + 8 = 14 MB；服务器上的存储盒可以比紧凑盒大（`grow` 在存储超过紧凑盒 4 倍时才重新收紧，每次生长再留半个边长，`sgrid.ts:51`、`185-226`），最坏约为紧凑盒的 6 倍。和今天一样有上限（LESSONS“格子数有上限，内存却没有”），只是上限乘了 3.5。客户端的副本用 `loadBox` 按记录里的紧凑盒分配。

### 4.2 `Chunk` 和 `World`

```ts
// src/voxel/chunk.ts（P2）
export class Chunk {
  readonly cells: Uint16Array;           // 基础层，不变
  holes: Uint8Array | null;              // 只有 World 写
  part2: Uint32Array | null;             // 只有 World 写
  constructor(cx: number, cz: number, cells?: Uint16Array, light?: Uint8Array, holes?: Uint8Array | null, part2?: Uint32Array | null);
  layers(): CellLayers;                  // 三层的引用，不复制；非零项计数为 0 的层给 null
  // light、heightmap、modified、lit 不变
}
```

- `new Chunk(cx, cz, cells)` 仍然表示“只有整格方块的一列”：地形生成器、地形 Worker、`ChunkSource` 的签名都不变（`Uint16Array`）。带层构造时检查长度，并数出两层的非零项；全为 0 的层按 `null` 收下。
- `Chunk.get` / `Chunk.set` 在 `src/` 里没有调用者，已删掉。测试里的调用（存档、液体、光照、船体物理、`World` 的测试，共八个文件）都改成直接写 `cells[cellIndex(lx, y, lz)]`。
- `World.getCell`：`c.holes === null && c.part2 === null` 时就是今天的一次读取；否则 `c.cells[i] | (holes ? holes[i] << 16 : 0) | (part2 && part2[i] !== 0 ? CELL_MULTI_BIT : 0)`。
- `World.getPart2(x, y, z)`：区块没有第二部件层、未加载、越界时为 0。
- `World.setCell(x, y, z, packed, flags?)`：参数是整格内容。
  1. `packed < FULL_LIMIT`（整格方块）从不检查，不管这一列有没有两层。没有两层时走今天的路径，一字不差；有两层时基础层写 `packed & 0xffff`，这一格的缺口和第二部件清零。同一次写入在内容相同的两列里结果相同，和层有没有分配无关。
  2. 其余的值（含 `NaN`）拆成格子值和第二部件，按 I1～I6 检查（不合法抛 `RangeError`），和三层里的旧内容比较；三层都相同返回 `false`，不发事件。`StructureGrid.setCell` 同样，并且检查在扩存储之前做：被拒绝的写入不会改变盒子。
  3. 写三层（需要时分配，更新非零项计数；不释放，见 4.1），`modified = true`，`markDirty`，然后发**一次**变更事件。
- 越界、未加载的规则不变（返回 `false`）。`y < 0` 的界岩、未加载的哨兵都是整格方块。
- 变更事件的签名不变，新旧值换成整格内容：

```ts
export type CellChangeListener = (x: number, y: number, z: number, oldCell: number, newCell: number, flags: number) => void;
```

  只改第二部件、只改缺口都会发事件。监听器要读当前状态时仍然从网格里读，不信参数（LESSONS“光照引擎必须是第一个监听器才正确”）。
- **邻居更新**没有新机制：`BlockUpdates`、`Fluids`、`StructureManager` 的钩子照旧挂在变更事件上，只是把“id 变了才处理”改成“内容变了就处理”（第 9、10 节）。
- **原样区块**的判定不变：`modified === false` 表示生成之后从没被写过。生成器只产出整格方块（平地生成器的层要过 `cellProblem` 且 `< FULL_LIMIT`），所以原样的一列永远没有另外两层。

### 4.3 `StructureGrid`

```ts
// src/voxel/sgrid.ts（P2）
export class StructureGrid implements VoxelGrid {
  // 存储改为私有：cells / holes / part2 三层，随盒子一起 resize、grow
  getCell(x: number, y: number, z: number): number;      // 格子值（< 2^25）
  getPart2(x: number, y: number, z: number): number;
  setCell(x: number, y: number, z: number, packed: number, flags?: number): boolean;
  forEachCell(fn: (x: number, y: number, z: number, packed: number) => void): void; // 整格内容
  readonly layered: boolean;   // 存储里现在分配了缺口层或第二部件层（可以全为 0，见 4.1）
  /** 盒子里三层的稠密副本（盒子外是空气）。拷出来的范围里没有非零项的层为 null。结构体记录、网格快照都用它。 */
  copyBox(minX: number, minY: number, minZ: number, sx: number, sy: number, sz: number): CellLayers;
  /** 把全部内容换成这个盒子：重新分配三层（全为 0 的层不分配）、重数 count、version++，不发变更事件。网络客户端的生成记录用它。 */
  loadBox(minX: number, minY: number, minZ: number, sx: number, sy: number, sz: number, layers: CellLayers): void;
  /** 只给船体物理这类逐格扫描：存储盒和三层的引用（计数为 0 的层给 null），下一次写入之后失效。 */
  storage(): { ox: number; oy: number; oz: number; sx: number; sy: number; sz: number; layers: CellLayers };
}
```

- `count` 仍是非空**格子**数（双部件格子算一格）；`cellBounds()`、射线的包围盒裁剪都建立在 I1 上，不变。
- `resize` 和 `grow` 对已分配的每一层做同样的搬移（现在的拷贝循环 sgrid.ts:243-246 只搬基础层），搬完之后计数为 0 的层不带进新存储。逐格建一条 2000 格的线仍然是摊还 O(1)。
- 监听器 `StructureCellListener` 和世界的一样，新旧值是整格内容。
- 现在直接碰 `grid.cells` 的地方全部改走上面的接口：`net/client/apply.ts:646-653`（改用 `loadBox`）、`mesh/snapshot.ts:78-87`（`copyBox`）、`structures/physics/helm.ts` 的 `findFirstHelm`（21-38 行，用 `storage()`；舵轮不能切，只看基础层）、`tests/drive/client.ts:369-380`（测试客户端共享服务器的存储：给 `StructureGrid` 加一个只给测试用的 `adoptStorage(other)`）、`tests/voxel/sgrid.test.ts:48,144`。

### 4.4 `VoxelGrid` 和整格的读写

```ts
// src/voxel/grid.ts（P2）
export interface VoxelGrid {
  getCell(x: number, y: number, z: number): number;   // 格子值：第一部件 + CELL_MULTI_BIT
  getPart2(x: number, y: number, z: number): number;  // 新增
  setCell(x: number, y: number, z: number, packed: number, flags?: number): boolean; // 写整格内容，一次事件
  // 其余不变
}

// src/voxel/parts.ts（P2，新文件）
export function getPacked(grid: VoxelGrid, x: number, y: number, z: number): number;
export function copyCell(src: VoxelGrid, sx: number, sy: number, sz: number, dst: VoxelGrid, dx: number, dy: number, dz: number, flags?: number): boolean;
export function solidFillAt(grid: VoxelGrid, x: number, y: number, z: number): number;
/** 半格坐标 (hx, hy, hz)（整数）指的那个八分格是否被硬材质占着。格子是 (hx >> 1, hy >> 1, hz >> 1)，八分格是 (hx & 1) | (hy & 1) << 1 | (hz & 1) << 2。 */
export function solidAtHalf(grid: VoxelGrid, hx: number, hy: number, hz: number): boolean;
/** 去掉含这个八分格的部件，返回被去掉的部件值（没有则 0）。挖掘、爆炸、夹毁都用它。 */
export function removePartAt(grid: VoxelGrid, x: number, y: number, z: number, octant: number, flags?: number): number;
/** 把一个部件并进这一格，返回 mergeProblem 的结果，只有 MERGE_OK 时写入。目标格没有硬部件（空气、液体、软方块）时直接写成这个部件；被盖掉的软方块要不要掉落由调用方先处理。 */
export function addPartAt(grid: VoxelGrid, x: number, y: number, z: number, part: number, flags?: number): 0 | 1 | 2;
export function removeOctantAt(grid: VoxelGrid, x: number, y: number, z: number, octant: number, flags?: number): boolean;      // M2.4 凿
export function restoreOctantAt(grid: VoxelGrid, x: number, y: number, z: number, partOctant: number, octant: number, flags?: number): boolean; // M2.4 补
```

- 对一格的任何修改都是“读整格内容 → 用第 3.3 节的函数算出新内容 → 一次 `setCell`”。同一格的两个部件一起变（合并、旋转后落下）也只发一次事件，钩子不会看到合并到一半的格子。
- **点查询只收整数**。“网格局部坐标里的一个点在不在硬八分格里”由调用方写成 `solidAtHalf(grid, Math.floor(lx * 2), Math.floor(ly * 2), Math.floor(lz * 2))`，船体的 `isDryHalf`（第 12.1 节）同样。不提供收小数坐标的版本：V8 把刚算出来的非整数传给没被内联的函数时要装箱（`shape.ts:345-348` 的说明）。实测一个收小数坐标的点查询（照第 12.1 节的船体结构写的）被内联时每次 0.01 字节，不被内联时（`node --max-inlined-bytecode-size=40`）每次 48 字节；收整数的写法两种情况下都是 0.00～0.02 字节。潜行护边每 tick 对每个结构体调几百次，不能靠“碰巧被内联”。`>> 1` 和 `& 1` 对负坐标也正确（算术右移）。
- **每 tick 运行的代码不构造、不传递双部件格子的整格内容**。它 ≥ 2³¹，在 V8 里是堆上的数，传给没被内联的函数每次装箱 16 字节（实测 `solidFill`、`solidCover`、`partAt` 对双部件的值每次 16 字节，`cellsTouch` 32 字节；整格方块和单个部件是小整数，0.01 字节）。这类代码读 `getCell` 和 `getPart2`（部件值 < 2²⁴）再查表，现成的入口是 `solidFillAt` 和 `solidAtHalf`，两者都不构造整格内容。`getPacked`、`solidFill(packed)`、`partAt`、`cellsTouch` 这些按值的查询只给一次性的工作用：组装的泛洪、放置、挖掘、编解码。
- `addPartAt` 不替调用方判断软方块：目标格是不可替换的软方块（火把、花）时它照样直接写。放置的流程（第 14.2 节 `planPlacement`）在调它之前已经把这种目标拒绝了；方块化和停靠（第 11.3 节）按“覆盖并掉落”处理。
- 实现 `VoxelGrid` 的类都要补 `getPart2`，P2 一并改：`src/sim/interact.ts:112` 的 `CellProbe`（过渡期返回 0；P8b 再改成返回要放的内容的第二部件，第 6.2 节）、`tests/voxel/shape.test.ts:948` 的 `ProxyWorld`（转给 `World.getPart2`）、`tests/voxel/robustness.test.ts:141` 的对象字面量（返回 0）。后两个文件其余部分归 P3，P2 只加这一个方法。

### 4.5 每一条复制格子的路径

P2 负责让下面每一条都带上三层，并各写一个“部分格子和双部件格子原样往返”的测试。P2 只管“不丢数据”；语义上的改动（按接触面粘连、合并规则等）属于后面的工作包。

| 路径 | 现在 | 改成 |
|---|---|---|
| `World.setCell`、`StructureGrid.setCell` / `resize` / `grow` / `forEachCell` | 只有基础层 | 4.2、4.3 |
| 存档的区块编码 `save/codec.ts encodeChunk / decodeChunk`；`sim/chunks.ts` 的暂存、恢复、`stashedCells` | u16 调色板 | `CellLayers`，第 13.3 节 |
| 结构体存档 `structures/serialize.ts` | 非空格子的游程，每格 u16 | 游程不变，每格写成 `Cell`（整格内容），第 13.3 节 |
| 协议 `net/codec.ts writeCell / readCell / writeCellVolume / readCellVolume` | 断言 < 2¹⁶，解码进 `Uint16Array` | 第 13.1 节 |
| `net/server/capture.ts` | 监听器给的 16 位值 | 监听器给的整格内容，`Map<number, number>` 不变 |
| `net/server/replicator.ts columnSnapshot`（1046-1061）、`structureRecord`（1645-1666） | `chunk.cells`、`getCell` 填 `Uint16Array` | `chunk.layers()`、`grid.copyBox(...)` |
| `net/client/apply.ts` 的快照（223）、结构体增量（259-262）、`loadCells`（644-653） | `Uint16Array` | `CellLayers`、`setCell(packed)`、`loadBox` |
| `net/client/chunks.ts generated`（133-142）：生成期间排队的增量 | 写进生成出的 `Uint16Array` | 先把生成结果包成 `CellLayers`，增量里有缺口或第二部件时按需分配另外两层 |
| `structures/assembly.ts transferCells`（116）、`gridCells`（365-378） | `getCell` → `setCell`；`Uint16Array` 快照 | `copyCell`；`Float64Array` 存整格内容 |
| `structures/collect.ts FillQueue.values`（221-248） | `Uint16Array` | `Float64Array` 存整格内容 |
| `structures/orient.ts rotCell` | 经 `makeCell` | 第 2.5 节 |
| `mesh/snapshot.ts`、`mesh/types.ts MeshInput`，以及 `client/meshing.ts`、`client/structures.ts` 的转交列表 | 只有 `cells` | 第 8.1 节 |
| `entities/manager.ts:1203,1249` 下落方块的存档字段 | `u16(cell & 0xffff)` | `varuint`；写之前断言 `< FULL_LIMIT`，读出来过 `cellProblem` 并要求 `< FULL_LIMIT`，否则 `SaveFormatError`；实体块的版本号加 1（第 13.3 节） |
| `worldgen/generator.ts:480 FlatGenerator` | `layer.id & 0xffff` | 构造时调 `generatorSpecProblem`（第 13.2 节：每层过 `cellProblem` 并要求 `< FULL_LIMIT`），不合法抛 `RangeError` |
| `voxel/fingerprint.ts`、`net/server/probe.ts`、`client/game.ts:1682`、`tests/net/digest.ts` | 只哈希基础层 | 第 13.4 节 |
| `voxel/raycast.ts:297` 的 `GridHit.cell`；`sim/interact.ts` 里读被瞄准格子的四处（`resolve` 520、`recheck` 540、`offhandGlue` 1191、`breakBlock` 1273） | `getCell` 的值 | `getPacked` 的值（过渡期的做法和原因见第 16.3 节） |
| 测试里的拷贝：`tests/liquid/helpers.ts:122-133`、`tests/structcore/helpers.ts:115-145`、`tests/mesh/helpers.ts:32-48`、`tests/net/gen.ts`、`tests/net/hidden-cost.test.ts:132`（手写的结构体记录） | 基础层 | 带三层 |

`fluids.ts`（`scanColumns`、`slopeDirections`、`peek`）和地形生成直接读基础层是有意保留的：液体的判断只需要 id（I7），生成器只产出整格方块。P2 在这些读取处加注释说明。

## 5. 碰撞

全部在 `src/voxel/shape.ts`（P3）。导出的函数和签名不变：`boxOverlapsSolid`、`deepestPenetration`、`resolvePenetration`、`forEachSolidCellOverlapping`、`sweepAxis`、`supportProbe`、`hasSupportBelow`、`columnHasSolidBelow`、`nearestFreeOffset`，以及常量 `CONTACT_EPS`、`MAX_BOX_COORD`、`FREE_OFFSET_STEP` 等。实体模块约 50 处调用因此不用改。两处扩展：

```ts
export interface Penetration { nx: number; ny: number; nz: number; depth: number; cx: number; cy: number; cz: number;
  /** 产生这次推出的八分格；整格单位时为 -1。 */
  octant: number; }
export function deepestPenetration(grid: VoxelGrid, box: AABB, opts?: PushOptions, out?: Penetration): Penetration | null; // out 可选，给了就不分配
export function forEachSolidCellOverlapping(grid: VoxelGrid, box: AABB,
  fn: (x: number, y: number, z: number, packed: number, octants: number) => boolean | void): void; // octants = 真正和盒子重叠的硬八分格
```

### 5.1 碰撞只看占用，分两种单位

碰撞对一个格子只关心 `f = solidFill`（两个部件的并，材质不分）：

- `f === 0`：空，跳过。
- `f === 0xff`：**整格单位**。按 M1 的算法处理，逐位相同。几何上拼满的双部件格子也走这里。唯一的例外在推出里：面邻居有部分格子的整格改按八分格算（5.3）。
- 其它：**八分格单位**。每个被占的八分格是一个边长 0.5 的立方体，在半格网格上跑同一套算法。

这样只有整格方块的世界，每个查询的结果和 M1 逐位相同：现有的 `tests/voxel`、`tests/entities`、`tests/drive` 里的用例一个都不用改（P2 只给两个测试替身补了 `getPart2`，第 4.4 节），改了就说明整格路径变了。

**容差**沿用 `CONTACT_EPS = 1e-9`：只是贴着（某个分离轴上重叠不超过它）不算重叠。半格范围的算法是把现在的公式放大一倍：

```
h0 = Math.floor((min + CONTACT_EPS) * 2)        // 盒子碰到的最低半格
h1 = Math.ceil((max - CONTACT_EPS) * 2) - 1     // 最高半格
格子范围： x0 = h0 >> 1， x1 = h1 >> 1          // 与现在的 floor(min + eps)、ceil(max - eps) - 1 恒等
格子 x 里被碰到的那一半： lo = (h0 <= 2x) ? 0 : 1， hi = (h1 >= 2x + 1) ? 1 : 0   // lo > hi 时这一格没有八分格被碰到
```

三个轴的 `(lo, hi)` 各查一张 3 项的小表（x：`0x55`、`0xaa`、`0xff`；y：`0x33`、`0xcc`、`0xff`；z：`0x0f`、`0xf0`、`0xff`），按位与起来就是“盒子在这一格里碰到的八分格”`sub`。部分格子与盒子重叠当且仅当 `f & sub !== 0`。

- 格子范围永远按格子的公式算，不因为半格范围为空而提前返回。唯一的差别出现在宽度为 0、又正好落在某个 0.5 平面上的探测盒：它算作碰到整格方块（和 M1 一样），不算碰到部分格子的任何八分格。这种盒子只在支撑探测的内缩量超过半宽时出现，不影响玩法。
- 无效的盒子（NaN、无穷、超出 `MAX_BOX_COORD`、min > max）对所有查询仍然是空，循环保证结束。

### 5.2 重叠

`boxOverlapsSolid`、支撑探测、`nearestFreeOffset` 的候选检查、`LocalObb.hasSolid` 用同一个判定。

- **世界**（恒等变换）：`worldRangeHasSolid` 的参数换成六个半格整数 `hx0, hx1, hy0, hy1, hz0, hz1`（跨函数只传整数，不装箱；见 shape.ts:345-353 的说明）。逐列取一次区块：
  - 这一列的区块 `holes === null && part2 === null`：现在的循环，一字不差（按 `>> 1` 得到的格子范围，`SOLID[cells[i] & ID_MASK]`）。
  - 否则逐格算 `f`：`v = cells[i]`；`SOLID[v & ID_MASK] === 0` 则空；否则 `f = ~holes[i] & 0xff`，有第二部件再并上 `~(part2[i] >>> 16) & 0xff`。`f === 0xff` 直接命中；否则算这一格的 `sub`，`f & sub` 非零命中。
  - 世界下方（y < 0）、未加载的列、建筑高度以上的规则不变。
- **不是 `World` 的世界网格**（测试替身）：经 `getCell` / `getPart2` 的同一套逻辑，结果必须和直接扫描一致（现有测试 shape.test.ts:982 的做法，加部分格子）。
- **结构体，轴对齐**（`LocalObb.aligned`）：盒子在局部空间也是轴对齐的，用局部包围盒 `c ± e` 算半格范围和 `sub`，同上。整格仍然直接 `return true`。
- **结构体，任意旋转**：整格用现在的 15 轴分离轴测试。部分格子：先用局部包围盒的 `sub` 筛八分格（这就是三个格子轴上的测试），再对剩下的每个被占八分格做其余 12 个轴的测试：八分格中心 `(x + 0.25 + 0.5·ox, …)`，投影半径是单位格的一半。`buildSatAxes` 现在把 `rA + rB` 存成一个数（shape.ts:207、242），改成每个轴多存一个 `rB / 2`，八分格的阈值是 `(rA + rB) − rB/2`；轴仍然每次查询只建一次。

### 5.3 推出

`deepestPenetration`（`findPenetration`）在候选格子范围里逐格看 `f`：

- `f === 0`：跳过。
- `f === 0xff`，并且六个面邻居的 `solidFill` 都是 0 或 `0xff`：**整格单位**，就是现在的代码：六个面的深度量到格子的面，面邻居不是实心的面才是候选的推出方向（暴露面），格子的“真实重叠”是六个深度的最小值。
- 其它情况（部分格子，或者有部分格子做面邻居的整格）：**八分格单位**。对每个被占、且与盒子重叠（5.2 的判定）的八分格 `o`：
  - 六个深度量到这个八分格的面：最小角 `(x + ox/2, y + oy/2, z + oz/2)`，边长 0.5；
  - 方向 `d` 的面暴露，当且仅当沿 `d` 紧挨着的那个八分格（同一格里的，或邻格里的）不在它所在格子的 `solidFill` 里；
  - 其余（偏向 `prefer`、报告真实深度而不是带偏向的分数）和整格单位相同。
- 单位之间的取舍不变：真实重叠最大的赢；相等时暴露面推出距离小的赢；再相等时先扫到的赢。扫描顺序是格子按 y、z、x，同一格里八分格按编号从小到大。
- 这个顺序和“把世界放大一倍后跑 M1”的顺序（半格网格按 y、z、x）**不同**，所以两边在完全平局时可以给出深度相同、法线不同的结果（20 万个随机盒子里有 920 个）。顺序以本节为准，不改成半格网格的顺序：只有整格方块时它就是 M1 的顺序。放大世界的对拍因此这样比：重叠、扫掠、支撑、推出的 `depth` 逐位比较；法线只在“最优的（单位，暴露面）唯一”时比较。是否唯一由测试自己的暴力枚举判定：列出每个与盒子重叠的被占八分格的真实重叠和每个暴露面的推出距离，达到“真实重叠最大、其中推出距离最小”的（单位，面）只有一个才算唯一。
- 结果的 `cx, cy, cz` 是单位所在的格子，`octant` 是八分格（整格单位为 −1）。

为什么整格旁边有部分格子时也要按八分格算：整格方块挨着一块上半砖时，它朝半砖的那个面只有下半边露着。把整个面当成暴露面，走在上面的人稍微陷进去一点就会被这个面横着推出去，这正是 LESSONS“实体在地板接缝处被卡住”。按八分格算，上面那两个八分格朝半砖的面不暴露，只会被向上推。

`resolvePenetration` 只是反复调用上面的函数，逻辑不变。

### 5.4 扫掠

`sweepAxis`（只对世界）在半格网格上做：横截面用另外两个轴的半格范围，沿扫掠轴一个半层一个半层地看。

- **哪些半层会挡**：部分格子的每个半层，只要它在横截面里（`f & sub` 取这一半层的那 4 个八分格）有被占的八分格就挡。整格单位只在它的**入口半层**挡：向正方向扫是它的低半层，向负方向扫是它的高半层。这条规则等价于 M1 的“已经重叠的格子整个忽略”，所以整格方块的结果逐位相同。
- **起点**：第一个还没重叠的半层。向正方向 `hStart = Math.ceil((max − eps) * 2)`，向负方向 `hStart = Math.floor((min + eps) * 2) − 1`。已经重叠的八分格被忽略，所以盒子总能从重叠里移出来。
- **结果**：向正方向挡在半层 `h`，位移是 `h / 2 − max`（不小于 0）；向负方向是 `(h + 1) / 2 − min`（不大于 0）。没被挡住返回 `delta`。`h / 2` 是精确的，所以落在半砖上的脚正好在 `y + 0.5`。
- 竖直方向仍然按列扫：`columnFirstSolidUp / Down` 的层号参数和返回值换成半层整数，另外传这一列在横截面里的 x、z 两个 `(lo, hi)` 合成的八分格掩码（一个整数）。水平方向逐半层调用 5.2 的范围查询，多传一个“这一层是整格的入口半层吗”的整数标志。所有跨函数的参数仍然只有整数。
- 区块没有另外两层时，循环退化成现在的样子：只有偶数（或奇数）半层可能挡，直接按格子层扫，不要真的把循环次数翻倍。
- 上面两条（“整格只在入口半层挡”等价于 M1；部分格子的结果等于把世界放大一倍后跑 M1）用脚本在沿扫掠轴的一维情形里各比较了 30 万组随机数据，没有差异；“由半格范围 `>> 1` 得到的格子范围等于现在的格子范围”同样验证过（含负坐标和正好落在边界上的值）。审查时又用一份照 5.1～5.4 写的原型替换 `voxel/shape.ts` 跑了三维的对拍：只有整格方块的世界里，重叠、三个轴的扫掠、推出、支撑和仓库的实现逐位相同（20 万个随机盒子）；只有部分格子的世界里，重叠、扫掠、支撑和放大一倍的 M1 没有差异。P3 的测试里保留这几项对拍（推出的法线按 5.3 的说明比）。
- M1 的一个细节要原样保留：沿扫掠轴厚度为 0 的盒子，水平扫掠直接返回 `delta`（`shape.ts:916` 的 `x0 > x1`）。这一条只对落在格面上的盒子成立；落在 0.5 平面上、沿扫掠轴厚度为 0 的盒子按 5.1 的半格范围被它前面的半层挡住（位移 0）。“等于放大一倍的世界”的对拍不含宽度为 0、落在 0.5 平面上的盒子。没有调用者扫这种盒子。

### 5.5 支撑与找空位

- `hasSupportBelow`、`columnHasSolidBelow` 仍是同一个探测盒（脚印内缩、向下 `maxGap`）的重叠测试，只是换成 5.2 的判定：脚印下面是格子里空着的那一半时不算有支撑。站立、附着、携带、挤压四种判定仍然只差内缩量。
- `nearestFreeOffset` 的候选顺序和 0.25 的步长不变；0.25 的网格本来就分得清半格。

### 5.6 快速路径和内存分配

- 整格和空格：每个查询对它们的开销和现在相同。世界路径以“这一列的区块有没有另外两层”分流，结构体路径以 `StructureGrid.layered` 分流（别的 `VoxelGrid` 实现走 `getCell` / `getPart2` 的通用路径）；没有部分方块时走的就是今天的代码。分流只是为了快，结果由格子决定而不由层在不在决定：第 5.3 节里“挨着部分格子的整格按八分格算”的那个邻居可以在隔壁区块，所以判断一个整格走哪条路径时读的是它六个邻居的格子，不是它自己那个区块有没有层；层是 `null` 和层全 0 的结果必须相同（服务器的区块和它的副本可以正好差在这里），P3 用“一侧区块有层、一侧没有”的用例钉住。
- 热路径不分配：跨函数只传整数和对象；八分格的表都是模块常量的类型化数组；`deepestPenetration` 给了 `out` 就不分配。
- 分配预算（`tests/voxel/alloc.test.ts`）：现有 11 个用例仍然每次调用 < 1 字节；新增在有部分格子的区块里的用例，同样 < 1 字节：半砖旁边的 `boxOverlapsSolid`、站在半砖顶上的 `hasSupportBelow`、沿一排半砖的 `sweepAxis`（没被挡住）。被挡住的扫掠返回一个带小数的数，本来就会装箱（现有的例外，沿用）。点查询 `solidAtHalf`、`isDryHalf` 只收整数（第 4.4 节），它们的两个调用场景各有一个预算（第 15 节）：在船的甲板上潜行、在船体旁边采样液体。

### 5.7 走上半砖

场景 38 不需要新的移动规则，靠的是 5.4 的精确扫掠加上已有的台阶：

- `STEP_HEIGHT = 0.6` 不变。走路的身体（玩家、兔子）站在地上、水平移动被挡住时，抬高至多 0.6 再试一次，然后落回去（`physics.ts tryStepUp`，389-421）；结构体上的台阶走 `stepOntoStructure`（660-686），靠 5.3 的暴露顶面。半砖高 0.5，直接走得上去；整格高 1.0，仍然要跳。`constants.ts:158-163` 的注释“地形的台阶都是整格”改掉。
- **站着不下陷**：向下的扫掠停在 `y + 0.5`，精确。
- **不被接缝卡住**：贴着一排半砖走时，身体的侧面正好在格子的中线或边界上，按 5.1 的容差不算碰到旁边的八分格；走在一排半砖顶上时，脚的高度是 `y + 0.5`，下半层不在横截面里。结构体上靠 5.3 的八分格暴露面规则。两种都要有测试，并且做“去掉这条规则测试就失败”的检查。
- **下台阶**：没有向下吸附。走下 0.5 的台阶是一次约 4 tick 的下落，中间按空中的规则控制方向；不到 3.5 格不受伤，不到 1 格不出落地声。潜行护边的探测深度是 0.6，所以潜行时也会走下半砖的边。是否加吸附见第 17 节问题 6。沿八分格楼梯往下走或跑，是一连串这样的下落；每个 tick 身体先竖直移动、再水平移动，踏面只有半格深，所以常常“落在一级的边上，同一个 tick 里又走出这一级”。这对移动本身没有影响，对服务器的校验有（第 5.8 节第 4 条）。已知的后果：沿 54.7° 的对角八分格楼梯往下**冲刺**会一再落空超过 3.5 格（30 格高的楼梯掉 11 点血）；直着走、直着跑、斜着走都不受伤。要不要为此加向下吸附留给负责人（第 17 节问题 6，ROADMAP 的遗留）。
- **相机**：迈上台阶时身体在一个 tick 里上升 0.5，画面会跳一下。客户端在算眼睛位置的地方加一个只管画面的竖直偏移 `stepLag`：自己的角色在一个客户端 tick 里相对载体（没有载体就是相对世界）上升了 `dy`，`0.05 < dy <= STEP_HEIGHT + 0.01`，而且这个 tick 前后都着地（不是起跳），就 `stepLag −= dy`；每帧 `stepLag *= exp(−dt / 0.06)`，并夹在 `[−0.6, 0]`。第一人称的眼睛和第三人称相机的锚点都加上它。它不进模拟、不上报，服务器不知道。归 P8b（`client/` 里的相机）。
- `MAX_SUBSTEP = 0.4` 小于半格，快速下落不会穿过半砖厚的地板（P3 加测试，改注释）。

### 5.8 客户端预测和服务器校验

客户端的预测和服务器的校验跑的是同一份代码（`BodyMover` 和 `voxel/shape.ts`），所以只要副本的格子内容和服务器相同（三层都相同，第 13.4 节的摘要负责检查），两边对同一步算出的结果逐位相同。但服务器不重放移动，它用 `drive.ts` 的几条检查判断每条上报；其中三处是按“台阶都是整格、踏面一格深”定的，八分格楼梯会让它们误判。下面第 1、3、4、5 条是改动，都在 `src/entities/drive.ts`（P3；第 5 条还动了 `manager.ts`）；第 2 条是保留下来的限制。审查时把这三处改动连同 5.10 改进一份原型，换掉仓库里的 `drive.ts` 和 `physics.ts`，跑了用到它们的现有测试（`tests/{entities,drive,net,sim,structures,shipphys,client}` 共 1333 个；验收测试直接模式 153 个，联机模式 151 个，另有 2 个本来就跳过），全部通过，没有一个需要改。

1. **竖直余量**（713、735、754 行）。现在只允许一个 `STEP_HEIGHT`：每条上报都到达时够用（每个 tick 至多迈一级），连续丢几条上报之后，走楼梯的人在一条上报的间隔里已经上了好几级，会被 `check:rise` 纠正。改成：上报以着地结束（`groundOk`）时，上限再加 `Math.SQRT2 * h`，`h` 是这条上报的水平位移（713 行算出的那个）：
   - 754 行：`bound = spanPeak + STEP_HEIGHT + Math.SQRT2 * h`；
   - 735 行（没看到的落地）：`highest` 同样加 `Math.SQRT2 * h`；
   - 713 行的速度上限不用改：它是每 tick 0.43 再加一个 `STEP_HEIGHT`；楼梯上单个 tick 最多迈一级（0.5），长时间平均每 tick 最多升 0.40（沿对角线冲刺）。原型上连丢 10 条、15 条上报都通过。
   
   为什么是 √2：每迈一级升 0.5，要跨过一个台阶的立面；立面在网格的两个水平轴上各每 0.5 格一个，所以升高不超过 `|dx| + |dz|` 再加两级的取整（每个轴一级），而 `|dx| + |dz| <= √2·h`。只写 `+ h` 不够：沿对角线走“高度 = 0.5 ×（i + j）”的楼梯时，升高是水平位移的 1.38（走）到 1.42（跑）倍（原型上实测）。取整多出来的至多 1 格由 `STEP_HEIGHT`（0.6）和 `spanPeak` 里的起跳弧盖住（弧高一个 tick 0.40，两个 tick 0.72；要多出两级至少得过两个 tick）。用 √2·h 而不用 `|dx| + |dz|`，是因为它不依赖楼梯所在网格的朝向（世界、转了任意角度的船都一样）。只在两处之间有楼梯时才加这一项：第 3 条的阶梯路径（`stairClear`，从较低的一端到较高的一端，用路径检查的坐标系和深度上限）走得通。墙、露天的台地前没有楼梯，`√2·h` 不加，上限和 M1 相同（否则一条上报能跳上 √2·h + 1.85 高的墙：16 tick 横移 4 格就是 8 格高；这是 P3 的审查发现的，本节最初的写法没有这个条件）。空中的上报不受益。
2. **空中结束的上报不加这一项**，这是已知的限制：在楼梯上连丢 3 条以上的上报、其间上了两级以上、并且正好在下一条到达的上报之前起跳，仍然会被 `check:rise` 纠正一次（实测：冲刺，每 4 条丢 3 条，每次都在到达的那条之前起跳）。不为它加“迈了几级”的计数器：那要改上报的格式，并且和 `landings` 一样是一处要防作弊的新规则，而触发它需要连续丢包和起跳凑在一起，后果只是一次拉回。P10 把它记进 NETCODE 的已知限制。
3. **路径检查**（`pathClear`，1011-1052 行）加第六种候选路径“阶梯”。现在的五条路径（直线，四条折线）在露天的楼梯上够用：容差 0.2 小于 0.25，直线不过，“先竖直后水平”的折线过。但那条折线要求起点上方有整段升高的净空；在楼梯间里（天花板和踏面平行），丢 4 条以上的上报就过不了，往下走同理。新的候选 `stairClear(lo, hi)`，`lo` 是两个端点里较低的一个（所以上行、下行都覆盖）：
   - 从 `lo` 出发沿水平直线走向 `hi` 的水平位置，每 `REPORT_PATH_STEP`（0.1）取一个样，高度 `y` 从 `lo.y` 开始；
   - 样本不通（`sampleClear` 为假）时，把 `y` 抬高 `REPORT_PATH_STEP` 的最小整数倍使它变通，最多抬 `STEP_HEIGHT`，并且不超过 `hi.y`；抬不通就失败。`y` 只升不降；
   - 走到 `hi` 的水平位置之后，从 `y` 竖直到 `hi.y` 的这一段（`legClear`）也要通。
   - 两个端点等高、或水平距离为 0 时这个候选不适用（返回假）。
   
   它只放行“一路向上、每次不超过一级”的路径，墙和笼子照样过不去；抬高取“最小的倍数”而不是固定的 0.6，否则每级多抬 0.1，十几级之后会顶到天花板。
4. **落在踏面的边上**（719 行的 `groundOk`）。上报声称着地、并且这是它自己的一次落地（上一条被接受的上报不在地上；纪元的第一条上报除外），而服务器在它的终点找不到支撑（`supported` 为假）时，现在的处理是“当它还在空中”，竖直包络继续按上一段下落往下算；身体实际上已经在那一级上停过、速度归零了，下一段下落里它会高出那条越落越快的包络，被 `check:rise` 纠正。只有整格方块时这要“落在一个方块的边上、同一个 tick 里走出去，接着的那段下落又足够长（原型上是 9 个 tick、两格半）”才会发生，整格楼梯上没有见过（16 次下行 0 次）；沿八分格楼梯往下走，没有丢包、没有延迟也会发生（原型上 16 次下行里 14 次）。改成：`check()` 算出 `groundOk` 之后，这种上报把 `unseen` 当作真，即进入现有的 LANDINGS 分支（731-744 行）：两个位置里较低的那个下方、下落够得着的范围内必须真有地面，包络从那块地面重新开始，摔落的距离在这里结算一次。作弊的人得不到新东西：丢掉一条上报本来就能走到同一个分支。改过之后 16 次下行的纠正为 0。这种落地的地面也可以是旧位置下面、这条上报自己下落距离以内的那级边沿（身体先竖直后水平移动，先落在边沿上再走出去）。紧接着一条真正站着的上报、或者这样一次落地之后，声称着地而脚下没有东西的上报，最晚起跳的时刻再保留一条上报（`envHeld`）：客户端的身体在这个 tick 开始时还站在边上，下一个 tick 可以起跳（否则老实的玩家边下楼梯边跳会被 `check:rise` 纠正）。只保留一次。
5. **站在什么上面**（P3 的审查发现的；贴墙的漏洞 M1 就有）：上报声称着地时，服务器只认脚下的硬格子。支撑探测比脚印宽 `REPORT_SUPPORT_REACH`（移动先定着地标志再水平移动，走出边沿的那个 tick 仍声称着地；船的姿态两边不同），上报又可以陷进硬格子 `REPORT_HARD_TOLERANCE`，所以贴着、靠近或陷进墙时墙也落在探测里；身体本身（脚以上 `REPORT_SUPPORT_REACH` 起）碰到的硬格子所在的那一侧，脚印每次内缩 0.05，直到身体不再碰到，最多内缩 `REPORT_HARD_TOLERANCE`，倾斜的结构体再多缩 `倾斜的正切 × (探测深度 + REPORT_SUPPORT_REACH)`（至多 0.05）。否则贴墙每 tick 升一格、贴墙下落不受伤。服务器把陷进世界方块的身体挪出去（`'unstick'`）时不结束它的下落。

P3 的测试（新文件；`tests/net/e2e-own-agree.test.ts` 里加场景）：
- 零延迟、不丢包：走上和走下半砖、直的八分格楼梯、对角的八分格楼梯、楼梯间（天花板比每级踏面高 3.0，这是 45° 的八分格楼梯走得上去的最低净空：2.5 时身体宽 0.6、踏面深 0.5，走两级就卡住），世界里和船上各一遍，走和跑，被拒绝的上报为 0。
- 每 11 条上报丢 10 条：同样的场景，纠正为 0。
- 对第 1、3、4 条各做一次“去掉它，对应的测试失败”的检查。
- 第 2 条的限制写成一个断言现状的测试（纠正一次，原因是 `check:rise`），将来有人改进时会提醒他更新文档。

### 5.9 实体模块里自己读格子的地方

P3 一并改（`src/entities/` 除 `inventory.ts`、`input.ts` 外都归 P3）：

| 位置 | 改成 |
|---|---|
| 潜行护边的点探测 `physics.ts:956-961`（世界）、`984-989`（结构体） | 用 `solidAtHalf`，参数是调用处取好的半格整数。世界部分对每个圆盘点，`hx = Math.floor((x + …) * 2)`、`hz` 同理，从 `Math.ceil((y − eps) * 2) − 1` 到 `Math.floor((y − 0.6 + eps) * 2)` 逐个半层看；这一列的区块没有另外两层时就是现在按格的循环。结构体部分把现在的三个 `Math.floor(…)` 换成 `Math.floor(… * 2)`，`grid.layered` 为假时走现在的代码。保持“护边认为有支撑 ⇒ 附着探测也认为有支撑” |
| 舵位 `manager.ts:474-492` | 见表后的说明 |
| 下落方块落地 `manager.ts:1434-1448` | 目标格仍是 `floor(y + 0.5)`，条件仍是 `REPLACEABLE`（有部件的格子按 I7 不可替换）且没有结构体的格子占着。停在下半砖上的沙子因此落进上面那一格，和半砖之间留半格空隙（第 17 节问题 7）。下落方块带的值必须 `< FULL_LIMIT`，加断言 |
| `riseOut`（`body.ts:769-791`） | 按 0.5 一步往上找空位 |
| `FallingBlockEntity.cell` 的注释、`constants.ts` 的 `MAX_SUBSTEP` 和 `STEP_HEIGHT` 注释 | 改文字 |
| `entities/fluids.ts:77`（P2 已经换成 `isDryHalf`，第 12.1 节） | 不用再改 |

**舵位**。座位在舵轮后面那一格 `(sx, sy, sz)`（船的局部格子）。身体宽 0.6，站在格子中心时脚印落在这一格以内、并且横跨它的四个象限；高 1.8，占 4 个半层。所以整条规则可以只用这一列的半层来写，全是整数，和船的朝向无关：

```
halfSolid(k)  = (solidFillAt(grid, sx, k >> 1, sz) & (k & 1 ? 0xcc : 0x33)) !== 0    // 这一列的第 k 个半层里有硬八分格
free(h)       = !halfSolid(h) && !halfSolid(h + 1) && !halfSolid(h + 2) && !halfSolid(h + 3)   // 脚在半层 h 的底面时身体不碰东西
floor(h)      = halfSolid(h − 1)                                                     // 脚下紧挨着的半层里有东西
```

1. 依次试 `h = 2·sy`、`2·sy + 1`、`2·sy − 1`，取第一个 `free(h) && floor(h)` 的：`seat = (sx + 0.5, h / 2, sz + 0.5)`。
2. 都不满足、但 `free(2·sy)`：`seat = (sx + 0.5, sy, sz + 0.5)`。这是 M1 的行为（座位格和它上面一格空着就坐，不要求有地板），保留。
3. 否则用玩家当前的位置（现在的回退）。

只有整格方块的船，结果和现在相同：`free(2·sy)` 就是现在的“两格都不是实心”；第 1 步里 `2·sy ± 1` 两个候选在整格的船上不可能成立（它们要求同一个整格一半硬、一半空）。有半砖地板时，第 1 步让舵手站在半砖的顶面上（`sy + 0.5` 或 `sy − 0.5`），而不是陷进去或悬在半格高处。

### 5.10 结构体推身体：不从它来的那一侧推出去

结构体每 tick 先移动，实体后移动；身体被结构体的格子盖住时，`Collider.resolveStructures`（`physics.ts:425-503`）把它沿“最浅的暴露面”推出去。墙有一格厚时这总是推回墙的前面。墙只有半格厚时不行：墙一个 tick 走过的距离超过（身体宽 + 0.5）/ 2（玩家 0.55 格，兔子 0.45，掉落物 0.375），最浅的面就成了墙的**背面**，身体被推到墙后面，等于穿了过去。这是 LESSONS“船被推穿薄墙”在实体这一侧的翻版。原型上实测：14 格/秒的半砖厚的墙前面按住跳跃键的玩家，16 次里 16 次落到墙后；兔子从 10 格/秒起 16 次里 16 次；整格的墙都是 0 次。地上的掉落物在 12、14 格/秒时连整格的墙也会穿过（20 次里 2 次、4 次），这是 M1 就有的。

M1 为此有一个“偏向结构体运动方向”的规则（`preferFor`，`physics.ts:758-779`），但它按**速度差**算：身体被推过一次之后已经带上了墙的水平速度，速度差只剩身体自己的竖直速度（在跳、在落），偏向指到了上下。而穿入深度来自**位置**：身体在空中时，这个子步里先结算结构体、后做自己的水平移动（245-246 行），墙已经走完这个 tick 的路，身体还没动。改成按位移算，三处改动都在 `src/entities/physics.ts`（P3）：

1. `move()` 进来时记下身体的位置 `p0`。
2. `preferFor` 对“这个 tick 动过、又不是载体”的结构体 `r`，偏向取**这个 tick 里结构体相对身体已经多走的位移**：

   ```
   Δ = (pointVelocity(r, 身体盒中心) − e.carrierVel) × TICK_DT − (e.pos − p0)
   |Δ| < PREFER_MIN_SPEED × TICK_DT（0.025 格）：没有偏向
   否则 prefer = Δ / |Δ|，preferWeight = max(PREFER_WEIGHT, |Δ|)
   ```

   取代现在的速度差公式。身体已经走完自己这个 tick 的位移时，`Δ` 就是速度差乘 `TICK_DT`，和现在一致；差别只在“身体这个子步还没动”的时候。权重取 `|Δ|`：身体原来在墙前面时，从正面推出去的距离不会超过 `|Δ|`，所以正面的得分不大于 0，一定赢过背面，和速度无关。`setLean` 给的固定偏向（挤压判定用）不变。
3. `resolveStructures` 里“是否用带偏向的结果”的条件，从“最浅的推出不小于 `PREFER_MIN_DEPTH`（0.2）”改成“……或者最浅的推出方向和 `prefer` 相反（点积 < −0.5）”。新加的这一半只对第 2 步算出来的偏向生效，不对 `setLean` 的固定偏向生效。原因：掉落物宽 0.25，从半格厚的墙背面推出去只要 0.05～0.15，够不到 0.2 的门槛；而“擦边不偏向”（LESSONS“叶片侧面擦过船时船被猛踢”）指的是推出方向和运动方向垂直的情形，点积接近 0，不受影响。

原型上的结果：半砖厚的墙和半砖厚的叶片（叶尖 8～14 格/秒），玩家、兔子、掉落物，站着或跳着，穿过去的次数全部为 0；去掉第 3 步，掉落物的 2/20、4/20 回来；只在“速度差不够大时”才用位移（不取代速度差公式）不起作用。整格的墙前面的掉落物也不再穿过。走在甲板、半砖甲板、楼梯上的那些场景，逐 tick 的结果没有变化。

这条规则在每 tick 的相对位移小于（墙厚 + 身体宽）时成立：半格厚的墙对掉落物约 15、兔子 18、玩家 22 格/秒（整格的墙 25、28、32）以上，墙在任何一个 tick 都碰不到身体，直接越过去。船最快约 10.5 格/秒，转子的叶尖到 15 格/秒要半径 15。不对结构体的运动做子步。另一个没有处理的情形：甲板以每 tick 0.45 格上升、整格方块和上半砖的接缝正下方有掉落物在落时，掉落物被横着推进上半砖空着的下半格（每 tick 0.4 格及以下不发生）。

P3 的测试（`tests/entities/` 下新文件）：玩家（按住跳跃）、兔子、掉落物，在 14 格/秒的 `0xaa` 墙前面、在叶尖 14 格/秒的半砖叶片前面，始终留在前面；整格的墙同样；对第 2、3 步各做“去掉它，测试失败”的检查。

## 6. 射线与目标

### 6.1 射线命中什么

`src/voxel/raycast.ts`（P8a）。`raycastGrid`、`raycastGrids`、`placementCell`、`targetable`、`targetableOrLiquidSource` 的签名不变。

```ts
export interface GridHit {
  grid: VoxelGrid;
  x: number; y: number; z: number;   // 命中的格子（网格局部）
  /** 射线进入命中的那个八分格时穿过的面（局部 Dir）。可能是内面：下半砖的顶面在 y + 0.5，face 仍是 PY。 */
  face: Dir;
  /** 命中的八分格 0..7。 */
  octant: number;
  /** 这一格的整格内容（Target.cell 带的就是它）。 */
  cell: number;
  /** 命中的部件值：partAt(cell, octant)。挖掘时间、掉落、选取方块、按 id 分派都读它。 */
  part: number;
  dist: number;                      // 沿射线到进入点的距离
  point: Vec3;                       // 世界坐标的进入点
}
export type CellPredicate = (part: number) => boolean; // 现在按部件判断
```

**定义**：结果等于在半格网格上跑 M1 的 DDA，把每个被占的八分格当成一个格子，谓词作用在它所属的部件值上。实现上外层仍然按格子走：

- 格子值 `< FULL_LIMIT`（整格方块、模型方块、空气、液体）：现在的路径。命中时 `octant` 是射线在这一格里进入的第一个八分格，`part = cell`。火把、花草、雪层这些软方块仍然按整格被选中。
- 否则（有缺口或双部件）：从进入点起在这一格里做 2×2×2 的 DDA，最多经过 4 个八分格。第一个“被占、并且所属部件满足谓词”的八分格就是命中：`dist` 和 `point` 取进入这个八分格的地方，`face` 是进入它时穿过的面（第一个八分格沿用外层的进入面，后面的是穿过的内面）。都不满足就继续走下一格。
- 边界约定和外层相同：半开区间；正好穿过棱或角时，所有并列的轴同时前进，进入面取最陡的那个轴；起点在命中的八分格里面时，`dist = 0`，`face` 是射线主方向的反面。
- 整格的 `octant`：进入面所在轴上，射线向正方向走取 0、向负方向取 1；另外两个轴看进入点的小数部分是否 ≥ 0.5，正好在 0.5 上时向正方向走取 1、向负方向取 0、不动取 1。起点在格子里面时，三个轴都按起点的小数部分用同一条规则取。
- 所以射线会穿过部分格子里空着的八分格，打到后面的东西：隔着半砖上方的空隙能点到后面的方块。

对照实现是“射线对每个被占八分格的盒子求最近的进入点”。P8a 把它写在新文件 `tests/voxel/ray-helpers.ts` 里，`tests/voxel/raycast.test.ts` 改为引用它；现有的 `tests/voxel/helpers.ts` 归 P3（同一波），P8a 不碰，里面的 `referenceRay` 留到 P10 删掉。

### 6.2 交互怎么用它

`sim/rays.ts` 的三种射线和 `castRay` 的签名不变（P8a）；`sim/interact.ts`、`sim/players.ts` 归 P8b。被瞄准的部件一律是 `hit.part`，即“含 `hit.octant` 的那个部件”。

| 动作 | 规则 |
|---|---|
| 目标是否有效 | 客户端驱动的玩家：服务器上 `partAt(现在的格子, sub)` 不为 0，且 id 等于 `partAt(target.cell, sub)` 的 id（现在是比整格的 id）。别人凿了同一格的另一个部件、或这个部件的别的八分格，不影响 |
| 挖掘 | 挖的是 `hit.part`。挖掘的身份是“网格 + 格子坐标 + 部件值”：准星在同一个部件上移动（`octant` 变了）不重置进度；这个部件的值变了（被别人凿了）才重置；同格的另一个部件变了不重置。时间 = 这个部件材质的硬度，和它剩多少无关（第 17 节问题 5）。完成时 `removePartAt`，掉落这种材质的掉落物 1 份，位置按 `DROP_POINT`（第 9.5 节）。创造模式按下即挖，同样只挖这个部件 |
| 选取方块 | `pickBlockItem(hit.part)`（`entities/inventory.ts`，参数从格子改为部件值；客户端的预测 `net/client/intents.ts:232` 用 `partAt(target.cell, target.sub)`） |
| 放整块方块 | 目标格仍是 `placementCell(hit)` = 命中格 + 面的方向，不管这个面是格面还是内面。点下半砖的顶面，方块放进上面那一格（和半砖之间空半格，第 17 节问题 1）。目标格必须 `REPLACEABLE`：有部件的格子是硬的，所以“不能往已经有部件的格子里放整块方块”自动成立；目标格是不可替换的软方块（火把、花）时同样拒绝，和现在一样。点中的是可替换的软方块时仍然取代它。整条规则写在 `planPlacement` 里（第 14.2 节） |
| 放置时的重叠 | `placementBlocked`（957-1013）两边都用形状：新方块的形状对实体的身体（`CellProbe` 这个假网格改成返回要放的整格内容，查询走第 5 节），新方块对别的网格的硬八分格。整格方块的结果不变 |
| 支撑 | `supportOk`（224-229）的 `'solid'` 改成 `topCovered(getPacked(下方))`；和方块更新共用 `sim/support.ts`（第 9.2 节） |
| 涂胶 | 胶属于格面。`isCellFace(hit.octant, hit.face)` 为假（点的是内面）时拒绝，提示“胶只能涂在方块的外侧面上”（新消息键 `toast.glue.inner`）。其余条件见第 10.3 节。生存模式的耗时 = `hit.part` 材质的硬度；涂胶过程中这一格的内容变了就取消（沿用） |
| 桶 | 只对世界；往有部件的格子里倒不进去（不可替换）。目标格的算法同“放整块方块” |
| 舵轮、轴承、爆破箱 | 按 `hit.part & ID_MASK` 分派。它们不能切、不和别的部件同格，两次点选的流程不变；预览的格子集合仍然以格为单位 |
| 提示、预览失效 | 沿用；“世界有非液体的变化”现在包括只改缺口或第二部件的变化 |

`InteractionView`（`sim/view.ts`）：`AimTarget` 加 `sub: number`；`mining.sub` 的位 0～2 填被挖部件里最初命中的八分格，位 3 是“只针对这一个八分格”的标志（M2.3 恒为 0，见第 6.3 节）；`gluing.sub` 填 0。事件 `blockBroken` / `blockPlaced` 的 `cell` 改成那个**部件值**（一次挖掉或放下一个部件，一个事件）。

脚本接口（`PlayerControl`，以及验收测试的 `Me` 和 `HeadlessClient` 的同名方法）加可选的八分格：`lookAtPart(x, y, z, octant, gridId?)`（瞄这个八分格露出的某个面的中心）、`aimAt(x, y, z, face, gridId?, octant?)`、`mine(x, y, z, face, gridId?, maxTicks?, octant?)`（等到那个部件没了为止）、`targetCell()` 的结果带 `octant`。不给八分格时行为和现在一样（瞄格子中心），对部分格子可能瞄空。

### 6.3 网络上的目标

`Target { gridId, x, y, z, face, sub, cell }` 的布局不变（NETCODE 第 14 节）：

- `sub` = 命中的八分格，0～7；高 5 位必须是 0，否则按协议错误。客户端发 `hit.octant`（现在恒为 0，`net/client/intents.ts:73`），服务器把它带进 `AimTarget`（现在丢掉，`net/server/intents.ts:159-162`）。
- `cell` = 客户端看到的这一格的整格内容（协议的 `Cell`，第 13.1 节）。
- 目标的任何一项变了都算目标变了，包括 `sub`：准星在一格里从一个八分格移到另一个，客户端发新的 `Aim`（每 tick 至多一条，本来就有的限制）。
- 服务器从声称的瞄准还原出 `GridHit` 时（`Hands.resolve`，`interact.ts:516-530`）：`octant = sub`，`cell` 是服务器上这一格现在的整格内容，`part = partAt(cell, sub)`，`point` 取这个八分格的中心。
- 服务器的校验（`net/server/intents.ts:250-271`）：第 1 条改成 6.2 表里的“目标是否有效”；射线谓词作用在被瞄准的部件上；够不够得着仍然量到整格的盒子（多出来的余量不到半格，不值得收紧）。
- 私有状态里 `mining` 的 `sub`：位 0～2 是八分格，位 3 是“这次的进度只针对这一个八分格”的标志，位 4～7 必须是 0；`gluing` 的 `sub` 必须是 0；两端都校验。位 3 是为 M2.4 留的：凿子如果要计时（第 17 节问题 8 的建议），进度的身份是“网格 + 格子 + 八分格”，裂纹只包这一个八分格；M2.3 的服务器不置这一位，但 P8b 的编解码、校验和裂纹的画法现在就按它写，M2.4 不用改协议。
- 客户端画裂纹的条件：位 3 为 0 时，“自己的目标和 `mining` 在同一格，并且 `partAt(那一格, target.sub) === partAt(那一格, mining.sub)`”，裂纹包住整个部件；位 3 为 1 时，“目标和 `mining` 在同一格、同一个八分格”，裂纹只包这个八分格（占用掩码 `1 << 八分格`）。

### 6.4 目标框和其它叠加层

见第 8.6 节。

## 7. 光照

`src/light/engine.ts`（P5）。光照只在客户端的副本上算。规则来自 DESIGN：“一个面被不透明材质完全盖住时挡光，否则透光”。

### 7.1 模型：从“进格子的代价”改成“过面的条件”

光能不能从一格到相邻的一格，看的是它们之间那个面**两侧合起来**有没有被不透明材质盖满。只看一侧不够：并排的下半砖和上半砖各盖住公共面的一半，哪一侧都没有“完全盖住”，合起来却是封死的；网格化剔面看的也是两侧（第 8.2 节）。审查时照“只看自己一侧”的写法做了一个原型：一行下半砖、一行上半砖交替铺成的屋顶（斜屋顶就是这个样子）和棋盘式铺法，屋里的天空光是 14；`y = 4` 一层西半砖、`y = 3` 一层东半砖叠成的屋顶，屋里是 15；三种情形在半格网格上都没有任何空气通路。

对每个格子 `c`（整格内容）和方向 `d`，`n` 是 `c` 在 `d` 方向的邻居：

| 量 | 定义 | 两格都是整格方块时 |
|---|---|---|
| `oc(c, d)` | `opaqueCover(c, d)`：面 `d` 上被 `c` 的不透明材质盖住的象限，4 位 | 不透明方块 15，其它 0 |
| `open(c, d)` | `lightOpen(c, n, d)` = `(oc(c, d) \| oc(n, d ^ 1)) !== 15`：两侧合起来没把这个面盖满。对称：`open(c, d) === open(n, d ^ 1)` | 两格都不是不透明方块 |
| `op(c)` | 介质的不透光度 `lightOpacity(c)`：各部件里 `LIGHT_OPACITY < 15` 的取最大；没有这样的部件时，`opaqueFill(c) === 0xff` 取 15，否则取 0 | `LIGHT_OPACITY[id]` |
| `emit(c)` | `lightEmit(c)`：各部件 `EMIT` 的最大值 | `EMIT[id]` |
| `emitInto(c, d)` | `n` 的发光部件隔着这个面直接照进 `c` 的光：对 `n` 的每个部件 `p`，如果 `faceCover(p 的占用, d ^ 1) & ~oc(c, d) !== 0`（`p` 贴着这个面，而且贴着的地方 `c` 没有用不透明材质挡住），取 `EMIT[p 的材质]`；这些值的最大值，没有则 0 | `c` 不是不透明方块时 `EMIT[n 的 id]`，否则 0 |

`OPAQUE[id] === 1` 和 `LIGHT_OPACITY[id] >= 15` 对现在的每个方块都同时成立；P1 在 `registerBlock` 里加断言把两者绑在一起，“不透明”从此只有一个意思。世界上方（`y > TOP_Y`）是一层虚拟的格子：覆盖为 0，天空光 15，不发光。

```
from(c, d) = open(c, d) ? level(n) : (方块光 ? emitInto(c, d) : 0)
take(c, d) = from(c, d) − cost(c)                                   // cost(c) = max(1, op(c))
             例外（天空光直着往下）：d = PY、op(c) === 0、open(c, PY) 时 take = level(n)，不衰减
block(c) = max(emit(c),   六个方向 take 的最大值)
sky(c)   = max(skySrc(c), 六个方向 take 的最大值)
```

- **面是通的**：邻居格子里的光（不管是它自己发的还是路过的）过来，衰减 `cost(c)`。
- **面被封死**：路过的光过不来。邻居**贴着这个面的发光部件**的光过得来（晶石灯是不透明的发光方块，光要能从它自己的面出来；切成半砖的晶石灯贴着哪个面，就从哪个面照出去），不贴这个面的不行。例：一格里下半是岩石半砖、上半是晶石灯半砖，镶在岩石地板里。它的底面被岩石盖满，`emitInto` 为 0，地板下面是暗的；四个侧面各被岩石和灯盖满，灯占着上面两个象限，侧面的邻居拿到 15 − 1 = 14。只看“这一格的 `emit`”的写法会让灯光穿过岩石半砖照亮地窖（原型上是 14），岩石半砖的底面还会被画成亮的。
- `op(c) >= 15` 只出现在几何上被不透明材质占满的格子：它的六个面都被自己封死，`emitInto(c, ·)` 也都是 0，所以自然“什么也收不到”，值就是 `emit(c)`，不需要单独的规则。
- 两格都是整格方块时，每一项都退化成 M1 的公式：封死当且仅当有一侧是不透明方块；`c` 不透明时 `take <= 0`；`n` 不透明时 M1 里 `level(n)` 本来就等于 `EMIT[n]`（方块光）或 0（天空光）。
- 例（场景 44）：
  - 下半砖铺的屋顶：屋顶那一格顶面是通的、`op = 0`，天空光直着落进来，值 15；它和下面一格之间被自己的底面盖满，光到此为止。
  - 上半砖铺的屋顶：屋顶那一格和上面一格之间被封死；它的下半是空的，光只能从侧面进来。**墙必须砌到屋顶这一层**，屋顶才是封闭的：上半砖搁在墙顶上时，墙顶和半砖底面之间有半格高的一圈空隙，光从那里进屋是对的（边上那一格是 14）。
  - 下半砖和上半砖交替：相邻两格之间的面被两侧各盖一半，封死。屋里是 0。
  - 竖着的半砖（如 `0x55`）上下两个面都只盖了一半：正上方、正下方的格子也是同一侧的半砖或空气时，光直着穿过去，“有缺口的地方透光”；上下两层错开半格（西半砖压在东半砖上）时，两层之间的面被盖满，封死。
- **已知的近似**：一格只有一个亮度。格子里没被不透明材质占的八分格如果被分成互不相连的两块（比如只凿掉对角的八分格 0 和 7），光仍然能从一块“走到”另一块，从这一格的对面出去。DESIGN 的规则是按面说的（“一个面被不透明材质完全盖住时挡光，否则透光”），这种情形按规则就是透光；要堵住它得按八分格存光照，不做。同样的原因：发光部件被同一格里的不透明材质和这一格的空八分格隔开时（例：西下四分之一是晶石灯 `0x11`，它上面和东边是岩石 `0x66`，东上四分之一空着），整格仍然是 `emit(c)`，光从这一格每个通的面出去，照亮岩石后面的邻居，尽管在半格网格上灯一个空八分格也碰不到。按八分格存光照之前不处理。半砖、楼梯、凿掉一个角这些常见形状不受影响（它们的空八分格是连通的，发光部件贴着它们）。
- **唯一性**：除了“天空光直着往下进入 `op = 0` 的格子”，每一步至少衰减 1，而不衰减的边只向下，所以任何环的代价都为正，不动点唯一。`emitInto` 不依赖任何格子的亮度，相当于光源。和现在的论证相同。

**天空光的来源和高度图**

- 直射的天空光到不到得了格子 `y`：`direct(TOP_Y + 1)` 为真（虚拟层）；`direct(y) = direct(y + 1) && op(y) === 0 && open(y, PY)`。它一旦为假，下面就都为假。
- `heightmap[列]` = 最高的 `direct(y)` 为假的 `y`，加 1（没有则 0）。等价的说法：从上往下第一个“`op(y) !== 0`，或者它和上面一格之间的面被封死”的格子，加 1。只有整格方块时，这就是现在的“最高的 `lightOpacity > 0` 的格子”。
- `skySrc(c)`：`y >= heightmap` 时为 15（这只是把 `take` 的直射规则提前算好，和公式一致）。否则，在世界最高一层（`y === TOP_Y`）按一般规则从虚拟层拿一步：`open(c, PY)` 时为 `15 − cost(c)`，封死时为 0。其余为 0。
- 下半砖屋顶：屋顶那一格 `direct` 为真，在高度图之上；它下面那一格是第一个 `direct` 为假的。西半砖压东半砖：上层那一格 `direct` 为真，下层那一格和它之间被封死，`direct` 为假。
- 一个格子的内容变了，会改变 `direct` 在这一格（它的 `op` 和顶面）和**下面一格**（它的底面）的取值，更新高度图时两处都要重算。

### 7.2 增量更新怎么改

不变的：桶队列、预算、区块登记、孤儿边界、从区块里读当前状态而不信事件参数。要改的是凡是“看邻居”的地方都换成 7.1 的 `from` / `take`，并且彼此严格一致：

| 位置 | 改动 |
|---|---|
| `pull`（652-701） | 逐个方向取 `take(c, d)`：面封死时用 `emitInto`（方块光）或 0（天空光），面通时用邻居的值；不衰减的向下规则要求 `open(c, PY)` |
| `supported`（710-740） | 和 `pull` 逐条对应（否则 SUPPORT 不变量会破）：邻居隔着通的面给得出 `level`，并且严格更亮。隔着封死的面由 `emitInto` 给的那一份算作这一格自己的来源（和 `emit` 一样不需要支撑） |
| `offer`（845-869）、`runAdd`（775-840） | 从格子 `r` 以值 `l` 往方向 `d` 的格子 `t` 发：面通时发 `l`；面封死时，方块光发 `emitInto(t, d ^ 1)`，天空光不发。然后照旧减 `cost(t)` |
| `runRemove`（886-959）、`unlight`（967-993） | 处理移除项 `(r, 旧值 o)` 时，**不看 `r` 和邻居之间的面现在通不通**（面可能是刚刚才被封上的，`r` 以前给出去的光要收回），对六个邻居都检查“`o` 可能支撑过它”。唯一可以跳过的是自己朝 `r` 的那个面 `oc === 15` 的邻居：它单靠自己就封死了这个面，它的内容变成这样的时候已经重新结算过。多移除总是安全的，会被补回来。末尾给 `r` 自己算回填值的那几行（944-951），在带层的区块里直接调 `pull` |
| `cellChanged`（548-602） | 见下 |
| `initChunk`（292-398）、`exchange`（404-461）、`orphanBorder`（510-536） | 直射、横向种子、跨区块交换都按 7.1；高度图按 `direct` |

`cellChanged(x, y, z, oldCell, newCell)`：

1. 用参数判断这次变化和光照有没有关系，没有就返回。“没有关系”是下面三种之一：
   - `oldCell === newCell`；
   - 两个值都 `< FULL_LIMIT`，并且两个 id 的 `LIGHT_OPACITY`、`EMIT` 都相同。这就是现在的提前返回（液位、朝向变化不花时间），一字不改；
   - `emit(old) === 0 && emit(new) === 0 && op(old) === op(new)`，并且六个面的不透明覆盖相同（`FACE_COVER[opaqueFill(old)] === FACE_COVER[opaqueFill(new)]`，一共 24 位）。带发光部件的格子只要内容变了就算有关系。
2. 从区块里读这一格现在的内容，更新高度图（这一格和下面一格两处的 `direct`；抬高时把失去直射的格子逐个重置并排进移除队列，降低时往下重扫，做法同现在），结算这一格（`settle`，目标是 `max(源, pull)`）。
3. 新增：新旧内容至少有一个 `>= FULL_LIMIT`（这次变化涉及部分格子）时，再对六个邻居各做一次同样的结算（目标是邻居自己的 `max(源, pull)`）。原因：在过面的模型里，一个面被封上、或者一个发光部件不再贴着某个面之后，这一格自己的亮度可以不变，但对面的邻居已经拿不到原来的光了；只结算这一格发现不了。

新旧都是整格方块的编辑不做第 3 步，开销和现在一样，而且仍然正确：不透明方块放下时这一格自己被重置，移除队列从它出发（不看面通不通）会查到所有邻居；放下的是发光的不透明方块时，邻居从它拿到的 `emitInto` 不低于原来拿到的值；面被打开时这一格被抬高，扩散会经过新打开的面。这一格的邻居里有部分格子时也一样：邻居的覆盖没变，变的只有这一格的亮度和它“是不是不透明”，两者都由这一格的重置或抬高带出去。

### 7.3 没有部分方块的区块，开销不变

- 引擎读格子时以“这个区块有没有另外两层”分流（`chunk.holes === null && chunk.part2 === null`；层分配之后不释放，见第 4.1 节，全为 0 的层走带层的路径，结果相同）。没有时走现在的代码：`op = LIGHT_OPACITY[id]`，面封死当且仅当有一侧 `op >= 15`，`pull` 不读邻居的格子（不透明邻居的值本来就等于它的 `emit`，和 `from` 一致）。跨区块边界的邻居按邻居所在区块分流：只要两格里有一格在带层的区块里，这个面就按 7.1 的一般规则算。
- 有另外两层的区块里，每格多读一到两个数组，`pull` 要读邻居的内容。需要的表（每种占用掩码六个面的覆盖，即 `FACE_COVER`）照 engine.ts:91-93 的做法绑成模块常量。
- 预算见第 15 节：现有四个数不变，新增“半砖屋顶上开关一个缺口”的编辑用例。

### 7.4 对照实现

`tests/light/reference.ts` 重写成 7.1 的直接实现：反复对所有格子套用 `block(c)`、`sky(c)` 的公式直到不再变化，`op`、`emit`、`open`、`emitInto` 用第 3.2 节的值上的查询算出，高度图按 `direct` 的递推重算。它必须照本节的文字写，不能照引擎的代码写。随机比较（`engine.test.ts:560 randomEdit`、`tests/light/terrain.ts`）加入部分格子：六种方向的半砖、楼梯、任意掩码、不透明加透明的双部件格子、晶石灯半砖、晶石灯加岩石的双部件格子。只有整格方块的场景，新旧两种对照实现给出相同的值。

对照实现和引擎出自同一段文字，同一个误解会让两边一起错（“只看自己一侧”就是这样漏过去的）。所以 P5 另写一个**不依赖 7.1 的检查**：在半格网格上，从“露天”的八分格出发，经过没被不透明材质占的八分格做泛洪（面相邻），泛洪到不了的格子天空光必须是 0。“露天”指所在的列里它上方没有任何被不透明材质占的八分格。这个检查只对“每一格里没被不透明材质占的八分格在格内连通”的场景成立（7.1 的已知近似），随机场景按这个条件生成：半砖、楼梯、缺一个或两个相邻八分格的方块。

## 8. 网格化与叠加层

### 8.1 输入

```ts
// src/mesh/types.ts（P2 加字段，P4 用）
export interface MeshInput {
  sx: number; sy: number; sz: number;
  cells: Uint16Array;            // 带 1 格边距的基础层，和现在一样
  holes: Uint8Array | null;      // 同样的布局；null = 这个盒子里没有缺口
  part2: Uint32Array | null;     // 同样的布局；null = 这个盒子里没有双部件格子
  light: Uint8Array | null;
}
```

- `snapshotSection`、`snapshotStructure`（P2）只在源头有这一层、并且拷出来的盒子里确实有非零项时才分配，否则给 `null`。地形的任务因此和现在逐字节相同，Worker 协议不变；非 `null` 的层加进转交列表。
- `checkInput` 校验三层的长度。P2 合并后、P4 合并前，网格化器忽略另外两层（第 16.3 节）。
- `client/meshing.ts isTriviallyEmpty`（53-63，P4）：“全是不透明 id 就不用网格化”的捷径加一个条件：`holes === null && part2 === null`。否则埋在石头里的一个凿出来的洞永远画不出来。

### 8.2 发哪些面

网格化器对每个任务先看 `holes === null && part2 === null`：是，就完全是现在的代码。否则先建两张按带边距的格子索引的草稿表（放在 `MeshContext` 上，跨任务复用）：`opq`（`opaqueFill`，8 位）和 `partial`（这一格有缺口或第二部件，即格子值 `>= FULL_LIMIT`）。

**走哪条路径按面决定，不按格子。** 立方体类格子 X 的面 `d`，“前面那一层的 9 格”指 `X + d` 和它在这一层里的 8 个邻居，也就是 M1 给这个面的四个角取遮蔽和光照时看的那 9 格。

- X 和这 9 格都不是 `partial`：这个面照现在的 `emitCube` 发一个四边形，**字节和 M1 相同**。
- 否则这个面走**八分格路径**（下面）。部分格子和双部件格子自己的面总是走八分格路径。
- 模型方块（火把、花草、雪层、仙人掌、舵轮、螺旋桨、轴承）仍走各自的发射器。

不按“这一格或它的 26 个邻居里有部分格子”来分：那样放下一块半砖，周围 3×3×3 里所有整格方块的每个面都换了取样方式（墙脚的接触阴影变窄），远超过真正挨着半砖的那几个面。

八分格路径按**八分格的面**发：

- 对格子里每个部件 P、它占的每个八分格 `o`、每个方向 `d`，这个四分之一面是否画，看它对面紧挨着的八分格 A（同一格里的或邻格里的）：
  1. A 被不透明材质占着 → 不画；
  2. A 被和 P 同一个 id 的材质占着，而这个 id 是“自己挡自己”的非不透明立方体（玻璃、冰、树叶，`INFO_SELF_CULL`）→ 不画；
  3. A 所在的邻格是模型方块，并且它的 `INFO` 说它完全盖住这个面（现在的规则，例如满 8 层的雪）→ 不画；
  4. 否则画。
- 同一格两个部件之间的面也按这四条：两个不透明的部件贴在一起的面都不画；玻璃半砖贴着石头半砖，玻璃那一面不画、石头那一面画。
- **每个要画的四分之一面单独发一个 0.5 × 0.5 的四边形**，不合并。合并成更大的矩形要另定一套规则；这里只在挨着部分方块的面上多出面数，换来规则简单、可以逐象限对拍。以后要省面数再做（M4）。
- 面的位置：八分格的面在半格网格上，格面在格子边界，内面在 0.5 处。
- **要写一个新的发射函数**（例如 `quarterFace`）和一个按八分格取样的顶点函数。现有的 `boxFace` 不能原样用：它调的 `sampleVertex`（`builder.ts:217-262`）按格子的 id 取样，而且对落在格子内部的角把步长取成 0（332 行）。`boxFace` 和 `sampleVertex` 本身不改，模型方块还在用。
- 贴图：和 `boxFace` 一样由顶点位置得出，切出来的面显示的是整张贴图上对应的那一块，不需要新贴图；原木的贴图旋转照旧作用在每个面上。面朝哪个方向就用材质在那个方向的贴图（顶、侧、底），内面也一样。草皮的下半砖侧面因此是泥土色的下半张图。
- 绘制分组（不透明、镂空、半透明）按部件的材质。
- 模型方块自己的形状不变；它们判断“邻居是否盖住我贴着格子边界的面”时，把查 `INFO[邻居 id]` 换成“邻居朝我的面 `opaqueCover === 15`，或邻居是模型且 `INFO` 说盖住”。

对照测试（`tests/mesh/cube.test.ts` 的随机对拍）改成：对随机的占用掩码和双部件格子，暴力算出每个四分之一面该不该画，和网格里的四边形逐个对上。另加一条：前面那一层 9 格和自己都不是部分格子的面，输出和 M1 逐字节相同（场景里别处可以有部分格子）。

### 8.3 环境光遮蔽和平滑光照

对八分格路径发出的每个四分之一面：它属于八分格 H，朝向 `d`，前面的八分格是 F = H + d（半格网格上走一步）。它的每个顶点沿面内两个轴各有一个朝外的符号 `su, sv`。

**八分格公式** `O(V)`：

- 遮蔽取 F 所在半层里的三个八分格：`side1 = F + su·û`，`side2 = F + sv·v̂`，`corner = F + su·û + sv·v̂`。八分格“是遮挡物”= 它被不透明材质占着（查 `opq`）。级别照旧：两个 side 都是遮挡物为 0，否则 `3 − (side1 + side2 + corner)`。字节仍是线性的 `级别 × 85`，曲线只在渲染器里套一次。
- 光照取 F、side1、side2、corner 这四个八分格所在格子的光照值的平均；是遮挡物的八分格不计；两个 side 都是遮挡物时 corner 也不计；一个都不剩时取 F 所在格子的值。同一格里的几个八分格各算一份。

**每个顶点用哪个值**。顶点在面内的两个坐标都是 0.5 的倍数，按它相对格子的位置分三类：格角（两个坐标都是整数）、棱中点（恰好一个是整数）、面心（都不是整数）。

- 格角：`O(V)`。四周的格子都不是部分格子时，它取到的四个八分格分属四个格子，就是 M1 的按格取样，数值相同。
- 棱中点和面心：`O(V)` 取样的四个八分格所在的格子里**有部分格子或双部件格子**时，用 `O(V)`；**都没有**时，取这条棱两端的格角（面心取这个格面的四个格角）的值的平均，遮蔽字节和两个光照字节各自平均，四舍五入（`(a + b + 1) >> 1`，`(a + b + c + e + 2) >> 2`）。内面上的顶点取样的格子里总有这个部分格子自己，所以内面一律用 `O(V)`。

为什么不一律用 `O(V)`：整格方块的面被拆成四块之后，棱中点上的 `O(V)` 只看得到半格以内的遮挡物，而旁边没拆的面在同一点上显示的是两个角的线性插值。例：地板旁边立着一堵墙，地板面靠墙的两个角遮蔽是 1、另外两个角是 3，没拆的面在棱中点处是 2（字节 170）；`O(V)` 在那里取到的八分格都是空的，给出 3（字节 255）。两块共面的地板一块拆了、一块没拆，公共棱上就差出一道台阶，墙脚的阴影也在拆开的那块上窄了一半。按上面的规则，一个顶点的取值只在它真正挨着部分方块时才变：拆开的面和没拆的共面邻居在公共棱上处处相等（格角相同；中点一边是平均值，一边是插值，只差四舍五入），拆开的两个面之间也相等（公共棱上的顶点取样的是同样的格子）。

- 对角线的翻转规则不变（先比遮蔽再比光），对每个四分之一面单独判断。
- 结构体（`light: null`）照旧只算遮蔽。
- **T 形接缝**：拆开的面在棱中点多一个顶点，旁边没拆的面在这条棱上只有两个端点。中点的坐标是半整数，在模型空间里正好落在那条棱上，颜色按上一条也相同，但光栅化之后仍可能偶尔露出单个像素。P4 在浏览器里对着“墙脚 + 地板 + 旁边一块半砖”的场景，从几个距离和角度截图检查（WebGL2 和 WebGPU 各一遍）。看得到亮点时的修法是把这个中点也插进没拆的那个面（它改成带一个额外顶点的扇形三角化，取样方式不变），不是扩大八分格路径的范围；看不到就不做，记进报告。

### 8.4 液体

DESIGN：液体不流进有部件的格子，所以有部件的格子永远不是液体格。液体的顶面高度、角的平均、波动标记都不变。变的是液体贴着部分格子的那些面（`src/mesh/shapes/liquid.ts`）。

液体的每个边界面有两份：朝外的一份，和从液体里面往外看的一份。现在它们各有一条规则，都是按整个面判断的：朝外的一份在邻居不透明时不画；里面的一份在邻居“封住”这个平面时不画，即邻居自己在这个平面上画了一个面（`tables.SEALS_LIQUID`：任何立方体都算，玻璃、冰、树叶也算；`liquid.ts:88-93` 的 `sealsFace`），两个共面的面会闪。两条规则都改成按象限，各用一张 4 位的掩码，`n` 是邻居的整格内容，`d'` 是邻居朝液体的那个面：

| 掩码 | 定义 | 邻居是整格方块时 |
|---|---|---|
| `opaqueCover(n, d')` | 第 3.2 节 | 不透明方块 15，其它 0 |
| `sealCover(n, d')` | 邻居有缺口或第二部件时：`faceCover(两个部件占用的并, d')`（能切的材质都是立方体，在自己贴着格面的地方都画面）；否则是现在的 `sealsFace`：封住为 15，不封为 0 | 和现在相同 |

`sealCover` 写在 `mesh/shapes/` 里（它要用网格化的表），不进 `blocks/shapes.ts`。`opaqueCover` 的象限一定也在 `sealCover` 里。

- 侧面：邻居是同种液体不画。否则朝外的一份只画 `opaqueCover` 没盖住的象限，里面的一份只画 `sealCover` 没盖住的象限。所以每个象限是三种情形之一：两份都画（邻居在这里是空的），只画朝外的一份（邻居在这里是玻璃、冰、树叶的部件：从外面隔着它看得见水面，从水里看到的是它自己的面），都不画（不透明的部件）。例：水旁边是玻璃下半砖，下面两个象限只有朝外的一份，上面两个象限两份都有。
- 裁剪的做法：侧面是“底边到两个角的高度连线”下面的梯形。左右两半（`u < 0.5`、`u > 0.5`）要留的象限相同时（旁边是下半砖或上半砖：只留下面两个或只留上面两个象限），整个梯形只和 `y = 0.5` 求交一次，顶边上只有原来的两个角（加上顶边本身穿过 `y = 0.5` 的那个交点）；两半要留的象限不同时，先在水平中点处分成左右两半（中点的高度线性插值），每一半再和 `y = 0.5` 这条线求交，留下要画的象限里的部分。顶边上原有的顶点（位置、高度、光、波动标记）一个都不许动，新顶点只出现在 `u = 0.5` 或 `y = 0.5` 上，属性线性插值。
- 底面、以及四个角都满高（1.0）时的顶面：是平的，直接按象限裁，两份各用各的掩码。顶面不满高时不和上面的格子共面，整个画。
- `occludes` / `raiseFromLayerAbove`（95-154）里的“遮挡物”改成“八个八分格都不透明的格子”（`opq === 0xff`）。
- 水贴着下半砖时，半砖上方那半格是空气：这是规则的结果，不是网格化的问题。

### 8.5 结构体的网格

同一个网格化器，`light: null`。`client/structures.ts` 的同步网格化阈值（24³）不变；P4 的性能测试要包含一条半砖木筏。P4 的审查发现这个阈值数的是格子：满是半砖的结构体在同样的格子数下四边形是整格的 2～3 倍（22³ 的下半砖棋盘 8.5 万个四边形、主线程 22 ms，最密的整格结构体 3.2 万个、6.7 ms）。快照里有缺口层或第二部件层的结构体改成超过 12³ 就交给网格 Worker，由 P10 做。

### 8.6 叠加层

`render/backend.ts`、`render/three/overlays.ts`、`boxgeom.ts`、`client/view.ts`（P8b）。

```ts
// src/render/backend.ts
export interface OverlayCell { structureId: number; x: number; y: number; z: number;
  /** 要画的八分格。目标框：被瞄准的部件的占用；预览、冲突：这一格硬部件的并；模型方块和整格方块 0xff。 */
  fill: number; }
export interface OverlayFace extends OverlayCell { face: Dir; covered: boolean; /* 现有字段不变 */
  /** 胶所在的象限，4 位（第 2.3 节的编号）。 */
  quads: number; }
export interface OverlayState { /* 现有字段不变 */
  /** 凿子在主手时高亮的八分格（M2.4）；没有则 -1。 */
  targetOctant: number;
  /** 半透明的放置预览（M2.4）；没有则 null。 */
  placement: { structureId: number; x: number; y: number; z: number; fill: number; item: number } | null; }
```

- **目标框**：被瞄准的部件的轮廓，`fill = ~partHoles(hit.part) & 0xff`；软方块和模型方块仍是整格的框。轮廓按占用掩码生成并缓存（256 种，纯函数放 `boxgeom.ts`）：对半格网格上每条长 0.5 的棱，看围着它的 4 个八分格里被占的个数，1 个、3 个、或者 2 个且成对角时画这条棱；0 个、4 个、或者 2 个相邻（共面）时不画。格子外面的八分格算空。整体向外胀 0.004，和现在一样。
- **裂纹**：包住一个占用掩码的外表面（对面的八分格不在这个掩码里的那些四分之一面），向外偏 0.003，贴图坐标由位置得出，按掩码缓存。掩码通常是被挖的那个部件的占用；私有状态的 `mining.sub` 位 3 为 1 时是单个八分格 `1 << 八分格`（第 6.3 节，M2.4 的凿子）。显示条件见第 6.3 节。
- **组装预览和停靠冲突**：仍然以格为单位（格子的列表不变），每格画它的 `BOXES[fill]`（至多 4 个盒子）而不是单位立方体。实例层的每个实例带盒子的最小角和尺寸；`fill` 要并进 `cellsHash`，否则只变形状不会重新上传。
- **胶**：`collectGlueFaces`（`client/view.ts:656-689`）对每个有胶的面（A 在负侧、B 在正侧，方向 `d` 从 A 指向 B）取两侧的硬覆盖 `a = solidCover(A, d)`、`b = solidCover(B, d ^ 1)`，产出**至多三项**，`quads` 为 0 的不产出：
  - 被盖住的部分：`{ A, face: d, covered: true, quads: a & b }`。只在玩家拿着强力胶、且在 8 格内时显示（现在的规则）。
  - A 这一侧露出的部分：`{ A, face: d, covered: false, quads: a & ~b }`，贴花在 A 的面上，用 B 那一格的光。
  - B 这一侧露出的部分：`{ B, face: d ^ 1, covered: false, quads: b & ~a }`，用 A 那一格的光。
  - `a` 和 `b` 都为 0（胶留在未加载区块旁边）时照现在画在 A 的正面上，`quads = 15`。
  
  所以整格方块的胶面被一块下半砖盖住一半时，盖住的下半只在拿着胶时看得见，露出的上半始终看得见（DESIGN“露出的胶面始终看得见”；潜行右键去胶点的就是这露出的一半）。两格都是整格方块时只有一项，和现在相同。贴花、胶条和透视的幽灵面都只画在 `quads` 的象限上（按 16 种掩码缓存几何；胶条沿这些象限合起来的外轮廓走）。
- 每帧不许为这些几何分配内存（`tests/render/players-alloc.test.ts` 的预算不变）。
- 第三人称相机（`client/camera.ts:456-560`，`view.ts blocksCamera`）：射线走 6.1；`clearanceAt` 和 `sweepCube` 对部分格子逐个测 `BOXES[会挡相机的八分格]`，整格仍是单位立方体。“会挡相机”= 硬材质或不透明材质的八分格。
- `sampleLight`（`view.ts:134-142`）：只有 `opaqueFill === 0xff` 的格子才往上挪一格取光。

## 9. 液体、方块更新、支撑、爆炸、下落方块、兔子、掉落物

DESIGN 的每条规则对应的判断式。除注明的以外归 P6。

### 9.1 液体

规则：液体不流进有部件的格子。`src/liquid/fluids.ts` 的逻辑**不改**：`canFlowInto`、`isPassable`、`isHole`、`holdsSource`、无限水源的“下方是实心”都是 `IS_SOLID[基础层的 id]`，而有部件的格子基础层必是硬材质（I7），所以部分格子对液体就是一堵墙、一块地板。

- 液体直接读基础层（`scanColumns`、`slopeDirections`、`peek`），保留，在读取处注明“有意不看缺口”。
- P6 要写的是保护：一个性质测试，随机地放、凿、挖之后检查 I7（“有缺口或第二部件的格子，基础层的 id 是硬的”）；场景 46；“最后一个部件被去掉之后水流进来”；“只凿不挖（硬 → 硬）不唤醒坡度搜索”（`slopeChange` 返回 0，本来就对）。
- 把部件放进液体格：整格的液体被换掉（和现在放任何硬方块一样），空着的那一半是干的。往有部件的格子里倒水倒不进去。水贴着下半砖时停在半砖所在格子的上面一格或旁边一格，离半砖表面有半格空气。无限水源把下方的部分格子当实心。

### 9.2 支撑

```ts
// src/sim/support.ts（P6，新文件）；below 是下方格子的整格内容
export function supportOk(def: BlockDef, below: number): boolean;
```

| `def.support` | 判断 |
|---|---|
| `'none'` | 真 |
| `'solid'`（火把、花、草丛、雪层） | `topCovered(below)`：下方格子的顶面被硬材质完全盖住。下半砖上不行，上半砖和整格上行；两块拼起来盖满顶面的也行 |
| `'sandOrSelf'`（仙人掌） | 不变：下方是沙或仙人掌（都不能切） |

- 方块更新（`sim/blockupdates.ts`）和放置（`sim/interact.ts`，P8b）都调它，取代两处各自的 `supportedBy` / `supportOk`。
- 舵轮：放置时要求 `topCovered(下方)`（P8b 在 `place` 里检查，不满足时用现有的提示 `toast.place.support`）。放下之后下方被凿，舵轮不掉落，只是不再粘在下面那一格上（第 10.2 节的安装面规则）。是否让它掉落见第 17 节问题 3。
- 世界的钩子不变（任何内容变化都把这一格和 6 个邻居排进队列）。结构体的钩子 `onStructureChange`（104-108）现在是“id 没变就返回”，改成“内容没变才返回”：凿掉甲板上火把下面的木板，火把要重新检查。
- 失去支撑的方块都是整格的模型方块，仍然是整格变成空气、掉落一份。

### 9.3 重力方块

- “沙子可以停在任何硬部件上”：`evaluateWorld`（175）和 `scheduledTick`（115）的“下方 `SOLID[id]`”不改，按 I7 它对部分格子成立。P6 加下方是下半砖、上半砖、单个八分格的测试。
- 落地见第 5.9 节（P3）：两处用的是同一个判断（下方格子的 id 是硬的；目标格可替换），所以沙子不会落进一个它马上又要掉下去的位置。
- 沙、砾石不能切，下落方块实体带的永远是整格方块的值。

### 9.4 爆炸

规则：爆炸按部件破坏。`sim/explosion.ts`：

- **射线的代价**（`cellCost`、`markCells`）：每一步的采样点落在哪个八分格，就付那个八分格所属部件材质的 `blastResistance`（空的八分格付 0），各网格相加，再加每步固定的 0.3，和现在一样。整格方块的代价不变。
- **标记**：每个网格一张 `Map<格子键, 八分格掩码>`，按第一次标到这一格的先后排列（就是现在按格子标记的顺序）；采样点所在的八分格有部件、且该部件的材质可以被炸掉（`destructible`），就把这个八分格记进掩码。
- **移除**（`destroy`、`removeCell`）：顺序不变，先世界、再按创建顺序的结构体，每个网格里按标记的先后。对一格：读它现在的内容，按第一部件、第二部件的顺序，凡是占用和掩码有交集的部件都去掉，结果一次写回。每去掉一个部件，按现在的规则决定掉落（世界的掉落开着时以 `1 / power` 的概率掉一份，随机数每个部件取一次）；爆破箱不能切，照旧整格变成点燃的箱子。
- 只有整格方块时，标记的顺序、随机数的次数和先后都和现在相同（`tests/sim/explosion.test.ts:20` 的弹坑不变），唯一的例外是船的干舱里立着的软的整格方块（火把、花草、雪层）：旧代码只在船的空格子里问干舱，这种格子里重新灌进来的世界的水挡住射线；按第 19.8 节不管船的这一格里有什么都问干舱，射线穿过去，这些方块会被炸掉（和水桶的射线一致，`tests/sim/explosion-hold.test.ts`）。
- **推船**（`pushShips`）：每格的冲量乘上 `volume8 / 8`。
- **视线**（`exposure`、`blocksSight`）：走 6.1 的射线，谓词按部件（硬材质）；P8a 合并之前按整格算。
- “世界里的液体被船体挡住不付代价”的判断留在 `sim/explosion.ts` 自己的那段代码里（现在的 185-200 行），由 P6 改成按点：点在船的硬八分格里（`solidAtHalf`），或在干的空腔里（`isDryHalf`）；两者的参数都是点在船的局部坐标乘 2 再取整，两个函数都由 P2 交付。P6 不调用 `sim/rays.ts` 的 `displacedByHull`（它收的是 `RayShip[]`，归 P8a），所以不依赖 P8a；两处的判断条件相同。

### 9.5 掉落物

```ts
// src/sim/drops.ts：参数从格子改为部件值
export function dropItemOf(part: number): number;
export function dropCountOf(part: number): number;
export function spawnBlockDrop(sim: Simulation, grid: VoxelGrid, x: number, y: number, z: number, part: number, tmp?: Vec3): boolean;
```

一个部件一份掉落，数量和种类按材质的 `drop`，和它剩多少个八分格无关。凿掉的八分格不掉落。

- **位置**：格子的最小角加上 `DROP_POINT[部件的占用]`（第 2.1 节）：整格方块是格子中心，和现在一样；带缺口的部件是它编号最小的那个八分格的中心。这个点是物品的中心（`spawnItem` 一直把物品竖直方向的中心放在给它的点上，脚比它低 0.125；整格方块的掉落因此和 M1 逐位相同）。凡是“一个部件变成掉落物”的地方都用它，一共三处，各有自己的生成调用，规则相同：这里的 `spawnBlockDrop`（挖掘、方块更新、爆炸，P6）、`structures/assembly.ts:65-77`（`dropOf` 和 `spawnCellDrop`：落回方块时冲突的格子，每个部件一份，P7）、`structures/physics/dynamics.ts destroyPinnedCell`（夹毁，838-852 行自己查 `drop`，P9）。落回方块冲突时那个位置可能在目标格原有的方块里，和现在整格冲突时一样，由实体的脱困规则挪到最近的空位。
- 三个函数的签名不变，参数的含义从格子改为部件值，并且**只读 id 位**：传进来的值带着缺口、带着第 24 位、甚至是整格内容都不抛错（1.2）。`spawnBlockDrop` 取位置时需要占用，按 `~partHoles(part) & 0xff` 取（对整格内容，位运算读到的是第一部件的缺口）。

### 9.6 兔子

`sim/rabbits.ts turfTop`（107-121）：柱顶那一格必须正好等于 `makeCell(B.TURF)`（完整的、单独的草皮），上面两格的条件不变（不是硬材质、不是液体；部分格子是硬的）。兔子在半砖上的移动由第 5 节负责。

### 9.7 其它

- 雪层叠满 8 层变成积雪方块（整格），不变。
- 花草、火把、雪层不能放进有部件的格子（目标格必须可替换）；有部件的格子也不会被它们“取代”。
- 桶的射线、船体排开的水，见第 6.2 节和第 12 节。

## 10. 粘连与胶

`src/structures/stick.ts`、`manager.ts`（P7）。规则：粘连和强力胶以格为单位，同一格里的部件永远是一个整体；两格只有在共享的面上都有材质时才粘连、才能涂胶；之后那个面不再接触时，胶消失。

### 10.1 “接触”的定义

两格 `a`、`b`（`b` 在 `a` 的 `d` 方向）**接触**，当且仅当两侧盖住的象限有重叠：

```
cellsTouch(a, b, d) = (solidCover(a, d) & solidCover(b, d ^ 1)) !== 0
```

- 选“象限重叠”而不是“两侧各自有材质就算”：两者的差别在只沿一条线相碰的情形，比如并排的下半砖和上半砖。它们没有共同的面积，不该粘住；“面不再接触时胶消失”说的也是这个意思。这也是网格化剔面用的同一张表。DESIGN 的原话是“在共享的面上都有材质”，按字面读，并排的下半砖和上半砖是算的；这里把它收窄了，是一条玩家看得见的规则，列在第 17 节问题 9。
- 场景 42：下面那格的上半砖盖住了自己的顶面，上面那格的上半砖没有碰到自己的底面，不接触，不相连。
- 不能切的硬方块（舵轮、轴承、螺旋桨、仙人掌、沙、爆破箱）按整格算，六个面都算有材质，和 M1 一样。
- 一格里有两个部件时，这一格的覆盖是两个部件的并：格子是一个整体。

### 10.2 谓词

函数名和参数个数都不变；**参数换成整格内容**（`getPacked`，或 `forEachCell`、填充队列里存的值）。两边都 `< FULL_LIMIT` 时走现在的代码。

```ts
export function autoSticks(a: number, b: number, dirAtoB: Dir): boolean;
export function mountSticks(a: number, b: number, dirAtoB: Dir): boolean;
export function sticksWithoutGlue(a: number, b: number, dirAtoB: Dir): boolean;
export function connectedCells(a: number, b: number, dirAtoB: Dir, glue: GlueStore, x: number, y: number, z: number): boolean;
export function connected(grid: VoxelGrid, glue: GlueStore, x: number, y: number, z: number, dir: Dir): boolean;
export function canGlue(c: number): boolean;      // 不变：按第一部件的 id（有部件的格子两个部件都是可涂胶的材质）
export function holdsGlue(c: number): boolean;    // 不变：可涂胶的格子，或未加载的哨兵
export function glueSideAt(c: number, dir: Dir): boolean;                                     // 新：这一格“在这个面上”= holdsGlue(c) && solidCover(c, dir) !== 0
export function glueFaceKept(a: number, b: number, dirAtoB: Dir): boolean;                    // 新：胶的存留规则（只看现状）
/** 钩子用：格子 (x, y, z) 的内容刚从 oldPacked 变成网格里现在的值，清理它六个面上的胶；返回去掉的面数。新内容自己从网格读。 */
export function pruneGlueAt(grid: VoxelGrid, glue: GlueStore, x: number, y: number, z: number, oldPacked: number): number;
export function sailVolume8(c: number): number;   // 新：帆材质占的八分格数（取代 isSailCell 的用处）
```

| 谓词 | 定义 |
|---|---|
| `autoSticks(a, b, d)` | 存在 `a` 的部件 `pa` 和 `b` 的部件 `pb`：`faceCover(pa 的占用, d) & faceCover(pb 的占用, d ^ 1) !== 0`，并且按现在的材质规则（同组；原木还要同 id、同轴、面在轴上）`pa` 粘 `pb`。即：真正碰在一起的两块材质决定粘不粘 |
| `mountSticks(a, b, d)` | `a` 是带安装面的方块、`d` 是它的安装方向（现在的规则），并且 `b` 朝它的那个面被硬材质**完全盖住**：`solidCover(b, d ^ 1) === 15`。舵轮、火把粘下方，轴承、螺旋桨粘背面，都要一整面 |
| `connectedCells` | 两格都能进结构体，并且：自动粘连，或任一方向的安装面，或（面上有胶、两格都 `canGlue`、并且 `cellsTouch`） |
| `glueSideAt(c, d)` | `holdsGlue(c) && solidCover(c, d) !== 0`：这一格是可涂胶的，而且在面 `d` 上有材质。未加载的哨兵按整格算（真） |
| `glueFaceKept(a, b, d)` | `glueSideAt(a, d) \|\| glueSideAt(b, d ^ 1)`：只要有一侧还在这个面上，胶就留着。在这个面上没有材质的格子（比如只在远离这个面的那半边有一块半砖），对这个面来说和空气一样 |

**胶什么时候消失**，两条：

1. **现状**：`glueFaceKept` 为假，即两侧都不在这个面上了。只有整格方块时这就是现在的规则（“只要面的任一侧还有可涂胶的方块，胶就留着”）。`pruneGlueInBox`（区块加载时）、`settlePlacedGlue` 只用这一条。
2. **失去接触**（只在变更钩子里判断）：格子 X 的内容从 `old` 变成 `new`，它某个有胶的面对面是 N。如果 `cellsTouch(old, N, d)` 为真、`cellsTouch(new, N, d)` 为假、并且 `holdsGlue(new)`（X 还是一个可涂胶的格子，只是不再碰到 N 了），这个面上的胶去掉。这是 DESIGN“之后那个面不再接触时，胶消失”和场景 42；X 整个没了（`new` 是空气）不属于这一条，按第 1 条胶留在 N 的面上，这是场景 27。

`pruneGlueAt(grid, glue, x, y, z, oldPacked)` 就是对这一格的六个面依次用这两条。`oldPacked` 取监听器的 `oldCell` 参数；它只用于第 2 条，万一过时（别的监听器先改了这一格），最坏是这一次不按第 2 条去胶。

这两条合起来的效果：

| 情形 | 结果 |
|---|---|
| 两块整格方块用胶粘着，挖掉一块 | 胶留在另一块露出的面上（场景 27）；两块都挖掉才消失 |
| 两块用胶粘着，把其中一块贴着胶面的材质凿光（它别的部分还在）；或者一格里两个部件，挖掉贴着胶面的那个 | 胶消失（场景 42） |
| 胶涂在露出的面上，对面那一格后来放进一个**不碰这个面**的部件（远侧的半砖、上方格子里的上半砖） | 胶留着：没有接触可失去，涂胶的那一侧还在面上 |
| 接着再放一个碰到胶面的部件 | 两格相连（`connectedCells`）；之后把它凿开，按第 2 条胶消失 |
| 并排的下半砖和上半砖，在其中一块的侧面涂胶 | 可以涂，胶留着但不起连接作用（两块不接触）；之后有部件贴上来才连上 |

第二行和第一行的差别（那一格还在就消失，整个没了就留下）来自 DESIGN 和两个场景的字面，是否要统一成“都留下”见第 17 节问题 11；统一的话只是去掉第 2 条。

**钩子**（`manager.ts:541-544`、`577-590`）：现在是“id 变了才 `pruneGlueAt`”，改成“内容变了就调”，并把旧内容传进去。空的胶存储仍然只花一次大小检查，这一格没有胶面时是六次查找。转子钩子里的帆数改成 `rotor.sails += (sailVolume8(新) − sailVolume8(旧)) / 8`。

### 10.3 涂胶和副手胶（`sim/interact.ts`，P8b）

- **涂胶**的条件，在现有的之外加两条。第一，点的是格面（第 6.2 节）。第二，被点的格子没有和面另一侧的格子接触：`holdsGlue(另一侧) && cellsTouch(被点的格子, 另一侧, 面)` 为真时拒绝，提示“两块已经挨着”（新消息键 `toast.glue.touching`）。M1 里盖住的面本来就点不到；有了部分形状，整格方块朝半砖的那个面露着一半，点得到，所以要显式拒绝，“已经挨着的两块不能直接粘”这条规则才保持成立（场景 26）。另一侧只在别处有部件、不碰这个面时不拒绝：被点的面是完全露着的。
- **去胶**（潜行右键）：点的是格面、面上有胶即可。
- **副手胶**（`offhandGlue`）：在现有条件之外要求 `cellsTouch(被点的格子, 放下的格子, 面)`。贴着下半砖的顶面（内面）放的整块方块和半砖不接触，不涂、不消耗。
- 同一格里的两个部件之间没有胶，也不需要：它们永远是一体。

## 11. 组装、方块化、停靠、旋转

`src/structures/collect.ts`、`assembly.ts`、`orient.ts`、`manager.ts`、`rotor.ts`、`serialize.ts`（P7；其中“不丢数据”的部分 P2 已经做完，见第 4.5 节）。

### 11.1 收集

- 填充的顺序、上限、失败原因都不变。队列里存的是整格内容，边的判断是 10.2 的 `connectedCells`；两边都是整格方块时走现在的路径，4000 格的预算（`tests/structures/collect.test.ts:514`）不变。
- 一格是一个整体：收集到一格，就带走它的全部部件。
- **轴心要碰到轴承的正面**。转子从轴承正前方那一格（轴心）起算，现在只要求轴心“能进结构体、不是功能方块”（`collect.ts:435-437`）。有了部分形状，轴心那一格可以只在远离轴承的半边有材质，转子就会隔着半格空气转。轴心是有部件的格子时加一个条件：`cellsTouch(轴承, 轴心, 轴承的朝向)`，不满足时返回现有的失败原因 `'no_hub'`。整格方块的轴心按 M1：硬的总是接触；软的（火把、花草、雪层）仍然是轴心，帆不够时返回 `not_enough_sails`。轴承不能切，它的正面是盖满的，所以这等于“轴心朝轴承的那个面上有硬材质”。转子转着的时候不能编辑，轴心不会在运转中被凿开。
- **上限按格数**：船 4000 格、转子 400 格数的是非空格子（`grid.count`，双部件格子算一格）；包围盒上限不变。往已有部件的格子里再放一个部件不增加格数，不触发“结构体满了”的检查。
- **帆数按体积**：`CollectResult.sails`、`Rotor.sails`、`Ship.sails` 的单位仍是“帆”，值是 `Σ sailVolume8 / 8`，可以是 1/8 的倍数。转子至少要 4 帆：8 块绒布半砖算 4。只有整格方块时仍是整数，现有断言不用改。`rotorTargetSpeed`、`topSpeedFor` 本来就接受小数。

### 11.2 进入结构体

`transferCells` 逐格 `copyCell`（三层一起），再清空源格。胶的搬移：只有一端被搬走的胶面，留在原地的那一端“在这个面上”（`glueSideAt`）时胶留在源网格；否则这是被搬走那一格露出的面，胶跟着它走，和对面是空气一样（`assembly.ts takeOffFaceGlue`；`GlueStore.moveTo` 本身不变）。留在原地的胶由源网格的钩子按 `glueFaceKept` 清理。补水（`refillWater`、`becomesSource`）的“下方是实心或水源”按 id，不变。

### 11.3 落回方块：合并还是冲突

方块化（转子停下）、停靠预览（`planDock`）、停靠提交（`commitDock`）用同一个函数判断每个要落下的格子。`incoming` 是旋转之后的整格内容（`rotCell(t.r, 源格子)`），`dest` 是目标格现在的整格内容：

```ts
// src/structures/assembly.ts
export const LAND_WRITE = 0;     // 目标是空气：直接写
export const LAND_OVERWRITE = 1; // 目标是软方块或液体：覆盖，非液体的软方块掉落（现在的规则）
export const LAND_MERGE = 2;     // 目标有硬部件，不重叠、合起来不超过两个部件：写 mergeCells(dest, incoming)
export const LAND_CONFLICT = 3;  // 重叠、目标在建筑高度以上或未加载
export const LAND_LIMIT = 4;     // 不重叠，但合起来超过两个部件；后果和 LAND_CONFLICT 完全相同，只是提示不同
export function landing(dest: number, incoming: number, aboveBuildHeight: boolean): 0 | 1 | 2 | 3 | 4;
```

- `solidFill(dest) === 0` → 空气为 `LAND_WRITE`，否则 `LAND_OVERWRITE`。`solidFill(dest) !== 0` → 按 `mergeProblem(dest, incoming)`：`MERGE_OK` 为 `LAND_MERGE`，`MERGE_OVERLAP` 为 `LAND_CONFLICT`，`MERGE_LIMIT` 为 `LAND_LIMIT`。目标是整格方块时永远重叠，所以只有整格方块时就是现在的 `isHardDestination`。
- `DockPlan.conflicts` 的每一项加一个字段 `limit: boolean`（这一格是 `LAND_LIMIT`）。有 `limit` 为真的冲突时，P8b 的停靠提示用新消息键 `toast.dock.twoParts`（“停靠位置有 {count} 格放不下：有的格子已经有两个部件（已标红）”），否则用现有的 `toast.dock.blocked`。玩家看到的是不重叠的空位，要告诉他为什么放不下（第 17 节问题 10）。
- 合并是一次 `setCell`（一次变更事件）。要落下的格子本身有两个部件时，只要有一个放不下，整格都算冲突：格子是一个整体。
- **冲突的后果**不变：停靠被拒绝，冲突格标红（列表仍以格为单位）；转子停下时冲突的格子变成掉落物，**每个部件一份**（位置按 `DROP_POINT`，第 9.5 节）；`BlockifyReport` 的计数仍然数格子。
- 船上的转子停下时“目标落在世界的硬方块里”的检查不变：取目标格中心所在的世界格子，它的 id 是硬的就算（世界格子里有任何部件都算，偏保守）。
- **胶**（`settlePlacedGlue`）：合并出来的格子算“这次落下的格子”。落下的格子和没有落下的、在这个面上（`glueSideAt`；没加载的格子算在）的邻居之间的胶去掉（轴承正面那一面除外）；邻居不在这个面上时只按 `glueFaceKept` 清理，和邻居是空气一样。于是目标格里原有的那个部件和它的世界邻居之间的胶也被去掉；合并之后那一格是一个整体，再次组装时整格跟着走。这是 DESIGN 两条规则合起来的结果，见第 17 节问题 2。
- 停靠时清掉干舱位置的液体：对船里是空气、且至少有一个干八分格（密封；船浮着时的舱底）的格子，即 `hullCavityCells` 里干的那些格子。只有一半干的空气格子在溢水层里，它的水位是半层，只有经过有部件格子的八分格才会这样，而液体不进有部件的格子，所以清掉它不会去掉船外的水。只有整格方块的船和 `isDryCell` 相同。（最初写的是“整格都干”；那样的话，用下半砖做舷墙的干船组装后原地停靠，组装时补在半干格子下面的水不会被清掉，船舱进水。P7 的审查发现的。）

### 11.4 旋转

落下的每个格子写的是 `rotCell(t.r, 整格内容)`（第 2.5 节）：状态、两个部件的形状一起转，顺序重排。格子位置（`snapCell`）和胶面的映射不变。场景 43 的“转 90° 停靠后形状跟着转”由 P7 用 24 个朝向的往返测试覆盖：组装 → 以每个朝向停靠 → 逐格比较 `rotCell` 的期望值。

### 11.5 存档和网络里的帆数

`Rotor.sails` 在结构体存档和结构体记录、转子增量里写成 `vu round(sails × 8)`，读出来除以 8（第 13 节）。

## 12. 船体物理与船体分析

`src/structures/hull.ts`、`src/structures/physics/`（P9）。原则：**只有整格方块的船，所有中间结果和现在逐位相同**（占用、采样点的个数和顺序、排水立方体、质量、惯量、空腔分类），所以 `tests/shipphys` 现有的测试（包括逐位确定性的那几个）一个不改。

### 12.1 船体分析的结果

```ts
// src/structures/hull.ts
export const HULL_OPEN = 0, HULL_SOLID = 1, HULL_BILGE = 2, HULL_SEALED = 3; // 不变
export const HULL_MIXED = 4;   // 这一格的 8 个八分格种类不全相同，看 mixedKinds

export interface HullInfo {
  version: number; ox: number; oy: number; oz: number; sx: number; sy: number; sz: number; // 不变
  /** 每格一个 HULL_*；HULL_MIXED 表示要看八分格。 */
  kind: Uint8Array;
  /** kind 为 HULL_MIXED 的格子下标，升序。 */
  mixedIndex: Int32Array;
  /** 与 mixedIndex 一一对应：八分格 o 的种类（0..3）在第 2·o 位起的 2 位。 */
  mixedKinds: Uint16Array;
  /** 整格属于这一种的格子数。只有整格方块的船和现在相同。 */
  solidCount: number; bilgeCount: number; sealedCount: number;
  /** 体积（格），含混合格子里的八分格，1/8 的倍数。 */
  solidVolume: number; bilgeVolume: number; sealedVolume: number;
  mass: number; com: Vec3; inertia: Float64Array;
  /** solidVolume + bilgeVolume + sealedVolume。 */
  maxDisplacement: number;
  floats: boolean;
}
export function hullKindAt(h: HullInfo, x: number, y: number, z: number): number;                    // 可能是 HULL_MIXED
export function hullOctantKind(h: HullInfo, x: number, y: number, z: number, octant: number): number; // 0..3
/** 半格坐标 (hx, hy, hz)（整数，局部坐标乘 2 取整）指的那个八分格是干的空腔（密封的；或船浮着时的舱底）。实体的液体采样、桶的射线、爆炸、相机都用它。 */
export function isDryHalf(h: HullInfo, hx: number, hy: number, hz: number): boolean;
/** 整格 8 个八分格都是干的空腔。 */
export function isDryCell(h: HullInfo, x: number, y: number, z: number): boolean;
/** 整格 8 个八分格都排水（实心或干的空腔）。 */
export function displacesWater(h: HullInfo, x: number, y: number, z: number): boolean;
/** 没有硬八分格、且至少有一个干八分格的格子，x, y, z 三个一组（组装后补水用；P2 把它从 assembly.ts 原样搬到这里）。 */
export function hullCavityCells(h: HullInfo): Int32Array;
/** 给渲染器的干区掩码；没有干的地方返回 null。 */
export function dryMask(h: HullInfo): { scale: 1 | 2; mask: Uint8Array } | null;
```

- “实心”的八分格 = 被硬部件占着的八分格。整格都是硬八分格的格子是 `HULL_SOLID`（包括拼满的双部件格子）。有部件但不满的格子总是 `HULL_MIXED`。
- `isPassableForWater`（241-244）没有调用者，删掉。
- `isDryHalf` 只收整数，理由同 `solidAtHalf`（第 4.4 节）。它由 P2 先加上，先实现成 `isDryCell(h, hx >> 1, hy >> 1, hz >> 1)`，并把四个拿着点却取整成格子的调用处换过去：`entities/fluids.ts:77`、`client/view.ts:363`、`sim/rays.ts:116`、`sim/explosion.ts:199`，都从 `isDryCell(hull, Math.floor(l.x), …)` 改成 `isDryHalf(hull, Math.floor(l.x * 2), …)`（`explosion.ts` 那一处现在用的是已经取整的 `lx, ly, lz`，改成从同一个局部点 `l` 另取半格坐标）。这样 P9 改内部时，第 1 波的其它工作包不用碰这些文件。

### 12.2 质量、质心、惯量

- 质量：对每个非空格子的每个部件，`density(材质) × FILL_VOLUME[占用] / 8`，位置在 `格子 + CENTROID[占用]`。不是硬材质的方块（火把等）和现在一样按整格算。
- 惯量：部件的每个被占八分格是一个边长 0.5 的立方体，质量 `density / 8`：平行轴项按八分格中心算，自身项是对角线上各加 `m / 24`。
- 整格的单部件方块必须用现在的表达式（质量 `density`，位置在格子中心，自身项 `m / 6`），不走按八分格求和的路径，保证数值逐位不变。
- 挂在船上的转子的质量（`massprops.ts rotorMass`）同样按部件的体积和质心算。
- `floats = mass < maxDisplacement × ρ`，`maxDisplacement` 现在是带小数的体积。

### 12.3 水密性：混合图上的泛洪

在“整格节点 + 部分格子里的八分格节点”上做和现在一样的优先级泛洪，水位以半层为单位（局部 +Y 为上）。**不建稠密的半格数组**：盒子上限 2²¹ 格时那是 1600 万个节点（LESSONS“格子数有上限，内存却没有”）。

- **节点**：`solidFill === 0` 的格子是一个整格节点，高度 `2y`。部分格子里每个没被硬部件占的八分格是一个节点，高度 `2y + oy`。实心格子没有节点。
- **边**：面相邻的两个整格节点；整格节点和相邻部分格子里贴着公共面的空八分格；半格网格上面相邻的两个空八分格（同一格里的，或相邻两个部分格子里的）。
- **水位** `L(节点)` = 从分析盒外面到这个节点的所有路径里，“路径上节点高度的最大值”的最小值（和现在的定义相同，单位换成半层）。播种和现在一样：分析盒表面上的每个节点以自己的高度入队（盒子是紧凑包围盒外扩一格，表面上只有空的整格节点），每个半层一个桶。整格节点的 `L` 仍然存在按格的 `Int16Array` 里，八分格节点的存在按部分格子编号的稀疏数组里。
- **分类**：节点的每个半层 `k`（整格节点有 `2y` 和 `2y + 1` 两个半层，八分格节点只有自己那一个）：没被泛洪到 → 密封；`L > k` → 舱底；否则 → 敞开。整格节点的两个半层种类相同时，这一格就是那个种类；不同时（溢水线正好在这一格的中间）记成 `HULL_MIXED`，下面 4 个八分格和上面 4 个八分格各取各的。
- 只有整格方块时所有高度都是偶数，`L` 也是偶数，两个半层的种类总是相同，结果和现在逐格相同，没有 `HULL_MIXED`。
- 复杂度 O(盒子 + 8 × 部分格子数)。船上每凿一下都会重新分析（`grid.version` 变了），客户端的副本也要算，所以有预算（第 15 节）。
- 例：舷墙是一圈下半砖时，舷墙那一层的舱内格子是混合的（下半舱底、上半敞开）；用上半砖封顶的舱室是密封的。

### 12.4 碰撞用的占用和采样点（`physics/shape.ts GridShape`）

- `occ` 每格一个码：`OCC_OPEN`、`OCC_SOLID`（8 个八分格都是硬的）、`OCC_SEALED`，新增 `OCC_PARTIAL`。有 `OCC_PARTIAL` 时另有两张按格的 8 位表（没有部分格子时不分配）：硬八分格掩码、密封的空八分格掩码。热路径的第一个分支仍是 `occ[i] !== OCC_SOLID`；只有碰到 `OCC_PARTIAL` 才取点所在的八分格（三个小数部分各和 0.5 比）去查掩码。
- `build` 读格子用 `grid.storage()` 的三层，不用只看第一部件的 `getCell`。`solidCount` 数的是“至少有一个硬八分格”的格子：只由半砖组成的船不是空船。
- **采样点**：
  1. 第一遍和现在完全一样：整格实心格子朝“敞开的整格”的每个单位面，4 个角加中心，角在整数网格上去重。面的另一侧是 `OCC_PARTIAL` 的那些面这一遍跳过。
  2. 第二遍只处理和部分格子有关的面：凡是“所属格子是 `OCC_PARTIAL`，或对面的格子是 `OCC_PARTIAL`”的硬八分格的面，如果对面的八分格既不是硬的也不是密封的，就是一个暴露的四分之一面，发它的 4 个角，不发中心。角在半格网格上去重：三个半格坐标都是偶数的点和第一遍的整数网格共用同一张稠密表（法线掩码按位或），其余的点放进一张以半格下标为键的哈希表。第二遍的点如果落在第一遍发过的某个单位面的边的中点上（这个点也在那个单位面上），法线掩码再并上那个面的方向。这样每个采样点的掩码正好等于经过它的所有暴露面（单位面和四分之一面）的方向；第二遍不因此多出点，只有整格方块的船不受影响。
  3. 第二遍的点排在第一遍之后，顺序是扫描顺序（格子按 y、z、x，方向 0..5，象限 0..3，角按固定顺序）。哈希表只用来查重，不决定输出顺序。
- 这样只有整格方块的船，点的个数和顺序不变（约 3500 格的敞口船仍是约 1.6 万个点）；部分方块只按自己的表面积加点：一个半砖的顶面是 9 个点（单位面是 5 个）。
- `nearestOwnerCell`（279-320）在部分格子里按八分格判断，返回格子和八分格（夹毁要用）。
- 转子（`rotorview.ts`）用同一个 `GridShape`，自动跟着改。包围半径、扫掠盒、`selectTerrainCandidates` 仍按格子的包围盒算（偏保守，不用改）。

### 12.5 浮力和阻力

- **排水体**：8 个八分格都排水的格子仍是一个单位立方体（现在的数组和循环，不动）。其它格子里每个排水的八分格（硬的，或干的空腔）是一个半立方体，进第二组数组。`dispVolume = 单位立方体数 + 半立方体数 / 8`。
- `applyBuoyancy` 加第二个循环处理半立方体。取水的方式和第一个循环相同（半立方体中心所在的那一列，格子 `k0` 和 `k0 + 1` 的水面高度 `h0`、`h1`），浸没的高度要另算，单位立方体的那个公式（`buoyancy.ts:98-101`）不能照搬：

  ```
  y0 = wy − 0.25            // 半立方体的底，它占 [y0, y0 + 0.5]
  k0 = Math.floor(y0)，fy = y0 − k0
  wet = max(0, min(h0, fy + 0.5) − fy) + max(0, min(fy + 0.5, 1 + h1) − 1)     // 0..0.5，对 y 连续
  v   = 0.25 × wet          // 浸没的体积（格）：底面积 1/4 乘浸没高度
  sum += v；sumRx += v × (wx − px)；sumRz += v × (wz − pz)
  ```

  `body.submerged` 仍以格为单位，带小数。
- `hydro.ts:38` 的 `cap` 用 `dispVolume`（现在用的是排水中心的个数）。
- `estimateDamping`（`massprops.ts:219-266`）：**没有半立方体时走现在的代码**，结果逐位不变。有半立方体时改按半层算（现在按 `Math.round(dy − ymin)` 分层，半立方体的中心在 .25 和 .75 上，会被分到不确定的层里）：
  1. 每个排水体的底：单位立方体是 `dy − 0.5`，半立方体是 `dy − 0.25`。`ymin` 取所有底的最小值，半层号 `j = Math.round((底 − ymin) × 2)`（底都是 0.5 的整数倍）。
  2. 每个半层的体积 `vol[j]`：单位立方体给 `j` 和 `j + 1` 各加 0.5，半立方体给 `j` 加 0.125。
  3. 水线所在的半层 `wl`：从下往上累加 `vol`，第一个使累加值不小于 `mass / ρ` 的半层；没有就取最高的半层。
  4. 水线面只数**穿过半层 `wl` 的排水体**，每个只数一次：单位立方体（它的 `j` 或 `j + 1` 等于 `wl`）面积 1，二阶矩 `dz² + 1/12` 和 `dx² + 1/12`；半立方体（`j === wl`）面积 1/4，二阶矩 `(dz² + 1/48) / 4` 和 `(dx² + 1/48) / 4`（边长 0.5 的正方形：面积 1/4，绕自身中心轴的二阶矩是面积乘 `0.5² / 12`）。竖着的半砖在同一格里上下两个半立方体分属两个半层，只有一个在水线上，面积不会重复计。
- 吃水符合体积（场景 43）：用下半砖铺底的木筏，平衡时的浸没体积等于 `质量 / ρ`，P9 的测试在 3% 以内核对（现有的阿基米德测试的做法）。
- 已知限制：排水体按中心所在的那一列取水，而水从不和部件同格。船头的立方体中心越过半砖厚的墙（墙面在 0.5 平面上）进入墙格那一列时，那一列在这个高度没有水，浮力势能在那里有一个台阶：撞墙那一 tick 按 `tests/shipphys/helpers.ts` 算的机械能会上升几焦耳（全速撞北半砖墙约 4 J），随后回落，一个周期内没有净增，动能也不超过撞前。所以半砖墙的测试断言 `collision.test.ts` 的动能条件，机械能条件只对墙面在格子平面上的墙断言。

### 12.6 接触

- 四种“点在不在格子里”的测试（`contacts.ts:418-434`、`474-489`、`665-677` 和 `745-757`、`858-871`）：先看 `occ` / 标志位是不是整格实心；是 `PARTIAL` 时再看点所在的八分格。空着的那一半里的点不产生接触。
- **探针**（`Prober.probe`，241-302）：被穿入的格子和它的 6 个邻居都不是部分格子时，现在的整数算法，不动。否则在半格网格上跑同一个算法：取点所在的八分格，看 6 个相邻的八分格，深度量到半格的平面（`faceDepth` 加一个格子边长的参数），回退最多走 4 个半格（仍是 2 格）。
- `ProbeTarget`（24-30）加按半格坐标的查询：`isSolidHalf(hx, hy, hz)`、`isOpenHalf(hx, hy, hz)`，以及 `isPartial(x, y, z)`；`GridShape` 和 `WorldPatch` 都实现。
- **世界补丁**（`patch.ts`）：标志位加 `PF_PARTIAL`，旁边一张按补丁下标的硬八分格掩码表（补丁里没有部分格子时不分配）。`fill`（79-150，读区块在 111 行）在区块有另外两层时把它们读进来，没有时就是现在的循环；补丁之外的回退（`flagsAt`，153-161）用 `solidFillAt`。硬格子的包围范围把部分格子也算进去。水的规则不变（水不和部件同格）。
- `collectCorners`（178-240，暴露面的掩码在 `cornerOpenMask`，245-270）：在 `PF_PARTIAL` 格子旁边也收集半格网格上的角点，暴露面的掩码按周围 2×2×2 的八分格算；别处不变。否则船沿滑过码头上的半砖台阶时，只有“船的点进地形”这一种接触。
- `GRAZE_PENALTY = 0.35`、`ROTOR_STALE_DEPTH = 0.5`、`maxSubstepTravel = 0.2` 不改。它们是按整格和 0.5 的点距定的；P9 加两个测试来确认不用改：半砖厚的墙挡得住全速的船；叶片推一条半砖船体的船（不滑过去、不误夹毁）。测试不过再调，并在注释里写明依据。

### 12.7 夹毁

每 tick 每条船仍然最多损毁一处，损毁的是**一个部件**：叶片陷得最深的那个八分格所属的部件。`Body` 的夹毁记录加 `pinOctant`（来自探针的八分格或 `nearestOwnerCell`）；`destroyPinnedCell`（`dynamics.ts:830-853`）改成 `removePartAt(grid, x, y, z, pinOctant)`，按被去掉的部件的材质掉落一份，位置按 `DROP_POINT`（第 9.5 节）。双部件格子要两个 tick 才全毁。

### 12.8 渲染器的干区

干区掩码是给水面着色器裁掉船舱里的世界水用的（`render/backend.ts DryVolume`、`render/three/drymask.ts`、`shading.ts:444-476`、`client/structures.ts:221`，归 P9）。

- `DryVolume` 加 `scale: 1 | 2`：掩码每个轴上每格 `scale` 个纹素。着色器的采样（x、z 双线性，y 取层中心）把“格”换成“纹素”。
- `dryMask(h)`：没有 `HULL_MIXED` 的格子时 `scale = 1`，掩码和现在一样（干的空腔格子为 1）。否则 `scale = 2`，每个八分格一个纹素，干的空腔八分格为 1。半砖做的船舷因此只裁掉舱内那一半的水，舱外那一半照常有水。
- 上限：`scale = 2` 的纹素数（8 × 分析盒）超过 `DRY_MASK_MAX_TEXELS = 2²²` 时退回 `scale = 1`，这时一格为 1 当且仅当它没有敞开的八分格、并且至少有一个干的八分格。

## 13. 协议与存档

### 13.1 `Cell` 和 `CellVolume`

字节布局就是 NETCODE 第 6、14 节早已留好的，不变；变的是两端的实现和内存里的类型。`Cell` 和 `CellVolume` 的编解码从此只有一份实现，协议和存档的区块共用（NETCODE 当初让它们分开，只是因为存档的调色板是 u16）；结构体的存档只共用 `Cell`（第 13.3 节）：

```ts
// src/save/cells.ts（P2，新文件）：只依赖 save/bytes.ts 和 blocks/cell.ts，纯函数，没有模块级状态
export const PALETTE_LIMIT = 4096;    // 从 net/protocol.ts 搬来；net/protocol.ts 改为转出
export interface CellBudget { cells: number }   // 从 net/codec.ts 搬来
export function cellSize(packed: number): number;                      // 这个 Cell 编码后的字节数（1..8）
export function writeCell(w: ByteWriter, packed: number): void;
export function readCell(r: ByteReader): number;                       // 返回整格内容
export function writeCellVolume(w: ByteWriter, v: CellLayers): void;   // 格数 = v.base.length
export function readCellVolume(r: ByteReader, n: number, budget: CellBudget, check?: (packed: number) => string | null): CellLayers; // check：调色板每项一次、逐格形式里值每变一次调一次，返回非 null 即失败
export function volumeCost(n: number, hasHoles: boolean, hasPart2: boolean): number;
// src/net/protocol.ts
export type Cell = number;            // 整格内容
export type CellVolume = CellLayers;
```

`net/codec.ts` 继续导出同名的函数（转出 `save/cells.ts` 的），`ProtocolError` 的包装方式不变。`tests/net/layering.test.ts` 现在只允许 `src/net` 的基础模块引用 `save/bytes`（47 行），P2 把 `save/cells` 加进去。

- **`Cell`**：`vu v`；`v & CELL_MULTI_BIT` 时再跟一个 `vu`，是第二部件。两端都检查布局，编码端抛 `RangeError`，解码端失败（网络上是协议错误，存档里是 `SaveFormatError`），绝不截断：`v < 2²⁵`；`v` 的缺口不是 `0xff`；有第二部件时它在 `[1, 2²⁴)` 里、缺口不是 `0xff`、id 不是 0。整格方块仍是 1～3 字节；带缺口的部件 3～4 字节；双部件格子的第一个数 4 字节，第二个数 3～4 字节。
- 编解码只管布局。**语义**（id 已注册、缺口只出现在可切的材质上、两个部件不重叠、顺序规范）由 `cellProblem` 在把格子写进存储的地方检查（13.2）。
- **`CellVolume`**：`u8 enc`，0 是调色板加游程，1 是逐格；调色板项和逐格的项都是 `Cell`。调色板的键是整格内容。解码时只有遇到需要的调色板项或格子才分配另外两层，空气的游程照旧不填。
- **编码器**是一遍扫描，输出由内容唯一决定：
  1. 按“整格内容变了”切游程。每个游程结束时累加逐格形式的字节数 `rawBytes += 游程长度 × cellSize(值)`，并记下（调色板下标，长度）；值第一次出现时进调色板。
  2. 调色板的项数超过 `PALETTE_LIMIT` 时放弃调色板：从这里起不再记游程、不再碰调色板的表，只继续切游程累加 `rawBytes`，结果一定是逐格形式。
  3. 扫完后算出调色板形式的确切字节数，**严格小于** `rawBytes` 才用调色板，否则逐格。
  
  `holes` 和 `part2` 都是 `null` 时“值”就是 `base[i]`，每格的工作是一次读取和一次比较，和现在存档的编码器相同（网络的编码器现在每格都算一次字节数，改成每个游程算一次）。存档编码器现在的第二个提前出口（游程数加调色板大小超过逐格形式的固定长度，`save/codec.ts:261-264`）去掉：逐格形式的长度不再是常数；它省掉的只是噪声区块里每个游程两次数组追加。
- **最坏的大小**：逐格形式每格一个 `Cell`，整格方块 1～3 字节，带缺口的部件 3～4 字节，双部件格子至多 8 字节。一个区块（32768 格）最坏 262 KB，全是整格方块时最坏 98 KB（现在的存档格式是 64 KB）；真实的区块走调色板，几百字节到几 KB。
- **解码的内存上限**：一个 `TickBatch` 里的格子体合计仍然不超过 `MAX_BATCH_CELLS = 2²⁵`，但计价按字节比例：`volumeCost = n + (有缺口层 ? ceil(n / 2) : 0) + (有第二部件层 ? 2n : 0)`。解码端先扣 `n`，第一次要分配某一层之前再扣那一层的份额，不够就按协议错误。编码端（`Replicator` 打包、`writeStructureRecord`）用同一个函数计价，超出的快照推到下一个包。这样一个包**解码时**分配的内存上限和现在一样（64 MB），而且两端的上限一致（LESSONS“存档写得出、读不回”）。结构体的盒子上限 2²¹ 格，三层全有时计价 3.5 × 2²¹，放得进一个包。
- 这个预算只管格子体的解码。增量（`ChunkDelta`、`StructureDelta`）里一个带缺口的格子和一个双部件格子，会让客户端的存储给那一列或那个结构体分配另外两层（每格再多 5 字节：一列 160 KB，一个结构体多出它基础层的 2.5 倍），这部分不计价。所以恶意的房主能让客户端占用的内存，上限是今天同样手法的 3.5 倍，仍然有界：列数受视野限制，结构体的盒子受 `checkDeltaBox` 限制。

### 13.2 带格子的记录

| 记录 | 现在 | M2.3 |
|---|---|---|
| `ChunkSnapshot.cells` | `'pristine' \| Uint16Array` | `'pristine' \| CellLayers`。原样的判定不变 |
| `ChunkDelta.cells` | `[index, Cell]`，Cell < 2¹⁶ | `Cell` 是整格内容；只改缺口或第二部件的变化也产生增量 |
| `StructureRecord.cells` | `Uint16Array` | `CellLayers`（`grid.copyBox` 的结果） |
| `StructureDelta.cells` | `[x, y, z, Cell]` | 同上 |
| 转子的 `sails`（`StructureRecord`、`StructureDelta` 位 5） | `vu sails` | `vu round(sails × 8)`，读出来除以 8 |
| `EntityRecord` 下落方块的 `Cell` | 任意 16 位 | 必须 `< FULL_LIMIT`，两端都检查；客户端另过 `cellProblem` |
| `WorldEvent` `blockBroken` / `blockPlaced` 的 `Cell` | 整格的值 | 被挖掉 / 放下的**部件值**：`< PART_LIMIT`，没有第二部件，两端都检查；客户端另过 `cellProblem`。P8b 合并之前带的是第一部件的值（第 16.3 节），同样满足这一行 |
| `Target`、`OptTarget` | `sub` 不校验，恒为 0 | 第 6.3 节 |
| `PrivateState` 视图的 `mining.sub`、`gluing.sub` | 不校验 | 第 6.3 节 |
| `GeneratorSpec` 平地的层 | `vu cell` | 必须 `< FULL_LIMIT`（编解码检查）；客户端和主机在用它造生成器之前调 `generatorSpecProblem` |
| `Use` 的 `flags` | 位 0 潜行 | 位 1～3 是半砖方向 `slabMode` 0～6（第 14.2 节），7 和更高的位按协议错误。M2.3 的客户端发 0 |
| `HostCommand` | 种类 0～5 | 新增种类 6 `SetCell`：`vu gridId, vi x, vi y, vi z, Cell`；服务器的检查见第 14.1 节 |
| `Stack`、预览位图、胶、实体采样、校正、移动上报 | | 不变。凿子是 M2.4 新增的物品 id，不改布局 |

**不可信输入的校验**

- 客户端（`net/client/apply.ts`）：包里**每一处**格子都过 `cellProblem`，不合法抛 `ReplicaError`（连接按协议错误结束）：快照、增量、结构体记录和结构体增量里的格子，下落方块实体带的格子，`blockBroken` / `blockPlaced` 事件带的部件值。整列的快照先用按 id 的“已注册”表扫基础层，只有带缺口或第二部件的格子才走完整的检查，加入时每列的开销仍在预算内（第 15 节）。这也补上现在的一个缺口：未注册的 id 能进副本，之后在网格化时才抛错。
- 生成器规格：`worldgen/generator.ts` 导出 `generatorSpecProblem(spec: GeneratorSpec): string | null`（平地的每一层过 `cellProblem` 且 `< FULL_LIMIT`；其它种类返回 `null`）。三处调用，各用自己的错误类型：`FlatGenerator` 的构造（`RangeError`）；客户端收到 `Welcome` 时，`net/client/netclient.ts:416` 在调 `chunkSource(m.generator)` 之前（不为 `null` 就按协议错误断开）；主机读存档里的生成器块时，`net/host/host.ts:632-635` 在 `readGeneratorSpec` 之后（`r.fail`，即 `SaveFormatError`）。否则坏的层要到 `FlatGenerator` 的构造函数里才以普通异常冒出来（客户端是 `client/terrain.ts:74`）。
- 服务器从不存客户端发来的格子：`Target.cell` 只用来比较，拿它调的 `partAt` 对任何布局合法的值都不抛错（第 3 节“全域性”）。`HostCommand SetCell` 见第 14.1 节。
- 存档：`decodeChunk` 对调色板的每一项（逐格形式时对每个格子）、结构体的读取对每个格子过 `cellProblem`，不合法抛 `SaveFormatError`（CRC 正确但内容坏了的存档不会把未注册的 id 或重叠的部件带进世界）；实体块里下落方块的格子同样（第 13.3 节）。

NETCODE 的改动：第 6 节“格子值的格式”里“M2.1 的副本还是 16 位存储”和“网络格式不复用存档的区块编码”两条删掉，换成指向本节；第 14 节表里 `Cell`、`Target`、`Use`、`HostCommand`、转子帆数各改一行；第 10 节目标的格式和服务器校验第 1 条照第 6.3 节改。P2 改第 6、14 节，P8b 改第 10 节。

### 13.3 存档

- `SAVE_VERSION` 从 3 升到 4。旧存档打不开，照现有的提示处理，不迁移。
- **子版本号的规则**：载荷变了的块，自己的版本号加 1；没变的不动。`STRUCTURES_FORMAT` 从 3 升到 4（`structures/serialize.ts:50`），实体块的 `SAVE_VERSION` 从 2 升到 3（`entities/manager.ts:115`）。外层的 `SAVE_VERSION` 已经把旧世界整个拒掉了，这两个号实际上不会被旧数据碰到；照规则加，是为了让每个块的读取代码只认识一种布局。
- **区块**（`save/codec.ts`，`BLKC`）：外壳（magic、版本、CRC）不变，载荷改成 `varint cx, varint cz, CellVolume(32768)`。`decodeChunk` 返回 `{ cx, cz, layers: CellLayers }`。
  - 解码的预算：`readCellVolume(r, 32768, { cells: volumeCost(32768, true, true) })`，即一个区块三层全有的份额；格数是常数，不存在读出一个巨大尺寸的问题。
  - 语义检查：`decodeChunk` 把 `cellProblem` 作为 `readCellVolume` 的第四个参数 `check` 传进去。`check` 对调色板的每一项调一次（没有游程用到的项也查），逐格形式里值每变一次调一次；返回非 `null` 就失败（`SaveFormatError`），不再有第二遍扫描。
  - 大小：逐格形式不再是固定的 2 字节一格（13.1“最坏的大小”）。只有整格方块的区块走调色板时，调色板项从固定 2 字节变成 1～3 字节的 `Cell`，其余相同，和现在差几十个字节以内。
- **暂存的区块**（`sim/chunks.ts`）用同一个编码；`ChunkManager.stashedCells(cx, cz): CellLayers | null`。
- **结构体**（`structures/serialize.ts`）：格子部分**保持现在的稀疏游程**，只把每格从 u16 换成 `Cell`：紧凑包围盒，然后 `varuint 游程数`，每个游程 `varuint gap, varuint 长度, 长度 × Cell`（现在是 `gap` 加一个带长度的 u16 数组）。不换成稠密的 `CellVolume`：现在的写法和读法都只和格子数成正比，而且读的时候先把所有游程解出来、核对包围盒确实紧凑，然后才分配（`serialize.ts:309-345`）；换成稠密的，一条 2²¹ 格盒子里的稀疏结构体每次自动存档都要扫 200 万格，读的时候还得先分配后检查。一个游程至少 3 字节（`r.count(3)`）。每个格子过 `cellProblem`（取代现在的 `checkCell`），包围盒必须紧凑的检查保留。写的一侧用 `forEachCell`（整格内容）。转子的帆数按 13.2。
- **实体**：下落方块的格子写成 `varuint`；读出来过 `cellProblem` 并要求 `< FULL_LIMIT`，否则 `SaveFormatError`（第 4.5 节）。
- 方块 tick、胶、玩家、生成器规格的块布局不变，版本号不动。生成器块读出之后多一步 `generatorSpecProblem`（13.2）。
- **`tests/save/codec.test.ts` 里要重写的用例**（格式变了，这些用例测的就是格式本身；P2 负责，其余用例只跟着返回值的形状改）：
  - `terrainChunk` 里那个 `0xffff` 的格子（69 行，id 1023 没注册）换成一个已注册的方块带满状态位；
  - `noiseChunk`（71-76 行）改成从已注册的整格方块值里随机取，另加一个带部分格子和双部件格子的噪声生成器；
  - “不超过逐格大小”的两个断言（210-219、221-230 行的 `CHUNK_VOLUME * 2 + 16`）改成“不超过各格 `cellSize` 之和加 16”；221-230 行的取值 `rng.int(…) * 37` 同样换成已注册的值；
  - 手工构造的坏载荷（262-290 行）：调色板项从 `u16` 改成 `Cell`，“逐格但格数不对”改成逐格形式被截断；
  - 新增：部分格子、双部件格子、拼满的双部件格子的往返；语义不合法的调色板项（重叠的部件、不可切的材质带缺口、没注册的 id）被拒绝；大小的三个用例见第 15 节。

### 13.4 摘要和指纹

副本和服务器是否一致全靠摘要判断。现在的摘要只哈希基础层，丢了缺口也算一致，所以 P2 必须先改它们，并且各带一个“只改缺口、只改第二部件，摘要必须不同”的测试。

```ts
// src/voxel/fingerprint.ts
export function columnHash(chunk: Chunk): number;      // 参数从 cells 数组改为区块
export function layersHash(v: CellLayers): number;     // 同一个算法，给暂存的列和生成器的输出用
export function gridHash(grid: StructureGrid): number;
```

- `layersHash`：先对基础层做现在的 FNV-1a。然后，如果缺口层里有非零项：混入一个分隔字节 `0x48`，再按下标升序对每个非零项混入下标（4 字节小端）和值。第二部件层同理，分隔字节 `0x50`，值是 4 字节小端。没有非零项的层什么都不混入，所以只有整格方块的列，哈希和现在相同（浏览器脚本里记着的值不用改），层是 `null` 还是全 0 也没有区别。
- `gridHash`：`forEachCell` 给的是整格内容。每格混入 x、y、z、值的低 16 位、16～31 位；值 ≥ 2³² 时再混入更高的位。只有整格方块的结构体哈希不变。
- 调用处：`net/server/probe.ts:51`、`client/game.ts:1682`（页面的 `debug.digest`）。
- `tests/net/digest.ts`：列的摘要用 `layersHash`（已加载的区块、暂存的列、原样列的生成器输出三种来源）；结构体的摘要按 `getPacked` 逐格哈希；`tests/net/intent-scenes.ts:75-81` 共用同一个函数。`tests/net/rig.ts` 的方块守恒按部件计数。

### 13.5 版本

没有单独的协议版本号，`BUILD_ID` 相同才能连（NETCODE 第 3 节）。存档的总版本和两个子版本见 13.3。

## 14. M2.4 的工具，以及在那之前怎么造部分方块

### 14.1 M2.3 期间

工具到 M2.4 才有。M2.3 的每个工作包都要能在测试里、在浏览器里摆出部分方块：

- **测试**：直接写格子。`sim.world.setCell(x, y, z, makePart(id, state, holes))` 放一个带缺口的部件；双部件格子用 `addPartAt` 或 `setCell(x, y, z, canonCell(a, b))`。验收测试的规定不变：搭场景在 `w.sim` 上做，动作经 `w.me`；网络模式下这些改动经变更事件、增量、副本到达客户端，测试结束时照常比较摘要。
- **共用的测试辅助** `tests/shapes.ts`（P1 建，P2 补网格部分）：

```ts
export const LOWER = 0x33, UPPER = 0xcc, WEST = 0x55, EAST = 0xaa, NORTH = 0x0f, SOUTH = 0xf0;
export function slab(id: number, fill: number, state?: number): number;   // 部件值
export function stairFill(high: Dir): number;                             // 下半加上 high 一侧的上面两个八分格
export function putPart(grid: VoxelGrid, x: number, y: number, z: number, part: number): void; // 并进这一格，放不下抛错
export function partsAt(grid: VoxelGrid, x: number, y: number, z: number): Array<{ id: number; state: number; fill: number }>;
export function partLabels(grid: VoxelGrid, box: CellBounds): string[];   // "x,y,z:planks_oak[33]+stone[cc]"，排好序，给断言用
```

- **浏览器**（P2）：房主命令 `SetCell { gridId, x, y, z, cell }`（13.2），和 `Teleport`、`Give` 一样是调试命令，只接受房主的连接。它绕过了交互的流程，所以服务器（`net/server/intents.ts hostCommand`）自己把关，下面任何一条不满足就不写，回一条提示（新消息键 `toast.host.setCell`，“这个格子不能这样改”）：
  1. `cellProblem(cell) === null`；`gridId` 是世界或一个现存的结构体。
  2. 这一格现在的内容和要写的内容都不是功能方块（舵轮、轴承、螺旋桨，`func !== 'none'`）：挖舵轮要先让舵手松手（`interact.ts:1276-1282`），轴承带着转子，这些流程命令里没有。
  3. 世界：`0 <= y < 128`，并且这一列已加载（`getCell` 不是未加载的哨兵）。
  4. 结构体：它没在转（`editable`）；非空内容的每个部件都能加入结构体（`canJoinStructure`：液体和不可破坏的方块不行，和手放时一样）；把空格子写成非空时，过和放置相同的两条上限（`interact.ts:906-921 structureFull`）：格数没到上限，`boxCellsWith(紧凑包围盒, x, y, z) <= sim.structureMaxBoxCells`。否则 `StructureGrid.setCell` 会为了够到任意远的坐标去扩存储（`sgrid.ts:103-112`），盒子超过 `STRUCTURE_MAX_BOX_CELLS` 之后这个结构体就再也发不出去、存不下来了（客户端用 `checkDeltaBox` 防的是同一件事）。
  
  通过之后是一次普通的 `setCell`，钩子照常运行（把结构体的最后一格写成空气，和挖掉它走同一条路）。页面上 `window.__blocklands.game.debug` 加：`setCell(x, y, z, packed, gridId = 0)`、`slab(x, y, z, blockId, dir, gridId = 0)`（把这种方块在 `dir` 一侧的半砖并进这一格）、`parts(x, y, z, gridId = 0)`（返回两个部件的 id、状态、占用）。现有脚本用的 `debug.cell(...) & 1023` 仍然是第一部件的 id。

### 14.2 M2.4：凿子和半砖

这里定到“M2.3 的交互、协议、叠加层不用返工”为止；提示文字、按键、图标、开局物品由 M2.4 自己定。

**物品**：`I.CHISEL = 1028`，不可堆叠。

**不需要新的意图**。凿和补就是 `Attack` 和 `Use`，目标的 `sub` 是命中的八分格，`face` 是命中的面：

| 操作 | 条件 | 效果 |
|---|---|---|
| 主手凿子，左键（`Attack`） | 目标部件的材质可切；所在的结构体没在转 | `removeOctantAt(grid, x, y, z, sub)`。不掉落；凿空的部件消失。整格方块凿一下变成 7 个八分格的部件。**创造模式**：按一下凿一个，按住每 5 tick 再凿一个。**生存模式**：要按住，凿掉一个八分格用 `硬度 / 8` 秒（第 17 节问题 8 的建议）；用的是挖掘的那一套进度和取消规则，只是身份换成“网格 + 格子 + 八分格”，私有状态里 `mining.sub` 的位 3 置 1（第 6.3 节），裂纹只包这一个八分格；凿完一个，接着凿准星所指的下一个 |
| 主手凿子，右键（`Use`） | `isCellFace(sub, face)` 为假（点的是内面）；内面对面的八分格 `o' = sub ^ (1 << (face >> 1))` 在这一格里空着；补上之后不和实体的身体重叠；所在的结构体没在转 | `restoreOctantAt(grid, x, y, z, sub, o')`。不消耗物品。补满 8 个就是整格方块 |
| 副手凿子，主手是可切的方块，右键 | 见下 | 放出半砖，消耗 1 个方块 |
| 副手凿子，主手是不可切的方块 | | 照常放整块 |

右键的优先级里，“主手是凿子”排在“正在掌舵”之后、“主手是强力胶”之前。

**半砖放在哪**：由 `sim/placement.ts` 的纯函数决定，服务器执行和客户端预览调的是同一个（像 `sim/rays.ts` 一样，`net/client` 可以引用它）：

```ts
// src/sim/placement.ts（P8b）
export interface PlacePlan {
  x: number; y: number; z: number;  // 目标格
  /** 写进目标格的整格内容（已经和原有的部件合并）。 */
  cell: number;
  /** 新放下的部件值。 */
  part: number;
  /** 目标格原来是被取代的软方块。 */
  replaces: boolean;
}
/** 放不下的原因：'occupied' 位置被占（提示 toast.place.occupied）；'twoParts' 不重叠，但这一格已经有两个部件（提示 toast.place.twoParts）。 */
export type PlaceRefusal = 'occupied' | 'twoParts';
/** slabMode：-1 放整块；0 贴着被点的面；1 + Dir 固定放在目标格的这一侧。 */
export function planPlacement(grid: VoxelGrid, hit: GridHit, blockId: number, state: number, slabMode: number): PlacePlan | PlaceRefusal;
```

- 整块（`slabMode = −1`）：第 6.2 节的规则：目标格 `placementCell(hit)` 必须 `REPLACEABLE`，否则 `'occupied'`（有部件的格子、整格方块、不可替换的软方块都在内）。M2.3 的 `place()` 就改成调它。
- 半砖：
  1. 目标格和默认的一侧：点的是内面（`!isCellFace(hit.octant, hit.face)`）时，目标格是被点的那一格，默认放在 `hit.face` 一侧（就是面前空着的那一半）；点的是格面时，目标格是 `placementCell(hit)`，默认放在 `opposite(hit.face)` 一侧（贴着被点的面）。被点的是可替换的软方块时照整块的规则取代它，默认放在下半。
  2. `slabMode >= 1` 时一侧改成 `slabMode − 1`，目标格不变。
  3. 部件值 = `makePart(blockId, state, ~HALF_FILL[一侧] & 0xff)`。按目标格现在的内容分三种：可替换（空气、液体、草丛、雪层）→ 直接写（被换掉）；有硬部件 → 看 `mergeProblem`：`MERGE_OK` 写合并后的内容，`MERGE_OVERLAP` 返回 `'occupied'`，`MERGE_LIMIT` 返回 `'twoParts'`；不可替换的软方块（火把、花）→ `'occupied'`（`mergeProblem` 对软方块返回 `MERGE_OK` 只表示“不重叠”，这里不能照它写，否则火把被悄悄盖掉）。
- 结构体的格数上限、实体身体的重叠（按半砖的形状）、消耗物品仍在 `place()` 里。副手是凿子，所以没有副手胶；同一格里的两个部件本来就是一体。

**每个玩家的半砖方向**：`slabMode` 是客户端的界面状态（0 贴面，1～6 六个方向），按键在 7 个值之间循环，不单独同步。它随每次 `Use` 放在 `flags` 的位 1～3 里发给服务器，服务器写进 `PlayerInput.slabMode`（新字段，默认 0）再处理这次按下；脚本控制的玩家直接设这个字段。所以预览只依赖本地状态，不会和服务器不同步。

**预览和高亮**：副手是凿子、主手是可切的方块、有目标时，客户端对副本调 `planPlacement`，结果是 `PlacePlan` 时把 `{ 网格, 目标格, fill = 新部件的占用, item }` 放进 `OverlayState.placement`（被拒绝时没有预览），渲染器用这种方块的贴图画半透明的 `BOXES[fill]`。主手是凿子时 `OverlayState.targetOctant = target.sub`，在部件的轮廓里再高亮这个八分格。场景 41 的“预览和实际放出的一致”由“同一个函数、同样的输入”保证，测试比较两边的 `PlacePlan`。

**M2.3 已经交付、M2.4 直接用的**：`removeOctantAt` / `restoreOctantAt`（P2）；命中八分格和内面的射线、`Target.sub`（P8a、P8b）；`planPlacement` 的两个分支和它的单元测试、`Use.flags` 的校验、`PlayerInput.slabMode`、`OverlayState` 的两个字段（P8b，M2.3 里恒为 −1 和 `null`）。**M2.4 要做的**：物品、图标和调色板位置、按键和提示、`Hands` 里主手 / 副手凿子的三个分支（生存模式凿子的计时按问题 8 的结论）、半透明预览和八分格高亮的绘制、脚本接口（`chisel`、`slabMode`）、场景 40 和 41、浏览器脚本里加一步。另外：

- 用真正的工具把场景 39 和 42 重跑一遍：39 的“放两种材质的半砖”用副手凿子放，42 的“凿掉接触面上的材质”用主手凿子凿。M2.3 里这两步是直接改格子做的（第 16.4 节），玩家操作的那一半到 M2.4 才第一次被验收测试跑到。
- 主手凿子左键点到不可切的目标（火把、舵轮、沙子……）：照常挖掘，和手里拿着别的物品一样。
- 凿和补都受“转动中的转子不能编辑”的限制（`interact.ts:646-650 locked`），提示用现有的 `toast.place.spinning`。
- 声音：用现有的通用世界事件 `sound { name, x, y, z }`（凿和补各一个名字），不加新的事件种类，也不借用 `blockBroken`（它表示一个部件没了）。
- `net/client` 要引用 `sim/placement.ts` 做预览，`tests/net/layering.test.ts` 里 `net/client` 的规则加上它（现在允许 `sim/view`、`sim/messages`、`sim/rays`）。

## 15. 性能预算

“预算”是测试里断言的上限，不变。“基线”一栏是在 `c20ea8e` 上量的（审计时的机器；ROADMAP 里没有 M1 的网格化、光照、液体、船体物理、实体的数字），只用来了解量级：同一份代码两次运行之间就差 1.1～1.7 倍（审查时在一台 4 核机器上把 `tests/shipphys/perf.test.ts` 跑了四遍：4000 格顶墙 0.66～1.14 ms，着陆 1.75～2.20 ms，1000 格着陆 0.88～1.08 ms，而每个数已经是“三次里最好的”），所以不能拿新量的一个数去和这一栏比。P10 怎么比见表后的第 2 条。

| 测试 | 预算 | 基线 |
|---|---|---|
| `tests/mesh/perf.test.ts`：地形 section（新建 / 复用）、海洋、瀑布、埋在地下、空 | < 2.5、2.5、2.5、0.25、0.05 ms | 0.35 / 0.17、0.23、0.45、0.05、0.014 ms |
| `tests/light/perf.test.ts`：`initChunk` 平均、单次编辑中位、空闲 `update`、高处屋顶编辑 | < 40、2、1、2 ms | 0.63、0.006、0.002、0.10 ms |
| `tests/liquid/perf.test.ts`：每个世界 tick 平均、每次液体 tick、最差的世界 tick | < 2 ms、10 µs、25 ms | 0.32～0.68 ms、1.5～2.6 µs、3.1～4.5 ms |
| `tests/shipphys/perf.test.ts`：1000 格、4000 格（航行 / 顶墙 / 着陆） | < 1.5、6 ms | 0.30 / 0.26 / 0.76、0.53 / 0.67 / 1.70 ms |
| `tests/entities/perf.test.ts`：200 个实体、5 条在动的船 | 中位 < 4 ms | 1.6 ms |
| `tests/voxel/alloc.test.ts`：世界上的 11 个查询 | 每次 < 1 字节 | 通过 |
| `tests/drive/alloc.test.ts`：在陆地上走 | < 256 字节 / tick | 101 字节 |
| `tests/structures/collect.test.ts:514`：4000 格的船、带胶的船、4097 格、400 格的转子 | < 25、25、25、5 ms | 通过 |
| `tests/net/hidden-cost.test.ts`：没有新东西的一帧、3700 格的船生成、加入时每个改过的列 | < 200 µs、20 ms、10 ms | 8.4 µs、0.17 ms、0.22 ms |
| `tests/net/replicator-cost.test.ts`：空包、平时每 tick 可靠 / 不可靠、溃坝每格 | 4～6 B、< 60 / 250 B、< 4 B | 15.9 / 101.6 B、3.24 B |
| `tests/save/codec.test.ts`：分层地形、空区块、平地 | < 8 KB、24 B、32 B | 通过 |
| `tests/worldgen/generator.test.ts`：每个区块 | 平均 < 6 ms | 通过 |

**没有部分方块的世界**

1. 上表的预算一个都不放宽。现有的测试用例不改，只有两类例外，都列在第 16.2 节各包的“文件”和“测试”里：测的就是被替换掉的格式或数据形状的用例（`tests/save/codec.test.ts` 里第 13.3 节列出的那几个；手写 `Uint16Array` 快照和记录的地方跟着 `CellLayers` 改），以及被删掉的 `Chunk.get` / `set` 的调用。行为类的用例（碰撞、实体、光照、液体、船体物理、粘连、交互在整格世界里的结果）一个都不改；改了就说明整格路径变了。
2. P10 的比法：在**同一台机器**上交替运行基准提交 `c20ea8e` 和集成后的提交（两个检出，A、B、A、B……），每个计时测试每边至少 5 次，比较两边的**中位数**；集成后的中位数超过基准的 1.15 倍就要查原因，并把两边各 5 个数写进报告。分配类的量的是字节，不随机器变，按预算，不留余量。
3. 两个基线里没有、要先记下来的数：`analyzeHull` 对 4000 格的船（NETCODE 记的是 0.8～2.1 ms）；敞口的 3945 格木板船着陆时每 tick 7.9 ms（现有的性能测试用的是内部密封的船，采样点只有 5322 个，测不到它）。P9 开工前先加这两个用例，各跑 5 次，把 5 个数都记下来（中位数和最大最小值）；M2.3 之后按第 2 条的方式和它比，中位数不得超过 1.15 倍。敞口船本来就超过 6 ms 的预算，这是 M1 的遗留，M2.3 不负责修，记进 ROADMAP。

**有部分方块的世界**（新增的用例，各由对应的工作包写）

| 用例 | 预算 | 归 |
|---|---|---|
| 分配：半砖旁边的 `boxOverlapsSolid`、半砖顶上的 `hasSupportBelow`、沿一排半砖没被挡住的 `sweepAxis` | 每次 < 1 字节 | P3 |
| 分配：在半砖和楼梯上走 | < 256 字节 / tick | P3 |
| 分配：在一条有半砖的船的甲板上潜行（潜行护边的 `solidAtHalf`，每 tick 每个结构体几百次）；在这条船的船体旁边、站在水里（液体采样的 `isDryHalf`） | 各比同一场景换成整格的船多出 < 256 字节 / tick | P3（绝对值做不到：每次结构体查询要新建一个约 0.7 KB 的局部盒子，M1 就是这样，整格的甲板上潜行也是约 2.6 KB / tick；见 ROADMAP 的遗留） |
| 200 个实体在半砖铺的甲板上 | 中位 < 4 ms | P3 |
| 网格化：一半是半砖和楼梯的 16³ section（起伏的地形，一半以上的格子是部分格子：地表下是双部件格子，地表上是楼梯、半砖和半砖柱，约 2300 个四边形）；24³ 的半砖木筏（主线程同步网格化的上限） | < 5 ms；< 8 ms | P4（预算场景里约六成格子是部分格子，其中约 78% 埋在地下、不发面。部分格子全部露在外面的“城镇”section（每 4 层一层下半砖地板、竖半砖墙、楼梯；一半格子是部分格子，1.88 万个四边形）是 4.6～4.9 ms（安静的机器上也是），贴着预算：测试只断言八分格路径每个四边形的开销不到整格路径的 1.5 倍（同一测试里交替测，实测 1.09～1.17 倍），不断言绝对时间；下半砖的棋盘 8.6 ms。见 ROADMAP 的遗留） |
| 光照：半砖屋顶上开关一个缺口（24×24 的屋顶，下半砖和上半砖交替，在 y = 30，平地 y = 4；去掉预热后 40 次开、40 次关合在一起取中位数）；10% 是部分方块的区块 `initChunk` | 中位 < 2 ms；平均 < 40 ms | P5（同样的屋顶在 y = 120 只打印不断言：关上缺口约 3 ms，整格石头屋顶走 M1 的代码也要约 2 ms） |
| 液体：性能测试的场景四周换成半砖 | 和整格的预算相同 | P6 |
| 收集：4000 格里 30% 是半砖和楼梯的船 | < 25 ms | P7 |
| 船体物理：1000 格里 30% 是半砖和楼梯、舱内保持密封的船，三种工况 | < 1.5 ms | P9（舱被凿开、灌水的同一条船着陆约 1.3～1.9 ms：贴近地面的采样点多了近一倍。记为遗留，见 ROADMAP） |
| `analyzeHull`：4000 格里 30% 是部分方块 | 不超过整格基线的 2 倍 | P9 |
| 采样点：整格的船点数不变；每个部分格子多出的点 ≤ 27（它的 3×3×3 个半格网格点） | 精确 | P9 |
| 网络：区块增量里单独的一个带缺口的格子、一个双部件格子（任意位置） | ≤ 7、11 字节（下标的差至多 3 字节，`y >= 64` 的单独一格就是 3 字节；带缺口的部件至多 4 字节；双部件 4 + 4） | P2 |
| 存档：分层地形的区块里已经有一个半砖，再加 k 个互不相邻的同一种半砖 | 每多一个多 ≤ 6 字节（把一个游程切成三段，多两个游程记号；调色板不变） | P2 |
| 存档：走调色板的整格区块 | 长度 = 现在的格式下的长度 − 2 × 调色板项数 + 各项 `cellSize` 之和（测试里按这个式子算期望值）；现有的三个大小上限不变 | P2 |
| 存档：`encodeChunk` 对分层地形的区块 | P2 开工前在自己的机器上量 5 次记下来，改完再量 5 次，中位数不超过 1.15 倍 | P2 |

`alloc.test.ts` 量的是字节，不随机器变；P3 开工时把 `tests/voxel/alloc.test.ts` 和 `tests/drive/alloc.test.ts` 加进 CI（`npm run test:ci` 现在把它们和计时测试一起排除了）。

## 16. 工作包

### 16.1 顺序和并行

```
第 0 波   P1 → P2                                  先后做，合并后才开始第 1 波
第 1 波   P3  P4  P5  P6  P7  P8a  P9              七个包同时做，各自一个检出，互不改同一个文件
第 2 波   P8b                                      等 P3、P6、P7、P8a 合并
第 3 波   P10                                      集成
之后      M2.4
```

- ROADMAP 的 P8 拆成两段：P8a 是射线（只动两个文件，可以进第 1 波），P8b 是交互和叠加层（要用 P3、P6、P7 的接口）。
- “互不改同一个文件”按 16.2 每个包的“文件”一栏执行。新测试一律放新文件；要改现有测试文件的，只改自己那一栏列出的。需要别的包的文件里改一行时，告诉负责集成的人，不自己改。
- 第 1 波的包只依赖 P1、P2 交付的接口（第 1～4 节、第 12.1 节里由 P2 先放好的 `hullCavityCells` 和 `isDryHalf`、第 13 节），彼此之间不调用对方的新接口。几个包都要用的东西因此都在 P1 里：掉落物的位置表 `DROP_POINT`（P6、P7、P9 各有一处生成掉落物的代码）、光照的值上查询（P5 的对照实现）。
- 每个包合并之后：`npm test`、`npm run typecheck`、`npm run build:artifact`、`node scripts/e2e-smoke.mjs` 都通过，游戏能玩。子 agent 不执行改变状态的 git 命令。
- 文档：P2 改 NETCODE 第 6、14 节，P8b 改第 10 节（第 13.2 节末尾），P10 改其余的。第 1 波的包不改 `docs/`：实现时不得不补定的规则写进各自的报告，由负责集成的人追加到本文末尾新开的“实现时补定的规则”一节（和 NETCODE 第 18 节同样的做法）。
- 标“难”的包（P3、P5、P9）用更高的思考强度并各配一名审查者；P1 和 P2 合起来配一名审查者；其余的包实现者自己写测试，第 1 波结束后做一次集成审查。对每条新规则都要做一次“去掉它，测试是否失败”的检查。

### 16.2 各工作包

**P1 编码与几何表**

- 目标：第 1、2、3 节。
- 文件：`src/blocks/cell.ts`、`src/blocks/shapes.ts`（新）、`src/blocks/registry.ts`（`CUTTABLE`、`opaque` 与 `lightOpacity` 的断言、删 `UNBREAKABLE` 表）、`src/net/protocol.ts`（只改 `CELL_MULTI_BIT` 的来源）；`tests/blocks/*.test.ts`（新）、`tests/shapes.ts`（新，值的部分）、`tests/core/layering.test.ts`（新）、`tests/core/foundation.test.ts`。
- 交付：第 1.2、1.4、2、3 节的全部常量、表和函数（含 `DROP_POINT` 和 3.2 的四个光照查询）。
- 测试：表的校验值和例子；`DROP_POINT` 按定义重算；24 个旋转的复合、求逆、和 `rotDir` 一致；规范顺序（含旋转后重排）；`mergeProblem` / `mergeCells` / `withoutOctant` / `withOctant` 对所有成对掩码的性质（结果规范、体积守恒）；`cellProblem` 对每条不变量的正反例（含 `0x0400`：id 为 0 而带状态）；绊线（带第 24 位而没有第二部件的值）在每个函数上都抛错；全域性（随机的、布局合法而语义不合法的值，第 3.1、3.2 节的查询和 `mergeProblem` 都不抛错）；光照查询对第 7.1 节的例子给出文中的结果；每个已注册方块的 `CUTTABLE` 和第 1.4 节的清单一致；整格方块的值不变。
- `tests/core/layering.test.ts` 检查三件事，扫描的写法照 `tests/net/layering.test.ts`（它已经覆盖 `src/net`，这里不重复；`src/client` 由 `tests/client/no-simulation.test.ts` 管，这里也不查）：
  1. **引用方向**。每个目录只能引用下表列出的目录（同一个目录内部不限；“只引用类型”指 `import type`）。表是按 `c20ea8e` 的实际引用关系和 ARCHITECTURE 的分层图定的，现有代码全部通过；M2.3 新增的引用（`voxel`、`mesh`、`light`、`structures`、`sim`、`save`、`worldgen` 引用 `blocks/shapes`）都在表内。

     | 目录 | 可以引用 | 另外只引用类型 |
     |---|---|---|
     | `core` | 无 | |
     | `blocks` | `core` | |
     | `voxel` | `core`、`blocks` | |
     | `worldgen`、`light`、`liquid` | `core`、`blocks`、`voxel` | |
     | `save` | `core`、`blocks` | `voxel` |
     | `structures`（含 `structures/physics`） | `core`、`blocks`、`voxel`、`save/cells`（只这一个文件：`serialize.ts` 调它的 `writeCell` / `readCell`） | `save` |
     | `entities` | `core`、`blocks`、`voxel`、`structures` | `save` |
     | `sim` | `core`、`blocks`、`voxel`、`worldgen`、`liquid`、`structures`、`entities`、`save` | |
     | `mesh` | `core`、`blocks` | `voxel` |
     | `art` | `core`、`blocks` | `render` |
     | `render` | `core`、`blocks`、`mesh` | |
     | `ui` | `core`、`blocks` | |

     表里没有的目录出现在 `src/` 下时测试失败（要求把它加进表）。
  2. **模块级的缓存**。在 `core blocks voxel worldgen light liquid structures entities sim mesh save` 这些目录里：不许有顶层的 `let` / `var`（现在一处都没有）；不许有顶层的 `const` 绑定到**空的**容器：`new Map()`、`new Set()`、`new WeakMap()`、`new WeakSet()`、`[]`、`{}`（带或不带类型参数）。例外只有方块注册表自己：`blocks/registry.ts`（`BLOCK_BY_KEY`、`TILE_NAMES`、`tileIndex`）和 `blocks/items.ts`（`ITEMS`），它们在模块初始化时由 `registerBlock` 填好。类型化数组的常量表（`new Uint8Array(n)` 之后在模块初始化时填好，例如第 2 节的表、`SOLID`、光照引擎的表）和带初值的字面量不在这条规则之内：扫描分不出“加载时填好的表”和“用到时才填的缓存”，后者靠审查；这条规则拦的是最常见的两种写法（`let cache = null`，空的 `Map`）。`tests/net/layering.test.ts` 里那条更严的规则（任何顶层的 `new`、数组、对象都算）搬不过来：模拟层里有两百多张常量表。
  3. **禁用的全局**。同样这些目录里（`save` 只查 `bytes.ts`、`cells.ts`、`codec.ts`、`crc32.ts`，存储适配器除外），代码里不出现 `window`、`document`、`navigator`、`performance`、`Date`、`Math.random`、`setTimeout`、`setInterval`、`requestAnimationFrame`、`localStorage`、`indexedDB`（ARCHITECTURE 硬性规则 1；现在一处都没有）。
  
  测试末尾照 `tests/net/layering.test.ts:253` 的做法，用几段故意写错的源码确认三条规则各自拦得住。
- 依赖：无。

**P2 存储与管线**

- 目标：第 4、13 节，第 14.1 节，第 16.3 节的过渡写法；任何一条路径都不再丢缺口和第二部件。系统的行为先不变（16.3）。
- 文件：
  - 存储：`src/voxel/{chunk,world,sgrid,grid,parts(新),fingerprint}.ts`。
  - 编解码：`src/save/{cells(新),codec}.ts`；`src/net/{protocol,codec}.ts`。
  - 服务器和客户端：`src/net/server/{capture,replicator,probe,intents}.ts`（`intents.ts` 只加 `SetCell` 命令）、`src/net/client/{apply,chunks,netclient}.ts`（`netclient.ts` 只加一处 `generatorSpecProblem` 的调用）、`src/net/host/host.ts`（同样一处）。
  - 模拟：`src/sim/{chunks,persist}.ts`；`src/sim/interact.ts`（只做三件事：四处读被瞄准格子的地方换成 `getPacked`、`blockBroken` 带第一部件的值、`CellProbe` 补 `getPart2`，见 16.3 和 4.4）；`src/sim/messages.ts`（只加 `toast.host.setCell`）；`src/sim/{rays,explosion}.ts` 和 `src/client/view.ts`（只换 `isDryHalf`）。
  - 射线：`src/voxel/raycast.ts`（只改命中处：`GridHit.cell` 填 `getPacked`；同时给 `GridHit` 加上第 6.1 节的 `octant`、`part` 两个字段，过渡期填 `0` 和 `cellPrimary(cell) & PART_MASK`，真值由 P8a 填）。`src/sim/interact.ts:525` 手写的那个 `GridHit` 字面量同样补上这两个字段，这样 P8a 合并时类型检查不会因为第 2 波才动的文件而失败。
  - 结构体：`src/structures/{serialize,assembly,collect,orient,hull}.ts`（只做第 4.5 节的加宽、`rotCell`、把 `hullCavityCells` 搬进 `hull.ts`、加 `isDryHalf`）；`src/structures/physics/helm.ts`（不再直接读 `grid.cells`）；`src/structures/manager.ts`（只改一行：`hullCavityCells` 改从 `./hull` 引用）。
  - 实体：`src/entities/{manager,fluids}.ts`（下落方块的存档字段和实体块的版本号、`isDryHalf`）。
  - 生成：`src/worldgen/generator.ts`（`generatorSpecProblem`，平地层的校验）。
  - 网格化输入：`src/mesh/{types,snapshot,mesher}.ts`（输入的两层、`checkInput`）、`src/client/{meshing,structures,game}.ts`（转交列表、调试接口、摘要）。
  - 测试：`tests/net/{digest,gen,codec,codec-pieces,apply,replica,chunks,intent-scenes,rig,host-status,hidden-cost,layering}*`（`layering.test.ts` 只加 `save/cells`）、`tests/save/*`、`tests/structcore/{serialize,helpers}*`、`tests/voxel/{world,sgrid}.test.ts`、`tests/voxel/{shape,robustness}.test.ts`（只给两个测试替身补 `getPart2`，文件其余部分归 P3）、`tests/mesh/{helpers,snapshot,worker}*`、`tests/mesh/cube.test.ts`（只给手写的 `MeshInput` 字面量补两层）、`tests/liquid/helpers.ts`、`tests/drive/client.ts`、`tests/shapes.ts`（网格的部分）、`tests/acceptance/g8-shapes-helpers.ts`（新）和 `g8-shapes-save.test.ts`（新）。
- 交付：第 4 节的存储和 `voxel/parts.ts`；`CellLayers` 贯通存档、协议、副本、网格化输入；摘要；`SAVE_VERSION = 4` 和两个子版本；调试命令；`isDryHalf`、`generatorSpecProblem`。
- 测试：
  - 第 4.5 节每条路径一个往返测试（部分格子、双部件格子、拼满的双部件格子）；只改缺口、只改第二部件各产生一次变更事件和一条增量。
  - 层：第一次写入带缺口或第二部件的格子时分配；计数回到 0 之后层还在、引用不变，而 `layers()`、`copyBox()`、`storage()` 给 `null`，编码和摘要与从没分配过时相同；带全 0 的层构造 `Chunk`、`loadBox` 按 `null` 收下；`resize` / `grow` 带着非零的层、丢下计数为 0 的层。
  - `setCell` 拒绝每一种不规范的内容；摘要对只差缺口、只差第二部件的副本报不一致。
  - 编解码：`Cell` 和 `CellVolume` 的新上限和拒绝、有界分配；编码器的三条规则（第 13.1 节），含调色板超过 `PALETTE_LIMIT` 的体；第 13.3 节列出的 `tests/save/codec.test.ts` 用例；结构体存档的稀疏游程往返，以及“包围盒不紧凑的坏数据在分配之前被拒绝”。
  - 不可信输入：客户端拒绝语义不合法的格子（快照、增量、结构体记录和增量、下落方块实体、两种事件各一例）和坏的生成器规格；主机拒绝存档里坏的生成器块；服务器收到 `Target.cell` 是布局合法的垃圾（重叠的部件、没注册的 id）时不抛错、按“目标无效”处理。
  - `SetCell`：第 14.1 节的四条各有一个被拒绝的例子（远离结构体的坐标、会超过格数上限、功能方块、未加载的列），拒绝之后存储没有变化。
  - 过渡期（16.3）：联机模式下瞄准并挖掉一个双部件格子、一个带缺口的单部件格子，全程不抛错，两端摘要一致。
  - 生成期间排队的带缺口增量；重发的结构体不留旧的层；模糊测试的生成器产出合法的部分格子和双部件格子。
  - 整格世界的行为类测试不改（第 15 节第 1 条）。**场景 47**（两种模式）。
- 依赖：P1。

**P3 碰撞核心与实体（难）**

- 目标：第 5 节。**场景 38**。
- 文件：`src/voxel/shape.ts`；`src/entities/` 除 `inventory.ts`、`input.ts` 以外的文件（含 `physics.ts` 的 5.10、`drive.ts` 的 5.8、`manager.ts` 的舵位和下落方块落地）；`package.json`（CI 里加两个分配测试）；测试：`tests/voxel/{shape,robustness,alloc,alloc-probe,helpers}*`、`tests/entities/*`、`tests/drive/*`（除 `client.ts`）、`tests/net/e2e-own-agree.test.ts` 和新的场景文件、`tests/acceptance/g8-shapes-move.test.ts`（新）。
- 使用：`solidFill` 的定义、三层存储、`solidAtHalf`、`solidFillAt`。交付：形状感知的全部盒子查询（签名不变）、`Penetration.octant`。
- 测试：
  - 现有测试原样通过。每个 `describe` 配一组部分格子的用例（半砖地板、半砖接缝、楼梯边、旋转的结构体上的半砖、挡在半层上的扫掠）。
  - 对照：对照实现 `overlapMargin` 推广到任意盒子；“把世界放大一倍、每个八分格当一个整格”的对拍（适用于场景里每个格子都按八分格处理的情形；比什么、法线什么时候比，照第 5.3 节）；只有整格方块时和 M1 逐位相同；直接扫描和经 `getPacked` 的结果一致。
  - 第 5.7 节：走上半砖、站着不下陷、不被接缝卡住（世界和结构体）、快速下落到半砖地板，各带“去掉规则就失败”的检查。
  - 第 5.8 节末尾列出的测试（零延迟和每 11 条丢 10 条，上行和下行，露天和楼梯间，世界和船；三处改动各自的去除检查；空中结束的上报的现状）。
  - 第 5.9 节逐条：潜行在半砖边、竖半砖旁；舵位在整格地板上、在下半砖和上半砖的地板上、座位下面没有地板的整格船（保持 M1 的位置）、把船镜像之后结果对称；下落方块落在半砖上。
  - 第 5.10 节末尾列出的测试。
  - 分配和性能用例（第 15 节）。
- 依赖：P2。

**P4 网格化**

- 目标：第 8.1～8.5 节。
- 文件：`src/mesh/mesher.ts`、`src/mesh/shapes/*`、`src/client/meshing.ts`；`tests/mesh/*`（`helpers.ts` 的三层已由 P2 加好，P4 可以再加辅助函数）、`tests/client/` 下新的网格化测试。
- 使用：`MeshInput` 的两层、`opaqueFill`、`faceCover`。
- 测试：
  - 逐个四分之一面的暴力对拍（随机掩码、双部件、玻璃 / 冰 / 树叶的自挡、模型邻居）。
  - 路径的划分：前面那一层 9 格和自己都不是部分格子的面，输出和 M1 逐字节相同（同一个场景里别处有部分格子）。
  - 顶点取值（第 8.3 节）：格角处等于 M1 的值；整格方块被拆开的面，在取样的格子里没有部分格子的棱中点上，值等于两个格角的平均；拆开的面和没拆的共面邻居在公共棱上的三个点处相等（差不超过 1）；地板上的半砖底边有接触阴影；部分格子不是整格的遮挡物。
  - 每个方块 × 一组掩码都能网格化、模型方块不带缺口。
  - 液体贴着 / 压着 / 在半砖下面（裁剪后的面积、共享顶点不变）；水旁边和水下面是玻璃半砖、冰半砖时，任何一个象限里都没有两个共面的面（第 8.4 节的三种情形各出现一次）。
  - 埋在地下的 section 里凿一个洞不再被当成“全实心”；确定性；性能（第 15 节）。
  - 浏览器里用 `debug.slab` 摆一组形状截图自查，其中一张是“墙脚 + 地板 + 旁边一块半砖”（第 8.3 节的 T 形接缝，WebGL2 和 WebGPU 各一遍，结果写进报告）。
- 依赖：P2。

**P5 光照（难）**

- 目标：第 7 节。**场景 44**。
- 文件：`src/light/engine.ts`；`tests/light/*`。
- 使用：第 3.2 节的四个光照查询（对照实现和测试用；引擎自己查表）。
- 测试：
  - 重写的对照实现（7.4）；随机编辑对拍加入部分格子，包括带预算的交错处理、区块进出、跨区块边界一侧有层一侧没有。
  - 场景 44 放在 `tests/light/` 里（光照只在客户端，服务器的验收世界没有光）。屋顶下面是暗的（天空光 0）：全是下半砖；全是上半砖，**墙砌到屋顶那一层**；一行下半砖一行上半砖交替；棋盘式交替；一层西半砖压着一层东半砖。透光：去掉一块；换成一块竖半砖（上下对齐的）；上半砖搁在墙顶上、墙没有砌到屋顶那一层时，屋里是亮的（边上的屋顶格 14），这一条断言的是规则本身。
  - 7.4 的泛洪检查（随机场景里，泛洪到不了的格子天空光为 0）；7.1 的已知近似写成一个断言现状的用例（空八分格只有 0 和 7 的格子透光）。
  - 发光：晶石灯半砖朝它贴着的每个面、以及经过自己空着的那一半发光；岩石下半砖加晶石灯上半砖的格子，正下方是暗的，侧面和上方是亮的，上下对调之后相反。
  - 只改缺口的变化会被处理（含“亮度不变但邻居要变暗”的情形，即 `cellChanged` 的第 3 步，带去除检查）；整格世界的值和性能不变。
- 依赖：P2。

**P6 液体、方块更新、爆炸**

- 目标：第 9 节（9.3 的落地除外，那在 P3）。**场景 46**，**场景 45** 的沙子和“失去支撑”部分。
- 文件：`src/liquid/fluids.ts`、`src/sim/{blockupdates,explosion,drops,rabbits,support(新)}.ts`；`tests/liquid/*`（除 `helpers.ts` 的三层拷贝）、`tests/sim/{blockupdates,explosion,rabbits}*` 和新文件、`tests/acceptance/g8-shapes-updates.test.ts`（新）。
- 交付：`supportOk`、按部件的 `drops`（位置按 `DROP_POINT`）、按部件的爆炸。
- 测试：第 9 节逐条；I7 的性质测试；爆炸在只有整格方块时随机数序列不变，双部件格子只炸掉被射线碰到的部件；结构体上凿掉支撑后火把掉落；掉落物的位置（整格方块在格子中心；带缺口的部件在它编号最小的八分格里，不和同格的另一个部件重叠）；掉落函数对带第 24 位的值、对整格内容都不抛错。
- 依赖：P2。

**P7 粘连、胶、组装与方块化**

- 目标：第 10.1、10.2 节，第 11 节。**场景 42**，**场景 43** 的组装、停靠、旋转部分。
- 文件：`src/structures/{stick,collect,assembly,orient,manager,rotor,serialize,structure}.ts`；帆数的单位涉及的几行：`src/net/codec.ts`（转子的 `sails` 两处）、`src/net/server/replicator.ts`、`src/net/client/{apply,replica}.ts`、`src/ui/views/helm.ts`；`tests/structures/*`、`tests/structcore/*`（除 P2 的两个文件）、`tests/acceptance/g8-shapes-stick.test.ts`（新）。旋转的新测试放新文件，不改 `tests/structures-contract/hull-orient.test.ts`（归 P9）。
- 测试：
  - 谓词对所有方块和状态仍然对称；上下两块上半砖不相连、并排的上下半砖不相连。
  - 胶：第 10.2 节“效果”表的每一行，世界、船、转子三种网格（场景 27 的三种情况；场景 42 的凿掉接触面；远侧的部件不删胶；并排的上下半砖之间的胶留着但不连接）；区块加载时的清理只按现状。场景 42 里“凿掉”用直接改格子来做。
  - 转子：轴心不碰轴承正面时 `'no_hub'`（轴心是远侧的半砖），碰到时照常。
  - `landing` 的五种结果，预览和提交一致；`DockPlan.conflicts` 的 `limit`；合并后的格子再组装整格带走；24 个朝向的停靠往返（形状和第二部件都转）；冲突时每个部件一份掉落，位置按 `DROP_POINT`。
  - 帆数按体积（绒布半砖 0.5，转子钩子跟着凿而变）；收集的预算。
- 依赖：P2。

**P8a 射线**

- 目标：第 6.1 节，以及 `sim/rays.ts` 里和它有关的部分（`displacedByHull` 按点、胶射线穿过空的八分格）。
- 文件：`src/voxel/raycast.ts`、`src/sim/rays.ts`；`tests/voxel/raycast.test.ts`、`tests/voxel/ray-helpers.ts`（新，对照实现；不碰 `tests/voxel/helpers.ts`）、`tests/sim/rays.test.ts`。
- 测试：现有用例原样通过（`GridHit` 只多字段）；对照实现的随机对拍（部分格子、双部件、旋转的结构体）；越过下半砖上方、打进楼梯的正确八分格和面、起点在格子里、正好过棱和角；整格的 `octant` 规则。
- 依赖：P2。

**P8b 交互与叠加层**

- 目标：第 6.2～6.4 节、第 8.6 节、第 10.3 节、第 14.2 节里标给 P8b 的部分、第 5.7 节的相机。**场景 39**，**场景 45** 的放火把部分。
- 文件：`src/sim/{interact,players,view,messages,placement(新)}.ts`、`src/entities/{inventory,input}.ts`、`src/net/{protocol,codec}.ts`（`Target.sub`、`Use.flags`、视图的 `sub`）、`src/net/server/intents.ts`、`src/net/client/{intents,inventory}.ts`、`src/client/{view,camera,uistate}.ts`、`src/render/backend.ts`（叠加层的字段）、`src/render/three/{overlays,boxgeom}.ts`；`tests/sim/*`（P6 的文件除外）、`tests/net/{intents,client-intents}*`、`tests/render/{overlays,assets}*`、`tests/client/{camera,glue-overlay}*`、`tests/acceptance/world.ts`、`tests/net/harness.ts`、`tests/acceptance/g8-shapes-parts.test.ts`（新）。
- 新消息键（`sim/messages.ts`）：`toast.glue.inner`、`toast.glue.touching`、`toast.place.twoParts`、`toast.dock.twoParts`。
- 测试：
  - 挖掘：分别挖掉一格里的两个部件各得 1 个方块；准星在部件内移动不重置进度，别人凿了它才重置；选取方块取被瞄准的部件；意图里目标部件被换掉按“无目标”。
  - 放置：点内面放整块；点格面、目标格里已经有部件时放整块被拒绝；花、火把、雪层放不进有部件的格子；半砖旁边站着人也能放、会重叠时拒绝；`planPlacement` 的两个分支和两种拒绝（`'occupied'`、`'twoParts'`，各自的提示），目标格是火把或花时拒绝。
  - 支撑：火把在下半砖上放不了、在上半砖上放得了；舵轮同样（下方顶面没盖满时用 `toast.place.support` 拒绝）。
  - 胶：点内面拒绝；两块接触时拒绝；对面那一格只在远侧有部件时可以涂；并排的下半砖和上半砖可以涂；副手胶的接触条件。
  - 停靠：有 `limit` 冲突时用 `toast.dock.twoParts`。
  - 叠加层：轮廓、裂纹（含单个八分格的掩码）、预览盒的几何；一个有胶的面产出的三项（盖住的、两侧各自露出的）和它们的象限；`mining.sub` 位 3 和高位的校验。
  - 相机在半砖天花板下的间隙；迈台阶的相机偏移。
- 依赖：P3、P6、P7、P8a。

**P9 船体物理与船体分析（难）**

- 目标：第 12 节。**场景 43** 的漂浮和吃水部分。
- 文件：`src/structures/hull.ts`、`src/structures/physics/*`、`src/render/backend.ts`（只有 `DryVolume`）、`src/render/three/{drymask,shading}.ts`、`src/render/three/backend.ts`（只有建干区三维贴图的 `makeMaskTexture`）、`src/client/structures.ts`（干区的上传）；`tests/shipphys/*`、`tests/structures-contract/hull-orient.test.ts`、`tests/render/drymask.test.ts`、`tests/render/{pose,backend}.test.ts`（只给 `DryVolume` 字面量补 `scale`）、`tests/acceptance/g8-shapes-ship.test.ts`（新）。
- 开工第一件事：加敞口船和 `analyzeHull` 的性能用例，各跑 5 次记下基线（第 15 节）。
- 测试：现有测试原样通过，整格的船采样点个数不变；半砖和楼梯的船吃水符合体积；半立方体的浸没高度对几组手算的值（跨两格、水面不满的格子）；竖半砖做的船，阻尼估计里的水线面面积是 1/2 格每列而不是 1；半砖船体停在平地上不下陷、不悬空；整格船滑过半砖台阶、贴着半砖厚的墙不穿过；叶片推半砖船；夹毁双部件格子一次去掉一个部件、一份掉落（位置按 `DROP_POINT`）；半砖围成的密封舱是干的；下半砖做的舷墙挡水到半格（上半砖做的舷墙让水从下面进来，那一层是敞开的）；`isDryHalf` 对混合格子逐个八分格；测试里的对照（`tests/shipphys/helpers.ts` 的穿透深度、能量）改成按八分格；性能（第 15 节）。
- 依赖：P2。

**P10 集成**

- 目标：场景 38、39、42～47 在直接和联机两种模式下通过（40、41 属于 M2.4）；去掉 16.3 的过渡行为残留；性能对照（第 15 节第 2 条的比法）；浏览器检查。
- 内容：联机的端到端测试加部分方块（中途加入时带部分方块的区块和船、组装和停靠时按部件守恒、副本里屋顶下的光照即场景 44 的联机版、溃坝遇到半砖）；带宽重量（凿得很多的场景下区块增量的大小，更新 NETCODE 第 5 节的估算）；`scripts/e2e-play.mjs` 加一步（用 `debug.slab` 摆半砖，走上去再走下来、挖掉一个部件、组装一条半砖船）；`scripts/e2e-room.mjs` 的两页摘要比较含部分方块；删掉 `tests/voxel/helpers.ts` 里不再有人用的 `referenceRay`；整体验证。
- 文档：把 DESIGN“M2 规则”里的“材质 + 形状”并进正文，连同第 17 节各个问题的结论（接触按象限重叠、一格两个部件的上限、胶在失去接触时的去留等）；更新 ARCHITECTURE 的“方块”“统一的体素网格”“网格与渲染”；NETCODE 加第 5.8 节的三处改动和已知限制（楼梯上连续丢包后在空中结束的上报）；ROADMAP 里“现有的两种工具下，一格最多两个部件”改成“存储只放两个部件，第三个被拒绝”，记下敞口船的遗留；LESSONS。
- 依赖：全部。

**M2.4 凿子与半砖**：第 14.2 节。**场景 40、41**；用真正的工具重跑场景 39 和 42。

### 16.3 过渡期：还没改造的系统怎么对待部分格子

P2 合并之后，世界里可以存在部分格子，但工具要到 M2.4 才有，所以只有测试和调试命令会造出它们。在某个系统的工作包合并之前，这个系统的行为定义为：**把有部件的格子当成第一部件材质的整格方块**（因为它只看 `getCell(...) & ID_MASK`）。带缺口的单部件格子和双部件格子都是这样。

| 系统 | 过渡期的行为 | 到哪个包为止 |
|---|---|---|
| 碰撞、实体 | 整格实心 | P3 |
| 网格 | 画成第一部件材质的整格立方体，看不到第二部件 | P4 |
| 光照 | 按第一部件的 id | P5 |
| 方块更新、爆炸、掉落 | 按第一部件的 id；爆炸把整格去掉，掉第一部件的一份 | P6 |
| 粘连、胶、方块化 | 整个面都算接触；目标格有部件就是硬冲突 | P7 |
| 射线、交互 | 命中整格，`octant` 为 0；挖掘去掉整格（两个部件一起），掉落第一部件的一份，`blockBroken` 带第一部件的值 | P8a、P8b |
| 船体 | 质量、浮力、接触都按整格 | P9 |

**不让绊线在过渡期里响**。没改造的代码拿着 `getCell` 的值（双部件格子带第 24 位）到处传；这个值一旦进了“接受整格内容”的函数就会抛错（1.2）。按包合并的任何顺序都不出错，靠下面三条，前两条是 P2 的工作：

1. **被瞄准的格子从源头起就是整格内容。** `voxel/raycast.ts:297` 把 `GridHit.cell` 填成 `getPacked` 的值（谓词仍然用 `getCell` 的值，它只看 id）；`sim/interact.ts` 里自己重读这一格的四处同样用 `getPacked`：`resolve`（520 行）、`recheck`（540）、`offhandGlue`（1191）、`breakBlock`（1273）。于是 `Target.cell`（`net/client/intents.ts:73` 从 `hit.cell` 抄来）、`recheck` 里的相等比较、挖掘和涂胶记下的格子值、传给 `sticksWithoutGlue` / `canGlue` 的参数，全都是合法的整格内容；它们在 P7、P8a 合并前后含义相同。只看 id 的地方（`& ID_MASK`）不受影响。
2. **事件带第一部件的值。** `breakBlock` 发 `blockBroken`、调 `spawnBlockDrop` 时用 `cellPrimary(cell) & PART_MASK`（去掉第 24 位）。`blockPlaced` 带的是新放下的整格方块，本来就合法。两种事件因此一直满足第 13.2 节“`< PART_LIMIT`”的检查，P8b 再把含义换成“被挖掉的那个部件”。
3. **按 id 的函数不设绊线。** 掉落的三个函数和 `canGlue` / `holdsGlue` 只读 id 位（1.2），所以它们换成新的实现前后，旧的调用处传什么都不出错。跨包的调用其实只有 `sim/interact.ts`（P8b，第 2 波）调 `sim/drops.ts`（P6）和 `structures/stick.ts`（P7）这两处，按前两条它传的已经是合法的值；`structures/assembly.ts`（`dropOf`、`spawnCellDrop`，65-77 行）和 `physics/dynamics.ts`（838-852 行）各有自己的掉落代码，不经过 `sim/drops.ts`。这一条是多一层保险。

第 1 波的包之间不调用对方的新接口（16.1），所以除了这三条没有别的交叉。P2 用一个联机模式的测试钉住它（瞄准并挖掉一个双部件格子，全程不抛错）。

过渡期里对整格的破坏性操作会连第二部件一起去掉而只掉一份，这只影响调试时摆出来的格子。存储、存档、网络、摘要从 P2 起就是完整的，所以每个包的测试都可以在两种模式下摆部分方块。整格方块的行为在任何时候都不变。

### 16.4 验收场景归谁

| 场景 | 归 | 文件 |
|---|---|---|
| 38 走上半砖、不下陷、不卡接缝 | P3 | `tests/acceptance/g8-shapes-move.test.ts` |
| 39 一格两种材质，分别挖掉 | P8b（两块半砖用直接写格子摆出来，挖是玩家的动作）；M2.4 用副手凿子把“放”也做成玩家的动作 | `g8-shapes-parts.test.ts` |
| 40、41 凿子 | M2.4 | |
| 42 按共享面粘连；面不接触时胶消失 | P7（“凿掉”用直接改格子做）；M2.4 用主手凿子重跑 | `g8-shapes-stick.test.ts` |
| 43 半砖和楼梯的船 | P7（组装、停靠、旋转）、P9（漂浮、吃水） | `g8-shapes-stick.test.ts`、`g8-shapes-ship.test.ts` |
| 44 半砖屋顶下面是暗的 | P5（`tests/light/`，屋顶的几种铺法见 P5 的测试），P10（联机版，读副本的光照） | |
| 45 火把与半砖；沙子落在半砖上 | P6（沙子、失去支撑）、P8b（放置） | `g8-shapes-updates.test.ts`、`g8-shapes-parts.test.ts` |
| 46 水不流进有部件的格子 | P6 | `g8-shapes-updates.test.ts` |
| 47 存档往返 | P2 | `g8-shapes-save.test.ts` |

验收测试照现有的写法（一条场景一个 `describe`，场景在 `w.sim` 上搭，动作经 `w.me`，两种模式的 tick 数相同）。每个文件里至少有一步是玩家的动作（走、挖、右键舵轮），这样联机模式跑到的不只是场景编辑。

第 1 波的验收测试不能依赖同一波里别的包：断言只写本包负责的结果。例如场景 45 的沙子只断言它最后落成方块的那一格（半砖上面那一格），这在 P3 合并前后都成立；场景 43 的组装和停靠部分不断言吃水。P10 再把跨包的断言补齐。

## 17. 需要负责人决定的事（已决定）

**负责人 2026-11-19 决定：11 条全部按“建议”。** 正文本来就是按建议写的，所以没有要改的地方；下面保留每一条的选项和理由，供以后重看。P10 把这些结论写进 DESIGN。

以后要改主意时：除了问题 10 的 (b)（那是换一套存储方案），代价都限制在一两个工作包里，各条里写了要改哪里。

1. **贴着半砖的顶面（内面）放整块方块，放在哪？**
   - (a) 放进上面那一格，和半砖之间空半格。
   - (b) 拒绝，提示位置不合适。
   - 建议 (a)。能在半砖上继续往上盖；空半格是“一格里不能既有部件又有整块”的直接结果。它和下面的半砖不接触，所以不相连、也涂不了胶。
2. **停靠或方块化时，要落下的部件和目标格里原有的部件不重叠，就合并成一格；之后这一格是一个整体。** 再次组装时，船会把合并进来的那块世界部件一起带走；合并出来的格子和它周围世界方块之间原有的胶，按“结构体落回方块时不产生新的连接”被去掉。
   - (a) 照 DESIGN 合并。
   - (b) 目标格里已有部件就算冲突（停靠被拒绝，转子停下时掉落）。
   - 建议 (a)。这是 DESIGN 两条已确认规则的直接结果，和“胶面靠上码头”那条暂定规则是同一类问题，可以到 M3 定粘性活塞时一起重看。
3. **舵轮下面的方块后来被凿掉或挖掉，舵轮掉不掉？** DESIGN 把舵轮和火把、花草并列（“要求下方格子的顶面被完全盖住”），但现在舵轮没有支撑规则，下面挖空了也不掉。
   - (a) 只在放置时检查；之后下面不完整了，舵轮留着，只是不再粘在下面那一格上。
   - (b) 和火把一样，失去完整的顶面就掉落（舵手被放下）。
   - 建议 (a)。(b) 会让别人在甲板上凿一下就把船的舵卸掉。
4. **哪些方块能切。** 规格里的清单见第 1.4 节：除了 DESIGN 点名不能切的，爆破箱也不能切（它和舵轮、轴承一样是“一个方块起头”的功能方块，点燃时整格变成实体）；晶石灯、玻璃、冰、树叶、矿石、草皮都能切。
   - 建议照清单。想让晶石灯不能切、或让爆破箱能切，改的是 `CUTTABLE` 的一个条件。
5. **挖掉一个部件要多久？** DESIGN 定了返还（1 个方块，不论剩多少），没定时间。
   - (a) 材质的硬度，和整块一样。
   - (b) 按剩下的体积折算。
   - 建议 (a)。涂胶的耗时用的是同一个数；(b) 会鼓励“先凿小再挖”。
6. **下台阶和潜行。** 走上半砖是直接迈上去的；走下来是一次约 0.2 秒的下落，连续的下行楼梯上人大半时间在空中，转向比平地迟钝。潜行时不会在半砖的边上停住（潜行护边只拦 0.6 格以上的落差，和“能迈上 0.6 格”对称）。
   - (a) M2.3 保持这样，试玩之后再决定要不要加“贴地下台阶”。
   - (b) 现在就加：在地面上行走时，脚下 0.6 格以内有地面就直接贴下去。它牵涉摔落计算、潜行护边和服务器的移动校验，属于 P3 的额外工作。
   - 建议 (a)。
7. **沙子落在下半砖上。** 按 DESIGN“沙子可以停在任何硬部件上”，它停住并变回方块，但沙子不能和半砖同格，只能占上面那一格：落定的一瞬间上移半格，和半砖之间留半格空隙。
   - (a) 照此实现。
   - (b) 落在没有完整顶面的格子上时变成掉落物。
   - 建议 (a)，和场景 45 的字面一致；(b) 只改 `landFalling` 的一个条件。
8. **生存模式里凿子凿一下要多久？** DESIGN 定了凿一下去掉一个八分格、不掉落，没定时间。如果按下即凿，按住凿子 36 tick（1.8 秒）就能凿穿任何可切的方块；挖掉它要按硬度计时（黑曜岩 10 秒，铁块 5 秒，矿石 3 秒）。凿子就成了穿墙最快的办法，联机时包括别人的墙。
   - (a) 两种模式都按下即凿（按住每 5 tick 一个）。
   - (b) 创造模式按下即凿；生存模式要按住，每个八分格用 `硬度 / 8` 秒，凿光一整块和挖掉它一样久，仍然不掉落。
   - 建议 (b)，第 14.2 节按 (b) 写。协议和叠加层已经为它留好（`mining.sub` 的位 3，第 6.3 节），选 (a) 只是 M2.4 里少做一段计时。
9. **“接触”按什么算？** DESIGN 的原话是“两格只有在共享的面上都有材质时才粘连、才能涂胶”。
   - (a) 两侧盖住的象限有重叠，即有共同的面积。并排的下半砖和上半砖只沿一条线相碰：不相连，它们之间的胶不起连接作用。
   - (b) 按字面：两侧在这个面上各有材质就算，上面那种情形相连。
   - 建议 (a)，第 10.1 节按 (a) 写。场景 42 的例子（上下两格的上半砖）两种读法结果相同。改成 (b) 是 `cellsTouch` 一个函数的事，代价是它和网格化剔面用的不再是同一个条件。P10 把结论写进 DESIGN。
10. **一格最多两个部件。** 两个部件都被凿小之后，格子里可以空出放得下第三个部件的位置（例：下半砖凿到只剩一个角，上半砖也凿到只剩一个角，另外半格全空），玩家会看到“空着却放不进去”。
    - (a) 上限两个。第三个放不进，提示“这一格已经有两个部件了”；停靠、转子停下时合并后会超过两个的格子，按冲突处理并在提示里说明。
    - (b) 不设上限。存储要从“一层稠密的第二部件”改成按位置索引的部件表，第 1、4、13 节和所有读第二部件的地方都要重做。
    - 建议 (a)，全文按 (a) 写。要让第三个部件有地方放，得先把两个部件都凿小，少见；(b) 的代价是整个存储方案。
11. **胶粘着的两块，把其中一块贴着胶面的材质凿光（它别的部分还在），胶怎么办？**
    - (a) 胶消失（DESIGN“之后那个面不再接触时，胶消失”，场景 42 的字面）。这样有一个不对称：那一块整个被挖掉时，胶留在另一块露出的面上（场景 27，已实现）；只凿掉贴着的那一半时，胶没了。
    - (b) 胶留在另一块露出的面上，两块不再相连；把凿掉的补回来、或者再贴上一块，就重新连上。规则变成一条：“面的两侧都没有材质了，胶才消失”。场景 42 的后半句要改成“……两格不再相连”。
    - 建议 (a)，第 10.2 节按 (a) 写，因为它不改已确认的文字；(b) 更统一，改起来是去掉第 10.2 节“胶什么时候消失”的第 2 条和它的测试。两种选法下，露出的面都能涂胶，往胶面对面的格子里放一个不碰这个面的部件也都不会把胶删掉。

## 18. 已定的设计

技术上的取舍，已经按下面定了；理由多数在正文里，这里列出结论和出处。

| # | 决定 | 理由 | 见 |
|---|---|---|---|
| 1 | 八分格 `o = ox \| oy << 1 \| oz << 2` | 位的编号就是轴的编号，旋转、半边掩码、象限都能直接按位算 | 1.1 |
| 2 | `getCell` 只返回第一部件（带第 24 位），第二部件另取；“一个数表示整格”一律用 `格子值 + 第二部件 × 2²⁵` | ROADMAP 要求热路径读到的值 < 2²⁵；其余地方用一个数，记录、Map 的键、`===` 比较都不用改 | 1.2 |
| 3 | 带第 24 位而没有第二部件的值，到处都抛错 | 71 处按 16 位存格子的代码里，漏改的会在第一次碰到双部件格子时报错，而不是丢数据 | 1.2 |
| 4 | 两个部件的顺序由几何决定：含最小被占八分格的在前 | 相同的内容必须有相同的数值（摘要、增量、目标比较）；和放置先后无关，合并时谁先到都一样；同材质时按 id 排序行不通 | 1.3 |
| 5 | 同材质的两个部件不合并成整格 | 一个部件对应一个物品，合并会吞掉一个 | 1.3 |
| 6 | 界面和协议用“含八分格 o 的部件”指部件，不用“第几个” | 部件的先后会因凿、挖、旋转而对调 | 1.3、6 |
| 7 | 盒子分解的最大值是 4（穷举验证）；表用带固定次序的穷举搜索定义，不用贪心 | 贪心在 16 种掩码上不是最少的；定义唯一，测试才能独立再算一遍 | 2.2 |
| 8 | 旋转表按 `(ax, ay)` 索引，放在 `blocks` 层 | `blocks` 不能引用 `structures` 的 `GridRot` | 2.4 |
| 9 | 形状查询分两层：值上的在 `blocks/shapes.ts`，网格上的在 `voxel/` | Worker 里的网格化和协议校验没有网格，也要用同一套 | 3 |
| 10 | 三层存储；第二部件层是 `Uint32Array`；层分配之后不释放，交出去时计数为 0 的层给 `null` | 照 ROADMAP；引用一旦不是 `null` 就一直有效，反复凿补不反复分配，tick 中途没有数组被拿走；摘要和编码只看非零项，所以写法仍然唯一 | 4.1 |
| 11 | `setCell` 的参数、变更事件的新旧值、`forEachCell` 都是整格内容；一格的修改是一次写、一次事件 | 签名不变，现有的调用和监听器不用改；钩子不会看到合并到一半的格子 | 4.2～4.4 |
| 12 | 碰撞只看占用：满的格子按 M1 的整格算法（逐位相同），其余按八分格在半格网格上跑同一个算法 | 整格世界零回归，可以用“现有测试一字不改”来验证；八分格的规则可以用“放大一倍的整格世界”对拍 | 5.1 |
| 13 | 推出时，挨着部分格子的整格也按八分格算 | 否则半露的面会被当成整面暴露，在接缝处把人横着推出去 | 5.3 |
| 14 | 扫掠时整格只在入口半层挡 | 和 M1“已经重叠的格子整个忽略”等价，结果逐位相同 | 5.4 |
| 15 | 台阶高度不变（0.6）；不加向下吸附；相机的台阶缓动只在客户端 | 半砖 0.5 本来就迈得上；吸附牵涉太多（见问题 6）；画面的事不进模拟 | 5.7 |
| 16 | 服务器的竖直余量加上 √2 × 水平位移（只在着地的上报上，并且两处之间阶梯路径走得通）；空中结束的上报不加，记为已知限制 | 连续丢包后走楼梯不被误纠正；沿对角线的楼梯升高是水平位移的 1.4 倍；√2·h 不依赖楼梯所在网格的朝向；没有“阶梯走得通”这个条件时一条上报能跳上 8 格高的墙（P3 的审查），所以加了它 | 5.8 |
| 17 | 射线的结果定义为“在半格网格上跑 M1 的 DDA”；谓词按部件 | 定义短，对照实现简单；整格的命中不变 | 6.1 |
| 18 | `Target.sub` 就是命中的八分格；不加新的目标字段 | 凿、补、挖、选取、放半砖需要的信息都能从“格子 + 面 + 八分格”推出 | 6.3、14.2 |
| 19 | 整块方块的目标格永远是“命中格 + 面的方向” | 一条规则同时覆盖格面和内面，`placementCell` 不用改 | 6.2 |
| 20 | 胶只属于格面；被点的格子和对面的格子接触时不能涂 | 胶的存储按格面；半露的面点得到之后，“已经挨着的两块不能直接粘”要显式保证；对面只在别处有部件时这个面是全露的，照常能涂 | 6.2、10.3 |
| 21 | 光照改成“过面”的模型：面通不通看两侧的不透明覆盖合起来有没有盖满；封死的面只放行贴着它的发光部件的光；涉及部分格子的变化多结算六个邻居；高度图按“直射到不到得了” | 只看一侧时，交替的上下半砖屋顶和错开的竖半砖会漏光；只看整格的 `emit` 时，灯光会穿过同格的岩石半砖；面被封上时这一格的亮度可以不变 | 7 |
| 21a | 一格只有一个亮度：格内不连通的空八分格之间仍然透光 | DESIGN 的规则是按面说的；要堵住得按八分格存光照 | 7.1 |
| 22 | 部分格子的介质不透光度取非不透明部件里最大的 | 冰的半砖和整块冰衰减一样，整格方块的值不变 | 7.1 |
| 23 | 走不走八分格路径按面决定（这个面自己的格子或它前面一层的 9 格里有部分格子）；八分格路径逐个发四分之一面，不合并 | 按格子的 26 邻域来定，会改掉半砖周围所有整格方块的面；不合并则规则简单，可以逐象限对拍 | 8.2 |
| 24 | 遮蔽和平滑光照按前方半层的八分格取样；棱中点和面心只在它取样的格子里有部分格子时才这样取，否则取格角的平均 | 格角处退化成 M1 的公式；拆开的面和没拆的共面邻居在公共棱上颜色相同，墙脚的阴影不变窄 | 8.3 |
| 24a | 液体的面按象限用两张掩码：不透明覆盖管朝外的一份，“封住”覆盖管里面的一份 | 玻璃、冰、树叶的部件自己画面，里面那一份再画会共面闪烁 | 8.4 |
| 25 | 液体的逻辑不改，靠不变量 I7 | 可切的材质都是硬的，有部件的格子对液体就是墙 | 9.1 |
| 26 | 支撑 = 下方顶面被硬材质完全盖住；重力方块 = 下方格子是硬的 | 照 DESIGN；后者不用改代码 | 9.2、9.3 |
| 27 | 爆炸按采样点所在的八分格付代价、做标记；标记仍按格子的先后 | 整格世界的随机数序列不变 | 9.4 |
| 28 | “接触”= 两侧盖住的象限有重叠（玩家看得见的规则，另列为问题 9） | 只沿一条线相碰的两块没有共同面积；和剔面用同一张表 | 10.1 |
| 29 | 安装面要求一整面被盖住 | 放置和粘连用同一条规则 | 10.2 |
| 30 | 胶的存留分两条：现状上只要有一侧还在这个面上就留；变更时“失去接触而那一格还在”就去掉 | 只看现状的规则无法同时满足场景 42（凿掉接触面，胶消失）和“往对面放一个不碰这个面的部件，胶不该消失”：两者的终态相同。整格时就是现在的规则 | 10.2 |
| 30a | 胶的叠加层一个面至多三项：盖住的部分、两侧各自露出的部分 | 半露的胶面，露出的一半要一直看得见，也是潜行右键去胶点的地方 | 8.6 |
| 31 | 粘连谓词的参数换成整格内容，函数名和参数个数不变 | 调用处只需要换取值的方式 | 10.2 |
| 32 | 落回方块：软的覆盖，硬的不重叠且不超过两个部件就合并，否则冲突；双部件的格子整格进退 | 照 DESIGN；格子是一个整体 | 11.3 |
| 33 | 船和转子的上限按格数；帆数和质量按体积，帆数的单位仍是“帆” | 上限保护的是存储和包围盒；整格时数值和断言不变 | 11.1 |
| 34 | 船体泛洪用“整格节点 + 八分格节点”的混合图，水位以半层计 | 稠密的半格数组在盒子上限处是 1600 万个节点；整格的船结果逐格不变 | 12.3 |
| 35 | 采样点：整格的面不动；和部分格子有关的面按四分之一面发 4 个角 | 整格的船点数不变；多出来的点只和部分表面的面积成正比 | 12.4 |
| 36 | 排水体分单位立方体和半立方体两组，两个循环 | 整格的循环不动 | 12.5 |
| 37 | 夹毁一次去掉一个部件 | 和“爆炸按部件破坏”“一个部件一个物品”一致 | 12.7 |
| 38 | 干区掩码在有混合格子时按八分格上传，有上限 | 半砖船舷两侧一干一湿，按格分不出来 | 12.8 |
| 39 | 存档的区块和协议共用一份 `CellVolume` 编码（放在 `save/cells.ts`）；结构体的存档保持稀疏游程，只共用 `Cell` | 旧存档反正作废；一份实现、一个模糊测试目标。结构体不用稠密的体：现在的读写只和格子数成正比，而且先校验后分配 | 13.1、13.3 |
| 40 | 解码的预算按字节比例计价，编码端同样计价 | 另外两层最多让每格多 5 字节；两端上限一致 | 13.1 |
| 41 | 校验分两层：编解码查布局，`cellProblem` 查语义 | 编解码保持“只看字节”；语义检查只有一份 | 13.2 |
| 42 | 摘要对没有非零项的层什么都不混入 | 整格世界的哈希不变；`null` 和全 0 等价 | 13.4 |
| 43 | 凿和补不加新意图；半砖方向随 `Use` 发送，不在服务器上保存 | 预览只依赖本地状态，不会和服务器不同步 | 14.2 |
| 44 | M2.3 期间用直接写格子（测试）和房主的调试命令（浏览器）造部分方块 | 规则说的是部件怎么表现，和它是怎么造出来的无关 | 14.1 |
| 45 | 过渡期里没改造的系统把有部件的格子当成第一部件的整格；被瞄准的格子从射线起就用整格内容，事件带第一部件的值 | 这是它们不改代码时本来的行为，每个包合并后游戏都能跑；`getCell` 的值不会流进带绊线的函数 | 16.3 |
| 46 | P8 拆成射线（第 1 波）和交互（第 2 波） | 射线只动两个文件、没有别的依赖；交互要用碰撞、支撑、粘连三个包的接口 | 16.1 |
| 47 | 点查询 `solidAtHalf`、`isDryHalf` 只收半格整数，不提供收小数的版本 | 非整数传给没被内联的函数要装箱（实测每次 48 字节），而是否内联不可控 | 4.4、12.1 |
| 48 | 推出的平局顺序保持“格子按 y、z、x，八分格按编号”；放大世界的对拍只在最优唯一时比法线 | 只有整格方块时就是 M1 的顺序；两种顺序只在完全平局时不同 | 5.3 |
| 49 | 路径检查加“阶梯”候选，从较低的一端走向较高的一端 | 楼梯间里“先竖直后水平”的折线被天花板挡住；一条规则同时覆盖上行和下行 | 5.8 |
| 50 | 声称着地而终点没有支撑的上报，按“没看到的落地”处理 | 身体先竖直后水平移动，半格深的踏面上常常落地后同一个 tick 又走出去；否则没有丢包也会被纠正 | 5.8 |
| 51 | 结构体推身体的偏向按“这个 tick 里相对身体多走的位移”算，权重取这段位移；推出方向和偏向相反时不论深浅都用偏向 | 半格厚的墙和叶片会把空中的身体从背面推出去；按速度差算时偏向指到了身体自己的竖直速度上 | 5.10 |
| 52 | 舵位只看座位那一列的半层；找不到地板时保持 M1 的位置 | 全是整数，和船的朝向无关；整格的船结果不变 | 5.9 |
| 53 | 掉落物出现在部件编号最小的八分格的中心（`DROP_POINT`，放在 P1） | 质心可以落在同格的另一个部件里；三个包各有一处生成掉落物的代码，共用一张表 | 2.1、9.5 |
| 54 | 轴心要碰到轴承的正面 | 否则转子隔着半格空气转；和其它连接一样用接触来判断 | 11.1 |
| 55 | 落回方块时“不重叠但超过两个部件”单列为 `LAND_LIMIT`，后果同冲突 | 玩家看到的是空位，提示要说明原因 | 11.3 |
| 56 | 半立方体的浮力用自己的浸没高度公式；阻尼估计有半立方体时按半层算 | 单位立方体的公式不能照搬；按整层分会把竖半砖的水线面面积算成两倍 | 12.5 |
| 57 | 每个载荷变了的存档块，自己的版本号加 1 | 每个块的读取代码只认识一种布局 | 13.3 |
| 58 | 生成器规格的检查只有一个函数 `generatorSpecProblem`，构造、客户端、主机三处调用 | 坏的层在客户端按协议错误、在存档里按损坏处理，而不是从构造函数里冒出一个普通异常 | 13.2 |
| 59 | `SetCell` 命令自己检查上限、功能方块和加载状态 | 它绕过了交互的流程；远处的一次写入会让结构体的存储无限扩张 | 14.1 |
| 60 | `planPlacement` 被拒绝时返回原因 | 两个部件的上限要有自己的提示 | 14.2 |
| 61 | 分层测试：引用方向按表；模块级状态只拦顶层的 `let` / `var` 和空容器；禁用的全局 | `src/net` 那条更严的规则会命中模拟层里两百多张常量表 | 16.2 |
| 62 | 性能对照：同一台机器上新旧代码交替运行，比中位数 | 同一份代码两次运行就差 1.1～1.7 倍，不能和表里的数比 | 15 |

## 19. 实现过程中定下的规则

规格没写到、实现时定下来的规则记在这里，按工作包分。和前面各节冲突时，以这一节为准（前面的正文已经跟着改过的不再重复）。

### 19.1 P1（编码与几何表）

- 出错的方式：`makePart`、`withHoles` 只做掩码（和 `makeCell` 一样），不检查；`canonCell`、`mergeCells`、`rotatePart`、`rotIndex`、`withoutOctant`、`withoutPartAt`、`withOctant` 对不合法的输入抛 `RangeError`（不是部件值、八分格编号不在 0～7、`ay` 和 `ax` 同轴、不能切的方块被切）。`partAt`、`otherPart` 是热路径，不检查八分格编号。
- `otherPart(c, o)`：八分格 `o` 是空的，或者这一格只有一个部件时，返回 0。`withoutOctant`、`withoutPartAt` 遇到空的八分格原样返回。
- `rotIndex` 不检查 `az` 是否等于 `ax × ay`；`az` 只用来转朝向类和轴向类方块的状态。
- `cellProblem` 的检查顺序：范围；第 24 位和第二部件是否对应；I1；每个部件的 id（非 0、已注册、不是 `B.UNLOADED`）、I2、I3；双部件格子的 I5（都有缺口、不重叠）、I6（顺序）。不检查状态位。
- `shapes.ts` 引用 `./defs`，方块表在第一次查表之前一定已经注册。
- 分层测试（`tests/core/layering.test.ts`）：目录按 `src/` 下第一级的名字算，子目录跟父目录；`src/` 下直接放 `.ts` 文件不通过；第三方包只有 `render` 能引用 `three`。

### 19.2 P2（存储与管线）

- `World.setCell` / `StructureGrid.setCell` 的检查是 `checkCanonical`：布局、第 24 位和第二部件对应、I1～I6。它不查 id 是否注册，那是 `cellProblem` 在不可信数据的入口做的事。
- 射线命中时只读一次 `getCell`，第 24 位置位才再读 `getPart2`。
- `isDryHalf(h, hx, hy, hz)` 收半格的整数坐标。P9 之前它回答的是“这个点所在的整格干不干”；P9 合并后逐个八分格回答。
- 网络编解码里三种宽度的格子：下落方块实体和平地生成器的层只能是整格方块（`writeFullCell` / `readFullCell`，< 2¹⁶）；方块事件带的是部件值（`writePartCell` / `readPartCell`，< 2²⁴）；其余是整格内容。语义检查（`cellProblem`）在 `apply.ts`。
- 空结构体的记录是 `{ base: new Uint16Array(0), holes: null, part2: null }`。
- 网格输入：`snapshotSection` 只在遇到非零项时才分配另外两层；`checkInput` 检查层的长度。
- `debug.setCell` 在本地只拒绝编不出来的值（`layoutProblem`，返回 `false`）；布局合法、语义不合法的值照样发给服务器，由 `SetCell` 的检查拒绝并回提示。`debug.slab` 把半砖并进副本里这一格现在的内容，放不下返回 `false`。
- `StructureGrid.adoptStorage(other)` 只给驾驶测试的夹具用。
- `encodeChunk` 的写缓冲从 4096 字节起。编码器只在需要比较时才累加 `rawBytes`（调色板形式小于格数时它一定赢），输出和每次都累加完全相同。

### 19.3 过渡期的标记（P10 清掉）

- `docs/NETCODE.md` 第 14 节里，`Target.sub`、`Use.flags` 第 1～3 位的检查标着“P8b 实现”，转子帆数按 `round(sails × 8)` 发送标着“P7 实现”。两个包合并后去掉这些标记。
- `src/liquid/fluids.ts` 里“只读基础层”的注释（第 4.5 节）由 P6 加。

### 19.4 P7（粘连、胶水、装配、落回世界）

- 接触类的判断（`autoSticks`、`mountSticks`、`sticksWithoutGlue`、`connectedCells`、`glueSideAt`、`glueFaceKept`）和 `sailVolume8` 遇到“第 24 位置位却没带第二部件”的值抛 `RangeError`（两个参数里任何一个 ≥ `FULL_LIMIT` 时才检查）。按 id 的判断从不抛错。
- `isSailCell` 保留为材质判断（看第一部件的 id）；`sailVolume8` 对每个部件各用一次。
- 轴心是有部件的格子（值 ≥ `FULL_LIMIT`）而且不和轴承接触时，收集返回 `no_hub`。整格方块的轴心按 M1：硬的总是接触；软的（火把、花草、雪层）仍然是轴心，帆不够时返回 `not_enough_sails`，帆数要求为 0 时能启动。
- `pruneGlueAt(oldPacked)` 在这一格现在是能涂胶的整格方块时直接返回：两条规则都不可能去掉面。
- 三个格子变化钩子（世界、船、转子）在胶存储不空、并且新旧内容至少有一个 `holdsGlue` 时才调 `pruneGlueAt`；两边都不能留胶（空气、液体、花草、火把）的变化不可能去掉任何面。液体状态的变化因此只多两次查表，和周围有多少胶面无关。
- 装配后对新结构体做的那一遍寿命检查（`pruneGlueAround`）把现在的内容当作 `oldPacked` 传进去，所以只有“状态规则”起作用。
- 挨着没加载的列的格子被凿掉一面时，那一面的胶立刻去掉：“失去接触”规则拿哨兵值（当作整格方块）来比。不管那一列里实际是什么，两条规则里总有一条会去掉它。
- 落回世界时被挡住的格子：掉落物取**转过之后**的格子，每个部件一份，第一部件在前，位置是目的地坐标里各自的 `DROP_POINT`，掉什么按各自的 `BlockDef.drop`（石头掉圆石）。被覆盖的软方块掉在格子中心。
- `landing()` 保留第 11.3 节字面上的分支“值 ≥ `FULL_LIMIT` 且 `solidFill(dest) === 0` → `LAND_OVERWRITE`”；按 I7，合法的格子走不到它。
- `BlockifyReport` 不加字段：并进去算作放下了。`DockPlan.overwritten` 只数 `LAND_OVERWRITE`。`DockConflict`、`DockPlanConflict` 带 `limit`（因为一格最多两个部件而放不下）。`isHardDestination` 删掉了。
- `STRUCTURES_FORMAT` 仍是 4，尽管转子的帆数现在按八分之一存：4 就是 M2.3 的布局，中间没有发布过。
- 协议里帆数用编解码器自己的 `Math.round(sails * 8)`（`net` 不能引用 `structures/`）。帆数是 1/8 的整数倍，所以没有误差；`varuint` 仍然拒绝负数和非有限值。
- 舵的界面按精确值显示帆数（`String(round(sails × 8) / 8)`），不再取整。
- 组装时的胶：只有一端被搬走的胶面，留在原地的那一端在这个面上（`glueSideAt`）胶才留在源网格，否则跟着被搬走的格子走。落地时的胶：落下的格子和这次没写的格子之间的胶面，只在那一格在这个面上时去掉（没加载的格子算在），否则只按状态规则。
- 停靠时清液体的格子：船里是空气、至少有一个干八分格（`assembly.ts hasDryOctant`，逐个八分格问 `isDryHalf`）。
- 收集的开销：打包后是 M1 的 1.04～1.06 倍，vitest 下是 1.12～1.21 倍。原因是分层存储的 `getCell` 加上循环体变大后在 vitest 下不被内联，不是队列里存整格内容。P10 比较这类循环时也要在打包后的构建里量。

### 19.5 P9（船体物理与船体分析）

- `hullCavityCells` 列出“没有硬八分格、至少有一个舱底或密封八分格”的格子，不管船浮不浮（原来的语义）。
- 采样点第二遍的顺序：格子按 y、z、x；方向 0～5；象限 0～3（P1 的 `quadrantOctant`）；一个象限里先内侧的八分格、后外侧的；角按第一遍 `FACE_CORNERS` 的顺序。第二遍的点落在第一遍某个单位面的边的中点上时，掩码并上那个面的方向（第 12.4 节，表 `FACE_EDGE_MIDS`）；`tests/shipphys/shapes-shape.test.ts` 断言每个点的掩码**等于**经过它的暴露面的方向。
- 8 个八分格都排水的混合格子算一个单位立方体，按 M1 的扫描顺序。
- `nearestOwnerCell`：8 个八分格都硬的格子用格子中心参加比较（同 M1），报告点所在那一侧的八分格（点在中间平面上时取朝目标的一侧）；部分格子里，闭包含这个点的每个硬八分格用自己的中心参加比较。
- 探测器走整数路径时报告点所在的八分格（`x − cx ≥ 0.5`），所以几何上是满的双部件格子也说得出该夹毁哪个部件。
- `ProbeTarget.hasPartial` 是快速路径的标志：目标有部分格子时才做那 7 次 `isPartial` 查询。
- 世界补丁：`PF_PARTIAL` 和 `PF_SOLID` 互斥；格子级的 `isOpen` 是两者都不是；`isOpenHalf` 是“不硬”（世界里没有密封的八分格）；补丁之外由 `solidFillAt` / `solidAtHalf` 回答。
- `collectCorners`：周围 8 格里有部分格子的整数点改在半格网格上取；奇数的半格点由第一个闭包含它的部分格子发出（不建稠密的半格表）。
- 接触记录多一个字段 `F_OCTANT = 83`，`STRIDE = 84`。
- `destroyPinnedCell` 在 `removePartAt` 之后算掉落位置（这次写入不改位姿），用被去掉的部件的填充查 `DROP_POINT`。
- `rotorMass` 把每个部分部件当作在自己质心上的质点（没有自身项），和 M1 对方块的做法相同。
- `estimateDampingHalf`：水线是累计体积第一次达到 `质量 / ρ` 的半层；`ymax` 包括单位立方体的上半层。
- `DryVolume`：盒子仍以格为单位，多一个 `scale`；纹素下标是 `tx + tz × (sx × scale) + ty × (sx × scale) × (sz × scale)`。`DRY_MASK_MAX_TEXELS` 从 `structures/hull.ts` 导出。`render/three/backend.ts` 里 `setStructureDryVolume`（字节数、同尺寸判断、存下的记录）和 `assignDrySlots`（层数 = `sy × scale`）跟着 `scale` 走。
- 部件全都不硬的部分格子（按 I3 不可能出现）在灌水时当作一个整格节点。
- 性能预算（第 15 节）量的是舱内保持密封的船。把壳也凿开、舱里灌水的同一条船着陆时超出预算，原因是贴近地面的采样点从约 3900 个变成约 7200 个（第 12.4 节的四分之一面），地形接触和探测器的开销跟着涨。整格方块、舱口敞开的 1000 格船着陆是 1.03～1.06 ms，在预算内。
- `tests/shipphys/perf-shapes.test.ts` 是计时测试，不进 `test:ci`（`--exclude "**/perf-*.test.ts"`）。

### 19.6 P4（网格化）

- “带层的任务” = `holes !== null || part2 !== null`。全零的层也走带层的路径，输出和没有层时逐字节相同。
- 带层的任务里，“遮挡物”（模型和液体的 `sampleVertex`、`raiseFromLayerAbove`、八分格取样）一律指“8 个八分格都不透明”（`opq === 0xff`）；没有部件的格子就是 `INFO_OCCLUDER`。
- 模型和液体的 `covers(q, face)`：邻居是部分格子时看 `faceCover(opq, face) === 15`；否则看这个 id 的 `INFO` 覆盖位（所以雪层仍然盖住它下面的面；雪不能切）。
- 第 8.2 节的规则 3 只用于整格的邻居（部分格子的邻居不会是模型）。
- 不合法的格子（合法的存储不会产生，但网格化不能崩）：第一部件是带缺口的模型或液体时，由它自己的发射器画成完整的；第二部件不是立方体类的不画。
- 被埋住的部分格子（它和六个邻居的八分格全都不透明）什么也不发，和规则 1 逐面得出的结论相同。
- 求平均用的角上的值是挨着那个角的象限的 `O(V)`，只从前面一层算（格子在那个角上没有材质时也有值）。
- 液体裁剪后的属性：(u, y) 处的值在这个 u 上的底边值和顶边值之间按 `y / H(u)` 线性插值，底边、顶边的值各自对 u 线性（在原来的角上精确）；贴图坐标由位置得出；AO 是 255；顶边上新增的顶点只有两个顶角都带波动标志时才带，顶边以下的顶点从不带。平的面（底面、满高的顶面）按象限对角上的属性做双线性插值，两面共用一条对角线（和 `commitDoubleSided` 一样）。
- 侧面在 y = 0.5 被裁开可能剩下三角形：所有几何都是四边形，三角形写成“最后一个角重复一次”的四边形，五边形是一个四边形加一个这样的三角形。`tests/mesh/helpers.ts checkInvariants` 只在显式传 `{ paddedTriangles: true }` 时接受这一种退化（重合的一对角是 2、3 或 1、2，另一个三角形面积为正），只有带部分邻居的液体测试这样传；其余测试仍然不接受任何零面积三角形。
- 侧面对着两个掩码都是 15 的部分邻居（比如远侧有一块半砖）时，和 M1 的双面逐字节相同；朝外 15、朝里 0 是 M1 的单面。
- 液体面上象限的编号按第 2.3 节（`quadrantOf`）：位 0 是沿编号较小的切向轴的那一半，用绝对坐标。
- 部件的四分之一面按部件（存储顺序）、方向 0～5、八分格 0～7 的顺序发出。
- `qao` 里存的是 AO 字节而不是级别（`MeshContext` 内部的事，输出相同）。`boxFace` 拆成了 `boxFaceCorners` 加提交两步，行为不变。没被盖住的象限不合并成矩形（第 8.2 节）。
- 性能：复用同一个 `Mesher` 的各个用例都在 M1 的 1.03 倍以内。“每次新建 `Mesher` 网格化一个全空的盒子”是 1.24 倍（多 4 µs：`MeshContext` 多了约 20 个字段），游戏里不出现这种情况（全空的 section 不进网格化，网格 Worker 只有一个 `Mesher`），预算（< 0.05 ms）有余量。
- 整格方块的输出和 M1 逐字节相同：60 个随机盒子的输出哈希 `be459147` 钉在 `tests/mesh/shapes-path.test.ts` 里。
- T 形接缝（第 8.3 节）：两个渲染器的截图里没有亮点或裂缝，没有做扇形三角化。
- 液体侧面两半要留的象限相同时只在 `y = 0.5` 裁一次，不在水平中点拆开（第 8.4 节）：拆开会在顶边中间多一个顶点，一个顶角带波动标志、另一个不带时它不跟着波动，侧面在那里会比水面高出最多约 0.04 格。
- `MeshContext.quarterFace` 每个格面、每个平面只算一次顶点的值，第 8.3 节求平均用的角上的值共用这份缓存；输出不变（1500 个随机带层场景的哈希 `4bb62d66` 前后相同），八分格路径快约 12%。调用约定：前面的八分格不透明的四分之一面不调 `quarterFace`。
- 性能测试多一个“露在外面”的 section：至少一半格子是部分格子、没有一个被埋住，断言八分格路径每个四边形的开销不到整格路径的 1.5 倍（同一测试里交替测）。

### 19.7 P5（光照）

- 区块“有层” = `chunk.holes !== null`；一格是部分格子 = `holes[i] !== 0`（有第二部件就一定有缺口，第 4.1 节、I5；层不会被释放）。
- 分派按面、按格子，不是第 7.3 节写的按区块：两个整格之间的面走 M1 的那一步，即使区块有层；挨着部分格子的面走第 7.1 节的规则。两者的值相同（不透明的整格恒为天光 0、方块光 `EMIT`，正是 `emitInto` 穿过封闭面给出的值），有随机对拍钉住。
- 一格的方块光源是 `emit(c)`，加上挨着部分格子的那些封闭面上的 `emitInto − 衰减`。两个整格之间的封闭面沿用 M1 的记法（不透明的发光邻居算支撑者）。`pull` 也算封闭面上的 `emitInto`。
- 第 7.2 节里 `runRemove` 那个可选的跳过（邻居自己把朝 r 的面盖满了就跳过）没有实现；多去掉一些总是安全的。
- 增量更新高度图：改动在 y、原高度 `hOld`，只在 `y ≥ hOld − 1` 时处理。天光在 y 停下，高度是 y + 1；否则在 y − 1 停下，高度是 y；否则若 `y ≤ hOld`，从 `max(y − 2, −1)` 往下重扫（y = 0 的改动不会写出 −1）；否则高度不变。
- `cellChanged` 在 `oldCell === newCell` 时直接返回。参数是部分格子时，它当场把整格内容拆成部件，往下只传部件（第 4.4 节）；`sameLight` 判断“和光照无关”的那第三种情况。
- 引擎有一个只增不减的标志 `shapes`：点亮过带缺口层的区块、或者听到过涉及部分格子的改动之后置位。置位之前不做“挨着带层区块”的检查，所以只有整格方块的世界跑的就是 M1 的代码。
- `initChunk` 的边界交换里，新区块的发光部件穿过封闭面照进旧区块的那部分 `emitInto`，由新区块自己铺光时送过去；交换本身只算新区块这一侧的 `emitInto`。
- 旧的对照实现保留为 `tests/light/reference-m1.ts`，只用来核对新旧两个对照在整格方块上一致。和 M1 逐字节相同由 `m1-equality.test.ts` 里取自 M1 引擎的哈希钉住。第 7.4 节点名要加部分格子的 `engine.test.ts randomEdit` 和 `terrain.ts` 没有动（第 15 节第 1 条），带部分格子的随机对拍在新的 `tests/light/shapes-fuzz.test.ts` 里。
- 已知的开销：一个区块只要有过一个部分格子，它里面所有的光照工作（离那一格很远的也算）都是原来的 1.2～1.4 倍（`fullAround` 的六次邻居读取、`spreadFromFull` 里逐邻居的缺口判断）。第 4.1、7.3 节接受这一点，没有预算被打破；M2.4 起玩家凿过的每个区块都处于这种状态（见 ROADMAP）。

### 19.8 P6（液体、方块更新、爆炸、掉落）

- 推力的权重：值小于 `FULL_LIMIT` 的格子是 1（所有整格方块，包括火把、花、舵轮这些模型，它们的 `volume8` 是 0 或 8）；其它格子（按 I7 是硬的）是 `volume8 / 8`。权重同时乘在冲量和这一格在作用点里的权重上；作用点仍是格子中心，不用部件的质心。
- 爆炸里“被船体挡住”的条件和 `sim/rays.ts displacedByHull` 完全相同：点在船的硬八分格里，或者 `isDryHalf` 在 `floor(2 × 局部坐标)` 处成立，不管这一格里还有什么（旧代码只在船的空格子里问干舱）。这是第 9.4 节“只有整格方块时和现在相同”的唯一例外。“相同”指判断式本身；喂给它的东西有两处和 `displacedByHull` 不同，M1 就是这样：船体分析过期时（同一个 tick 里刚改过船）爆炸当作没有干舱，而射线的 `hullOf` 会重新分析；转子的硬八分格也算挡水，`displacedByHull` 只拿到船。
- 爆炸的标记和清除：每个网格按第一次标记的顺序记格子，以及每格里被标记的八分格；清除时重新读这一格，部件的占用碰到被标记的八分格、并且炸得动，就去掉；剩下的用一次带 `SET_EXPLOSION` 的 `setCell` 写回。写完之后先第一部件、后第二部件：火药箱被点燃（一次 `rng.int`），别的部件在掉落开着时各掷一次 `rng.next`。取样点所在的八分格按每个轴 `p − floor(p) ≥ 0.5`。
- 支撑有两个入口：规格里的 `supportOk(def, below)`，和 `supportOkAt(def, grid, x, y, z)`（方块更新用它，不形成整格内容）。两者永远一致（有测试）。
- 结构体的格子变化钩子对任何内容变化都重新排队，包括只变状态的（转了朝向）；重新判断是幂等的，只多一次查表。
- 雪层、草丛、花都按“下面那一格的顶面被硬材质盖满”（`'solid'`）判断支撑。
- 掉落物的位置：见第 9.5 节（点是物品的中心）。三处生成掉落物的代码（`sim/drops.ts`、`structures/assembly.ts`、`physics/dynamics.ts`）做法相同。
- 液体的开销：有部分格子的世界里，“25 个水源”的探针是同一场景整格地板的 1.13～1.36 倍（交替运行；范围随机器负载变），来自分层的 `World.getCell`（每次读多约 20%）；在预算内。液体的判断只读 id 和状态位（I7），所以给 `World` 加一个只读基础层的读取、让 `fluids.ts` 的 16 处 `getCell` 都用它，不改变任何判断；审查的实验里这样回到 0.98～1.04 倍（P10 做）。
- 爆炸逐步的代码里，值小于 `FULL_LIMIT` 的格子（空气或整格方块）不拆成八分格：标记记在八分格 0 上，清除时不读标记。带船的爆炸因此回到 M1 的 1.03～1.09 倍（审查时是 1.5 倍）。
- `tests/sim/explosion-fullblock-fingerprint.ts` 钉住整格方块世界的爆炸结果（取自 `c20ea8e`）。

### 19.9 P8a（射线）

- 射线进入部分格子的时刻正好也穿过这一格的某个中间平面时，第一个八分格的面是这一格的进入面（被穿过的格子边界所在的轴），不是所有被穿过的平面里最“陡”的那个。这是按第 6.1 节实现要点的那一句（“第一个八分格沿用外层的进入面”），也和整格方块一致（它们总是报格子级的面）；只在精确相等时有区别。
- 八分格由射线参数算出：运动的轴上是 `(hm ≤ t) XOR (向负方向运动)`，`hm` 是中间平面的参数；不运动的轴看起点在哪一半。和 DDA 用的是同一套算术，所以八分格和格子的判断不会因为舍入而不一致。
- 中间平面和格子边界同时被穿过时，射线离开这一格：过了这两个平面的那个八分格在下一格里，当前格里只在那条棱上被碰到的八分格不算进入。
- 射线经过部分格子时，只要第 24 位置位就读 `getPart2`（要知道第二部件占哪些八分格、谓词收不收它），不只在命中时读；整格方块和单部件的格子从不读。
- `displacedByHull` 在八分格判断之前保留格子级的范围检查（`hx >> 1` 对 `cellBounds()`）。
- `GridHit.cell` 在命中双部件格子时是一个堆上的数（第 6.1 节要求它是整格内容）：由已经读到的 `getCell` 和 `getPart2` 在命中对象里拼出，不存进别的对象、不传给别的函数，所以只多一个堆上的数。部分格子里的 2×2×2 DDA 用 `raycastGrid` 自己的局部变量，不建每条射线的状态对象：穿过部分格子而没有命中的射线不分配，命中部分格子和命中整格的分配相同（只有命中对象）。世界的射线直接读 `origin` 和 `dir`（世界的变换是恒等），不经 `toLocal` 拷贝，所以世界上的射线不依赖内联。两种内联条件下都由 `tests/voxel/ray-alloc.test.ts` 钉住。
- 整格方块世界里射线的开销：实现时量到 M1 的 1.07～1.10 倍（每次命中要算八分格，每格多一次比较）；审查后的修复把八分格的遍历改成局部变量，再量是 0.90～1.09 倍（中位数，7 轮交替）。P10 在空闲的机器上定数。
- `cellDisplaced` 对有部分格子的船体含义变了：世界里的一格水“全部被排开”要求每个内缩的取样点都在硬的或干的八分格里。服务器对水桶目标的检查跟着变。对和世界对齐的船体这是精确的；对偏移或转过的船体，九个取样点可能漏掉一条没被排开的窄带（整格船体时比内缩量 0.1 还薄，挨着部分格子时最多约四分之一格），服务器因此会拒绝客户端射线够到的水。接受：拒绝什么也不改变。
- `partlyDisplaced(ships, x, y, z)`：世界格子 8 个八分格的中心里任何一个被船体排开就为真。倒液体的检查（`sim/interact.ts bucketClick`，P8b）用它，不再只问格子中心：格子中心在三个中间平面上，按半开区间只代表八分格 7。
- 一格里射线所在的第一个八分格总是报格子级的面，和这个位置上的整格方块一样：起点在这一格里面、正好在某个中间平面上时也是这样（报射线主方向的反面，不报起点所在的那个中间平面）。

### 19.10 P3（碰撞核心与实体）

- `Penetration.octant`：整格单元是 −1，否则是八分格编号；`cx, cy, cz` 仍是这个单元所在的格子。并列时先按格子比，再按扫描顺序 y、z、x 和八分格编号。
- 走不走 M1 的路径只由格子决定：世界的推出看“范围外扩一格”、2×2 个区块以内；水平扫掠看盒子自己所在的列（没有进入新的半层时直接返回，不查区块），或者扫到的第一列所在的区块；结构体没有层时走 M1 的路径。全零的层走一般路径，答案相同。
- `forEachSolidCellOverlapping`：整格在它的单位立方体和盒子重叠时访问（只有宽度为 0、正好落在格子中间平面上的盒子 `octants` 才是 0）；部分格子只在 `octants != 0` 时访问。
- 5.8 第 1 条：`√2·h` 只在上报以站立结束（`groundOk`）、并且两处之间阶梯路径走得通时才加；阶梯的结果路径检查接着用。第 4 条：落在边上要求上一条被接受的上报在空中、并且这条不是纪元的第一条。
- 5.10：身体自己的位移从 `move()` 开始时的位置量起。载体从不推身体，固定的倾斜偏向不变。
- 舵位的候选依次是半层 `2sy`、`2sy + 1`、`2sy − 1`，每个都要四个空的半格和脚下一个硬的半格；都不行时用 M1 的规则。
- 结构体的粗筛盒子（`StructRec` 的范围）按硬八分格在半格网格上逐面收紧（一个面的整层边界格外侧一半都空时往里收半格；软方块不收），每个网格版本重算一次，只对有层的网格做。站在半砖甲板上的身体因此在粗筛盒子之外，和站在整格甲板上一样。
- 客户端驱动的玩家被 `'unstick'` 挪出方块时不结束下落。
- 联机一致性测试（楼梯）：客户端 `onGround` 为真而服务器为假，只在服务器的身体终点下方 `SUPPORT_GAP + REPORT_SUPPORT_REACH` 以内没有支撑时允许（并计数）；纠正和拒绝仍然必须是 0。
- 场景 38 的海上木筏会微微倾斜，所以“不下陷”断言的是在甲板坐标系里高度不变（1e-6），比站在整格甲板上高半格（1e-2）。
- `landFalling` 保留 `REPLACEABLE[here & ID_MASK]`：有部件的格子第一部件是硬的，所以落进去的下落方块变成掉落物。
- `test:ci` 现在跑两个分配测试（`tests/voxel/alloc.test.ts`、`tests/drive/alloc.test.ts`）。
- 性能（在繁忙的机器上交替测得，P10 在空闲时重测）：实体 tick 是 M1 的 0.99～1.03 倍；微基准里水平扫掠约 1.02 倍，身体跨在区块边界上时 1.35～1.67 倍（5.4 要求检查那一层）；世界的推出 1.13 倍。
- 已知的、M1 就有而没有改的：每隔一条上报声称着地的长距离下落，会早一条上报落地（30 格的下落伤害 24 而不是 27）；L 形楼梯上每 11 条上报丢 10 条仍被纠正一次（`check:speed`）。
