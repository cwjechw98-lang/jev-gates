/**
 * A minimal, dependency-free stand-in for `defineTool` from `@deepseek-ai/dsh-tools`.
 *
 * Why not import the real one: a plugin loaded from outside the harness install
 * tree cannot resolve `@deepseek-ai/*`, and adding a machine-specific `node_modules`
 * junction to make it resolve would make the delivered package depend on this
 * machine's layout. So the semantics are mirrored instead, with the citation:
 *
 *   - author-facing spec -> raw JSON Schema: `dsh-tools/lib/index.js`
 *     `parameterSchemaSpecToJsonSchema` / `valueSchemaSpecToJsonSchema`;
 *   - `required` is a per-property `required: true` annotation in the spec and a
 *     top-level `required: string[]` array in the emitted schema;
 *   - an object node must declare `additionalProperties` explicitly, because the
 *     registry refuses an accidental JSON Schema default;
 *   - `type: 'json'` emits a node with no constraints.
 *
 * The registry receives `{ name, description, parameters, output, execute }`,
 * exactly the shape `ToolDefinition` declares
 * (`dsh-tools/lib/types/index.d.ts:106`, `ToolSchema` from `dsh-llm`).
 */

/** Value kinds an author may declare. `json` means "any lossless JSON value". */
const KINDS = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object', 'json']);

/** A violation that a caller can turn into a tool-argument error. */
export class ToolArgsError extends Error {
  constructor(violations) {
    super(`invalid tool arguments: ${violations.join('; ')}`);
    this.name = 'ToolArgsError';
    this.violations = violations;
  }
}

function fail(message) {
  throw new TypeError(`toolspec: ${message}`);
}

/**
 * Compile one author-facing value spec into a raw {@link JsonSchemaNode}.
 * @param {object} spec - author spec: `{ type, enum?, const?, items?, properties?, additionalProperties?, description?, title? }`
 * @param {string} path - where this node sits, for error messages.
 * @returns {object} a raw JSON Schema node.
 */
export function valueSpecToJsonSchema(spec, path = '<root>') {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) fail(`${path}: a value spec must be an object`);
  const node = {};
  if (typeof spec.description === 'string') node.description = spec.description;
  if (typeof spec.title === 'string') node.title = spec.title;

  if (Array.isArray(spec.oneOf)) {
    if (spec.oneOf.length < 2) fail(`${path}: oneOf needs at least two branches`);
    node.oneOf = spec.oneOf.map((branch, index) => valueSpecToJsonSchema(branch, `${path}.oneOf[${index}]`));
    return node;
  }

  if (spec.type === 'json') return node;
  if (typeof spec.type !== 'string' || !KINDS.has(spec.type)) {
    fail(`${path}: type must be one of ${[...KINDS].join(', ')}, got ${JSON.stringify(spec.type)}`);
  }
  node.type = spec.type;

  if (spec.enum !== undefined) {
    if (!Array.isArray(spec.enum) || spec.enum.length === 0) fail(`${path}: enum must be a non-empty array`);
    node.enum = [...spec.enum];
  }
  if (spec.const !== undefined) node.const = spec.const;

  if (spec.type === 'array') {
    if (spec.items !== undefined) node.items = valueSpecToJsonSchema(spec.items, `${path}[]`);
  }
  if (spec.type === 'object') {
    if (spec.additionalProperties === undefined) {
      fail(`${path}: an object spec must state additionalProperties (the registry refuses an implicit default)`);
    }
    node.additionalProperties = spec.additionalProperties === true;
    if (spec.properties !== undefined) {
      const { schema, required } = parameterSpecToJsonSchema(spec.properties, path);
      node.properties = schema.properties;
      if (required.length > 0) node.required = required;
    }
  }
  return node;
}

/**
 * Compile a parameter property map into an object-rooted JSON Schema.
 * The map is an implicit open object root, so `additionalProperties` is stated here.
 * @param {Record<string, object>} spec - property name -> value spec, each optionally `required: true`.
 * @param {string} path - where the map sits, for error messages.
 * @returns {{ schema: object, required: string[] }}
 */
export function parameterSpecToJsonSchema(spec, path = '<parameters>') {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) fail(`${path}: parameters must be a property map`);
  const properties = {};
  const required = [];
  for (const [key, propertySpec] of Object.entries(spec)) {
    const { required: isRequired, ...rest } = propertySpec ?? {};
    properties[key] = valueSpecToJsonSchema(rest, `${path}.${key}`);
    if (isRequired === true) required.push(key);
  }
  const schema = { type: 'object', properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return { schema, required };
}

