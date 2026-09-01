import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeEntryPayload, validateEntryPayload } from '../src/worker.js';

test('normalizeEntryPayload trims and stringifies input', () => {
  const payload = normalizeEntryPayload({
    stripeCustomerId: '  cus_123  ',
    stripeSubscriptionId: ' sub_123 ',
    entryKey: ' plan ',
    entryValue: 42,
  });

  assert.deepEqual(payload, {
    stripeCustomerId: 'cus_123',
    stripeSubscriptionId: 'sub_123',
    entryKey: 'plan',
    entryValue: '42',
  });
});

test('validateEntryPayload requires subscription-linked fields', () => {
  const validation = validateEntryPayload({ entryKey: 'x' });
  assert.equal(validation.ok, false);
  assert.match(validation.error, /required/);
});

test('validateEntryPayload accepts expected payload', () => {
  const validation = validateEntryPayload({
    stripeCustomerId: 'cus_abc',
    stripeSubscriptionId: 'sub_abc',
    entryKey: 'feature',
    entryValue: '{"enabled":true}',
  });

  assert.equal(validation.ok, true);
  assert.equal(validation.value.stripeCustomerId, 'cus_abc');
  assert.equal(validation.value.stripeSubscriptionId, 'sub_abc');
});
