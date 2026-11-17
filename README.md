# Blocklands（方块大陆）

原创体素沙盒，网页打开即玩。核心玩法是可组装的多方块结构：会转的机械（风车、转盘）和会漂的物理船。哪些方块连成一体，由"自动粘连 + 强力胶"决定。液体按原版 MC 规则。

一版单文件原型已经验证过玩法（未上传）。本仓库从零重写；各里程碑的范围和完成情况见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 运行

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run build:artifact
```

- `npm run dev`：本地开发服务器。
- `npm test`：全部无头测试（模拟层在 Node 里步进），含 `tests/acceptance/` 下 24 条验收场景。
- `npm run typecheck`：类型检查。
- `npm run build` 产出普通静态站 `dist/`；`npm run build:artifact` 产出单文件 `dist-artifact/blocklands.html`（JS 内联、Worker 走 blob URL，无任何网络请求）。
- `node scripts/e2e-smoke.mjs`：端到端冒烟测试（Playwright，WebGL2 与 WebGPU 两种模式）。
- 渲染默认走 WebGPU，不可用时自动回退 WebGL2；地址后加 `#webgl2` 可强制 WebGL2。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/DESIGN.md](docs/DESIGN.md) | 规则与架构要求（必须遵守） |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 重写版的代码架构与约定 |
| [docs/LESSONS.md](docs/LESSONS.md) | 原型踩过的坑和解法方向 |
| [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) | 验收场景（实现成自动化测试） |
| [docs/NETCODE.md](docs/NETCODE.md) | 联机协议与同步的实现规格 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 前提、里程碑、完成标准和进度 |

必须原创：名字、贴图、UI 都不能模仿 Minecraft。
