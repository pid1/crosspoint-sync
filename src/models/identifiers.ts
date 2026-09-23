import type { DB } from '../db/db.js';
import { resolveDocument } from './merge.js';

/**
 * Optional multi-identifier document matching, tracking
 * koreader/koreader-sync-server#55 (open, unmerged).
 *
 * A client offers an ordered list of identifiers for one book, strongest first,
 * so a copy that hashes differently keeps the position. `type` is an opaque
 * label chosen by the client: it is stored and echoed without being
 * interpreted, so a new kind of identifier needs no server change.
 */

export interface Identifier {
  type: string;
  value: string;
}

export const MAX_IDENTIFIERS = 8;

// A value becomes a document key, so it carries a document key's restrictions;
// neither may contain the separators of the flattened query form.
const TYPE_RE = /^[a-z][a-z0-9-]{0,31}$/;
const VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The list itself, or null when an entry is malformed or a type repeats. */
function validate(list: Identifier[]): Identifier[] | null {
  const types = new Set<string>();
  for (const { type, value } of list) {
    if (!TYPE_RE.test(type) || !VALUE_RE.test(value)) return null;
    // Two values for one type is a client bug: resolving it in list order would
    // make the answer depend on which the client happened to put first.
    if (types.has(type)) return null;
    types.add(type);
  }
  return list;
}

/** The list as a PUT body carries it, or null when it is malformed. */
export function parseList(raw: unknown): Identifier[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_IDENTIFIERS) return null;
  const list: Identifier[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { type, value } = entry as { type?: unknown; value?: unknown };
    if (typeof type !== 'string' || typeof value !== 'string') return null;
    list.push({ type, value });
  }
  return validate(list);
}

/**
 * The same list flattened to `type:value,type:value`. A GET has no body and
 * repeated query parameters are not reliably ordered, so the order lives in one
 * parameter.
 */
export function parseQuery(raw: string): Identifier[] | null {
  if (raw.length === 0) return null;
  const entries = raw.split(',');
  if (entries.length > MAX_IDENTIFIERS) return null;
  const list: Identifier[] = [];
  for (const entry of entries) {
    const pair = entry.split(':');
    if (pair.length !== 2) return null;
    list.push({ type: pair[0], value: pair[1] });
  }
  return validate(list);
}

export function encodeList(list: Identifier[]): string {
  return list.map((i) => `${i.type}:${i.value}`).join(',');
}

export function decodeList(raw: string | null | undefined): Identifier[] | null {
  return typeof raw === 'string' && raw.length > 0 ? parseQuery(raw) : null;
}

/**
 * The strongest identifier the reader shares with the writer, in the reader's
 * own order of preference and under the reader's own label.
 *
 * A different question from how the record was found: a reader can match a
 * record on its own content digest and still be reading a different edition
 * from the one that wrote the position, in which case the xpointer does not
 * apply.
 */
export function commonIdentifier(reader: Identifier[], writer: Identifier[]): string | null {
  const values = new Set(writer.map((i) => i.value));
  for (const { type, value } of reader) {
    if (values.has(value)) return type;
  }
  return null;
}

/**
 * The type a list creates a record under: the label the caller gave the entry
 * whose value is `document`, wherever the list ranks it. Undefined for a list
 * naming no such entry, which is what makes such a list invalid.
 */
export function documentType(list: Identifier[], document: string): string | undefined {
  return list.find((i) => i.value === document)?.type;
}

/** The document an offered list resolved to, under the caller's own label. */
export interface IdentifierMatch {
  document: string;
  type: string;
  /** Its rank in the caller's list; nothing above it describes the record. */
  index: number;
}

function hasProgress(db: DB, userId: number, document: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM progress WHERE user_id = ? AND document = ? LIMIT 1')
    .get(userId, document);
  return row !== undefined;
}

function aliasTarget(db: DB, userId: number, alias: string): string | null {
  const row = db
    .prepare('SELECT document FROM identifier_aliases WHERE user_id = ? AND alias = ?')
    .get(userId, alias) as { document: string } | undefined;
  return row?.document ?? null;
}

/**
 * Walk the list in the caller's order, trying each value as a document (through
 * any merge that applies) before following it through the alias table, and stop
 * at the first hit.
 *
 * The order is the client's preference, so it is what decides between a strong
 * identifier and a weak one; a server that resolved in its own order would give
 * two clients different answers about the same book. Testing the document side
 * first is what keeps an alias from shadowing a digest that is a document in
 * its own right.
 */
export function resolveIdentifiers(
  db: DB,
  userId: number,
  list: Identifier[]
): IdentifierMatch | null {
  for (const [index, { type, value }] of list.entries()) {
    const document = resolveDocument(db, userId, value);
    if (hasProgress(db, userId, document)) return { document, type, index };
    const target = aliasTarget(db, userId, value);
    if (target !== null && hasProgress(db, userId, target)) {
      return { document: target, type, index };
    }
  }
  return null;
}

/**
 * Record every identifier in `list` that is not the record's own digest as an
 * alias for it. The caller passes the identifiers from the match down, never
 * the whole offered list.
 *
 * One statement per identifier rather than a read and then a write: the primary
 * key is what makes "create, never repoint" hold against a concurrent push, the
 * `DO UPDATE ... WHERE` is what still lets an alias whose target has been
 * deleted be replaced, and the `NOT EXISTS` on the insert is what stops an alias
 * being created for a digest that is a document in its own right.
 */
export function registerAliases(
  db: DB,
  userId: number,
  list: Identifier[],
  canonical: string,
  createdAt: number
): void {
  const insert = db.prepare(
    `INSERT INTO identifier_aliases (user_id, alias, id_type, document, created_at)
     SELECT ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM progress WHERE user_id = ? AND document = ?)
     ON CONFLICT(user_id, alias) DO UPDATE SET
       id_type = excluded.id_type,
       document = excluded.document,
       created_at = excluded.created_at
      WHERE NOT EXISTS (
        SELECT 1 FROM progress
         WHERE user_id = identifier_aliases.user_id AND document = identifier_aliases.document)`
  );
  for (const { type, value } of list) {
    if (value === canonical) continue;
    insert.run(userId, value, type, canonical, createdAt, userId, value);
  }
}
