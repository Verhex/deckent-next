import { z } from 'zod';
import { DeckentJsonSchemaValidator, validateStandardSchemaSync, type ConfigSectionSchema, toInputJsonSchema } from '#platform/index.js';
import type { StandardSchemaV1 } from '#platform/index.js';

export type ConfigSchemaNode = z.ZodType | ProjectedConfigNode;
/** Foreign sections retain their validator; JSON Schema only supplies navigation and partial-overlay checks. */
export class ProjectedConfigNode {
  readonly description: string | undefined;
  constructor(readonly projection: Record<string, unknown>, private readonly root = projection, private readonly standard?: ConfigSectionSchema) {
    this.description = typeof projection['description'] === 'string' ? projection['description'] : undefined;
  }
  safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: { issues: readonly StandardSchemaV1.Issue[] } } {
    if (this.standard) {
      const parsed = validateStandardSchemaSync(this.standard, value);
      return parsed.status === 'valid' ? { success: true, data: parsed.value } : { success: false, error: { issues: parsed.status === 'invalid' && parsed.issues.length ? parsed.issues : [{ message: 'SECTION_INVALID' }] } };
    }
    const checked = new DeckentJsonSchemaValidator().getValidator(this.jsonSchema())(value);
    return checked.valid ? { success: true, data: checked.data } : { success: false, error: { issues: [{ message: 'SECTION_INVALID' }] } };
  }
  jsonSchema(): Record<string, unknown> {
    return { ...this.projection, ...(this.root['$defs'] ? { $defs: this.root['$defs'] } : {}), ...(this.root['definitions'] ? { definitions: this.root['definitions'] } : {}) };
  }
  private node(value: unknown): ProjectedConfigNode | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    let projection = value as Record<string, unknown>;
    const seen = new Set<unknown>();
    while (typeof projection['$ref'] === 'string') {
      if (seen.has(projection)) return undefined;
      seen.add(projection);
      const ref = projection['$ref'];
      if (!ref.startsWith('#/')) return undefined;
      let target: unknown = this.root;
      for (const part of ref.slice(2).split('/')) target = target && typeof target === 'object' ? (target as Record<string, unknown>)[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
      if (!target || typeof target !== 'object' || Array.isArray(target)) return undefined;
      projection = target as Record<string, unknown>;
    }
    return new ProjectedConfigNode(projection, this.root);
  }
  get options(): readonly ProjectedConfigNode[] {
    const branches = this.projection['anyOf'] ?? this.projection['oneOf'];
    return Array.isArray(branches) ? branches.flatMap(branch => this.node(branch) ?? []) : [];
  }
  get properties(): Readonly<Record<string, ProjectedConfigNode>> | undefined {
    const properties = this.projection['properties'];
    return properties && typeof properties === 'object' ? Object.fromEntries(Object.entries(properties).flatMap(([key, value]) => {
      const node = this.node(value); return node ? [[key, node]] : [];
    })) : undefined;
  }
  get item(): ProjectedConfigNode | undefined { return this.node(this.projection['items']); }
  get entry(): ProjectedConfigNode | undefined { return this.node(this.projection['additionalProperties']); }
  child(part: string): ConfigSchemaNode | undefined {
    const children = this.options.flatMap(option => option.child(part) ?? []);
    return this.properties?.[part] ?? (this.item && /^(0|[1-9]\d*)$/.test(part) ? this.item : this.entry) ??
      (children.length > 1 ? new ProjectedConfigNode({ anyOf: children.map(child => projectConfigSchema(child)) }, this.root) : children[0]);
  }
}
export function configSchemaNode(schema: ConfigSectionSchema): ConfigSchemaNode {
  return schema instanceof z.ZodType ? schema : new ProjectedConfigNode(schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' }), undefined, schema);
}
export function projectConfigSchema(schema: ConfigSchemaNode): Record<string, unknown> {
  return schema instanceof ProjectedConfigNode ? schema.jsonSchema() : toInputJsonSchema(schema);
}
