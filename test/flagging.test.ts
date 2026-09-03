import test from 'node:test';
import assert from 'node:assert/strict';

import { FLAG_RULES, type FlagRule } from '../src/flag-rules';
import { evaluateRules, pollAndFlag, type PollDeps, type PollEnv } from '../src/flagging';
import type { ShapedMessage } from '../src/graph';
import type { StripeCustomer } from '../src/stripe';
import { createFakeD1 } from './fake-d1';

const REFUND_RULE = FLAG_RULES[0];

function message(overrides: Partial<ShapedMessage> = {}): ShapedMessage {
  return {
    id: 'AAMkAD_1',
    subject: 'Refund request',
    from: { name: 'Ada', address: 'ada@example.com' },
    toRecipients: [{ name: 'Support', address: 'support@example.com' }],
    receivedDateTime: '2026-08-30T10:15:00Z',
    webLink: 'https://outlook.office365.com/owa/?ItemID=AAMkAD_1',
    conversationId: 'conv_1',
    hasAttachments: false,
    ...overrides,
  };
}

/** `StripeCustomer` requires more than an id, and a fake customer should look like one. */
function customer(id: string): StripeCustomer {
  return { id, email: 'ada@example.com', name: 'Ada' };
}

/**
 * `PollEnv` is `Env & GraphEnv` — what `isGraphConfigured` narrows to — so the
 * credentials have to be here even though every test stubs `listMessages` and
 * nothing reaches Graph. That is the type doing its job: the poll is
 * unreachable without them.
 */
function pollEnv(db: D1Database, overrides: Partial<PollEnv> = {}): PollEnv {
  return {
    DB: db,
    ADMIN_API_TOKEN: 'secret',
    STRIPE_SECRET_KEY: 'sk_test',
    GRAPH_TENANT_ID: 'tenant-abc',
    GRAPH_CLIENT_ID: 'client-abc',
    GRAPH_CLIENT_SECRET: 'client-secret',
    GRAPH_MAILBOX: 'support@example.com',
    ...overrides,
  };
}

/** Default deps: no Stripe customer, one fixed "now". */
function pollDeps(messages: ShapedMessage[], overrides: PollDeps = {}): PollDeps {
  return {
    listMessages: async () => messages,
    lookupCustomer: async () => null,
    now: () => new Date('2026-08-30T12:00:00Z'),
    ...overrides,
  };
}

test('the example refund rule matches a subject containing the word "refund"', () => {
  for (const subject of [
    'Refund request',
    'Re: refund request',
    'i want a refund',
    'REFUND',
    'refund-status?',
    'Question (refund)',
    'refund.',
  ]) {
    assert.equal(REFUND_RULE.matches(message({ subject })), true, subject + ' should match');
  }
});

test('the example refund rule does not match unrelated subjects', () => {
  for (const subject of ['Invoice question', 'Cannot log in', 'Re: your subscription', '', null]) {
    assert.equal(REFUND_RULE.matches(message({ subject })), false, String(subject) + ' should not match');
  }
});

/**
 * The documented choice, asserted in both directions. \b after "refund" needs a
 * non-word character, so an inflected form does not match at all — the regex
 * does not fall back to matching the "refund" prefix inside a longer word.
 * src/flag-rules.ts explains why the narrow form is kept and how to widen it.
 */
test('the example refund rule deliberately ignores refunds/refunded/refundable', () => {
  for (const subject of [
    'refunds are slow',
    'I was refunded twice',
    'still refunding?',
    'this is refundable',
    'non-refundable deposit',
    'prefund the account',
  ]) {
    assert.equal(REFUND_RULE.matches(message({ subject })), false, subject + ' must not match');
  }

  // The word-family alternative documented in src/flag-rules.ts, for contrast:
  // widening is a one-character-class change, not a redesign.
  assert.equal(/\brefund(s|ed|ing|able)?\b/i.test('I was refunded twice'), true);
});