/** A human-readable name for one JSON value, used in violation messages. */
function describeValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    default: return true;
  }
}

/**
 * Walk a raw schema against a value and collect every violation.
 * Deliberately small: it enforces the subset this project authors, not all of
 * JSON Schema. An unenforced keyword would be a silent hole, so the compiler
 * above refuses to emit one.
 * @param {object} schema - raw JSON Schema node.
 * @param {unknown} value - the value to check.
 * @param {string} path - where the value sits, for messages.
 * @param {string[]} violations - accumulator.
 * @returns {string[]} every violation found, in walk order.
 */
export function collectViolations(schema, value, path = '', violations = []) {
  const at = path === '' ? '<root>' : path;
  if (Array.isArray(schema.oneOf)) {
    const passes = schema.oneOf.some((branch) => collectViolations(branch, value, path, []).length === 0);
    if (!passes) violations.push(`${at}: does not match any allowed shape`);
    return violations;
  }
  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    violations.push(`${at}: expected ${schema.type}, got ${describeValue(value)}`);
    return violations;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => allowed === value)) {
    violations.push(`${at}: must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  }
  if (schema.const !== undefined && value !== schema.const) {
    violations.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  }
  if (schema.type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const name of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, name)) violations.push(`${at}.${name}: required`);
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const name of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties, name)) violations.push(`${at}.${name}: unknown property`);
      }
    }
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      if (Object.prototype.hasOwnProperty.call(value, name)) collectViolations(child, value[name], path === '' ? name : `${path}.${name}`, violations);
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => collectViolations(schema.items, item, `${path}[${index}]`, violations));
  }
  return violations;
}

/**
 * Build a registry-ready tool definition.
 *
 * @param {object} options
 * @param {string} options.name - model-facing tool name; must be unique in the registry.
 * @param {string} options.description - the text the model sees.
 * @param {Record<string, object>} options.parameters - author-facing parameter spec.
 * @param {{ schema: object, render: (args: object, value: any) => object[] }} options.output -
 *   canonical output schema and its pure content projection.
 * @param {(args: object, exec: object) => Promise<unknown>} options.execute - the body.
 * @param {number} [options.timeoutMs] - cooperative budget; declaring it asserts the body
 *   forwards `exec.signal`.
 * @param {(args: object) => object} [options.presentCall] - UI card for the call.
 * @param {(args: object, value: any) => object} [options.presentationMeta] - replayable UI metadata.
 * @returns {object} the definition to hand to `ctx.tools.register`.
 */
export function defineTool(options) {
  if (options === null || typeof options !== 'object') fail('defineTool needs an options object');
  const { name, description, parameters, output, execute, timeoutMs, presentCall, presentationMeta } = options;
  if (typeof name !== 'string' || name.length === 0) fail('defineTool needs a non-empty name');
  if (typeof description !== 'string' || description.length === 0) fail(`defineTool(${name}) needs a description`);
  if (typeof execute !== 'function') fail(`defineTool(${name}) needs an execute function`);
  if (output === null || typeof output !== 'object' || typeof output.render !== 'function') {
    fail(`defineTool(${name}) needs output.render`);
  }
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    fail(`defineTool(${name}): timeoutMs must be a positive finite number`);
  }

  const compiled = parameterSpecToJsonSchema(parameters);
  const outputSchema = valueSpecToJsonSchema(output.schema, `${name}.output`);

  const definition = {
    name,
    description,
    parameters: compiled.schema,
    output: {
      schema: outputSchema,
      render: (args, value) => output.render(args, value),
    },
    async execute(args, exec) {
      const violations = collectViolations(compiled.schema, args ?? {}, '');
      if (violations.length > 0) throw new ToolArgsError(violations);
      return execute(args ?? {}, exec);
    },
  };
  if (timeoutMs !== undefined) definition.timeoutMs = timeoutMs;
  if (typeof presentCall === 'function') definition.presentCall = (args) => presentCall(args);
  if (typeof presentationMeta === 'function') {
    definition.output.presentationMeta = (args, value) => presentationMeta(args, value);
  }
  return definition;
}
