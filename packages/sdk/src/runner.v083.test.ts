import { access, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { tool } from './capabilities/tool.js';
import {
  defineAutoAgent,
  defineDagAgent,
  defineStaticDag,
  defineToolAgent,
  resultStoragePolicySchema,
  runCheckpointSchema,
} from './contracts/index.js';
import { createAgentProfile } from './profiles/profile.js';
import { sha256 } from './internal/stable-json.js';
import { Runner } from './runner.js';
import { MockProvider } from './testing/mock-provider.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe('Runner 0.8.1-0.9.0 contracts', () => {
  it('defaults runtime paths while preserving explicit overrides', async () => {
    const defaults = new Runner({ provider: new MockProvider([]) });
    const explicit = new Runner({
      provider: new MockProvider([]),
      workspace: '/tmp/dagent-ts-explicit-paths',
      runtimeDirectory: '.private',
    });

    expect(defaults.workspacePath).toBe(resolve(homedir(), '.dagent'));
    expect(defaults.runtimeDirectory).toBe('.runtime');
    expect(explicit.workspacePath).toBe('/tmp/dagent-ts-explicit-paths');
    expect(explicit.runtimeDirectory).toBe('.private');
    await Promise.all([defaults.close(), explicit.close()]);
  });

  it.each(['', '.', '..', '../private', 'private/../data', '/private', 'C:/private'])(
    'rejects unsafe runtime directory %j',
    (runtimeDirectory) => {
      expect(
        () =>
          new Runner({
            provider: new MockProvider([]),
            workspace: '/tmp/dagent-ts-runtime-validation',
            runtimeDirectory,
          }),
      ).toThrow(/runtime directory/u);
    },
  );

  it('uses V4 public state and V5 checkpoints while accepting the V4/V3 legacy pair', async () => {
    const workspace = await temporaryDirectory();
    const provider = new MockProvider([
      { content: 'done', reasoningContent: '', refusal: '', toolCalls: [] },
    ]);
    const runner = new Runner({
      provider,
      workspace,
      runtimeDirectory: '.private/runtime',
    });
    const agent = defineToolAgent({
      kind: 'tool-agent',
      id: 'text_only',
      name: 'Text only',
      systemPrompt: 'Help.',
      scope: {},
      reviewLevel: 'never',
    });

    const outcome = await runner.run(agent, { prompt: 'hello' });

    expect(outcome.checkpoint.schemaVersion).toBe(5);
    expect(outcome.checkpoint.plan).toMatchObject({
      schemaVersion: 5,
      runtimeDirectory: '.private/runtime',
    });
    expect(outcome.state.schemaVersion).toBe(4);
    expect(outcome.state.conversation?.schemaVersion).toBe(3);
    await expect(access(join(outcome.state.workspacePath, '.private'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(() => runCheckpointSchema.parse({ ...outcome.checkpoint, schemaVersion: 3 })).toThrow();
    const legacyPlanPayload = { ...outcome.checkpoint.plan, schemaVersion: 4 as const };
    const { fingerprint: _fingerprint, ...legacyPayload } = legacyPlanPayload;
    expect(_fingerprint).toBe(outcome.checkpoint.plan.fingerprint);
    const legacy = runCheckpointSchema.parse({
      ...outcome.checkpoint,
      schemaVersion: 4,
      state: {
        ...outcome.state,
        schemaVersion: 3,
        inputArtifactFiles: [],
      },
      plan: {
        ...legacyPayload,
        fingerprint: sha256(JSON.parse(JSON.stringify(legacyPayload))),
      },
    });
    expect(legacy.state.inputArtifactFiles).toEqual([]);
    expect(
      runCheckpointSchema.parse(JSON.parse(JSON.stringify(outcome.checkpoint)) as unknown).plan
        .extraSystemPrompt,
    ).toBeUndefined();
    expect(() =>
      runCheckpointSchema.parse({
        ...outcome.checkpoint,
        plan: { ...outcome.checkpoint.plan, runtimeDirectory: 'tampered' },
      }),
    ).toThrow(/fingerprint/u);
    await runner.close();
  });

  it('removes host-selected storage paths from ResultStoragePolicy', () => {
    expect(resultStoragePolicySchema.parse({})).toEqual({ maxInlineBytes: 256 * 1024 });
    expect(() =>
      resultStoragePolicySchema.parse({
        maxInlineBytes: 1024,
        internalDirectory: '.legacy/results',
      }),
    ).toThrow();
  });

  it('inserts the literal extra prompt after the profile and freezes it in review checkpoints', async () => {
    const workspace = await temporaryDirectory();
    const risky = tool({
      id: 'tool.prompt-review',
      input: z.object({}).strict(),
      output: z.literal('ok'),
      risk: 'high',
      execute: () => 'ok' as const,
    });
    const firstProvider = new MockProvider([
      (request) => {
        const system = request.messages[0]?.content ?? '';
        expect(system.indexOf('PROFILE')).toBeLessThan(system.indexOf('## Runtime Context'));
        expect(system.indexOf('## Runtime Context')).toBeLessThan(
          system.indexOf('HOST ${workspace}'),
        );
        return {
          content: '',
          reasoningContent: '',
          refusal: '',
          toolCalls: [{ id: 'call-prompt', name: 'tool.prompt-review', arguments: {} }],
        };
      },
    ]);
    const firstRunner = new Runner({
      provider: firstProvider,
      capabilities: [risky],
      workspace,
      runtimeDirectory: '.runtime',
      extraSystemPrompt: 'HOST ${workspace}',
    });
    const agent = defineToolAgent({
      kind: 'tool-agent',
      id: 'prompt_agent',
      name: 'Prompt agent',
      systemPrompt: 'PROFILE',
      scope: { capabilities: ['tool.prompt-review'] },
      reviewLevel: 'risky',
    });
    const pending = await firstRunner.run(agent, { prompt: 'go' });
    expect(pending.status).toBe('awaiting-review');
    if (pending.status !== 'awaiting-review') return;
    expect(pending.checkpoint.plan.extraSystemPrompt).toBe('HOST ${workspace}');
    firstRunner.extraSystemPrompt = 'MUTATED ORIGINAL';
    expect(pending.checkpoint.plan.extraSystemPrompt).toBe('HOST ${workspace}');
    await firstRunner.close();

    const secondProvider = new MockProvider([
      (request) => {
        const system = request.messages[0]?.content ?? '';
        expect(system).toContain('HOST ${workspace}');
        expect(system).not.toContain('CHANGED HOST');
        return { content: 'approved', reasoningContent: '', refusal: '', toolCalls: [] };
      },
    ]);
    const secondRunner = new Runner({
      provider: secondProvider,
      capabilities: [risky],
      workspace,
      runtimeDirectory: '.runtime',
      extraSystemPrompt: 'CHANGED HOST',
    });

    const completed = await secondRunner.resume(pending.checkpoint, {
      reviewId: pending.review.id,
      revision: pending.review.revision,
      action: 'approve',
      reason: '',
    });

    expect(completed.status).toBe('completed');
    await secondRunner.close();
  });

  it.each(['', '   ', 'x'.repeat(16_385)])('rejects invalid extra prompts', (prompt) => {
    expect(
      () =>
        new Runner({
          provider: new MockProvider([]),
          workspace: '/tmp/dagent-ts-extra-prompt-validation',
          runtimeDirectory: '.runtime',
          extraSystemPrompt: prompt,
        }),
    ).toThrow();
  });

  it('places the extra prompt before dynamic planner instructions', async () => {
    const workspace = await temporaryDirectory();
    const graph = {
      schemaVersion: 1 as const,
      id: 'prompt_order',
      name: 'Prompt order',
      description: '',
      nodes: [],
      edges: [],
      artifacts: {},
    };
    const provider = new MockProvider([
      (request) => {
        const system = request.messages[0]?.content ?? '';
        expect(system.indexOf('PLANNER PROFILE')).toBeLessThan(
          system.indexOf('PLANNER HOST POLICY'),
        );
        expect(system.indexOf('PLANNER HOST POLICY')).toBeLessThan(
          system.indexOf('Create a canonical DAGSpec'),
        );
        return {
          content: JSON.stringify({ graph, rationale: '', rerunNodeIds: [] }),
          reasoningContent: '',
          refusal: '',
          toolCalls: [],
        };
      },
    ]);
    const runner = new Runner({
      provider,
      workspace,
      runtimeDirectory: '.runtime',
      extraSystemPrompt: 'PLANNER HOST POLICY',
    });
    const agent = defineDagAgent({
      kind: 'dag-agent',
      id: 'prompt_planner',
      name: 'Prompt planner',
      systemPrompt: 'PLANNER PROFILE',
      scope: {},
      reviewLevel: 'never',
    });

    const outcome = await runner.run(agent, { prompt: 'plan nothing' });

    expect(outcome.status).toBe('completed');
    await runner.close();
  });

  it('keeps AutoAgent routing classification outside the extra prompt', async () => {
    const workspace = await temporaryDirectory();
    const provider = new MockProvider([
      (request) => {
        expect(request.messages[0]?.content).not.toContain('ROUTED HOST POLICY');
        return {
          content: '{"route":"tool","reason":"direct"}',
          reasoningContent: '',
          refusal: '',
          toolCalls: [],
        };
      },
      (request) => {
        expect(request.messages[0]?.content).toContain('ROUTED HOST POLICY');
        return { content: 'done', reasoningContent: '', refusal: '', toolCalls: [] };
      },
    ]);
    const toolAgent = defineToolAgent({
      kind: 'tool-agent',
      id: 'auto_tool',
      name: 'Auto tool',
      systemPrompt: 'TOOL PROFILE',
      scope: {},
      reviewLevel: 'never',
    });
    const dagAgent = defineDagAgent({
      kind: 'dag-agent',
      id: 'auto_dag',
      name: 'Auto DAG',
      systemPrompt: 'DAG PROFILE',
      scope: {},
      reviewLevel: 'never',
    });
    const agent = defineAutoAgent({
      kind: 'auto-agent',
      id: 'auto',
      name: 'Auto',
      systemPrompt: 'ROUTER PROFILE',
      scope: {},
      reviewLevel: 'never',
      toolAgent,
      dagAgent,
    });
    const runner = new Runner({
      provider,
      workspace,
      runtimeDirectory: '.runtime',
      extraSystemPrompt: 'ROUTED HOST POLICY',
    });

    const outcome = await runner.run(agent, { prompt: 'answer directly' });

    expect(outcome.status).toBe('completed');
    await runner.close();
  });

  it('applies the extra prompt after AutoAgent selects DAG planning', async () => {
    const workspace = await temporaryDirectory();
    const graph = {
      schemaVersion: 1 as const,
      id: 'auto_dag_prompt',
      name: 'Auto DAG prompt',
      description: '',
      nodes: [],
      edges: [],
      artifacts: {},
    };
    const provider = new MockProvider([
      (request) => {
        expect(request.messages[0]?.content).not.toContain('AUTO DAG HOST POLICY');
        return {
          content: '{"route":"dag","reason":"staged"}',
          reasoningContent: '',
          refusal: '',
          toolCalls: [],
        };
      },
      (request) => {
        expect(request.messages[0]?.content).toContain('AUTO DAG HOST POLICY');
        return {
          content: JSON.stringify({ graph, rationale: '', rerunNodeIds: [] }),
          reasoningContent: '',
          refusal: '',
          toolCalls: [],
        };
      },
    ]);
    const agent = defineAutoAgent({
      kind: 'auto-agent',
      id: 'auto_dag_route',
      name: 'Auto DAG route',
      systemPrompt: 'ROUTER PROFILE',
      scope: {},
      reviewLevel: 'never',
      toolAgent: defineToolAgent({
        kind: 'tool-agent',
        id: 'auto_dag_tool',
        name: 'Auto DAG tool',
        systemPrompt: 'TOOL PROFILE',
        scope: {},
        reviewLevel: 'never',
      }),
      dagAgent: defineDagAgent({
        kind: 'dag-agent',
        id: 'auto_dag_planner',
        name: 'Auto DAG planner',
        systemPrompt: 'DAG PROFILE',
        scope: {},
        reviewLevel: 'never',
      }),
    });
    const runner = new Runner({
      provider,
      workspace,
      runtimeDirectory: '.runtime',
      extraSystemPrompt: 'AUTO DAG HOST POLICY',
    });

    const outcome = await runner.run(agent, { prompt: 'plan it' });

    expect(outcome.status).toBe('completed');
    await runner.close();
  });

  it('propagates the frozen extra prompt to registered agents in a static DAG', async () => {
    const workspace = await temporaryDirectory();
    const provider = new MockProvider([
      (request) => {
        expect(request.messages[0]?.content).toContain('REGISTERED HOST POLICY');
        return { content: 'delegated', reasoningContent: '', refusal: '', toolCalls: [] };
      },
    ]);
    const registered = defineToolAgent({
      kind: 'tool-agent',
      id: 'registered_worker',
      name: 'Registered worker',
      systemPrompt: 'WORKER PROFILE',
      scope: {},
      reviewLevel: 'never',
    });
    const graph = {
      schemaVersion: 1 as const,
      id: 'registered_agent_graph',
      name: 'Registered agent graph',
      description: '',
      nodes: [
        {
          id: 'delegate',
          kind: 'agent' as const,
          description: '',
          agentId: 'registered_worker',
          prompt: 'work',
          artifactInputs: [],
          artifactOutputs: [],
        },
      ],
      edges: [],
      artifacts: {},
      output: { $expr: { type: 'node-output' as const, nodeId: 'delegate', path: [] } },
    };
    const runner = new Runner({
      provider,
      agents: [registered],
      workspace,
      runtimeDirectory: '.runtime',
      extraSystemPrompt: 'REGISTERED HOST POLICY',
    });

    const outcome = await runner.run(defineStaticDag(graph), {});

    expect(outcome.status).toBe('completed');
    expect(provider.requests).toHaveLength(1);
    await runner.close();
  });

  it('does not apply the extra prompt to result validation', async () => {
    const workspace = await temporaryDirectory();
    const inspect = tool({
      id: 'tool.validation-evidence',
      input: z.object({}).strict(),
      output: z.literal('evidence'),
      execute: () => 'evidence' as const,
    });
    const provider = new MockProvider([
      (request) => {
        expect(request.messages[0]?.content).toContain('AGENT ONLY POLICY');
        return {
          content: '',
          reasoningContent: '',
          refusal: '',
          toolCalls: [{ id: 'call-evidence', name: 'tool.validation-evidence', arguments: {} }],
        };
      },
      (request) => {
        expect(request.messages[0]?.content).toContain('AGENT ONLY POLICY');
        return { content: 'draft', reasoningContent: '', refusal: '', toolCalls: [] };
      },
      (request) => {
        expect(request.messages[0]?.content).not.toContain('AGENT ONLY POLICY');
        return {
          content: '{"passed":true,"issues":[],"summary":"valid"}',
          reasoningContent: '',
          refusal: '',
          toolCalls: [],
        };
      },
    ]);
    const runner = new Runner({
      provider,
      capabilities: [inspect],
      workspace,
      runtimeDirectory: '.runtime',
      extraSystemPrompt: 'AGENT ONLY POLICY',
      validation: {
        enabled: true,
        maxRetries: 0,
        profile: createAgentProfile({ name: 'validator', content: 'Validate.' }),
      },
    });
    const agent = defineToolAgent({
      kind: 'tool-agent',
      id: 'validated_agent',
      name: 'Validated agent',
      systemPrompt: 'PROFILE',
      scope: { capabilities: ['tool.validation-evidence'] },
      reviewLevel: 'never',
    });

    const outcome = await runner.run(agent, { prompt: 'inspect' });

    expect(outcome.status).toBe('completed');
    expect(outcome.state.validations).toHaveLength(1);
    await runner.close();
  });

  it('advances canonical conversation revision when reviewed execution replans to review', async () => {
    const workspace = await temporaryDirectory();
    let invocations = 0;
    const flaky = tool({
      id: 'tool.reviewed-flaky',
      input: z.object({}).strict(),
      output: z.literal('recovered'),
      risk: 'high',
      execute: () => {
        invocations += 1;
        if (invocations === 1) throw new Error('transient');
        return 'recovered' as const;
      },
    });
    const graph = {
      schemaVersion: 1 as const,
      id: 'reviewed_replan',
      name: 'Reviewed replan',
      description: '',
      nodes: [
        {
          id: 'work',
          kind: 'capability' as const,
          description: '',
          capabilityId: 'tool.reviewed-flaky',
          arguments: {},
          artifactInputs: [],
          artifactOutputs: [],
        },
      ],
      edges: [],
      artifacts: {},
      output: { $expr: { type: 'node-output' as const, nodeId: 'work', path: [] } },
    };
    const plan = {
      content: JSON.stringify({ graph, rationale: 'review it', rerunNodeIds: [] }),
      reasoningContent: '',
      refusal: '',
      toolCalls: [],
    };
    const provider = new MockProvider([
      plan,
      (request) => {
        expect(request.messages[0]?.content).toContain('REPLAN HOST POLICY');
        expect(request.messages[0]?.content).toContain('This is a replan.');
        return plan;
      },
    ]);
    const runner = new Runner({
      provider,
      capabilities: [flaky],
      workspace,
      runtimeDirectory: '.runtime',
      extraSystemPrompt: 'REPLAN HOST POLICY',
    });
    const agent = defineDagAgent({
      kind: 'dag-agent',
      id: 'reviewed_planner',
      name: 'Reviewed planner',
      systemPrompt: 'Plan.',
      scope: { capabilities: ['tool.reviewed-flaky'] },
      reviewLevel: 'always',
      maxReplans: 1,
    });
    const first = await runner.run(agent, { prompt: 'recover safely' });
    expect(first.status).toBe('awaiting-review');
    if (first.status !== 'awaiting-review') return;

    const second = await runner.resume(first.checkpoint, {
      reviewId: first.review.id,
      revision: first.review.revision,
      action: 'approve',
      reason: '',
    });

    expect(second.status).toBe('awaiting-review');
    if (second.status !== 'awaiting-review') return;
    expect(second.state.conversation?.revision).toBeGreaterThan(
      first.state.conversation?.revision ?? 0,
    );
    expect(second.checkpoint.state.conversation?.revision).toBe(
      second.state.conversation?.revision,
    );
    expect(second.review.revision).toBeGreaterThan(first.review.revision);

    const completed = await runner.resume(second.checkpoint, {
      reviewId: second.review.id,
      revision: second.review.revision,
      action: 'approve',
      reason: '',
    });
    expect(completed.status).toBe('completed');
    expect(invocations).toBe(2);
    await runner.close();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dagent-v083-'));
  temporaryDirectories.push(directory);
  return directory;
}
