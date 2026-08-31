# Skills

Skill 是一个包含 `SKILL.md` 的目录，用来给 Agent 提供可发现的工作方法、参考资料、
模板、资产或脚本。Dagent 不自动执行 Skill 中的脚本；Agent 通过受控 capability 读取
内容，再决定使用哪些已注册工具。

## Skill roots

```ts
const runner = new Runner({
  provider,
  workspace: './workspace',
  runtimeDirectory: '.runtime',
  skillRoots: ['./skills', './team-skills'],
  managedSkillRoot: './.dagent-ts/skills',
});
```

`skillRoots` 是只读扫描来源，`managedSkillRoot` 保存通过 API/SkillStore 安装的 Skill。
Runner 会去重绝对路径，并自动注册：

- `skill.list`
- `skill.view`

## 目录结构

支持 root 下一级 Skill，或 category/Skill 两级结构：

```text
skills/
├── release-notes/
│   ├── SKILL.md
│   └── templates/
│       └── release.md
└── writing/
    └── technical-review/
        ├── SKILL.md
        └── references/
            └── checklist.md
```

扫描不会递归接受任意深度，避免路径含义不明确。

## SKILL.md

```markdown
---
name: technical-review
description: Review technical documents for correctness and clarity.
category: writing
---

# Technical review

1. Confirm claims against primary evidence.
2. Separate correctness issues from style suggestions.
3. Return a concise review and concrete edits.
```

front matter 使用 YAML。`name` 和 `category` 只允许字母、数字、`_`、`-`，且不能以非法
字符开头。缺少 description 时，Store 使用正文第一段。

## Agent scope

```ts
const reviewer = defineToolAgent({
  kind: 'tool-agent',
  id: 'reviewer',
  name: 'Reviewer',
  scope: {
    capabilities: ['skill.list', 'skill.view', 'tool.read_file'],
    skills: ['writing/technical-review'],
  },
});
```

`scope.skills` 限制 SkillStore capability 对本次 Agent 可见的名称。可以写 qualified name，
也可以在不歧义时使用短名称。Skill scope 不会自动授予文件、shell 或网络工具。

ToolAgent system prompt 会包含最终 scope 的确定性路由索引。排序后的名称/description 条目
使用 8,000 字符预算，之后仅名称条目另用 2,000 字符预算；仍有省略时会报告数量并引导模型
调用 `skill.list`。完整 `SKILL.md` 正文继续通过 `skill.view` 按需加载；dynamic DAG planner
不会收到这份业务 Skill 索引。

## SkillStore

```ts
const skills = runner.skills;

await skills.list();
await skills.view('writing/technical-review');
await skills.view('writing/technical-review', 'references/checklist.md');

await skills.installMarkdown(markdown);
await skills.installArchive(zipBytes, {
  name: 'release-notes',
  category: 'writing',
});

await skills.delete('writing/release-notes');
```

只有 managed root 下安装的 Skill 可以删除。安装使用 staging directory 后原子 rename；
重复 qualified name 会失败。ZIP 必须包含且只表达一个根 `SKILL.md`，路径穿越和指向目录外
的链接文件会被拒绝。

## 关联文件

`skill.view` 会列出以下受识别目录：

- `references/`
- `templates/`
- `assets/`
- `scripts/`

读取关联文件必须传安全相对路径，且最终 `realpath` 仍在 Skill 目录内。目录列表是发现
机制，不表示文件会自动加载到模型上下文。

## Host 管理

统一 Host 提供：

- `GET /api/v1/skills`
- `GET /api/v1/skills/view`
- `POST /api/v1/skills`
- `DELETE /api/v1/skills`

Web UI 与 API 安装的内容进入 `<dataDirectory>/skills`。配置的 `skillRoots` 仍是外部只读
来源。Host 不应允许远程匿名用户安装 Skill；若暴露网络访问，应在反向代理处增加认证。
