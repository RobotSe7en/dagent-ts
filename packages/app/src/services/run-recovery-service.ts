import type { RunCheckpoint, RunEvent } from 'dagent-ai';
import { runCheckpointSchema } from 'dagent-ai/contracts';

import type { AppRepository, StoredRun } from '../database/repositories.js';

const activeStatuses = new Set(['pending', 'planning', 'running', 'resuming']);

export class RunRecoveryService {
  public constructor(private readonly repository: AppRepository) {}

  public async recover(): Promise<number> {
    const interrupted = (await this.repository.listRuns()).filter((run) =>
      activeStatuses.has(run.status),
    );
    for (const run of interrupted) await this.#interrupt(run);
    return interrupted.length;
  }

  async #interrupt(run: StoredRun): Promise<void> {
    const timestamp = new Date().toISOString();
    const checkpoint =
      run.checkpoint === undefined ? undefined : interruptedCheckpoint(run.checkpoint, timestamp);
    await this.repository.updateRun(run.id, 'interrupted', checkpoint);
    const events = await this.repository.eventsAfter(run.id, 0);
    const sequence = (events.at(-1)?.sequence ?? 0) + 1;
    const event: RunEvent = {
      runId: run.id,
      sequence,
      timestamp,
      type: 'run-completed',
      outcome: 'interrupted',
    };
    await this.repository.appendEvent(event);
  }
}

function interruptedCheckpoint(checkpoint: RunCheckpoint, timestamp: string): RunCheckpoint {
  return runCheckpointSchema.parse({
    ...checkpoint,
    state: {
      ...checkpoint.state,
      status: 'interrupted',
      error: 'Run was interrupted because the application restarted.',
      pendingReview: undefined,
      revision: checkpoint.state.revision + 1,
      updatedAt: timestamp,
    },
    createdAt: timestamp,
  });
}
