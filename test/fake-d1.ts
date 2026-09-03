/**
 * A small, deliberately strict stand-in for a D1 binding.
 *
 * The point is that it can FAIL. A fake that answers every query with a
 * plausible object proves nothing: it would happily accept a typo'd column, a
 * missing bind argument, or SQL that no SQLite would run, and the tests built
 * on it would go green while production went red. So this one:
 *
 * - dispatches on the actual statement text and throws on anything it does not
 *   recognise, which means adding a query to src/ without teaching this file
 *   about it is a loud failure, not a silent pass;
 * - checks that the number of bound arguments matches the number of distinct
 *   ?N placeholders in the SQL — the check that catches "added a column to the
 *   INSERT and forgot the .bind() argument";
 * - reads the INSERT column list and the ON CONFLICT DO UPDATE assignments out
 *   of the SQL rather than hardcoding the upsert's behaviour, so a change to
 *   which columns the conflict branch writes changes what the tests observe;
 * - implements LIKE with its ESCAPE character, because escaping the `_` in a
 *   Stripe id is a behaviour worth testing rather than assuming.
 *
 * Return shapes match real D1 exactly: .all() -> { results, success, meta },
 * .first() -> a row object or null, .run() -> { results, success, meta }.
 * Getting these wrong in the same direction as the code under test would hide
 * bugs instead of catching them — which is also why `db` is typed as a real
 * `D1Database` and the methods this fake does not implement throw rather than
 * being cast away: a query path that starts using `batch` or `raw` fails here
 * instead of silently doing nothing.
 */

/** Rows are untyped on purpose: the fake reads columns out of the SQL, not a schema. */
type FakeRow = Record<string, unknown>;

/** Seed rows. Everything but the key is optional, and defaults the way the real DDL does. */
export interface AccountSeed {
  email: string;
  stripe_customer_id?: string | null;
  flagged?: number;
  flag_reason?: string | null;
  flag_subject?: string | null;
  last_flagged_at?: string | null;
  first_seen_at?: string | null;
}

export interface ProcessedMessageSeed {
  message_id: string;
  received_at?: string | null;
  processed_at?: string;
}

export interface FakeD1Seed {
  accounts?: AccountSeed[];
  processedMessages?: ProcessedMessageSeed[];
}

/** Every statement the binding was asked to execute, in order. */
export interface RecordedStatement {
  sql: string;
  bindings: unknown[];
}

export interface FakeD1 {
  db: D1Database;
  statements: RecordedStatement[];
  accounts: Map<string, FakeRow>;
  processedMessages: Map<string, FakeRow>;
}

type ExecutionMode = 'all' | 'first' | 'run';

