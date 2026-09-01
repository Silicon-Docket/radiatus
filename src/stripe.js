const STRIPE_API_BASE = 'https://api.stripe.com/v1';

export class StripeApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'StripeApiError';
    this.status = status;
  }
}

export function classifyQuery(rawQuery) {
  const value = (rawQuery || '').trim();
  // Stripe IDs consist of prefix, underscore, and alphanumeric characters only
  if (value.startsWith('cus_') && /^cus_[a-zA-Z0-9]+$/.test(value)) {
    return { type: 'customer', value };
  }
  if (value.startsWith('sub_') && /^sub_[a-zA-Z0-9]+$/.test(value)) {
    return { type: 'subscription', value };
  }
  return { type: 'email', value };
}

async function stripeRequest(env, path, params = {}) {
  const url = new URL(STRIPE_API_BASE + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const response = await fetch(url.toString(), {
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY },
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new StripeApiError(response.status, 'Invalid response from Stripe');
  }
  if (!response.ok) {
    throw new StripeApiError(response.status, data.error?.message || 'Stripe API error');
  }
  return data;
}

async function stripeRequestOrNullOn404(env, path, params) {
  try {
    return await stripeRequest(env, path, params);
  } catch (error) {
    if (error instanceof StripeApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Stripe's email filter is exact and case-sensitive, so searching
 * "John@Example.com" does not find a customer stored as "john@example.com".
 * Try what the operator typed, then the lowercased form, which covers the
 * common case of a mixed-case search against a lowercase-stored address.
 *
 * Not covered: an address stored mixed-case and searched lowercase. Finding
 * that needs Stripe's Search API, which lags the live data by up to a minute
 * and so is a poor fit for looking up a customer who just signed up.
 */
export async function findCustomerByEmail(env, email) {
  const typed = (email || '').trim();
  if (!typed) return null;

  const candidates = [typed];
  const lowercased = typed.toLowerCase();
  if (lowercased !== typed) candidates.push(lowercased);

  for (const candidate of candidates) {
    const result = await stripeRequest(env, '/customers', { email: candidate, limit: 1 });
    if (result.data[0]) return result.data[0];
  }
  return null;
}

export async function getCustomer(env, customerId) {
  const customer = await stripeRequestOrNullOn404(env, `/customers/${encodeURIComponent(customerId)}`);
  if (customer && customer.deleted === true) return null;
  return customer;
}

export function getSubscription(env, subscriptionId) {
  return stripeRequestOrNullOn404(env, `/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

export function getPaymentMethod(env, paymentMethodId) {
  return stripeRequestOrNullOn404(env, `/payment_methods/${encodeURIComponent(paymentMethodId)}`);
}

export async function listSubscriptionsForCustomer(env, customerId) {
  if (!customerId) throw new Error('customerId is required');
  const result = await stripeRequest(env, '/subscriptions', { customer: customerId, limit: 10 });
  return result.data;
}

export async function listInvoicesForCustomer(env, customerId) {
  if (!customerId) throw new Error('customerId is required');
  const result = await stripeRequest(env, '/invoices', { customer: customerId, limit: 10 });
  return result.data;
}

export function shapeCustomer(customer) {
  return { id: customer.id, email: customer.email, name: customer.name };
}

export function shapeSubscription(subscription) {
  // Basil API version (2025-03-31+) moved period fields to items[0]; fall back to new location if top-level is missing
  const periodStart = subscription.current_period_start ?? subscription.items?.data?.[0]?.current_period_start;
  const periodEnd = subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end;

  return {
    id: subscription.id,
    status: subscription.status,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  };
}

export function shapeInvoice(invoice) {
  return {
    id: invoice.id,
    status: invoice.status,
    amountDue: invoice.amount_due,
    amountPaid: invoice.amount_paid,
    currency: invoice.currency,
    created: invoice.created,
    hostedInvoiceUrl: invoice.hosted_invoice_url,
  };
}

export function shapePaymentMethod(paymentMethod) {
  if (!paymentMethod || !paymentMethod.card) return null;
  return { brand: paymentMethod.card.brand, last4: paymentMethod.card.last4 };
}

export async function lookupStripeRecord(env, rawQuery) {
  const { type, value } = classifyQuery(rawQuery);
  if (!value) return { found: false };

  let customer;
  if (type === 'email') {
    customer = await findCustomerByEmail(env, value);
  } else if (type === 'customer') {
    customer = await getCustomer(env, value);
  } else {
    const subscription = await getSubscription(env, value);
    customer = subscription ? await getCustomer(env, subscription.customer) : null;
  }
  if (!customer) return { found: false };

  const [subscriptions, invoices] = await Promise.all([
    listSubscriptionsForCustomer(env, customer.id),
    listInvoicesForCustomer(env, customer.id),
  ]);

  let paymentMethod = null;
  const defaultPaymentMethodId = customer.invoice_settings?.default_payment_method;
  if (defaultPaymentMethodId) {
    try {
      paymentMethod = shapePaymentMethod(await getPaymentMethod(env, defaultPaymentMethodId));
    } catch {
      // Payment method fetch failed, but return the rest of the lookup result
      // (payment method is supplementary, not required for the lookup to succeed)
    }
  }

  return {
    found: true,
    customer: shapeCustomer(customer),
    paymentMethod,
    subscriptions: subscriptions.map(shapeSubscription),
    invoices: invoices.map(shapeInvoice),
  };
}
