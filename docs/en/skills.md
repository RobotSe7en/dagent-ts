# Skills

A Skill is a directory with a `SKILL.md` file that gives an Agent discoverable methods, references,
templates, assets, or scripts. Dagent does not execute Skill scripts automatically. An Agent reads
content through controlled capabilities, then chooses among its registered tools.

## Skill Roots

```ts
const runner = new Runner({
  provider,
  workspace: './workspace',
  runtimeDirectory: '.runtime',
  skillRoots: ['./skills', './team-skills'],
  managedSkillRoot: './.dagent-ts/skills',
});
```

`skillRoots` are read-only discovery sources. `managedSkillRoot` stores Skills installed through
the API or SkillStore. Runner deduplicates absolute roots and automatically registers:

- `skill.list`
- `skill.view`

## Directory Layout

A root supports either one-level Skills or two-level category/Skill paths:

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

Discovery does not accept arbitrary recursive depth, keeping path meaning unambiguous.

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

Front matter is YAML. `name` and `category` allow letters, digits, `_`, and `-` with a valid first
character. When description is absent, the Store uses the first body paragraph.

## Agent Scope

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

`scope.skills` restricts the names visible to SkillStore capabilities for this Agent. Use a
qualified name, or a short name when it is unambiguous. Skill scope does not automatically grant
file, shell, or network tools.

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

Only Skills installed under the managed root can be deleted. Installation writes to a staging
directory and atomically renames it. Duplicate qualified names fail. A ZIP must describe one root
`SKILL.md`; path traversal and linked files outside the Skill directory are rejected.

## Linked Files

`skill.view` discovers these directories:

- `references/`
- `templates/`
- `assets/`
- `scripts/`

Reading a linked file requires a safe relative path whose final `realpath` remains inside the Skill
directory. Discovery lists files; it does not automatically load them into model context.

## Host Management

The unified host provides:

- `GET /api/v1/skills`
- `GET /api/v1/skills/view`
- `POST /api/v1/skills`
- `DELETE /api/v1/skills`

Web and API installations enter `<dataDirectory>/skills`; configured `skillRoots` remain external
read-only sources. Do not allow anonymous remote users to install Skills. Add authentication at a
reverse proxy before exposing the host over a network.