test('the example rule reads the subject only, never a body that is not there', () => {
  const withoutSubject = message({ subject: undefined });
  assert.equal(REFUND_RULE.matches(withoutSubject), false);
  // A shaped Graph message has no body field at all; a rule cannot reach one.
  // The type says so too — `ShapedMessage` declares no such field — but assert
  // it at runtime as well, since that is what actually ships.
  assert.equal('body' in message(), false);
  assert.equal('bodyPreview' in message(), false);
});

test('evaluateRules returns the first matching rule and null when nothing matches', () => {
  const first: FlagRule = { id: 'first', description: 'subject is exactly "hit"', matches: (m) => m.subject === 'hit' };
  const second: FlagRule = { id: 'second', description: 'everything', matches: () => true };
  assert.equal(evaluateRules(message({ subject: 'hit' }), [first, second])?.id, 'first');
  assert.equal(evaluateRules(message({ subject: 'miss' }), [first, second])?.id, 'second');
  assert.equal(evaluateRules(message({ subject: 'miss' }), [first]), null);
  assert.equal(evaluateRules(message(), []), null);
});

test('a rule that throws is skipped, not allowed to stop the run', () => {
  const explodes: FlagRule = {
    id: 'explodes',
    description: 'always throws',
    matches: () => {
      throw new TypeError('bad rule');
    },
  };
  const works: FlagRule = { id: 'works', description: 'everything', matches: () => true };

  assert.doesNotThrow(() => evaluateRules(message(), [explodes]));
  assert.equal(evaluateRules(message(), [explodes]), null);
  // Crucially, a later rule still gets its turn.
  assert.equal(evaluateRules(message(), [explodes, works])?.id, 'works');
});

test('pollAndFlag flags a matching sender and records the message as processed', async () => {
  const { db, accounts, processedMessages } = createFakeD1();
  const summary = await pollAndFlag(
    pollEnv(db),
    pollDeps([message()], { lookupCustomer: async () => customer('cus_123') })
  );

  assert.deepEqual(summary, { fetched: 1, skipped: 0, processed: 1, flagged: 1 });
  assert.deepEqual(accounts.get('ada@example.com'), {
    email: 'ada@example.com',
    stripe_customer_id: 'cus_123',
    flagged: 1,
    flag_reason: 'refund-mention',
    flag_subject: 'Refund request',
    last_flagged_at: '2026-08-30T10:15:00Z',
    first_seen_at: '2026-08-30T10:15:00Z',
  });
  assert.equal(processedMessages.get('AAMkAD_1')?.received_at, '2026-08-30T10:15:00Z');
});

test('pollAndFlag lowercases the sender address before it becomes an account key', async () => {
  const { db, accounts } = createFakeD1();
  await pollAndFlag(
    pollEnv(db),
    pollDeps([message({ from: { name: 'Ada', address: '  Ada@Example.COM ' } })])
  );

  assert.deepEqual([...accounts.keys()], ['ada@example.com']);
});

test('the Stripe lookup gets the address as sent, not the lowercased account key', async () => {
  // findCustomerByEmail tries the address as given and only then its lowercase
  // form, because Stripe's /customers?email= filter is exact and
  // case-sensitive. Handing it the already-lowercased key collapses those two
  // candidates into one, so a customer stored in Stripe as Ada@Example.com is
  // never resolved — and never will be, since COALESCE only fills a null and
  // every later poll repeats the same failing query.
  const { db, accounts } = createFakeD1();
  const asked: string[] = [];
  await pollAndFlag(
    pollEnv(db),
    pollDeps([message({ from: { name: 'Ada', address: '  Ada@Example.COM ' } })], {
      lookupCustomer: async (env, email) => {
        asked.push(email);
        return customer('cus_123');
      },
    })
  );

  assert.deepEqual(asked, ['Ada@Example.COM'], 'trimmed, but the casing must survive');
  assert.deepEqual([...accounts.keys()], ['ada@example.com'], 'the row is still keyed lowercase');
  assert.equal(accounts.get('ada@example.com')?.stripe_customer_id, 'cus_123');
});

