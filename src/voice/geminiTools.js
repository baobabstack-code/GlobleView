/**
 * Convert the voice session's OpenAI-shaped function tools
 * (`{ type: 'function', name, description, parameters }`) into Gemini Live
 * `functionDeclarations`, whose `parameters` is Gemini's OpenAPI-style
 * Schema: upper-case type names, and only the keywords below.
 */

/** Schema keywords Gemini's function declarations accept, kept as they are. */
const KEPT_KEYWORDS = new Set([
  'description',
  'enum',
  'format',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
]);

const TYPES = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'object',
]);

/**
 * Gemini has no "any" type. An untyped node (`{}`) becomes text the
 * consumer parses, as the analyst engine does for filter values.
 */
const ANY_VALUE_NOTE =
  'Any value as text: write numbers as digits and flags as true or false.';

/** Convert one JSON Schema node; throws on a construct Gemini can't express. */
export function toGeminiSchema(node, path = 'parameters') {
  if (!node || typeof node !== 'object' || Array.isArray(node))
    throw new Error(`${path}: schema must be an object`);
  if (node.type === undefined && !node.properties && !node.items) {
    const description = [node.description, ANY_VALUE_NOTE]
      .filter(Boolean)
      .join(' ');
    return { type: 'STRING', description };
  }
  let type = node.type;
  let nullable = false;
  if (Array.isArray(type)) {
    const concrete = type.filter((t) => t !== 'null');
    if (concrete.length !== 1)
      throw new Error(`${path}: union type ${JSON.stringify(type)}`);
    nullable = concrete.length !== type.length;
    type = concrete[0];
  }
  if (!TYPES.has(type)) throw new Error(`${path}: unsupported type ${type}`);

  const out = { type: type.toUpperCase() };
  for (const [key, value] of Object.entries(node)) {
    if (KEPT_KEYWORDS.has(key)) out[key] = value;
  }
  if (nullable) out.nullable = true;
  if (out.enum && type !== 'string') {
    // Gemini only enumerates strings; a numeric enum stays a plain number.
    delete out.enum;
  }

  if (type === 'array') {
    if (!node.items) throw new Error(`${path}: array without items`);
    out.items = toGeminiSchema(node.items, `${path}.items`);
  }
  if (type === 'object') {
    const props = Object.entries(node.properties || {});
    if (props.length) {
      out.properties = Object.fromEntries(
        props.map(([name, child]) => [
          name,
          toGeminiSchema(child, `${path}.properties.${name}`),
        ]),
      );
      const required = (node.required || []).filter((name) =>
        Object.hasOwn(out.properties, name),
      );
      if (required.length) out.required = required;
    }
  }
  return out;
}

const NUMERIC_TEXT = /^\s*[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?\s*$/;

/** Text Gemini sent for an "any" value, restored to the value it names. */
function restoreAnyValue(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (NUMERIC_TEXT.test(value)) return Number(value);
  return value;
}

const isAnyNode = (node) =>
  node && node.type === undefined && !node.properties && !node.items;

/** Paths (`filters.[].value`) under a schema whose node accepts any type. */
function anyPathsIn(schema, prefix = []) {
  if (!schema || typeof schema !== 'object') return [];
  if (isAnyNode(schema)) return prefix.length ? [prefix.join('.')] : [];
  const paths = [];
  if (schema.items) paths.push(...anyPathsIn(schema.items, [...prefix, '[]']));
  for (const [name, child] of Object.entries(schema.properties || {}))
    paths.push(...anyPathsIn(child, [...prefix, name]));
  return paths;
}

/**
 * Per tool, the argument paths whose values Gemini sends as text. The server
 * owns the tool schemas, so it hands this map to the browser with the token.
 */
export function anyValuePaths(tools = []) {
  const map = {};
  for (const tool of tools) {
    const paths = anyPathsIn(tool.parameters);
    if (paths.length) map[tool.name] = paths;
  }
  return map;
}

function restoreAt(value, segments) {
  if (!segments.length) return restoreAnyValue(value);
  const [head, ...rest] = segments;
  if (head === '[]')
    return Array.isArray(value)
      ? value.map((item) => restoreAt(item, rest))
      : value;
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, head))
    return value;
  return { ...value, [head]: restoreAt(value[head], rest) };
}

/**
 * Restore a Gemini tool call's arguments to what the app's actions expect:
 * at the paths from `anyValuePaths`, text is turned back into numbers or
 * flags (see ANY_VALUE_NOTE). Everything else passes through unchanged.
 */
export function createGeminiArgDecoder(paths = {}) {
  return (name, args) => {
    let out = args ?? {};
    for (const path of paths[name] || []) out = restoreAt(out, path.split('.'));
    return out;
  };
}

/**
 * Gemini Live function declarations for the voice tools. `behavior:
 * 'BLOCKING'` makes the model wait for each result before it speaks, which
 * is how the app's tool flow already works with OpenAI.
 */
export function toGeminiFunctionDeclarations(tools = []) {
  return tools.map((tool) => {
    if (tool?.type !== 'function' || !tool.name)
      throw new Error('Voice tools must be function tools with a name');
    const declaration = {
      name: tool.name,
      description: String(tool.description || ''),
      behavior: 'BLOCKING',
    };
    const params = tool.parameters;
    // An object with no properties is refused; such tools take no arguments.
    if (params && Object.keys(params.properties || {}).length) {
      declaration.parameters = toGeminiSchema(
        params,
        `${tool.name}.parameters`,
      );
    }
    return declaration;
  });
}
