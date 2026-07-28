import { z } from 'zod';

import { capability, type CapabilityBinding } from '../capabilities/index.js';
import { jsonValueSchema } from '../contracts/index.js';
import type { JsonValue } from '../contracts/index.js';
import type { SkillEntry, SkillView } from './store.js';
import { type SkillStore } from './store.js';

const listInputSchema = z.object({
  category: z.string().optional(),
});

const viewInputSchema = z.object({
  name: z.string().min(1),
  filePath: z.string().min(1).optional(),
});

function visibleNames(
  metadata: Readonly<Record<string, JsonValue>>,
): readonly string[] | undefined {
  const value = metadata['skills'];
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

function isVisible(entry: SkillEntry, allowed: readonly string[] | undefined): boolean {
  return (
    allowed === undefined || allowed.includes(entry.qualifiedName) || allowed.includes(entry.name)
  );
}

function entryPayload(entry: SkillEntry): JsonValue {
  return {
    name: entry.name,
    qualifiedName: entry.qualifiedName,
    description: entry.description,
    category: entry.category ?? null,
    path: entry.path,
    managed: entry.managed,
  };
}

function viewPayload(view: SkillView): JsonValue {
  const linkedFiles = Object.fromEntries(
    Object.entries(view.linkedFiles).map(([group, files]) => [group, [...files]]),
  );
  return {
    skill: entryPayload(view.skill),
    content: view.content,
    path: view.path,
    filePath: view.filePath ?? null,
    linkedFiles,
  };
}

export function createSkillCapabilities(store: SkillStore): readonly CapabilityBinding[] {
  return [
    capability({
      id: 'skill.list',
      kind: 'skill',
      name: 'List skills',
      description: 'List instructional skills available to this agent.',
      input: listInputSchema,
      output: jsonValueSchema,
      source: 'skills',
      execute: async ({ category }, context) => {
        const allowed = visibleNames(context.metadata);
        return (await store.list())
          .filter((entry) => category === undefined || entry.category === category)
          .filter((entry) => isVisible(entry, allowed))
          .map(entryPayload);
      },
    }),
    capability({
      id: 'skill.view',
      kind: 'skill',
      name: 'View skill',
      description: "Read a skill's SKILL.md or a linked file inside its directory.",
      input: viewInputSchema,
      output: jsonValueSchema,
      source: 'skills',
      execute: async ({ name, filePath }, context) => {
        const view = await store.view(name, filePath);
        if (!isVisible(view.skill, visibleNames(context.metadata))) {
          throw new Error(`Skill '${name}' is outside this agent's skill scope.`);
        }
        return viewPayload(view);
      },
    }),
  ];
}