test('pollAndFlag does not flag a message that is already in processed_messages', async () => {
  const { db, accounts } = createFakeD1({
    processedMessages: [{ message_id: 'AAMkAD_1', received_at: '2026-08-30T10:15:00Z' }],
  });
  const summary = await pollAndFlag(pollEnv(db), pollDeps([message()]));

  assert.deepEqual(summary, { fetched: 1, skipped: 1, processed: 0, flagged: 0 });
  assert.equal(accounts.size, 0);
});

test('a cleared flag is not resurrected by a re-run over the same message', async () => {
  const fake = createFakeD1();
  const messages = [message()];

  await pollAndFlag(pollEnv(fake.db), pollDeps(messages));
  assert.equal(fake.accounts.get('ada@example.com')?.flagged, 1);

  // What POST /api/accounts/resolve does: clear the flag, keep the row.
  fake.accounts.get('ada@example.com')!.flagged = 0;

  const second = await pollAndFlag(pollEnv(fake.db), pollDeps(messages));
  assert.deepEqual(second, { fetched: 1, skipped: 1, processed: 0, flagged: 0 });
  assert.equal(
    fake.accounts.get('ada@example.com')?.flagged,
    0,
    'the operator cleared it; the poll must respect that'
  );
});

test('a Stripe lookup failure records the account with a null customer id and the run continues', async () => {
  const { db, accounts } = createFakeD1();
  const summary = await pollAndFlag(
    pollEnv(db),
    pollDeps([message(), message({ id: 'AAMkAD_2', subject: 'refund again' })], {
      lookupCustomer: async () => {
        throw new Error('Stripe is down');
      },
    })
  );

  assert.deepEqual(summary, { fetched: 2, skipped: 0, processed: 2, flagged: 2 });
  assert.equal(accounts.get('ada@example.com')?.stripe_customer_id, null);
});

test('a later Stripe failure never erases a customer id an earlier run resolved', async () => {
  const fake = createFakeD1();
  await pollAndFlag(
    pollEnv(fake.db),
    pollDeps([message()], { lookupCustomer: async () => customer('cus_123') })
  );

  await pollAndFlag(
    pollEnv(fake.db),
    pollDeps([message({ id: 'AAMkAD_2', receivedDateTime: '2026-08-30T11:00:00Z', subject: 'refund, again' })], {
      lookupCustomer: async () => {
        throw new Error('Stripe is down');
      },
    })
  );

  const account = fake.accounts.get('ada@example.com');
  assert.equal(account?.stripe_customer_id, 'cus_123', 'COALESCE keeps what was already resolved');
  assert.equal(account?.last_flagged_at, '2026-08-30T11:00:00Z');
});

test('re-flagging an account never rewrites first_seen_at', async () => {
  const fake = createFakeD1();
  await pollAndFlag(pollEnv(fake.db), pollDeps([message()]));
  fake.accounts.get('ada@example.com')!.flagged = 0;

  await pollAndFlag(
    pollEnv(fake.db),
    pollDeps([message({ id: 'AAMkAD_2', receivedDateTime: '2026-09-05T09:00:00Z', subject: 'refund please' })])
  );

  const account = fake.accounts.get('ada@example.com');
  assert.equal(account?.first_seen_at, '2026-08-30T10:15:00Z', 'known-since must survive a re-flag');
  assert.equal(account?.last_flagged_at, '2026-09-05T09:00:00Z');
  assert.equal(account?.flagged, 1);
});

test('pollAndFlag skips Stripe entirely when no key is configured', async () => {
  const { db, accounts } = createFakeD1();
  let lookups = 0;
  await pollAndFlag(
    pollEnv(db, { STRIPE_SECRET_KEY: undefined }),
    pollDeps([message()], {
      lookupCustomer: async () => {
        lookups += 1;
        return customer('cus_123');
      },
    })
  );

  assert.equal(lookups, 0, 'a poll must not make a Stripe call that can only come back 401');
  assert.equal(accounts.get('ada@example.com')?.stripe_customer_id, null);
});

