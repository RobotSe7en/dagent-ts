import type { DockerSandbox } from 'dagent-ai';

export class SandboxService {
  public constructor(private readonly sandbox: DockerSandbox | undefined) {}

  public async status() {
    if (this.sandbox === undefined) {
      return {
        enabled: false,
        backend: 'local' as const,
        available: true,
        isolated: false,
      };
    }
    return {
      enabled: true,
      isolated: true,
      ...(await this.sandbox.status()),
    };
  }
}
