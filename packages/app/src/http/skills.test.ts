import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MockProvider } from 'dagent-ai/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { appConfigSchema } from '../config.js';
import { createApplication } from './server.js';

const temporaryDirectories: string[] = [];
const packagedSkill =
  'UEsDBBQAAAAIAC53/FwgLyKqSQAAAE4AAAAPAAAAYnVuZGxlL1NLSUxMLm1k09XV5cpLzE21Uiguzc1NLMqsSuVKSS1OLsosKMnMz7NSCIYJ63ElJ5akpucXVVoplBdllmTmpXPpAnVzhRanKmSk5hSkFukBAFBLAwQUAAAACAAud/xcdulaUxUAAAATAAAAFQAAAGJ1bmRsZS9zY3JpcHRzL3J1bi5qc0vOzyvOz0nVy8lP11DKz1bStOYCAFBLAwQUAAAACAAud/xc6G7lfg4AAAAMAAAAGgAAAGJ1bmRsZS9yZWZlcmVuY2VzL3N0eWxlLm1k805NLVAozsgvKtHjAgBQSwECFAMUAAAACAAud/xcIC8iqkkAAABOAAAADwAAAAAAAAAAAAAAgAEAAAAAYnVuZGxlL1NLSUxMLm1kUEsBAhQDFAAAAAgALnf8XHbpWlMVAAAAEwAAABUAAAAAAAAAAAAAAIABdgAAAGJ1bmRsZS9zY3JpcHRzL3J1bi5qc1BLAQIUAxQAAAAIAC53/FzobuV+DgAAAAwAAAAaAAAAAAAAAAAAAACAAb4AAABidW5kbGUvcmVmZXJlbmNlcy9zdHlsZS5tZFBLBQYAAAAAAwADAMgAAAAEAQAAAAA=';

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('skill resources', () => {
  it('installs packaged skills, serves linked files, and protects agent references', async () => {
    const directory = await temporaryDirectory();
    const application = await createApplication({
      config: appConfigSchema.parse({ dataDirectory: join(directory, 'data') }),
      provider: new MockProvider([]),
      logger: false,
    });
    const installed = await application.server.inject({
      method: 'POST',
      url: '/api/v1/skills',
      payload: { format: 'zip', contentBase64: packagedSkill },
    });
    const listed = await application.server.inject({
      method: 'GET',
      url: '/api/v1/skills',
    });
    const script = await application.server.inject({
      method: 'GET',
      url: '/api/v1/skills/view?name=writing%2Fsummarize&filePath=scripts%2Frun.js',
    });
    const tested = await application.server.inject({
      method: 'POST',
      url: '/api/v1/capabilities/skill.view/test',
      payload: {
        arguments: { name: 'writing/summarize', filePath: 'references/style.md' },
      },
    });
    const agent = await application.server.inject({
      method: 'POST',
      url: '/api/v1/agents',
      payload: {
        kind: 'tool-agent',
        id: 'summarizer',
        name: 'Summarizer',
        scope: { skills: ['writing/summarize'] },
        reviewLevel: 'never',
      },
    });
    const deleteInUse = await application.server.inject({
      method: 'DELETE',
      url: '/api/v1/skills?name=writing%2Fsummarize',
    });
    await application.server.inject({
      method: 'DELETE',
      url: '/api/v1/agents/summarizer',
    });
    const deleted = await application.server.inject({
      method: 'DELETE',
      url: '/api/v1/skills?name=writing%2Fsummarize',
    });

    expect(installed.statusCode).toBe(201);
    expect(installed.json()).toMatchObject({
      skill: {
        skill: { qualifiedName: 'writing/summarize', managed: true },
        linkedFiles: {
          references: ['references/style.md'],
          scripts: ['scripts/run.js'],
        },
      },
    });
    expect(listed.json()).toMatchObject({
      skills: [{ qualifiedName: 'writing/summarize' }],
    });
    expect(script.json()).toMatchObject({ content: 'console.log("ok");\n' });
    expect(tested.json()).toMatchObject({
      result: {
        status: 'completed',
        output: expect.objectContaining({ content: 'Keep short.\n' }),
      },
    });
    expect(agent.statusCode).toBe(201);
    expect(deleteInUse.statusCode).toBe(409);
    expect(deleted.statusCode).toBe(204);
    await application.close();
  });

  it('rejects agent presets that reference unavailable skills', async () => {
    const directory = await temporaryDirectory();
    const application = await createApplication({
      config: appConfigSchema.parse({ dataDirectory: join(directory, 'data') }),
      provider: new MockProvider([]),
      logger: false,
    });
    const invalid = await application.server.inject({
      method: 'POST',
      url: '/api/v1/agents',
      payload: {
        kind: 'tool-agent',
        id: 'invalid_skill_user',
        name: 'Invalid',
        scope: { skills: ['missing'] },
        reviewLevel: 'never',
      },
    });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ error: { message: string } }>().error.message).toContain(
      "unavailable skill 'missing'",
    );
    await application.close();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dagent-skills-http-'));
  temporaryDirectories.push(directory);
  return directory;
}