test('an empty rule set disables flagging while the poll still runs harmlessly', async () => {
  const { db, accounts, processedMessages } = createFakeD1();
  const summary = await pollAndFlag(pollEnv(db), pollDeps([message()], { rules: [] }));

  assert.deepEqual(summary, { fetched: 1, skipped: 0, processed: 1, flagged: 0 });
  assert.equal(accounts.size, 0);
  assert.equal(processedMessages.size, 1);
});

test('one throwing rule does not stop the poll from flagging on a later rule', async () => {
  const { db, accounts } = createFakeD1();
  const rules: FlagRule[] = [
    {
      id: 'broken',
      description: 'always throws',
      matches: () => {
        throw new Error('bad regex');
      },
    },
    { id: 'everything', description: 'matches every message', matches: () => true },
  ];
  const summary = await pollAndFlag(pollEnv(db), pollDeps([message({ subject: 'anything' })], { rules }));

  assert.equal(summary.flagged, 1);
  assert.equal(accounts.get('ada@example.com')?.flag_reason, 'everything');
});

test('a matching message with no sender address is recorded but flags nothing', async () => {
  const { db, accounts, processedMessages } = createFakeD1();
  const summary = await pollAndFlag(pollEnv(db), pollDeps([message({ from: null })]));

  assert.deepEqual(summary, { fetched: 1, skipped: 0, processed: 1, flagged: 0 });
  assert.equal(accounts.size, 0);
  assert.equal(processedMessages.size, 1, 'it must still advance the watermark, or the poll stalls on it');
});

test('a message with no id or no receivedDateTime is dropped rather than corrupting the watermark', async () => {
  const { db, processedMessages } = createFakeD1();
  // `ShapedMessage` types both fields as `string | undefined`, so absent means
  // undefined here rather than the null the JavaScript version used — the
  // guard in pollAndFlag is the same falsy check either way.
  const summary = await pollAndFlag(
    pollEnv(db),
    pollDeps([message({ id: undefined }), message({ id: 'AAMkAD_3', receivedDateTime: undefined })])
  );

  assert.deepEqual(summary, { fetched: 2, skipped: 0, processed: 0, flagged: 0 });
  assert.equal(processedMessages.size, 0);
});

test('the first poll looks back 24 hours; later polls resume from the last message processed', async () => {
  const fake = createFakeD1();
  const asked: string[] = [];
  const deps = pollDeps([message()], {
    listMessages: async (env, since) => {
      asked.push(since);
      return [message()];
    },
  });

  await pollAndFlag(pollEnv(fake.db), deps);
  assert.equal(asked[0], '2026-08-29T12:00:00.000Z', 'no watermark yet: 24h before now, not the whole mailbox');

  await pollAndFlag(pollEnv(fake.db), deps);
  // The newest received_at recorded (10:15:00), less the 10-minute overlap the
  // poll re-reads so a late-appearing older message is not lost.
  assert.equal(asked[1], '2026-08-30T10:05:00.000Z', 'resumes from the watermark, minus the overlap');
});

test('the watermark is the newest received_at, not the last row written', async () => {
  const fake = createFakeD1();
  const asked: string[] = [];
  const messages = [
    message({ id: 'a', receivedDateTime: '2026-08-30T09:00:00Z', subject: 'refund one' }),
    message({ id: 'b', receivedDateTime: '2026-08-30T11:00:00Z', subject: 'refund two' }),
    message({ id: 'c', receivedDateTime: '2026-08-30T10:00:00Z', subject: 'refund three' }),
  ];

  await pollAndFlag(pollEnv(fake.db), pollDeps(messages));
  await pollAndFlag(
    pollEnv(fake.db),
    pollDeps([], {
      listMessages: async (env, since) => {
        asked.push(since);
        return [];
      },
    })
  );

  // 11:00:00 is the newest received_at of the three, not the last one written
  // (10:00:00); the overlap window then steps back from it.
  assert.deepEqual(asked, ['2026-08-30T10:50:00.000Z']);
});

