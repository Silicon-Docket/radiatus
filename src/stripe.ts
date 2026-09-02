const STRIPE_API_BASE = 'https://api.stripe.com/v1';

/**
 * The only binding this client needs. `STRIPE_SECRET_KEY` is optional on `Env`
 * because the feature ships switched off; it is required here, so the worker
 * has to narrow through `isStripeConfigured` before it can call in.
 */
export interface StripeEnv {
  STRIPE_SECRET_KEY: string;
}

/** Query-string values Stripe accepts; numbers are stringified on the way out. */
type StripeParams = Record<string, string | number | undefined | null>;

/** Stripe wraps a failure in `{ error: { message } }` whatever the endpoint. */
interface StripeErrorEnvelope {
  error?: { message?: string };
}

/** Every Stripe list endpoint returns its rows under `data`. */
interface StripeList<T> {
  data: T[];
}

// The interfaces below describe only the fields this module reads. Stripe sends
// a great deal more, which is what the index signatures acknowledge — those
// extra fields exist, they are simply never looked at and never forwarded.

export interface StripeCustomer {
  id: string;
  email: string | null;
  name: string | null;
  deleted?: boolean;
  invoice_settings?: { default_payment_method?: string | null } | null;
  [key: string]: unknown;
}

export interface StripeSubscription {
  id: string;
  status: string;
  customer?: string;
  cancel_at_period_end: boolean;
  current_period_start?: number;
  current_period_end?: number;
  items?: { data?: Array<{ current_period_start?: number; current_period_end?: number }> };
  [key: string]: unknown;
}

export interface StripeInvoice {
  id: string;
  status: string | null;
  amount_due: number;
  amount_paid: number;
  currency: string;
  created: number;
  hosted_invoice_url: string | null;
  [key: string]: unknown;
}

export interface StripePaymentMethod {
  card?: { brand: string; last4: string; [key: string]: unknown } | null;
  [key: string]: unknown;
}

/**
 * SECURITY BOUNDARY. The exact set of customer fields that leaves this module —
 * the return type of `shapeCustomer`, so a stray field in that object literal is
 * a compile error rather than something only a test catches. Adding a field here
 * means deciding it is safe to expose to anyone holding ADMIN_API_TOKEN.
 */
export interface ShapedCustomer {
  id: string;
  email: string | null;
  name: string | null;
}

/**
 * SECURITY BOUNDARY. The exact set of subscription fields that leaves this
 * module. Adding a field here means deciding it is safe to expose to anyone
 * holding ADMIN_API_TOKEN.
 */
export interface ShapedSubscription {
  id: string;
  status: string;
  currentPeriodStart: number | undefined;
  currentPeriodEnd: number | undefined;
  cancelAtPeriodEnd: boolean;
}

/**
 * SECURITY BOUNDARY. The exact set of invoice fields that leaves this module.
 * Adding a field here means deciding it is safe to expose to anyone holding
 * ADMIN_API_TOKEN.
 */
export interface ShapedInvoice {
  id: string;
  status: string | null;
  amountDue: number;
  amountPaid: number;
  currency: string;
  created: number;
  hostedInvoiceUrl: string | null;
}

/**
 * SECURITY BOUNDARY. Brand and last four digits only — never the full PAN
 * surrogate, expiry, fingerprint, or billing address Stripe returns alongside
 * them. Adding a field here means deciding it is safe to expose to anyone
 * holding ADMIN_API_TOKEN.
 */
export interface ShapedPaymentMethod {
  brand: string;
  last4: string;
}

export type StripeQueryType = 'customer' | 'subscription' | 'email';

export interface StripeQuery {
  type: StripeQueryType;
  value: string;
}

export type StripeLookupResult =
  | { found: false }
  | {
      found: true;
      customer: ShapedCustomer;
      paymentMethod: ShapedPaymentMethod | null;
      subscriptions: ShapedSubscription[];
      invoices: ShapedInvoice[];
    };

export class StripeApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'StripeApiError';
    this.status = status;
  }
}

