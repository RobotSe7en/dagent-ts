import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { tool } from '../capabilities/tool.js';
import { DagentError } from '../errors.js';
import { MockProvider } from '../testing/mock-provider.js';
import { FeedbackLearnerAgent } from './feedback-learner.js';
import { createAgentProfile } from './profile.js';
import { AgentResponseFormatError, extractJsonObject, ProfiledAgent } from './profiled-agent.js';
import { PromptBuilder, renderTemplate } from './prompt-builder.js';
import {
  listBuiltinProfiles,
  loadBuiltinProfile,
  normalizeProfileName,
  ProfileStore,
} from './store.js';
import { ValidatorAgent } from './validator-agent.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('ProfileStore', () => {
  it('loads, atomically saves, lists, and deletes Markdown profiles', async () => {
    const root = await temporaryRoot();
    const store = new ProfileStore(join(root, 'profiles'));

    const saved = await store.save('analyst', '# Analyst\n\nRead carefully.');

    expect(saved).toEqual({
      name: 'analyst',
      description: 'Analyst',
      content: '# Analyst\n\nRead carefully.',
    });
    expect(await store.listNames()).toEqual(['analyst']);
    expect(await store.load('analyst.md')).toEqual(saved);
    await expect(store.delete('analyst')).resolves.toBe(true);
    await expect(store.delete('analyst')).resolves.toBe(false);
  });

  it.each([
    '../outside',
    'nested/profile',
    '/tmp/profile.md',
    String.raw`nested\profile`,
    'profile.txt',
    '',
  ])('rejects path-like or malformed names: %s', (name) => {
    expect(() => normalizeProfileName(name)).toThrow(DagentError);
  });

  it('ignores non-profile files when listing', async () => {
    const root = await temporaryRoot();
    const profiles = join(root, 'profiles');
    await mkdir(join(profiles, 'nested'), { recursive: true });
    await writeFile(join(profiles, 'valid.md'), '# Valid');
    await writeFile(join(profiles, 'notes.txt'), 'ignored');
    await writeFile(join(profiles, '1invalid.md'), 'ignored');

    await expect(new ProfileStore(profiles).listNames()).resolves.toEqual(['valid']);
  });

  it('loads all packaged profiles', async () => {
    const profiles = await listBuiltinProfiles();

    expect(profiles.map(({ name }) => name)).toEqual([
      'conversation',
      'dag_agent',
      'dag_design',
      'validator_agent',
      'feedback_learner',
    ]);
    await expect(loadBuiltinProfile('conversation')).resolves.toMatchObject({
      description: 'General-Purpose Agent',
    });
  });
});

describe('PromptBuilder', () => {
  it('assembles profile, runtime context, capabilities, and task variables', () => {
    const echo = tool({
      id: 'tool.echo',
      name: 'echo',
      description: 'Echo text.',
      input: z.object({ text: z.string() }).strict(),
      output: z.string(),
      execute: ({ text }) => text,
    });
    const profile = createAgentProfile({
      name: 'analyst',
      content: '# Analyst\n\nBe precise.',
    });

    const messages = new PromptBuilder().build({
      profile,
      task: 'Task {{ taskId }}: {{ request }}',
      variables: { taskId: 't1', request: 'inspect' },
      capabilities: [echo.definition],
      context: 'Project context.',
      workspacePath: './workspace',
    });

    expect(messages[0]?.content).toContain('# Analyst');
    expect(messages[0]?.content).toContain('## Runtime Context');
    expect(messages[0]?.content).toContain(
      'echo (tool, id: tool.echo): Echo text. Arguments: text.',
    );
    expect(messages[0]?.content).toContain('## Context\nProject context.');
    expect(messages[1]).toEqual({ role: 'user', content: 'Task t1: inspect' });
  });

  it('only substitutes named variables and never reparses inserted content', () => {
    const inserted = '{"a": 1} {% raw %} {{ untouched }}';

    expect(
      renderTemplate('{{ payload }} / {{ 7 * 6 }} / {{ missing }}', {
        payload: inserted,
      }),
    ).toBe(`${inserted} / {{ 7 * 6 }} / {{ missing }}`);
  });

  it('places a literal extra system prompt after runtime context and before dynamic sections', () => {
    const profile = createAgentProfile({
      name: 'analyst',
      content: '# Analyst\n\nBe precise.',
    });
    const message = new PromptBuilder().buildSystemMessage({
      profile,
      task: '',
      workspacePath: './workspace',
      extraSystemPrompt: 'Keep {{literal}} exactly.',
      context: 'Dynamic context.',
    });

    expect(message.content.indexOf('## Runtime Context')).toBeLessThan(
      message.content.indexOf('## Extra System Prompt'),
    );
    expect(message.content.indexOf('Keep {{literal}} exactly.')).toBeLessThan(
      message.content.indexOf('## Context'),
    );
    expect(message.content).toContain('Keep {{literal}} exactly.');
  });
});

