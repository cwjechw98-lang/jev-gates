/**
 * The tool-registration contract.
 *
 * A tool that registers with a lossy schema is registered but uncallable: the model
 * is shown a parameter list that no longer matches what `execute` reads. Nothing
 * throws, nothing logs, and the failure only appears as a tool the agent "cannot
 * figure out how to use". These tests pin the compiled schema, not the intent.
 *
 * They run against a mock `ctx`, which is deliberate: this is a unit check of the
 * registration contract. Whether the real registry ends up exposing the tools is a
 * different question, and it is answered by booting a harness — see
 * `adapters/dsh/catalog-probe.mjs` and the acceptance's catalog set.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../adapters/dsh/tools.mjs';

/** A minimal Cordis context that records what the plugin registers. */
function mockContext() {
  const registered = [];
  const listeners = [];
  return {
    registered,
    listeners,
    ctx: {
      tools: {
        register(definition) {
          registered.push(definition);
          return () => {};
        },
      },
      on(event, handler) {
        listeners.push({ event, handler });
        return () => {};
      },
      effect(fn) {
        fn();
      },
      logger: { info() {} },
    },
  };
}

/** Register with the given config and return the definitions. */
function register(config = {}) {
  const { ctx, registered, listeners } = mockContext();
  apply(ctx, { mode: 'advisory', ...config });
  return { registered, listeners };
}

test('all six capabilities register as tools', () => {
  const { registered } = register();
  assert.deepEqual(
    registered.map((d) => d.name).sort(),
    ['jev_check_progress', 'jev_context_plan', 'jev_diagnose', 'jev_review_scope', 'jev_route_skill', 'jev_verify_completion'],
  );
});

test('every tool declares a description long enough to be usable', () => {
  const { registered } = register();
  for (const definition of registered) {
    assert.equal(typeof definition.description, 'string', `${definition.name} has no description`);
    assert.ok(definition.description.length > 120, `${definition.name}'s description is too thin to route on`);
  }
});

test('the compiled parameter schema is a closed object with the declared properties', () => {
  const { registered } = register();
  for (const definition of registered) {
    const schema = definition.parameters;
    assert.equal(schema.type, 'object', `${definition.name}: parameters must be an object schema`);
    assert.equal(schema.additionalProperties, false, `${definition.name}: an open object schema hides a lost parameter`);
    assert.ok(Array.isArray(schema.required) && schema.required.length > 0, `${definition.name}: nothing is required`);
    for (const key of schema.required) {
      assert.ok(schema.properties[key], `${definition.name}: required ${key} has no property schema`);
    }
  }
});

test('no declared parameter is silently dropped', () => {
  const { registered } = register();
  const byName = Object.fromEntries(registered.map((d) => [d.name, d.parameters]));
  // Spelled out rather than derived, so a dropped parameter is a test failure and
  // not something the test recomputes from the same source it is checking.
  assert.deepEqual(Object.keys(byName.jev_verify_completion.properties).sort(), ['allowModel', 'artifacts', 'projectRoot', 'request', 'runId', 'taskId']);
  assert.deepEqual(Object.keys(byName.jev_route_skill.properties).sort(), ['availableTools', 'explicitSkill', 'runId', 'task', 'taskId']);
  assert.deepEqual(Object.keys(byName.jev_check_progress.properties).sort(), ['events', 'maxRepeats', 'runId', 'taskId']);
  assert.deepEqual(Object.keys(byName.jev_review_scope.properties).sort(), ['diff', 'files', 'rubric', 'runId', 'scope', 'snapshot', 'taskId']);
  assert.deepEqual(Object.keys(byName.jev_context_plan.properties).sort(), ['budgetTokens', 'keepIds', 'messages', 'runId', 'taskId']);
  assert.deepEqual(Object.keys(byName.jev_diagnose.properties).sort(), ['envelope', 'runId', 'taskId']);
});

test('array parameters declare their item type', () => {
  const { registered } = register();
  for (const definition of registered) {
    for (const [key, property] of Object.entries(definition.parameters.properties)) {
      if (property.type !== 'array') continue;
      assert.ok(property.items, `${definition.name}.${key}: an array without items is uncallable`);
      assert.ok(typeof property.items.type === 'string', `${definition.name}.${key}: items must declare a type`);
    }
  }
});

test('every object-typed node states additionalProperties', () => {
  const { registered } = register();
  for (const definition of registered) {
    for (const [key, property] of Object.entries(definition.parameters.properties)) {
      const nodes = [property, property.items].filter(Boolean);
      for (const node of nodes) {
        if (node.type !== 'object') continue;
        assert.ok(
          node.additionalProperties !== undefined,
          `${definition.name}.${key}: an object node must state additionalProperties, or the registry rejects the schema`,
        );
      }
    }
  }
});

test('every tool declares an object output with a renderer', () => {
  const { registered } = register();
  for (const definition of registered) {
    assert.equal(definition.output?.schema?.type, 'object', `${definition.name}: output must be an object schema`);
    assert.equal(typeof definition.output?.render, 'function', `${definition.name}: output needs a render function`);
  }
});

test('the renderer produces text blocks and survives a sparse envelope', () => {
  const { registered } = register();
  for (const definition of registered) {
    const blocks = definition.output.render({}, {});
    assert.ok(Array.isArray(blocks) && blocks.length > 0, `${definition.name}: render returned nothing`);
    assert.equal(blocks[0].type, 'text');
    assert.equal(typeof blocks[0].text, 'string');
  }
});

test('a tool can be switched off without disturbing the others', () => {
  const { registered } = register({ capabilities: { jev_review_scope: { mode: 'off' } } });
  const names = registered.map((d) => d.name);
  assert.ok(!names.includes('jev_review_scope'), 'the disabled tool must not register');
  assert.ok(names.includes('jev_verify_completion'), 'disabling one tool must not disable the rest');
  assert.equal(names.length, 5);
});

test('the plugin observes tool executions without owning the ones it registers', () => {
  const { listeners } = register();
  const post = listeners.find((l) => l.event === 'tools/post-execute');
  assert.ok(post, 'the plugin must observe real executions, or C1 has no harness-observed evidence');
  assert.equal(typeof post.handler, 'function');
});

test('the post-execute observer always calls next, so it can never swallow a result', async () => {
  const { listeners } = register();
  const post = listeners.find((l) => l.event === 'tools/post-execute');
  let called = 0;
  const sentinel = { ok: true };
  const returned = await post.handler({ name: 'some_tool', callId: 'c1', arguments: {} }, { isError: false, value: {} }, () => {
    called += 1;
    return sentinel;
  });
  assert.equal(called, 1, 'an observer that does not call next breaks the tool pipeline');
  assert.equal(returned, sentinel, 'the observer must pass the downstream decision through unchanged');
});

test('a throwing observer still lets the tool result through', async () => {
  const { listeners } = register();
  const post = listeners.find((l) => l.event === 'tools/post-execute');
  let called = 0;
  // A result shape the extractor cannot read must not break the call it watched.
  const returned = await post.handler(null, null, () => {
    called += 1;
    return 'downstream';
  });
  assert.equal(called, 1);
  assert.equal(returned, 'downstream');
});
