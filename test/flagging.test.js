import test from 'node:test';
import assert from 'node:assert/strict';

import { FLAG_RULES } from '../src/flag-rules.js';
import { evaluateRules, pollAndFlag } from '../src/flagging.js';
import { createFakeD1 } from './fake-d1.js';

const REFUND_RULE = FLAG_RULES[0];

function message(overrides = {}) {
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

function pollEnv(db, overrides = {}) {
  return { DB: db, STRIPE_SECRET_KEY: 'sk_test', GRAPH_MAILBOX: 'support@example.com', ...overrides };
}

/** Default deps: no Stripe customer, one fixed "now". */
function pollDeps(messages, overrides = {}) {
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
 * src/flag-rules.js explains why the narrow form is kept and how to widen it.
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

  // The word-family alternative documented in src/flag-rules.js, for contrast:
  // widening is a one-character-class change, not a redesign.
  assert.equal(/\brefund(s|ed|ing|able)?\b/i.test('I was refunded twice'), true);
});

test('the example rule reads the subject only, never a body that is not there', () => {
  const withoutSubject = { id: 'x', receivedDateTime: '2026-08-30T10:15:00Z' };
  assert.equal(REFUND_RULE.matches(withoutSubject), false);
  // A shaped Graph message has no body field at all; a rule cannot reach one.
  assert.equal('body' in message(), false);
  assert.equal('bodyPreview' in message(), false);
});

test('evaluateRules returns the first matching rule and null when nothing matches', () => {
  const first = { id: 'first', matches: (m) => m.subject === 'hit' };
  const second = { id: 'second', matches: () => true };
  assert.equal(evaluateRules(message({ subject: 'hit' }), [first, second]).id, 'first');
  assert.equal(evaluateRules(message({ subject: 'miss' }), [first, second]).id, 'second');
  assert.equal(evaluateRules(message({ subject: 'miss' }), [first]), null);
  assert.equal(evaluateRules(message(), []), null);
});

test('a rule that throws is skipped, not allowed to stop the run', () => {
  const explodes = {
    id: 'explodes',
    matches: () => {
      throw new TypeError('bad rule');
    },
  };
  const works = { id: 'works', matches: () => true };

  assert.doesNotThrow(() => evaluateRules(message(), [explodes]));
  assert.equal(evaluateRules(message(), [explodes]), null);
  // Crucially, a later rule still gets its turn.
  assert.equal(evaluateRules(message(), [explodes, works]).id, 'works');
});

test('pollAndFlag flags a matching sender and records the message as processed', async () => {
  const { db, accounts, processedMessages } = createFakeD1();
  const summary = await pollAndFlag(
    pollEnv(db),
    pollDeps([message()], { lookupCustomer: async () => ({ id: 'cus_123' }) })
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
  assert.equal(processedMessages.get('AAMkAD_1').received_at, '2026-08-30T10:15:00Z');
});

test('pollAndFlag lowercases the sender address before it becomes an account key', async () => {
  const { db, accounts } = createFakeD1();
  await pollAndFlag(
    pollEnv(db),
    pollDeps([message({ from: { name: 'Ada', address: '  Ada@Example.COM ' } })])
  );

  assert.deepEqual([...accounts.keys()], ['ada@example.com']);
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
  assert.equal(fake.accounts.get('ada@example.com').flagged, 1);

  // What POST /api/accounts/resolve does: clear the flag, keep the row.
  fake.accounts.get('ada@example.com').flagged = 0;

  const second = await pollAndFlag(pollEnv(fake.db), pollDeps(messages));
  assert.deepEqual(second, { fetched: 1, skipped: 1, processed: 0, flagged: 0 });
  assert.equal(fake.accounts.get('ada@example.com').flagged, 0, 'the operator cleared it; the poll must respect that');
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
  assert.equal(accounts.get('ada@example.com').stripe_customer_id, null);
});

test('a later Stripe failure never erases a customer id an earlier run resolved', async () => {
  const fake = createFakeD1();
  await pollAndFlag(
    pollEnv(fake.db),
    pollDeps([message()], { lookupCustomer: async () => ({ id: 'cus_123' }) })
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
  assert.equal(account.stripe_customer_id, 'cus_123', 'COALESCE keeps what was already resolved');
  assert.equal(account.last_flagged_at, '2026-08-30T11:00:00Z');
});

test('re-flagging an account never rewrites first_seen_at', async () => {
  const fake = createFakeD1();
  await pollAndFlag(pollEnv(fake.db), pollDeps([message()]));
  fake.accounts.get('ada@example.com').flagged = 0;

  await pollAndFlag(
    pollEnv(fake.db),
    pollDeps([message({ id: 'AAMkAD_2', receivedDateTime: '2026-09-05T09:00:00Z', subject: 'refund please' })])
  );

  const account = fake.accounts.get('ada@example.com');
  assert.equal(account.first_seen_at, '2026-08-30T10:15:00Z', 'known-since must survive a re-flag');
  assert.equal(account.last_flagged_at, '2026-09-05T09:00:00Z');
  assert.equal(account.flagged, 1);
});

test('pollAndFlag skips Stripe entirely when no key is configured', async () => {
  const { db, accounts } = createFakeD1();
  let lookups = 0;
  await pollAndFlag(
    pollEnv(db, { STRIPE_SECRET_KEY: undefined }),
    pollDeps([message()], {
      lookupCustomer: async () => {
        lookups += 1;
        return { id: 'cus_123' };
      },
    })
  );

  assert.equal(lookups, 0, 'a poll must not make a Stripe call that can only come back 401');
  assert.equal(accounts.get('ada@example.com').stripe_customer_id, null);
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
  const rules = [
    {
      id: 'broken',
      matches: () => {
        throw new Error('bad regex');
      },
    },
    { id: 'everything', matches: () => true },
  ];
  const summary = await pollAndFlag(pollEnv(db), pollDeps([message({ subject: 'anything' })], { rules }));

  assert.equal(summary.flagged, 1);
  assert.equal(accounts.get('ada@example.com').flag_reason, 'everything');
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
  const summary = await pollAndFlag(
    pollEnv(db),
    pollDeps([message({ id: null }), message({ id: 'AAMkAD_3', receivedDateTime: null })])
  );

  assert.deepEqual(summary, { fetched: 2, skipped: 0, processed: 0, flagged: 0 });
  assert.equal(processedMessages.size, 0);
});

test('the first poll looks back 24 hours; later polls resume from the last message processed', async () => {
  const fake = createFakeD1();
  const asked = [];
  const deps = pollDeps([message()], {
    listMessages: async (env, since) => {
      asked.push(since);
      return [message()];
    },
  });

  await pollAndFlag(pollEnv(fake.db), deps);
  assert.equal(asked[0], '2026-08-29T12:00:00.000Z', 'no watermark yet: 24h before now, not the whole mailbox');

  await pollAndFlag(pollEnv(fake.db), deps);
  assert.equal(asked[1], '2026-08-30T10:15:00Z', 'the watermark is the newest received_at recorded');
});

test('the watermark is the newest received_at, not the last row written', async () => {
  const fake = createFakeD1();
  const asked = [];
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

  assert.deepEqual(asked, ['2026-08-30T11:00:00Z']);
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

test('the support mailbox is never flagged by the team\'s own replies', async () => {
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
