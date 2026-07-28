import { resolve } from 'node:path';

import type { CapabilityDefinition, ChatMessage, JsonValue } from '../contracts/index.js';
import type { AgentProfile } from './profile.js';
import { renderProfile } from './profile.js';

export type PromptVariables = Readonly<Record<string, JsonValue | undefined>>;

export type PromptRequest = {
  readonly profile: AgentProfile;
  readonly task: string;
  readonly variables?: PromptVariables;
  readonly capabilities?: readonly CapabilityDefinition[];
  readonly context?: string;
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
    const sections = [renderProfile(request.profile)];
    if (request.workspacePath !== undefined) {
      sections.push(
        [
          '## Runtime Context',
          `- Workspace root: ${resolve(request.workspacePath)}`,
          '- Resolve relative file paths from this workspace root.',
        ].join('\n'),
      );
    }
    if (request.capabilities !== undefined && request.capabilities.length > 0) {
      sections.push(formatCapabilities(request.capabilities));
    }
    if (request.context !== undefined && request.context.trim().length > 0) {
      sections.push(`## Context\n${request.context.trim()}`);
    }
    return { role: 'system', content: sections.filter(Boolean).join('\n\n').trim() };
  }

  public buildUserMessage(task: string, variables: PromptVariables = {}): ChatMessage {
    return { role: 'user', content: renderTemplate(task, variables) };
  }
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