describe('ProfiledAgent', () => {
  it.each([
    ['{"action":"keep"} trailing', { action: 'keep' }],
    [
      'prefix {"text":"a } brace","nested":{"ok":true}} suffix',
      {
        text: 'a } brace',
        nested: { ok: true },
      },
    ],
    ['```json\n{"action":"keep"}\n```', { action: 'keep' }],
    ['{"first":true}\n{"second":true}', { first: true }],
  ])('extracts the first complete JSON object from %s', (content, expected) => {
    expect(extractJsonObject(content)).toEqual(expected);
  });

  it('rejects non-object or missing JSON', () => {
    expect(() => extractJsonObject('[{"action":"keep"}]')).toThrow(AgentResponseFormatError);
    expect(() => extractJsonObject('no structured response')).toThrow(AgentResponseFormatError);
  });

  it('uses an explicit model-call reservation hook', async () => {
    const reserve = vi.fn();
    const provider = new MockProvider([reply('done')]);
    const agent = new ProfiledAgent({
      provider,
      profile: createAgentProfile({ name: 'analyst', content: 'Analyze.' }),
      reserveModelCall: reserve,
    });

    await expect(agent.runText({ task: 'work' })).resolves.toBe('done');
    expect(reserve).toHaveBeenCalledOnce();
  });
});

describe('specialized profile agents', () => {
  it('parses validator results and includes execution context', async () => {
    const provider = new MockProvider([
      reply(
        JSON.stringify({
          passed: false,
          issues: [{ nodeId: 'write', message: 'Report is incomplete.' }],
          summary: 'Incomplete.',
        }),
      ),
    ]);
    const validator = new ValidatorAgent({
      provider,
      profile: createAgentProfile({ name: 'validator', content: 'Validate.' }),
    });

    const result = await validator.validate({
      userRequest: 'Write a report.',
      finalAnswer: 'Done.',
      executionContext: 'write completed',
      workspacePath: '/tmp/workspace',
    });

    expect(result).toEqual({
      passed: false,
      issues: [{ nodeId: 'write', message: 'Report is incomplete.' }],
      summary: 'Incomplete.',
    });
    expect(provider.requests[0]?.messages[1]?.content).toContain(
      'Execution context:\nwrite completed',
    );
  });

  it('adds actionable feedback when a rejected validation has no issues', async () => {
    const validator = new ValidatorAgent({
      provider: new MockProvider([reply('{"passed":false,"issues":[],"summary":""}')]),
      profile: createAgentProfile({ name: 'validator', content: 'Validate.' }),
    });

    const result = await validator.validate({ userRequest: 'work', finalAnswer: '' });

    expect(result.passed).toBe(false);
    expect(result.issues).toHaveLength(1);
  });

  it('skips malformed validation JSON but propagates provider failures', async () => {
    const profile = createAgentProfile({ name: 'validator', content: 'Validate.' });
    const malformed = new ValidatorAgent({
      provider: new MockProvider([reply('not json')]),
      profile,
    });
    await expect(
      malformed.validate({ userRequest: 'work', finalAnswer: 'answer' }),
    ).resolves.toMatchObject({ passed: true, summary: expect.stringContaining('skipped') });

    const unavailable = new ValidatorAgent({
      provider: new MockProvider([]),
      profile,
    });
    await expect(
      unavailable.validate({ userRequest: 'work', finalAnswer: 'answer' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  });

  it('renders feedback and trace through the shared profile runner', async () => {
    const provider = new MockProvider([reply('Prefer narrow workspace boundaries.')]);
    const learner = new FeedbackLearnerAgent({
      provider,
      profile: createAgentProfile({ name: 'learner', content: 'Learn.' }),
    });

    const result = await learner.learn({
      feedback: 'The boundary was broad.',
      trace: { status: 'failed' },
    });

    expect(result.notes).toBe('Prefer narrow workspace boundaries.');
    expect(provider.requests[0]?.messages[1]?.content).toContain('The boundary was broad.');
    expect(provider.requests[0]?.messages[1]?.content).toContain('{"status":"failed"}');
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dagent-profiles-'));
  temporaryRoots.push(root);
  return root;
}

function reply(content: string) {
  return {
    content,
    reasoningContent: '',
    refusal: '',
    toolCalls: [],
  };
}
