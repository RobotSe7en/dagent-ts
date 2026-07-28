import type { AutoAgent, DagAgent, Runner, SkillInstallOptions, ToolAgent } from 'dagent-ai';

export class SkillServiceError extends Error {
  public constructor(
    public readonly code: 'SKILL_IN_USE',
    message: string,
    public readonly statusCode: 409,
  ) {
    super(message);
    this.name = 'SkillServiceError';
  }
}

export class SkillService {
  public constructor(private readonly runner: Runner) {}

  public async list() {
    return { skills: await this.runner.skills.list() };
  }

  public view(name: string, filePath?: string) {
    return this.runner.skills.view(name, filePath);
  }

  public installMarkdown(content: string, options: SkillInstallOptions) {
    return this.runner.skills.installMarkdown(content, options);
  }

  public installArchive(content: Uint8Array, options: SkillInstallOptions) {
    return this.runner.skills.installArchive(content, options);
  }

  public async delete(name: string): Promise<void> {
    const skill = await this.runner.skills.view(name);
    const consumers = this.runner
      .agents()
      .filter((agent) =>
        agentSkillIds(agent).some(
          (skillName) => skillName === skill.skill.name || skillName === skill.skill.qualifiedName,
        ),
      )
      .map((agent) => agent.id);
    if (consumers.length > 0) {
      throw new SkillServiceError(
        'SKILL_IN_USE',
        `Skill '${skill.skill.qualifiedName}' is used by agent${
          consumers.length === 1 ? '' : 's'
        } ${consumers.map((id) => `'${id}'`).join(', ')}.`,
        409,
      );
    }
    await this.runner.skills.delete(skill.skill.qualifiedName);
  }
}

function agentSkillIds(agent: ToolAgent | DagAgent | AutoAgent): readonly string[] {
  if (agent.kind !== 'auto-agent') return agent.scope.skills;
  return [
    ...new Set([
      ...agent.scope.skills,
      ...agent.toolAgent.scope.skills,
      ...agent.dagAgent.scope.skills,
    ]),
  ];
}
