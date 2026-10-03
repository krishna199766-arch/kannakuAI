import * as z from 'zod/v4';

/**
 * The API limits how many fields of a request's schema may be unions (a nullable field is one), and a
 * full bill has dozens of "may not be printed" fields. So the model gets a union-free copy of the schema
 * where "absent" is a plain value ("" for text, 0 for page numbers, an extra enum choice), and
 * fromWire() turns those back into null before the app's own schema validates the result.
 */
const ABSENT = 'NOT_STATED';

/** A sub-schema sent to the model in a smaller form, and how to rebuild the app's shape from it. */
export type Simplify = Map<z.ZodType, { wire: z.ZodType; from: (v: unknown) => unknown }>;

const note = (s: z.ZodType, extra: string) => (s.description ? `${s.description}. ${extra}` : extra);

export function toWire(schema: z.ZodType, simplify: Simplify = new Map()): z.ZodType {
  const s = simplify.get(schema);
  if (s) return s.wire;
  if (schema instanceof z.ZodNullable) {
    const inner = schema.unwrap() as z.ZodType;
    const desc = schema.description ?? inner.description;
    const d = (extra: string) => (desc ? `${desc}. ${extra}` : extra);
    if (inner instanceof z.ZodString) return z.string().describe(d('"" if not present'));
    if (inner instanceof z.ZodNumber) return z.number().int().describe(d('0 if not known'));
    if (inner instanceof z.ZodBoolean) return z.enum(['YES', 'NO', ABSENT]).describe(d(`${ABSENT} if not present`));
    if (inner instanceof z.ZodEnum) return z.enum([...(inner.options as string[]), ABSENT]).describe(d(`${ABSENT} if not present`));
    throw new Error(`toWire: unsupported nullable ${inner.constructor.name}`);
  }
  if (schema instanceof z.ZodObject) {
    const shape = Object.fromEntries(Object.entries(schema.shape as Record<string, z.ZodType>).map(([k, v]) => [k, toWire(v, simplify)]));
    const o = z.object(shape);
    return schema.description ? o.describe(schema.description) : o;
  }
  if (schema instanceof z.ZodArray) {
    const a = z.array(toWire(schema.element as z.ZodType, simplify));
    return schema.description ? a.describe(note(schema, '')) : a;
  }
  return schema;
}

/** Maps the "absent" values back to null wherever the app schema allows null. Lenient: nulls pass through. */
export function fromWire(schema: z.ZodType, value: unknown, simplify: Simplify = new Map()): unknown {
  const s = simplify.get(schema);
  if (s) return value && typeof value === 'object' ? value : s.from(value);   // already in the app's shape: keep
  if (schema instanceof z.ZodNullable) {
    const inner = schema.unwrap() as z.ZodType;
    if (value === null || value === undefined || value === '' || value === ABSENT) return null;
    if (inner instanceof z.ZodNumber && value === 0) return null;
    if (inner instanceof z.ZodBoolean && typeof value === 'string') return value === 'YES';
    return value;
  }
  if (schema instanceof z.ZodObject && value && typeof value === 'object' && !Array.isArray(value)) {
    const shape = schema.shape as Record<string, z.ZodType>;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, shape[k] ? fromWire(shape[k], v, simplify) : v]));
  }
  if (schema instanceof z.ZodArray && Array.isArray(value)) return value.map((v) => fromWire(schema.element as z.ZodType, v, simplify));
  return value;
}
