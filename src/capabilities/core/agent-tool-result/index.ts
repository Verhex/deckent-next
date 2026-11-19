/** Private host provenance. JSON serialization and the strict tool outcome schema carry only the wire result. */
export type ToolErrorClass = 'ordinary' | 'session' | 'cancelled' | 'limit' | 'uncertain';
const classification = Symbol('tool-error-class');
export function withToolErrorClass<T extends object>(value: T, kind: ToolErrorClass): T {
  return Object.defineProperty({ ...value }, classification, { value: kind });
}
export function toolErrorClass(value: object): ToolErrorClass {
  return (value as { [classification]?: ToolErrorClass })[classification] ?? 'uncertain';
}
