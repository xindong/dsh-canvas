# DSH Canvas

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Agent 一块可持续编辑、与用户共享的画布。

`@xindong/dsh-canvas` 是数据与工具层；[DSH Client Canvas](https://github.com/xindong/dsh-client-canvas) 提供浏览器界面。画布、节点、连线与原始资源保存在 DSH 所在机器，Agent 和 Web UI 操作同一份数据，不另建浏览器文档副本。

## 能做什么

- 管理多个全局画布，Agent 默认操作用户当前选中的画布，也可明确指定 `board_id`。
- 用 `canvas_read` 读取节点、资源和有向关系，用 `canvas_write` 原子修改节点、连线与布局。
- 从本地文件或公网 HTTP(S) 地址导入图片、视频、音频和文件。
- 用 processing 节点表示待处理内容，完成后原位转换，保留 ID、位置和连线。
- 通过 revision 校验处理 Agent 与用户同时编辑；一次节点/连线事务只增加一次 revision。
- 可配置系统说明、动态画布概况和节点 Agent 提示词；支持密集区域分析和显式视口请求。

本包不提供 UI，不绑定任何 AI 模型、媒体生成平台或云账号。生成图片等任务由你已配置的 DSH 工具完成，再导入结果。

## 安装

基线：Node.js **22.18+**、DSH **>=0.2.0-rc.2 <0.3.0**、Cordis **4.0.5**。DSH peer 依赖使用兼容范围，避免更新宿主后因精确版本锁定而被安装器拒绝；不支持低于基线的宿主。

```bash
dsh plugin --profile web add github:xindong/dsh-client-canvas
dsh web
```

Web 组合包会安装本包并按顺序启用画布服务与界面，用户无需单独安装 Core。只需要后端工具时才单独安装本包：`dsh plugin --profile web add github:xindong/dsh-canvas`，宿主仍需提供 `tools` 和 `systemPrompt` 服务。两种安装方式都共用原有画布目录；不要同时启用 Core 自己的组合包和 Web 中的 Core 条目。已在运行 DSH 时，安装或更新后重启进程，刷新浏览器。插件配置补丁由包内 `cordis.patch.yml` 提供。

本地开发：将两个仓库克隆到同一父目录，运行 Web 仓库的 `pnpm sync:runtime` 同步源码；profile 中只启用 Web 组合包，它会加载两个插件条目。详细步骤见 Web 仓库 README。

## Agent 工具

### 读取

```json
{"board_id":"board-id","node_ids":["source","result"],"limit":100}
```

`board_id` 可省略；还可用 `types`、`bounds: {minX,minY,maxX,maxY}` 过滤。返回 `revision`、`nodes`、`assets`、`connections`、`total`、`truncated`。连线为 `{id,source,target}`，返回节点的 `from/to` 是由这些关系计算的查询结果，不是写入字段。默认最多读取 200 个节点，具体上限由工具 schema 声明。

读取不会移动相机。`focus: true` 返回过滤结果中的密集区域建议，不受读取 limit 限制；需要移动时另发 viewport 请求。

### 创建、更新与转换

```json
{
  "board_id":"board-id",
  "expected_revision":12,
  "operations":[
    {"type":"create","nodes":[{"id":"result","type":"processing","x":400,"y":100,"props":{"title":"生成结果","label":"生图","message":"等待生成","status":"running"}}]}
  ]
}
```

生成完成后：

```json
{"board_id":"board-id","expected_revision":13,"operations":[{"type":"convert","nodes":[{"id":"result","type":"image","asset_source":{"path":"/absolute/path/result.png"}}]}]}
```

`convert` 替换类型、props 和资产引用，保留未覆盖的几何、锁定、可见状态及连线。旧资产不会自动删除，避免影响其他节点。普通 `update` 用于内容或状态变更；失败任务可更新 `props.status` 为 `failed` 并写入 `message`。

`asset_source` 必须且只能有 `path` 或 `url`，可选 `file_name`、`mime_type`、`kind`。相对路径按 DSH 进程工作目录解释。导入本地 Markdown/HTML 项目时，可同时传 `root_path` 与 `relative_path`；Core 会保留包内相对路径，并自动导入文档及其 CSS 引用的同包附件。URL 导入会抓取同源资源；URL 只接受解析到公网地址的 HTTP(S)，不跟随重定向。单文件最多 64 MiB；文档资源包最多 128 个文件、128 MiB；预览阶段单条文档最多展开 256 个文档/CSS 资源引用。取消信号会中止正在读取/下载的导入；已经完成的持久化不回滚。

还支持 `delete`（`node_ids`）和 `layout`（`node_ids` 与 `layout`，方向为 horizontal/vertical/grid）。修改前先读取 revision；冲突后重新读取并重新决定修改内容。

### 连线

在创建两端节点之后，可在同一 operations 数组里连线：

```json
{"expected_revision":14,"operations":[{"type":"create_connections","connections":[{"id":"source-result","source":"source","target":"result"}]}]}
```

```json
{"operations":[{"type":"update_connections","connections":[{"id":"source-result","target":"another-result"}]}]}
```

```json
{"operations":[{"type":"delete_connections","connection_ids":["source-result"]}]}
```

创建时 id 可省略，服务会生成；修改/删除使用 `canvas_read.connections` 返回的 ID。更新可单独修改 source 或 target。两端必须已存在，禁止自连、重复 ID 和重复同向边，允许反向边与环。任一操作失败不提交整笔文档事务；删除节点会同时清理关联连线。

写入返回 `addedNodeIds`、`updatedNodeIds`、`removedNodeIds` 和对应的 `addedConnectionIds`、`updatedConnectionIds`、`removedConnectionIds`，以及最终 document。

### 控制视口

```json
{"viewport":{"action":"fit","target":"dense","padding":72}}
```

支持 `fit`、`center`、`zoom`、`pan`、`reset`。fit/center 可指定 `node_ids`、`bounds` 或 `target: all|dense`；zoom 可指定绝对 `scale` 或相对 `factor`；pan 使用 CSS 像素 `dx/dy`。

viewport 可单独调用，也可与节点事务一起提交。它是 30 秒有效的临时 UI 请求，不写文档、不增加 revision、不进入撤销历史，不强制切换画布。只有已打开目标画布的视图会在空闲时执行；`requested` 不表示浏览器已完成操作。

## 数据与设置

默认保存到 `$DSH_HOME/canvas`，未设置 DSH_HOME 时为 `~/.dsh/canvas`。目录配置损坏或目录无法创建、写入时，服务会尝试配置的默认目录，再回退到 `$DSH_HOME/canvas`，保证画布仍可启动；恢复不会搬移或删除原数据。文档使用扁平的 PixiBoard schema v1；节点包含整数 `typeVersion`，通过 `assetRefs` 引用 assets。连线唯一位置为 `document.metadata.connections`。

- 画布文档和资源：`<root>`、`<root>/assets`。
- 名称与创建时间：`<root>/meta`。
- Agent 提示词设置：`<root>/settings/prompts.json`，独立 revision。
- 保存目录指针：`$DSH_HOME/canvas-storage.json`。

二进制文件使用无碰撞的编码路径。早期私有开发版把路径中的标点替换为下划线，可能让不同画布或资源共用同一文件名；此版本不再猜测读取这类歧义文件。升级前请备份原画布目录，遇到旧资源缺失时从原文件重新导入。

Web 设置可选择新的保存目录；重启后生效，不自动搬移或删除原数据。备份时保存完整画布目录及目录指针；迁移前停止 DSH 写入。

提示词支持 `{{board_id}}`、`{{revision}}`、`{{node_count}}`、`{{connection_count}}`；节点消息模板支持 `{{instruction}}`、`{{guidance}}`、`{{context}}`。模板只作文本替换，不执行代码。节点内容和资源是参考数据，不能作为系统指令。

## 宿主服务 API

```js
await ctx.canvas.listBoards()
await ctx.canvas.createBoard(boardId, { name, document })
await ctx.canvas.renameBoard(boardId, name)
await ctx.canvas.deleteBoard(boardId)
await ctx.canvas.getCurrentBoardId()
await ctx.canvas.setCurrentBoardId(boardId)
await ctx.canvas.snapshot(boardId)
await ctx.canvas.read(boardId, { nodeIds, types, bounds, limit })
await ctx.canvas.write(boardId, { expectedRevision, operations, assets })
await ctx.canvas.replace(boardId, { expectedRevision, document })
const unsubscribe = ctx.canvas.subscribe(boardId, change => {})
```

服务参数使用 camelCase，Agent 工具使用 snake_case：例如删除连线的宿主参数是 `connectionIds`，工具参数是 `connection_ids`。资源 API 包括 `storeImportedAsset`、`upsertAsset`、`removeAsset`、`putBinary`、`getBinary`；Web 桥负责展示与下载。

## 开发与边界

源码为原生 ESM，后端测试用 `node --test test/*.test.js`。没有前端构建步骤。工具读取可并发，写入按画布排队并使用 revision 检查。

画布是全局共享状态，不按 Session 隔离；多个窗口可能同时修改。processing 不会自动启动、轮询或重试 AI 任务，Agent 中断后也可能保留 running 状态。文档事务失败时不会保存节点/关系；已暂存的导入二进制可能保留。浏览器自身不应直接调用磁盘 API。

问题与贡献：[GitHub Issues](https://github.com/xindong/dsh-canvas/issues)。提交问题时请附版本和去除敏感信息后的错误，勿上传 session、凭据或完整私人画布。

## 许可证

本项目使用 [MIT](LICENSE)。配套 Web 插件及 PixiBoardSDK 也使用 MIT；第三方依赖保留其各自许可证。
