// Identifiers for the SQL in fixes. A name is quoted unless it is lower-case letters, digits and
// underscores, starting with a letter or underscore, and not a reserved word.

const RESERVED = new Set(
  (
    'all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate ' +
    'collation column concurrently constraint create cross current_catalog current_date current_role ' +
    'current_schema current_time current_timestamp current_user default deferrable desc distinct do else end ' +
    'except false fetch for foreign freeze from full grant group having ilike in initially inner intersect into ' +
    'is isnull join lateral leading left like limit localtime localtimestamp natural not notnull null offset on ' +
    'only or order outer overlaps placing primary references returning right select session_user similar some ' +
    'symmetric system_user table tablesample then to trailing true union unique user using variadic verbose when ' +
    'where window with'
  ).split(' '),
);

export function ident(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) && !RESERVED.has(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/** schema.name, each part quoted when it needs to be. */
export function qualified(schema: string, name: string): string {
  return `${ident(schema)}.${ident(name)}`;
}
