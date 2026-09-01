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
 * .first() -> a row object or null, .run() -> { success, meta }. Getting these
 * wrong in the same direction as the code under test would hide bugs instead of
 * catching them.
 */

function normalize(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function distinctPlaceholderCount(sql) {
  const seen = new Set(sql.match(/\?\d+/g) || []);
  return seen.size;
}

/** Turns a SQL LIKE pattern into a RegExp, honouring the ESCAPE character. */
function likeToRegExp(pattern, escapeCharacter) {
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

function like(value, pattern, escapeCharacter) {
  if (value === null || value === undefined) return false;
  return likeToRegExp(pattern, escapeCharacter).test(String(value));
}

/** Resolves a VALUES token: ?N binds, a bare integer is a literal. */
function resolveValueToken(token, bindings) {
  const trimmed = token.trim();
  const placeholder = trimmed.match(/^\?(\d+)$/);
  if (placeholder) return bindings[Number(placeholder[1]) - 1];
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed.toUpperCase() === 'NULL') return null;
  throw new Error('fake D1: unsupported VALUES token ' + trimmed);
}

function splitList(text) {
  return text.split(',').map((part) => part.trim());
}

export function createFakeD1(initial = {}) {
  const accounts = new Map();
  const processedMessages = new Map();
  /** Every statement this binding was asked to execute, in order. */
  const statements = [];

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

  function selectColumns(row, sql) {
    const columns = splitList(sql.match(/^SELECT (.+?) FROM /i)[1]);
    if (columns.length === 1 && columns[0] === '*') return { ...row };
    const projected = {};
    for (const column of columns) projected[column] = row[column] ?? null;
    return projected;
  }

  function upsertAccount(sql, bindings) {
    const columns = splitList(sql.match(/INSERT INTO accounts \(([^)]+)\)/i)[1]);
    const values = splitList(sql.match(/VALUES \(([^)]+)\)/i)[1]);
    if (columns.length !== values.length) {
      throw new Error('fake D1: INSERT column/value count mismatch');
    }

    const incoming = {};
    columns.forEach((column, index) => {
      incoming[column] = resolveValueToken(values[index], bindings);
    });

    const existing = accounts.get(incoming.email);
    if (!existing) {
      accounts.set(incoming.email, { ...incoming });
      return;
    }

    // Apply exactly the assignments the SQL declares — so a test asserting
    // that first_seen_at survives a re-flag actually depends on the SQL not
    // assigning it, rather than on this fake's opinion.
    const setClause = sql.match(/DO UPDATE SET (.+?)$/i)[1];
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

  const handlers = [
    {
      test: /^SELECT MAX\(received_at\) AS watermark FROM processed_messages$/i,
      execute: () => {
        const values = [...processedMessages.values()].map((row) => row.received_at).filter(Boolean);
        return values.length === 0 ? { watermark: null } : { watermark: values.sort().at(-1) };
      },
    },
    {
      test: /^SELECT message_id FROM processed_messages WHERE message_id = \?1$/i,
      execute: (bindings) => {
        const row = processedMessages.get(bindings[0]);
        return row ? { message_id: row.message_id } : null;
      },
    },
    {
      test: /^INSERT OR IGNORE INTO processed_messages \(message_id, received_at\) VALUES \(\?1, \?2\)$/i,
      execute: (bindings) => {
        if (!processedMessages.has(bindings[0])) {
          processedMessages.set(bindings[0], {
            message_id: bindings[0],
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
        const [flaggedOnly, pattern] = bindings;
        const matched = [...accounts.values()]
          .filter((row) => (flaggedOnly === 0 ? true : row.flagged === 1))
          .filter((row) => like(row.email, pattern, '\\') || like(row.stripe_customer_id ?? '', pattern, '\\'))
          .sort((a, b) => {
            const left = a.last_flagged_at ?? a.first_seen_at ?? '';
            const right = b.last_flagged_at ?? b.first_seen_at ?? '';
            return right < left ? -1 : right > left ? 1 : 0;
          })
          .slice(0, Number(match[1]));
        return matched.map((row) => selectColumns(row, sql));
      },
    },
    {
      test: /^UPDATE accounts SET flagged = 0 WHERE email = \?1 RETURNING /i,
      execute: (bindings, sql) => {
        const row = accounts.get(bindings[0]);
        if (!row) return null;
        row.flagged = 0;
        return selectColumns(row, sql.replace(/^UPDATE.+RETURNING /i, 'SELECT ') + ' FROM accounts');
      },
    },
  ];

  async function execute(rawSql, bindings, mode) {
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
      const value = handler.execute(bindings, sql, match);
      if (mode === 'all') {
        const results = Array.isArray(value) ? value : value ? [value] : [];
        return { results, success: true, meta: { rows_read: results.length } };
      }
      if (mode === 'first') {
        return Array.isArray(value) ? value[0] ?? null : value;
      }
      return { success: true, meta: { changes: 1 } };
    }

    throw new Error('fake D1: unrecognised SQL: ' + sql);
  }

  function makeStatement(sql, bindings) {
    return {
      bind: (...args) => makeStatement(sql, args),
      all: () => execute(sql, bindings, 'all'),
      first: () => execute(sql, bindings, 'first'),
      run: () => execute(sql, bindings, 'run'),
    };
  }

  return {
    db: { prepare: (sql) => makeStatement(sql, []) },
    statements,
    accounts,
    processedMessages,
  };
}