interface StatementHandler {
  test: RegExp;
  execute: (bindings: unknown[], sql: string, match: RegExpMatchArray) => FakeRow | FakeRow[] | null;
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function distinctPlaceholderCount(sql: string): number {
  const seen = new Set(sql.match(/\?\d+/g) || []);
  return seen.size;
}

/**
 * A failed match is a fake that does not understand the statement it was given,
 * which is exactly the case this file exists to make loud rather than silent.
 */
function matchOrThrow(sql: string, pattern: RegExp, what: string): RegExpMatchArray {
  const match = sql.match(pattern);
  if (!match) throw new Error('fake D1: could not read ' + what + ' from ' + sql);
  return match;
}

/** Turns a SQL LIKE pattern into a RegExp, honouring the ESCAPE character. */
function likeToRegExp(pattern: string, escapeCharacter: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const character = pattern[i];
    if (character === escapeCharacter && i + 1 < pattern.length) {
      i += 1;
      source += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (character === '%') {
      source += '[\\s\\S]*';
    } else if (character === '_') {
      source += '[\\s\\S]';
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  // SQLite's LIKE is case-insensitive for ASCII by default.
  return new RegExp('^' + source + '$', 'i');
}

function like(value: unknown, pattern: string, escapeCharacter: string): boolean {
  if (value === null || value === undefined) return false;
  return likeToRegExp(pattern, escapeCharacter).test(String(value));
}

/** Resolves a VALUES token: ?N binds, a bare integer is a literal. */
function resolveValueToken(token: string, bindings: unknown[]): unknown {
  const trimmed = token.trim();
  const placeholder = trimmed.match(/^\?(\d+)$/);
  if (placeholder) return bindings[Number(placeholder[1]) - 1];
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed.toUpperCase() === 'NULL') return null;
  throw new Error('fake D1: unsupported VALUES token ' + trimmed);
}

function splitList(text: string): string[] {
  return text.split(',').map((part) => part.trim());
}

/** D1 reports a full `meta` on every call; the shape has to be complete to be honest. */
function meta(overrides: Partial<D1Meta> = {}): D1Meta & Record<string, unknown> {
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: 0,
    changed_db: false,
    changes: 0,
    ...overrides,
  };
}

export function createFakeD1(initial: FakeD1Seed = {}): FakeD1 {
  const accounts = new Map<string, FakeRow>();
  const processedMessages = new Map<string, FakeRow>();
  const statements: RecordedStatement[] = [];

  for (const row of initial.accounts || []) {
    accounts.set(row.email, {
      email: row.email,
      stripe_customer_id: row.stripe_customer_id ?? null,
      flagged: row.flagged ?? 1,
      flag_reason: row.flag_reason ?? null,
      flag_subject: row.flag_subject ?? null,
      last_flagged_at: row.last_flagged_at ?? null,
      first_seen_at: row.first_seen_at ?? row.last_flagged_at ?? null,
    });
  }
  for (const row of initial.processedMessages || []) {
    processedMessages.set(row.message_id, {
      message_id: row.message_id,
      received_at: row.received_at ?? null,
      processed_at: row.processed_at ?? '2026-09-01 00:00:00',
    });
  }

  function selectColumns(row: FakeRow, sql: string): FakeRow {
    const columns = splitList(matchOrThrow(sql, /^SELECT (.+?) FROM /i, 'the column list')[1]);
    if (columns.length === 1 && columns[0] === '*') return { ...row };
    const projected: FakeRow = {};
    for (const column of columns) projected[column] = row[column] ?? null;
    return projected;
  }

  function upsertAccount(sql: string, bindings: unknown[]): void {
    const columns = splitList(matchOrThrow(sql, /INSERT INTO accounts \(([^)]+)\)/i, 'the INSERT columns')[1]);
    const values = splitList(matchOrThrow(sql, /VALUES \(([^)]+)\)/i, 'the VALUES list')[1]);
    if (columns.length !== values.length) {
      throw new Error('fake D1: INSERT column/value count mismatch');
    }

    const incoming: FakeRow = {};
    columns.forEach((column, index) => {
      incoming[column] = resolveValueToken(values[index], bindings);
    });

    const email = String(incoming.email);
    const existing = accounts.get(email);
    if (!existing) {
      accounts.set(email, { ...incoming });
      return;
    }

