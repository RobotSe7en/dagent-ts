#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { join } from 'node:path';

import { OpenAICompatibleProvider } from 'dagent-ai/providers/openai-compatible';

import { appConfigSchema, loadAppConfig } from './config.js';
import { createApplication } from './http/server.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string', short: 'c' },
    host: { type: 'string' },
    port: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
});

if (values.version === true) {
  process.stdout.write('dagent-ai-app 0.1.0\n');
  process.exit(0);
}

const command = positionals[0] ?? 'serve';
if (values.help === true || command === 'help') {
  process.stdout.write('Usage: dagent serve [--config path] [--host address] [--port number]\n');
  process.exit(0);
}
if (command !== 'serve') {
  process.stderr.write(`Unknown command '${command}'.\n`);
  process.exit(2);
}

const loaded = await loadAppConfig(values.config);
const config = appConfigSchema.parse({
  ...loaded,
  host: values.host ?? loaded.host,
  port: values.port === undefined ? loaded.port : Number(values.port),
  webRoot: loaded.webRoot ?? join(import.meta.dirname, '..', 'web'),
});
const provider = new OpenAICompatibleProvider({
  baseURL: config.provider.baseURL,
  model: config.provider.model,
  ...(config.provider.apiKey === undefined
    ? { apiKeyEnv: config.provider.apiKeyEnv }
    : { apiKey: config.provider.apiKey }),
  contextWindowTokens: config.provider.contextWindowTokens,
  outputReserveTokens: config.provider.outputReserveTokens,
});
const application = await createApplication({ config, provider });
await application.server.listen({ host: config.host, port: config.port });

let closing = false;
const close = async (signal: string): Promise<void> => {
  if (closing) return;
  closing = true;
  application.server.log.info({ signal }, 'Shutting down.');
  await application.close();
};
process.once('SIGINT', () => void close('SIGINT'));
process.once('SIGTERM', () => void close('SIGTERM'));
