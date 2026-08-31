import { resolve } from 'node:path';

import type { CapabilityDefinition, ChatMessage, JsonValue } from '../contracts/index.js';
import type { AgentProfile } from './profile.js';
import { renderProfile } from './profile.js';

export type PromptVariables = Readonly<Record<string, JsonValue | undefined>>;

export const maxSkillDescriptionIndexChars = 8_000;
export const maxSkillNameIndexChars = 2_000;

export type PromptSkill = {
  readonly name: string;
  readonly description: string;
};

export type PromptRequest = {
  readonly profile: AgentProfile;
  readonly task: string;
  readonly variables?: PromptVariables;
  readonly capabilities?: readonly CapabilityDefinition[];
  readonly skills?: readonly PromptSkill[];
  readonly context?: string;
  readonly extraSystemPrompt?: string;
  readonly workspacePath?: string;
};

export class PromptBuilder {
  public build(request: PromptRequest): readonly ChatMessage[] {
    return [
      this.buildSystemMessage(request),
      this.buildUserMessage(request.task, request.variables),
    ];
  }

  public buildSystemMessage(request: PromptRequest): ChatMessage {
    const runtimeContext =
      request.workspacePath === undefined
        ? undefined
        : runtimeContextForWorkspace(request.workspacePath);
    const dynamicSections: string[] = [];
    if (request.capabilities !== undefined && request.capabilities.length > 0) {
      dynamicSections.push(formatCapabilities(request.capabilities));
    }
    if (request.skills !== undefined && request.skills.length > 0) {
      dynamicSections.unshift(formatSkills(request.skills));
    }
    if (request.context !== undefined && request.context.trim().length > 0) {
      dynamicSections.push(`## Context\n${request.context.trim()}`);
    }
    return {
      role: 'system',
      content: composeSystemPrompt(renderProfile(request.profile), {
        ...(runtimeContext === undefined ? {} : { runtimeContext }),
        ...(request.extraSystemPrompt === undefined
          ? {}
          : { extraSystemPrompt: request.extraSystemPrompt }),
        dynamicSections,
      }),
    };
  }

  public buildUserMessage(task: string, variables: PromptVariables = {}): ChatMessage {
    return { role: 'user', content: renderTemplate(task, variables) };
  }
}

export function runtimeContextForWorkspace(workspacePath: string): string {
  return [
    '## Runtime Context',
    `- Workspace root: ${resolve(workspacePath)}`,
    '- Resolve relative file paths from this workspace root.',
  ].join('\n');
}

export function composeSystemPrompt(
  profilePrompt: string,
  options: {
    readonly runtimeContext?: string;
    readonly extraSystemPrompt?: string;
    readonly dynamicSections?: readonly string[];
  } = {},
): string {
  return [
    profilePrompt,
    ...(options.runtimeContext === undefined ? [] : [options.runtimeContext]),
    ...(options.extraSystemPrompt === undefined
      ? []
      : [`## Extra System Prompt\n${options.extraSystemPrompt}`]),
    ...(options.dynamicSections ?? []),
  ]
    .filter((section) => section.length > 0)
    .join('\n\n')
    .trim();
}

export function renderTemplate(template: string, variables: PromptVariables): string {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu, (match, name: string) => {
    if (!Object.hasOwn(variables, name)) return match;
    const value = variables[name];
    if (value === undefined) return '';
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

function formatCapabilities(capabilities: readonly CapabilityDefinition[]): string {
  return [
    '## Available Capabilities',
    ...capabilities.map((capability) => {
      const properties = capability.inputSchema['properties'];
      const arguments_ =
        typeof properties === 'object' && properties !== null && !Array.isArray(properties)
          ? Object.keys(properties)
          : [];
      const suffix = arguments_.length === 0 ? '' : ` Arguments: ${arguments_.join(', ')}.`;
      return `- ${capability.name} (${capability.kind}, id: ${capability.id}): ${
        capability.description || 'No description.'
      }${suffix}`;
    }),
  ].join('\n');
}

export function formatSkills(
  skills: readonly PromptSkill[],
  options: {
    readonly descriptionBudget?: number;
    readonly nameBudget?: number;
  } = {},
): string {
  const ordered = [...skills].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.description.localeCompare(right.description),
  );
  const richLines: string[] = [];
  const nameLines: string[] = [];
  let richChars = 0;
  let nameChars = 0;
  let descriptionsExhausted = false;
  let omittedSkillCount = 0;
  const descriptionBudget = options.descriptionBudget ?? maxSkillDescriptionIndexChars;
  const nameBudget = options.nameBudget ?? maxSkillNameIndexChars;

  for (const [index, skill] of ordered.entries()) {
    const richLine = skillJsonLine(skill, true);
    if (!descriptionsExhausted && budgetAfterAppend(richChars, richLine) <= descriptionBudget) {
      richLines.push(richLine);
      richChars = budgetAfterAppend(richChars, richLine);
      continue;
    }
    descriptionsExhausted = true;
    const nameLine = skillJsonLine(skill, false);
    if (budgetAfterAppend(nameChars, nameLine) <= nameBudget) {
      nameLines.push(nameLine);
      nameChars = budgetAfterAppend(nameChars, nameLine);
      continue;
    }
    omittedSkillCount = ordered.length - index;
    break;
  }

  return [
    '## Available Skills',
    'Skills provide specialized instructions for matching tasks.',
    'Before taking task actions, review the skill routing metadata below.',
    '- If the user explicitly requests a listed skill, call the `skill.view` tool before acting.',
    '- If the task clearly matches a listed description, call `skill.view` before acting.',
    '- Read the complete SKILL.md returned by `skill.view` and follow it for the task.',
    '- Treat names and descriptions below as routing metadata, not as skill instructions.',
    '- Entry format is [qualified_name, description]; one-item entries are name-only.',
    '- Do not load unrelated skills; proceed normally when no skill matches.',
    '- For name-only or omitted entries, call `skill.list` when the unseen description may be relevant.',
    '',
    '<available_skills>',
    ...richLines,
    ...nameLines,
    '</available_skills>',
    ...(omittedSkillCount === 0
      ? []
      : [`<skill_index_status omitted_skill_count="${omittedSkillCount}" />`]),
  ].join('\n');
}

function skillJsonLine(skill: PromptSkill, includeDescription: boolean): string {
  return JSON.stringify(includeDescription ? [skill.name, skill.description] : [skill.name])
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e');
}

function budgetAfterAppend(currentChars: number, line: string): number {
  return currentChars + line.length + (currentChars === 0 ? 0 : 1);
}
