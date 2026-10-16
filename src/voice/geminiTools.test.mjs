import test from 'node:test';
import assert from 'node:assert/strict';
import { standaloneVoiceTools } from '../../server/standalone/voiceTools.js';
import { toGeminiFunctionDeclarations, toGeminiSchema } from './geminiTools.js';

const ALLOWED = new Set([
  'type',
  'description',
  'nullable',
  'enum',
  'format',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
  'properties',
  'required',
  'items',
]);

/** Every key in a converted schema, with the path that holds it. */
function* schemaKeys(node, path) {
  for (const [key, value] of Object.entries(node)) {
    yield [key, path];
    if (key === 'properties')
      for (const [name, child] of Object.entries(value))
        yield* schemaKeys(child, `${path}.${name}`);
    else if (key === 'items') yield* schemaKeys(value, `${path}[]`);
  }
}

test('every voice tool converts with only keywords Gemini accepts', () => {
  const tools = standaloneVoiceTools();
  const declarations = toGeminiFunctionDeclarations(tools);
  assert.equal(declarations.length, tools.length);
  assert.equal(new Set(declarations.map((d) => d.name)).size, tools.length);
  for (const declaration of declarations) {
    assert.equal(declaration.behavior, 'BLOCKING');
    assert.ok(declaration.description, `${declaration.name} has a description`);
    if (!declaration.parameters) continue;
    assert.equal(declaration.parameters.type, 'OBJECT');
    for (const [key, path] of schemaKeys(
      declaration.parameters,
      declaration.name,
    ))
      assert.ok(ALLOWED.has(key), `${path} keeps unsupported "${key}"`);
  }
});

test('required fields and string enums survive conversion', () => {
  const tools = standaloneVoiceTools();
  const declarations = new Map(
    toGeminiFunctionDeclarations(tools).map((d) => [d.name, d]),
  );
  for (const tool of tools) {
    const converted = declarations.get(tool.name).parameters;
    for (const name of tool.parameters?.required || [])
      assert.ok(
        converted?.required?.includes(name),
        `${tool.name}.${name} still required`,
      );
    for (const [name, prop] of Object.entries(
      tool.parameters?.properties || {},
    )) {
      if (prop.type === 'string' && prop.enum)
        assert.deepEqual(
          converted.properties[name].enum,
          prop.enum,
          `${tool.name}.${name}`,
        );
    }
  }
});

test('schema conversion upper-cases types and handles nullable unions', () => {
  assert.deepEqual(
    toGeminiSchema({
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: ['string', 'null'], maxLength: 40 },
        tags: {
          type: 'array',
          items: { type: 'string', enum: ['a', 'b'] },
          minItems: 1,
        },
        level: { type: 'integer', enum: [1, 2], minimum: 1 },
      },
      required: ['name', 'missing'],
    }),
    {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', maxLength: 40, nullable: true },
        tags: {
          type: 'ARRAY',
          minItems: 1,
          items: { type: 'STRING', enum: ['a', 'b'] },
        },
        level: { type: 'INTEGER', minimum: 1 },
      },
      required: ['name'],
    },
  );
  assert.throws(
    () => toGeminiSchema({ type: ['string', 'number'] }),
    /union type/,
  );
  assert.throws(() => toGeminiSchema({ type: 'array' }), /without items/);
});

test('a tool without arguments gets no parameters object', () => {
  const [declaration] = toGeminiFunctionDeclarations([
    {
      type: 'function',
      name: 'reset',
      description: 'Reset',
      parameters: { type: 'object', properties: {} },
    },
  ]);
  assert.deepEqual(declaration, {
    name: 'reset',
    description: 'Reset',
    behavior: 'BLOCKING',
  });
  assert.throws(
    () => toGeminiFunctionDeclarations([{ name: 'x' }]),
    /function tools/,
  );
});

test('arguments for "any" values are restored to numbers and flags', async () => {
  const { anyValuePaths, createGeminiArgDecoder } =
    await import('./geminiTools.js');
  const paths = anyValuePaths(standaloneVoiceTools());
  assert.deepEqual(paths, { analyst_query: ['filters.[].value'] });
  // The map travels to the browser as JSON.
  const decode = createGeminiArgDecoder(JSON.parse(JSON.stringify(paths)));
  const args = {
    layers: ['flights'],
    filters: [
      { field: 'military', op: 'eq', value: 'true' },
      { field: 'altitude', op: 'gt', value: '40000' },
      { field: 'callsign', op: 'contains', value: 'UAL' },
    ],
  };
  assert.deepEqual(
    decode('analyst_query', args).filters.map((f) => f.value),
    [true, 40000, 'UAL'],
  );
  // Typed fields are left alone, and unknown tools pass through.
  assert.deepEqual(decode('analyst_query', { layers: ['flights'] }), {
    layers: ['flights'],
  });
  assert.deepEqual(decode('no_such_tool', { a: 'true' }), { a: 'true' });
});
