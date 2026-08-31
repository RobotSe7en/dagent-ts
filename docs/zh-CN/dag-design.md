# 非执行 DAG 设计

0.9.5 增加了用于创建、修改、检查和解释 canonical `DAGSpec` 的纯设计边界。它使用
Runner 的权威 capability 与 ToolAgent 目录，但绝不调用 capability、创建 run/checkpoint、
写入工作区文件或启动 DAG 执行。

## SDK API

`runner.inspectDag(spec)` 进行确定性的本地结构校验并返回类型化 diagnostics，不调用模型。

`runner.designDag(instruction, options)` 让配置的 Provider 返回以下一种类型化结果：

- `proposal`：完整且校验通过的 candidate 与自然语言 summary；
- `no-change`：传入的当前 DAG 已正确；
- `answer`：不修改图的自然语言解释；
- `failure`：一个或多个结构化 diagnostics。

```ts
const diagnostics = runner.inspectDag(current);
const result = await runner.designDag('在 publish 前增加 normalize 步骤。', {
  current,
  selection: { nodeIds: ['publish'] },
  onEvent(event) {
    console.log(event.type);
  },
});

if (result.type === 'proposal') {
  console.log(result.summary, result.candidate);
}
```

`selection.nodeIds` 只是聚焦提示，并不允许丢弃图的其他部分；未知 id 会返回 failure。
修改时保留当前 DAG id。Candidate 除 canonical DAG 校验外，还必须只引用所选 Designer
scope 内的 capability/ToolAgent。

生命周期事件包括 `response-started`、可选 `reasoning-delta`、`response-finished`、
`validation-started` 与 `validation-passed`。事件有本地 sequence 和 timestamp，但没有
`runId`，因为设计不是一次运行。返回的 V3 conversation 可传入下一轮设计；reasoning
仍与后续模型上下文隔离。

## Host 与 Web

本地 Host 暴露：

- `POST /api/v1/dags/inspect`，请求为 `{ "graph": DAGSpec }`；
- `POST /api/v1/dags/design`，包含 `instruction`，以及可选 `agentId`、`current`、`selection`。

Web DAG Studio 的 Prompt Bar 使用这些接口，并在用户决定是否保存前显示结果。校验与设计
不会静默执行或修改 candidate。

DagentWork 桌面端按产品边界不提供 DAG 设计或 DAG 执行入口。
