# 静态 DAG

静态 DAG 让宿主用类型安全 builder 描述确定性 dataflow。Builder 输出纯 JSON 兼容
`DAGSpec`；执行器不保留 builder 对象，也不会执行图中的代码字符串。

## 最小 DAG

```ts
import { DagBuilder, defineStaticDag, tool } from 'dagent-ai';
import { z } from 'zod';

const upper = tool({
  id: 'tool.upper',
  input: z.object({ text: z.string() }).strict(),
  output: z.object({ text: z.string() }).strict(),
  execute: ({ text }) => ({ text: text.toUpperCase() }),
});

const graph = new DagBuilder({
  id: 'upper-text',
  name: 'Upper text',
  input: z.object({ text: z.string() }),
  output: z.string(),
});

const node = graph.capability(upper, { text: graph.input('text') }, { id: 'upper' });
graph.setOutput(node.output('text'));

const target = defineStaticDag(graph.build());
```

运行：

```ts
const outcome = await runner.run(target, {
  graphInput: { text: 'hello' },
});
```

确保 graph 使用的 capability 已注册到同一个 Runner。

## Input、Output 与 ValueRef

`DagBuilder<TInput, TOutput>` 的泛型通常从 `input` 和 `output` Zod schema 推导。

```ts
const source = graph.input('nested', 'value');
const full = node.output();
const field = node.output('payload').at('name');
const status = node.status();
```

引用在 `build()` 时转成 `{$expr: ...}` 数据表达式。运行时只允许引用图输入、上游节点输出、
当前 map/loop item、loop iteration 和已声明 artifact。

不能用任意字符串路径假装引用。引用不存在、依赖边缺失或节点形成环时，图在执行前失败。

## 依赖与条件

`after` 自动添加边：

```ts
const second = graph.capability(
  toolB,
  { text: first.output('text') },
  { id: 'second', after: [first] },
);
```

也可以显式添加条件边：

```ts
const conditional = graph.capability(toolC, { text: first.output('text') }, { id: 'conditional' });

graph.addEdge(first, conditional, {
  operator: 'eq',
  left: first.status().toBinding(),
  right: 'completed',
});
```

条件支持 `truthy`、`falsy`、`eq`、`neq`、`gt`、`gte`、`lt`、`lte` 和 `in`。节点
dataflow 引用仍必须由结构依赖支配；条件不是绕过依赖检查的方式。

## Agent 节点

```ts
const answer = graph.agent('researcher', graph.input('question'), { id: 'research' });
graph.setOutput(answer.output());
```

`researcher` 必须在 Runner 中注册。Agent 节点输出是字符串；更复杂的结构应由 capability
产生或通过明确 schema 的 DAG 输出。

## Artifacts

```ts
const report = graph.artifact('report', 'reports/final.md', {
  description: 'Final Markdown report',
  required: true,
});

graph.capability(
  writeReport,
  {
    path: report.path(),
    content: graph.input('content'),
  },
  {
    id: 'write',
    artifactOutputs: [report],
  },
);
```

artifact 路径相对运行 workspace。`artifactInputs`/`artifactOutputs` 声明节点边界，用于执行
前校验和运行状态跟踪；能力实现仍必须安全处理路径。

## Map

map 的子图使用 `executionScope: 'map'`：

```ts
const itemGraph = new DagBuilder<Record<string, never>, string, { readonly text: string }>({
  id: 'normalize-item',
  name: 'Normalize item',
  output: z.string(),
  executionScope: 'map',
});

const normalized = itemGraph.capability(
  upper,
  { text: itemGraph.item('text') },
  { id: 'upper-item' },
);
itemGraph.setOutput(normalized.output('text'));

const mapped = graph.map(graph.input('items'), itemGraph.build(), {
  id: 'map-items',
  concurrency: 4,
  maxItems: 100,
});
```

`concurrency` 同时受 Runner `maxConcurrency` 约束，`maxItems` 防止无界 fan-out。

## Subgraph

```ts
const nested = graph.subgraph(childGraph, { text: graph.input('text') }, { id: 'nested' });
```

子图拥有自己的输入、输出和结构校验，但共享本次运行的能力目录、预算、workspace 和取消
信号。

## Loop

loop 子图使用 `executionScope: 'loop'`，可以读取 `item()` 与 `iteration()`：

```ts
const checked = loopGraph.capability(
  checkDone,
  {
    value: loopGraph.item(),
    iteration: loopGraph.iteration(),
  },
  { id: 'check' },
);
loopGraph.setOutput(checked.output());

const repeated = graph.loop(
  loopGraph.build(),
  { value: graph.input('start') },
  {
    operator: 'eq',
    left: checked.output('done').toBinding(),
    right: true,
  },
  { id: 'bounded-loop', maxIterations: 10 },
);
```

loop 必须设置正整数 `maxIterations`，schema 上限为 100。循环状态应通过明确的子图输入输出
传递，不依赖进程全局变量。

## 校验

```ts
import { assertValidDag, validateDag, validateDagInScope } from 'dagent-ai';
```

`validateDag()` 返回 issues，适合编辑器；`assertValidDag()` 失败时抛出 `DagentError`，
适合执行边界。Builder 的 `build()` 已自动进行 scope-aware 校验。
