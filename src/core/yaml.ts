// A value as YAML text, for the agents whose settings are a YAML file (Goose's
// config.yaml, Hermes's): the entry their Connect panel and `tricot connect`
// show, and the lines Tricot writes into one. JSON is YAML, so a string that
// isn't a plain word is written as a JSON string, and nothing here needs a
// YAML library. Maps and lists are in block style, two spaces deep, as people
// write them; undefined values are left out. Browser-safe: the page shows it.

type Yaml = string | number | boolean | null | undefined | Yaml[] | { [key: string]: Yaml };

const PLAIN = /^[A-Za-z][\w-]*$/;
// Words YAML reads as something else when bare.
const RESERVED = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'y', 'n']);

const isCollection = (value: Yaml): value is Yaml[] | { [key: string]: Yaml } => typeof value === 'object' && value !== null;

function scalar(value: string | number | boolean | null | undefined): string {
  if (typeof value === 'string') return PLAIN.test(value) && !RESERVED.has(value.toLowerCase()) ? value : JSON.stringify(value);
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('YAML has no text for a number that is not finite.');
  return value === undefined || value === null ? 'null' : String(value);
}

const key = (name: string): string => (PLAIN.test(name) && !RESERVED.has(name.toLowerCase()) ? name : JSON.stringify(name));

const isEmpty = (value: Yaml[] | { [key: string]: Yaml }): boolean => (Array.isArray(value) ? value.length === 0 : Object.values(value).every((v) => v === undefined));

// The lines of a collection at one indentation.
function block(value: Yaml[] | { [key: string]: Yaml }, indent: number): string[] {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (!isCollection(item) || isEmpty(item)) return [`${pad}- ${inline(item)}`];
      const [first, ...rest] = block(item, indent + 2);
      return [`${pad}- ${first.slice(indent + 2)}`, ...rest];
    });
  }
  return Object.entries(value).flatMap(([name, item]) => {
    if (item === undefined) return [];
    if (!isCollection(item) || isEmpty(item)) return [`${pad}${key(name)}: ${inline(item)}`];
    return [`${pad}${key(name)}:`, ...block(item, indent + 2)];
  });
}

// A scalar, or an empty list or map, on one line.
function inline(value: Yaml): string {
  if (!isCollection(value)) return scalar(value);
  return Array.isArray(value) ? '[]' : '{}';
}

export function yamlText(value: Yaml): string {
  return isCollection(value) && !isEmpty(value) ? block(value, 0).join('\n') : inline(value);
}
