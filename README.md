# @xindong/dsh-canvas

DeepSeek Harness 的 UI 无关画布底座。它是画布文档的唯一权威数据源，按 Agent Session 自动分板，并向 Agent 提供两个工具：

- `canvas_read`：按 id、类型或边界读取节点。
- `canvas_write`：在一次事务中创建、更新或删除节点。

文档以 PixiBoard 的扁平 JSON 格式持久化到 `$DSH_HOME/canvas`。每次成功写入只增加一次 revision；调用者可传 `expected_revision` 做乐观并发控制。

## 安装

```bash
dsh plugin --profile web add github:xindong/dsh-canvas
```

本地开发：

```bash
dsh plugin --profile web add /absolute/path/to/dsh-canvas
```

## 服务 API

Host 插件可通过 `ctx.canvas` 调用：

```js
await ctx.canvas.snapshot(boardId)
await ctx.canvas.read(boardId, query)
await ctx.canvas.write(boardId, { expectedRevision, operations })
await ctx.canvas.replace(boardId, { expectedRevision, document })
const unsubscribe = ctx.canvas.subscribe(boardId, change => {})
```

Core 不含任何 UI、HTTP 路由或 PixiBoard 运行时。Web、桌面端或其他宿主应各自提供显示适配。
