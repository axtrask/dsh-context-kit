/**
 * Validate a tool's canonical output against its DECLARED output schema.
 *
 * The harness validates every value a tool returns and, on a mismatch, throws
 * `tool "<name>" returned invalid output: <violations>` (`INVALID_TOOL_OUTPUT`,
 * `@deepseek-ai/dsh-tools`). That message REPLACES the tool's own answer, so a
 * refusal path that forgets one schema-required property reaches the model as a
 * crash instead of as "nothing was compressed: …".
 *
 * That is exactly how `compress` shipped a broken refusal path: its `empty`
 * result omitted `freedTokens`, and asking to compress an already-compressed
 * span produced `returned invalid output: missing required property
 * "value.freedTokens"`. The earlier checks did not catch it because they only
 * inspected the properties they already knew about, and only ever exercised the
 * SUCCESS path.
 *
 * This module is the shared checker: recursive, so a gap in a nested `blocks[]`
 * item is caught too, and path-labelled, so the message names the exact field.
 *
 * A value schema expresses requiredness by `required: true` on the property
 * itself (which the harness compiles into the JSON Schema `required` list) or by
 * the JSON Schema `required` array; both are honoured.
 *
 * @module dsh-context-kit/scripts/schema-check
 */

/**
 * Collect every way `value` violates `schema`.
 * @param schema - the declared schema node (`output.schema`, or a nested node).
 * @param value - the candidate value.
 * @param path - dotted path used in the diagnostics, e.g. `value.blocks[0].start`.
 * @returns one human-readable line per violation; empty when the value conforms.
 */
export function schemaViolations(schema, value, path = 'value') {
  if (schema === undefined || schema === null) return [];
  const bad = [];
  const required = (name) => schema.required?.includes(name) === true || schema.properties?.[name]?.required === true;

  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [`${path} is not an object`];
    for (const name of Object.keys(schema.properties ?? {})) {
      if (value[name] === undefined) {
        if (required(name)) bad.push(`${path}.${name} is missing`);
        continue;
      }
      bad.push(...schemaViolations(schema.properties[name], value[name], `${path}.${name}`));
    }
    return bad;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${path} is not an array`];
    // `single` forces a one-element array; a longer one is a protocol violation.
    if (schema.single === true && value.length !== 1) bad.push(`${path} must hold exactly one element, got ${value.length}`);
    value.forEach((item, index) => bad.push(...schemaViolations(schema.items, item, `${path}[${index}]`)));
    return bad;
  }

  if (value === undefined) return [`${path} is missing`];
  switch (schema.type) {
    case 'integer':
      if (!Number.isInteger(value)) bad.push(`${path} is not an integer (${JSON.stringify(value)})`);
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) bad.push(`${path} is not a finite number`);
      break;
    case 'string':
      if (typeof value !== 'string') bad.push(`${path} is not a string`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') bad.push(`${path} is not a boolean`);
      break;
    case 'null':
      if (value !== null) bad.push(`${path} is not null`);
      break;
    default:
      break;
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    bad.push(`${path} is ${JSON.stringify(value)}, outside ${JSON.stringify(schema.enum)}`);
  }
  return bad;
}
