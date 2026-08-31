import { DagBuilder, Runner, defineStaticDag, tool } from 'dagent-ai';
import { MockProvider } from 'dagent-ai/testing';
import { z } from 'zod';

const fileSchema = z
  .object({
    path: z.string(),
    name: z.string(),
    size: z.number().int().nonnegative(),
    mediaType: z.string().optional(),
  })
  .strict();

const listManifest = tool({
  id: 'tool.list-artifact-manifest-example',
  description: 'Return the validated artifact input manifest.',
  input: z.object({ files: z.array(fileSchema).readonly() }).strict(),
  output: z.array(fileSchema).readonly(),
  execute: ({ files }) => files,
});

const graph = new DagBuilder<Record<string, never>, readonly z.infer<typeof fileSchema>[]>({
  id: 'artifact-files-example',
  name: 'Artifact file manifest example',
  output: z.array(fileSchema).readonly(),
});
const documents = graph.artifact('documents', 'inputs/documents/', {
  description: 'Files supplied when the run starts.',
});
const listed = graph.capability(
  listManifest,
  { files: documents.files() },
  { id: 'list-files', artifactInputs: [documents] },
);
graph.setOutput(listed.output());

await using runner = new Runner({
  provider: new MockProvider([]),
  capabilities: [listManifest],
  workspace: './.dagent-ts-artifacts',
});
const outcome = await runner.run(defineStaticDag(graph.build()), {
  graphInput: {},
  artifactUploads: {
    documents: [
      { filename: 'notes.md', content: Buffer.from('# Notes'), mediaType: 'text/markdown' },
      { filename: 'nested/data.json', content: Buffer.from('{"ok":true}') },
    ],
  },
});

if (outcome.status !== 'completed') throw new Error(outcome.state.error);
console.log(outcome.output);