test('a message that becomes visible after a newer one was processed is still picked up', async () => {
  // Exchange's index can surface a 10:15:03 message before a 10:14:58 one, and
  // a message released from quarantine or moved into the Inbox keeps its
  // original receivedDateTime. A bare `ge watermark` would exclude the older
  // message forever; the overlap window is what re-covers it.
  const fake = createFakeD1();
  const early = message({ id: 'visible-first', receivedDateTime: '2026-08-30T10:15:03Z', subject: 'refund now' });
  const late = message({ id: 'visible-later', receivedDateTime: '2026-08-30T10:14:58Z', subject: 'refund, delayed' });

  await pollAndFlag(pollEnv(fake.db), pollDeps([early]));
  assert.equal(fake.processedMessages.size, 1);

  const asked: string[] = [];
  const summary = await pollAndFlag(
    pollEnv(fake.db),
    pollDeps([], {
      // Stands in for Graph's own `receivedDateTime ge <since>` filter, so the
      // assertion depends on the window actually reaching back far enough.
      listMessages: async (env, since) => {
        asked.push(since);
        return new Date(late.receivedDateTime!).getTime() >= new Date(since).getTime() ? [late] : [];
      },
    })
  );

  assert.equal(summary.flagged, 1, 'the late-visible message must still be evaluated');
  assert.equal(
    fake.accounts.get('ada@example.com')?.flag_subject,
    'refund, delayed',
    'without the overlap this message is never seen by any rule'
  );
  assert.ok(new Date(asked[0]).getTime() < new Date('2026-08-30T10:14:58Z').getTime());
});

test('pollAndFlag reads the mailbox from env and never binds unparameterised SQL', async () => {
  const fake = createFakeD1();
  const hostile = message({
    id: "AAMkAD'); DROP TABLE accounts; --",
    subject: "refund'); DROP TABLE accounts; --",
    from: { name: 'x', address: "attacker'); DROP TABLE accounts; --@example.com" },
  });

  await pollAndFlag(pollEnv(fake.db), pollDeps([hostile]));

  for (const statement of fake.statements) {
    assert.ok(!statement.sql.includes('DROP TABLE'), 'no value may ever reach the SQL text: ' + statement.sql);
  }
  // It was stored, just as an inert bound value.
  assert.equal(fake.accounts.size, 1);
});

test("the support mailbox is never flagged by the team's own replies", async () => {
  // Inbox scoping in listRecentMessages should keep Sent Items out, but that is
  // unverified against a live tenant and the failure is bad enough to warrant a
  // second defence: without this, every "Re: refund request" the team sends
  // flags the support mailbox itself and pins it to the top of the queue.
  const fake = createFakeD1();
  const reply = message({
    id: 'AAMkAD_sent_1',
    subject: 'Re: refund request',
    from: { name: 'Support', address: 'Support@Example.com' },
    toRecipients: [{ name: 'Ada', address: 'ada@example.com' }],
  });

  const summary = await pollAndFlag(pollEnv(fake.db), pollDeps([reply]));

  assert.equal(summary.flagged, 0, 'the mailbox must not flag itself');
  assert.equal(summary.processed, 1, 'the message is still recorded so the run moves on');
  assert.equal(fake.accounts.size, 0, 'no account row is created for the mailbox itself');
});

test('a customer whose address merely resembles the mailbox is still flagged', async () => {
  // The self-flag guard is an exact address match, not a domain or prefix check
  // — narrowing it further would silently drop real customers.
  const fake = createFakeD1();
  const fromCustomer = message({
    id: 'AAMkAD_cust_1',
    from: { name: 'Ada', address: 'support-team@example.com' },
  });

  const summary = await pollAndFlag(pollEnv(fake.db), pollDeps([fromCustomer]));

  assert.equal(summary.flagged, 1);
  assert.deepEqual([...fake.accounts.keys()], ['support-team@example.com']);
});
