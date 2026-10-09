/** Any value `JSON.parse` can produce. The honest boundary type for a payload whose shape the
 *  server does not fix: structurally JSON, nothing more. Callers narrow it themselves. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