export function classifyQuery(rawQuery: string): StripeQuery {
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

async function stripeRequest<T>(env: StripeEnv, path: string, params: StripeParams = {}): Promise<T> {
  const url = new URL(STRIPE_API_BASE + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url.toString(), {
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY },
  });
  // The body is read once and has to serve both branches, so it is parsed as the
  // payload intersected with Stripe's error envelope rather than as `any`.
  let data: T & StripeErrorEnvelope;
  try {
    data = await response.json<T & StripeErrorEnvelope>();
  } catch {
    throw new StripeApiError(response.status, 'Invalid response from Stripe');
  }
  if (!response.ok) {
    throw new StripeApiError(response.status, data.error?.message || 'Stripe API error');
  }
  return data;
}

async function stripeRequestOrNullOn404<T>(
  env: StripeEnv,
  path: string,
  params?: StripeParams
): Promise<T | null> {
  try {
    return await stripeRequest<T>(env, path, params);
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
export async function findCustomerByEmail(env: StripeEnv, email: string): Promise<StripeCustomer | null> {
  const typed = (email || '').trim();
  if (!typed) return null;

  const candidates = [typed];
  const lowercased = typed.toLowerCase();
  if (lowercased !== typed) candidates.push(lowercased);

  for (const candidate of candidates) {
    const result = await stripeRequest<StripeList<StripeCustomer>>(env, '/customers', {
      email: candidate,
      limit: 1,
    });
    if (result.data[0]) return result.data[0];
  }
  return null;
}

export async function getCustomer(env: StripeEnv, customerId: string): Promise<StripeCustomer | null> {
  const customer = await stripeRequestOrNullOn404<StripeCustomer>(
    env,
    `/customers/${encodeURIComponent(customerId)}`
  );
  if (customer && customer.deleted === true) return null;
  return customer;
}

export function getSubscription(env: StripeEnv, subscriptionId: string): Promise<StripeSubscription | null> {
  return stripeRequestOrNullOn404<StripeSubscription>(
    env,
    `/subscriptions/${encodeURIComponent(subscriptionId)}`
  );
}

export function getPaymentMethod(
  env: StripeEnv,
  paymentMethodId: string
): Promise<StripePaymentMethod | null> {
  return stripeRequestOrNullOn404<StripePaymentMethod>(
    env,
    `/payment_methods/${encodeURIComponent(paymentMethodId)}`
  );
}

export async function listSubscriptionsForCustomer(
  env: StripeEnv,
  customerId: string | null | undefined
): Promise<StripeSubscription[]> {
  if (!customerId) throw new Error('customerId is required');
  const result = await stripeRequest<StripeList<StripeSubscription>>(env, '/subscriptions', {
    customer: customerId,
    limit: 10,
  });
  return result.data;
}

export async function listInvoicesForCustomer(
  env: StripeEnv,
  customerId: string | null | undefined
): Promise<StripeInvoice[]> {
  if (!customerId) throw new Error('customerId is required');
  const result = await stripeRequest<StripeList<StripeInvoice>>(env, '/invoices', {
    customer: customerId,
    limit: 10,
  });
  return result.data;
}

export function shapeCustomer(customer: StripeCustomer): ShapedCustomer {
  return { id: customer.id, email: customer.email, name: customer.name };
}

export function shapeSubscription(subscription: StripeSubscription): ShapedSubscription {
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

export function shapeInvoice(invoice: StripeInvoice): ShapedInvoice {
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

export function shapePaymentMethod(
  paymentMethod: StripePaymentMethod | null
): ShapedPaymentMethod | null {
  if (!paymentMethod || !paymentMethod.card) return null;
  return { brand: paymentMethod.card.brand, last4: paymentMethod.card.last4 };
}

export async function lookupStripeRecord(env: StripeEnv, rawQuery: string): Promise<StripeLookupResult> {
  const { type, value } = classifyQuery(rawQuery);
  if (!value) return { found: false };

  let customer: StripeCustomer | null;
  if (type === 'email') {
    customer = await findCustomerByEmail(env, value);
  } else if (type === 'customer') {
    customer = await getCustomer(env, value);
  } else {
    const subscription = await getSubscription(env, value);
    // A retrieved subscription always carries `customer`; the optional chain is
    // for the type, and either way a subscription without one yields found:false.
    customer = subscription?.customer ? await getCustomer(env, subscription.customer) : null;
  }
  if (!customer) return { found: false };

  const [subscriptions, invoices] = await Promise.all([
    listSubscriptionsForCustomer(env, customer.id),
    listInvoicesForCustomer(env, customer.id),
  ]);

  let paymentMethod: ShapedPaymentMethod | null = null;
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
