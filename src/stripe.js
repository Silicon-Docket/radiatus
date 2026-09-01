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
  const data = await response.json();
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

export async function findCustomerByEmail(env, email) {
  const result = await stripeRequest(env, '/customers', { email, limit: 1 });
  return result.data[0] || null;
}

export function getCustomer(env, customerId) {
  return stripeRequestOrNullOn404(env, `/customers/${encodeURIComponent(customerId)}`);
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
  return {
    id: subscription.id,
    status: subscription.status,
    currentPeriodStart: subscription.current_period_start,
    currentPeriodEnd: subscription.current_period_end,
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
    paymentMethod = shapePaymentMethod(await getPaymentMethod(env, defaultPaymentMethodId));
  }

  return {
    found: true,
    customer: shapeCustomer(customer),
    paymentMethod,
    subscriptions: subscriptions.map(shapeSubscription),
    invoices: invoices.map(shapeInvoice),
  };
}
