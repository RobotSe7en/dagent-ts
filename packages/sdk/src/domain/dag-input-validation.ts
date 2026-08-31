import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';

import type { DAGSpec, JsonSchema, JsonValue } from '../contracts/index.js';
import { DagentError, DagInputValidationError, errorMessage } from '../errors.js';

export function validateInputSchema(schema: JsonSchema): void {
  compileInputSchema(schema);
}

export function validateDagInput(specOrSchema: DAGSpec | JsonSchema, graphInput: JsonValue): void {
  const schema = isDagSpec(specOrSchema) ? specOrSchema.inputSchema : specOrSchema;
  if (schema === undefined) return;
  const validate = compileInputSchema(schema);
  if (validate(graphInput)) return;

  const issue = selectInputIssue(validate.errors);
  const path = issue === undefined ? [] : instancePath(issue);
  const schemaPath = issue === undefined ? [] : pointerSegments(issue.schemaPath);
  const location = formatJsonPath(path);
  const detail = issue?.message ?? 'input validation failed';
  throw new DagInputValidationError(
    `Graph input does not match inputSchema at ${location}: ${detail}.`,
    { path, schemaPath },
  );
}

function compileInputSchema(schema: JsonSchema): ValidateFunction<JsonValue> {
  try {
    assertJsonDocument(schema);
    const ajv = new Ajv2020({
      allErrors: true,
      strict: false,
      validateFormats: false,
      validateSchema: true,
    });
    return ajv.compile<JsonValue>(schema);
  } catch (error) {
    throw new DagentError(
      'DAG_VALIDATION_FAILED',
      `DAG inputSchema must be a valid, self-contained JSON Schema Draft 2020-12 document: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function assertJsonDocument(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new TypeError('JSON numbers must be finite');
  }
  if (typeof value !== 'object') {
    throw new TypeError(`JSON cannot contain ${typeof value} values`);
  }
  if (seen.has(value)) throw new TypeError('JSON cannot contain circular references');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonDocument(item, seen);
  } else {
    for (const item of Object.values(value)) assertJsonDocument(item, seen);
  }
  seen.delete(value);
}

function selectInputIssue(
  errors: readonly ErrorObject[] | null | undefined,
): ErrorObject | undefined {
  return (
    errors?.find((error) => error.keyword !== 'anyOf' && error.keyword !== 'oneOf') ?? errors?.[0]
  );
}

function instancePath(issue: ErrorObject): (string | number)[] {
  const path = pointerSegments(issue.instancePath);
  if (issue.keyword === 'required') {
    const params = issue.params as Record<string, unknown>;
    const missing = params['missingProperty'];
    if (typeof missing === 'string') path.push(missing);
  }
  return path;
}

function pointerSegments(pointer: string): (string | number)[] {
  const normalized = pointer.startsWith('#') ? pointer.slice(1) : pointer;
  if (normalized === '') return [];
  return normalized
    .split('/')
    .slice(1)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .map((segment) => (/^(?:0|[1-9][0-9]*)$/u.test(segment) ? Number(segment) : segment));
}

function formatJsonPath(path: readonly (string | number)[]): string {
  return path.reduce<string>(
    (result, segment) =>
      typeof segment === 'number'
        ? `${result}[${String(segment)}]`
        : /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(segment)
          ? `${result}.${segment}`
          : `${result}[${JSON.stringify(segment)}]`,
    '$',
  );
}

function isDagSpec(value: DAGSpec | JsonSchema): value is DAGSpec {
  return value['schemaVersion'] === 1 && Array.isArray(value['nodes']);
}