    // Apply exactly the assignments the SQL declares — so a test asserting
    // that first_seen_at survives a re-flag actually depends on the SQL not
    // assigning it, rather than on this fake's opinion.
    const setClause = matchOrThrow(sql, /DO UPDATE SET (.+?)$/i, 'the DO UPDATE assignments')[1];
    for (const assignment of splitList(setClause.replace(/COALESCE\(([^,]+), ([^)]+)\)/gi, 'COALESCE($1|$2)'))) {
      const [target, expression] = assignment.split('=').map((part) => part.trim());
      const coalesce = expression.match(/^COALESCE\(excluded\.(\w+)\|accounts\.(\w+)\)$/i);
      if (coalesce) {
        existing[target] = incoming[coalesce[1]] ?? existing[coalesce[2]] ?? null;
        continue;
      }
      const excluded = expression.match(/^excluded\.(\w+)$/i);
      if (excluded) {
        existing[target] = incoming[excluded[1]] ?? null;
        continue;
      }
      if (/^-?\d+$/.test(expression)) {
        existing[target] = Number(expression);
        continue;
      }
      throw new Error('fake D1: unsupported DO UPDATE expression ' + expression);
    }
  }

  const handlers: StatementHandler[] = [
    {
      test: /^SELECT MAX\(received_at\) AS watermark FROM processed_messages$/i,
      execute: () => {
        const values = [...processedMessages.values()]
          .map((row) => row.received_at)
          .filter((value): value is string => typeof value === 'string');
        return values.length === 0 ? { watermark: null } : { watermark: values.sort().at(-1) ?? null };
      },
    },
    {
      test: /^SELECT message_id FROM processed_messages WHERE message_id = \?1$/i,
      execute: (bindings) => {
        const row = processedMessages.get(String(bindings[0]));
        return row ? { message_id: row.message_id } : null;
      },
    },
    {
      test: /^INSERT OR IGNORE INTO processed_messages \(message_id, received_at\) VALUES \(\?1, \?2\)$/i,
      execute: (bindings) => {
        const messageId = String(bindings[0]);
        if (!processedMessages.has(messageId)) {
          processedMessages.set(messageId, {
            message_id: messageId,
            received_at: bindings[1],
            processed_at: '2026-09-01 00:00:00',
          });
        }
        return null;
      },
    },
    {
      test: /^INSERT INTO accounts \(.+\) VALUES \(.+\) ON CONFLICT\(email\) DO UPDATE SET /i,
      execute: (bindings, sql) => {
        upsertAccount(sql, bindings);
        return null;
      },
    },
    {
      test: /^SELECT .+ FROM accounts WHERE \(\?1 = 0 OR flagged = 1\) AND \(email LIKE \?2 ESCAPE '\\' OR COALESCE\(stripe_customer_id, ''\) LIKE \?2 ESCAPE '\\'\) ORDER BY COALESCE\(last_flagged_at, first_seen_at\) DESC LIMIT (\d+)$/i,
      execute: (bindings, sql, match) => {
        const [flaggedOnly, rawPattern] = bindings;
        const pattern = String(rawPattern);
        const sortKey = (row: FakeRow) => String(row.last_flagged_at ?? row.first_seen_at ?? '');
        const matched = [...accounts.values()]
          .filter((row) => (flaggedOnly === 0 ? true : row.flagged === 1))
          .filter((row) => like(row.email, pattern, '\\') || like(row.stripe_customer_id ?? '', pattern, '\\'))
          .sort((a, b) => {
            const left = sortKey(a);
            const right = sortKey(b);
            return right < left ? -1 : right > left ? 1 : 0;
          })
          .slice(0, Number(match[1]));
        return matched.map((row) => selectColumns(row, sql));
      },
    },
    {
      test: /^UPDATE accounts SET flagged = 0 WHERE email = \?1 RETURNING /i,
      execute: (bindings, sql) => {
        const row = accounts.get(String(bindings[0]));
        if (!row) return null;
        row.flagged = 0;
        return selectColumns(row, sql.replace(/^UPDATE.+RETURNING /i, 'SELECT ') + ' FROM accounts');
      },
    },
  ];

  function execute(rawSql: string, bindings: unknown[]): FakeRow | FakeRow[] | null {
    const sql = normalize(rawSql);
    statements.push({ sql, bindings });

    const expected = distinctPlaceholderCount(sql);
    if (bindings.length !== expected) {
      throw new Error(
        'fake D1: ' + sql + ' has ' + expected + ' placeholder(s) but was bound with ' + bindings.length
      );
    }

    for (const handler of handlers) {
      const match = sql.match(handler.test);
      if (!match) continue;
      return handler.execute(bindings, sql, match);
    }

    throw new Error('fake D1: unrecognised SQL: ' + sql);
  }

  /** The rows a mode produces, in the container real D1 wraps them in. */
  function toResult(value: FakeRow | FakeRow[] | null, mode: ExecutionMode): unknown {
    if (mode === 'first') return Array.isArray(value) ? value[0] ?? null : value;
    const results = Array.isArray(value) ? value : value ? [value] : [];
    if (mode === 'all') return { results, success: true, meta: meta({ rows_read: results.length }) };
    return { results: [], success: true, meta: meta({ changes: 1 }) };
  }

  function makeStatement(sql: string, bindings: unknown[]): D1PreparedStatement {
    // The rows this fake builds come out of the SQL text, so it cannot know the
    // caller's row type: the assertions below are the one honest cast in the file.
    const statement: D1PreparedStatement = {
      bind: (...args: unknown[]) => makeStatement(sql, args),
      first: async <T>(colName?: string): Promise<T | null> => {
        if (colName !== undefined) throw new Error('fake D1: first(colName) is not supported');
        return toResult(execute(sql, bindings), 'first') as T | null;
      },
      all: async <T>(): Promise<D1Result<T>> => toResult(execute(sql, bindings), 'all') as D1Result<T>,
      run: async <T>(): Promise<D1Result<T>> => toResult(execute(sql, bindings), 'run') as D1Result<T>,
      raw: () => {
        throw new Error('fake D1: raw() is not supported; teach this fake about it first');
      },
    };
    return statement;
  }

  const unsupported = (): never => {
    throw new Error('fake D1: this method is not supported; teach this fake about it first');
  };

  return {
    db: {
      prepare: (sql: string) => makeStatement(sql, []),
      batch: unsupported,
      exec: unsupported,
      withSession: unsupported,
      dump: unsupported,
    },
    statements,
    accounts,
    processedMessages,
  };
}
