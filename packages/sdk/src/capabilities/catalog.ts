import type {
  CapabilityDefinition,
  CapabilityInvocation,
  CapabilityResult,
  JsonValue,
} from '../contracts/index.js';
import { capabilityResultSchema, createInvocationId } from '../contracts/index.js';
import { DagentError, errorMessage, throwIfAborted } from '../errors.js';
import type { CapabilityBinding, CapabilityExecutionContext } from './tool.js';

export class CapabilityCatalog {
  readonly #bindings = new Map<string, CapabilityBinding>();
  readonly #disabled = new Set<string>();

  public constructor(bindings: readonly CapabilityBinding[] = []) {
    for (const binding of bindings) this.register(binding);
  }

  public register(binding: CapabilityBinding): void {
    const id = binding.definition.id;
    if (this.#bindings.has(id)) {
      throw new DagentError('INVALID_INPUT', `Capability '${id}' is already registered.`);
    }
    this.#bindings.set(id, this.#withEnabledOverride(binding));
  }

  public replace(binding: CapabilityBinding): void {
    this.#bindings.set(binding.definition.id, this.#withEnabledOverride(binding));
  }

  public unregister(id: string): boolean {
    return this.#bindings.delete(id);
  }

  public get(id: string): CapabilityBinding | undefined {
    return this.#bindings.get(id);
  }

  public require(id: string): CapabilityBinding {
    const binding = this.get(id);
    if (binding === undefined || !binding.definition.enabled) {
      throw new DagentError('CAPABILITY_NOT_FOUND', `Capability '${id}' is not available.`);
    }
    return binding;
  }

  public definitions(ids?: readonly string[]): readonly CapabilityDefinition[] {
    const selected =
      ids === undefined ? [...this.#bindings.values()] : ids.map((id) => this.require(id));
    return selected.map(({ definition }) => definition);
  }

  public setEnabled(id: string, enabled: boolean): CapabilityBinding | undefined {
    if (enabled) this.#disabled.delete(id);
    else this.#disabled.add(id);
    const existing = this.#bindings.get(id);
    if (existing === undefined) return undefined;
    const updated = Object.freeze({
      ...existing,
      definition: Object.freeze({ ...existing.definition, enabled }),
    });
    this.#bindings.set(id, updated);
    return updated;
  }

  public disabledIds(): readonly string[] {
    return [...this.#disabled].sort();
  }

  public async invoke(
    capabilityId: string,
    arguments_: Readonly<Record<string, unknown>>,
    context: CapabilityExecutionContext,
    invocationId = createInvocationId(),
  ): Promise<{ readonly invocation: CapabilityInvocation; readonly result: CapabilityResult }> {
    throwIfAborted(context.signal);
    const binding = this.require(capabilityId);
    const invocation: CapabilityInvocation = {
      id: invocationId,
      capabilityId,
      arguments: binding.input.parse(arguments_) as Readonly<Record<string, JsonValue>>,
    };
    try {
      const rawOutput = await binding.execute(binding.input.parse(arguments_), context);
      const output = binding.output.parse(rawOutput) as JsonValue;
      return {
        invocation,
        result: capabilityResultSchema.parse({
          invocationId,
          capabilityId,
          status: 'completed',
          output,
          content: typeof output === 'string' ? output : JSON.stringify(output),
          metadata: {},
        }),
      };
    } catch (error) {
      if (context.signal.aborted) {
        return {
          invocation,
          result: capabilityResultSchema.parse({
            invocationId,
            capabilityId,
            status: 'cancelled',
            content: '',
            error: 'Capability execution was cancelled.',
            metadata: {},
          }),
        };
      }
      return {
        invocation,
        result: capabilityResultSchema.parse({
          invocationId,
          capabilityId,
          status: 'failed',
          content: '',
          error: errorMessage(error),
          metadata: {},
        }),
      };
    }
  }

  #withEnabledOverride(binding: CapabilityBinding): CapabilityBinding {
    if (!this.#disabled.has(binding.definition.id) || !binding.definition.enabled) return binding;
    return Object.freeze({
      ...binding,
      definition: Object.freeze({ ...binding.definition, enabled: false }),
    });
  }
}
