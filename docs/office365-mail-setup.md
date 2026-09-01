# Office 365 correspondence panel (optional)

This is an **optional** feature. Radiatus runs fine without it: leave the four
`GRAPH_*` variables blank and `/api/mail/lookup` answers `501 Not Implemented`,
which the admin page renders as a plain "not configured" note. Nothing else in
the template changes. It is deliberately kept out of [Quick start](../README.md#quick-start).

## What it does

On the customer view in `/admin`, a **Correspondence** panel with a
**Load correspondence** button. Clicking it lists message *metadata* — received
date, sender, subject, attachment flag — from one shared mailbox, filtered to
messages involving the customer's email address. Each row links out to the
message's Outlook `webLink`.

## What it deliberately does not do

- **No message bodies.** Not `body`, not `bodyPreview`. `shapeMessage()` in
  `src/graph.js` is an explicit allow-list, and `$select` asks Graph for the
  same short list. But the real guarantee is the Exchange grant below: the
  `Application Mail.ReadBasic` role does not include message content at all, so
  a leaked `ADMIN_API_TOKEN` still cannot pull mail bodies through this route.
- **One mailbox, from configuration only.** The mailbox comes from
  `GRAPH_MAILBOX`. No request parameter influences it. That is the difference
  between "look up correspondence with a customer" and "browse any mailbox in
  the tenant with a shared password".
- **No reading in-app.** Outlook stays the reader, under the operator's own
  identity.

## Before you start

You need:

- A **Global Administrator** (for the app registration) and an **Exchange
  Administrator** (for the RBAC assignment). If that is not you, this is a
  request to someone else, and the wait is part of the cost.
- The [ExchangeOnlineManagement PowerShell module](https://learn.microsoft.com/en-us/powershell/exchange/exchange-online-powershell-v2)
  installed locally.
- A dedicated shared mailbox for customer support — do not point this at a
  person's mailbox.
- Roughly 30 minutes of work, plus a **30-minute to 2-hour propagation delay**
  before you can tell whether it worked. Budget for coming back tomorrow.

## Step 1 — Register the application in Entra

1. Entra admin center → **Identity** → **Applications** → **App registrations**
   → **New registration**.
2. Name it something recognisable (`radiatus-mail-readonly`), single tenant, no
   redirect URI. Register.
3. Copy the **Directory (tenant) ID** → `GRAPH_TENANT_ID`.
4. Copy the **Application (client) ID** → `GRAPH_CLIENT_ID`.
5. **Certificates & secrets** → **New client secret**. Copy the secret **Value**
   (not the Secret ID) → `GRAPH_CLIENT_SECRET`. It is shown once.

## Step 2 — Do NOT grant any Graph mail permission

> **Do NOT add any `Mail.*` API permission under "API permissions".**
>
> **Do NOT click "Grant admin consent".**
>
> Leave the API permissions blade exactly as the registration created it.

This is the step your muscle memory will reach for, and it is the one that
quietly ruins the security model. Entra application permissions and Exchange
RBAC for Applications are **two independent grant authorities, and they union**.
Consent `Mail.Read` in Entra — documented as *"read mail in all mailboxes
without a signed-in user"* — and the mailbox scope you configure in Step 3 stops
constraining anything. Nothing fails. Nothing warns you. The panel works
identically, while the application can in fact read every mailbox in the tenant.

There is no error state that tells you this happened. The only way to know is to
not do it.

If someone has already granted consent, remove the permission and revoke the
consent before continuing, then re-run `Test-ServicePrincipalAuthorization` in
Step 4 to confirm access still comes only from the RBAC assignment.

## Step 3 — Grant access through Exchange RBAC only

Connect as an Exchange Administrator:

```powershell
Connect-ExchangeOnline -UserPrincipalName you@yourdomain.com
```

Register the app's service principal in Exchange. Both IDs come from Step 1
(`AppId` is the Application/client ID; `ObjectId` is the **Enterprise
application** object ID from Entra → Enterprise applications, not the app
registration's own object ID):

```powershell
New-ServicePrincipal `
  -AppId "<GRAPH_CLIENT_ID>" `
  -ObjectId "<enterprise-application-object-id>" `
  -DisplayName "radiatus-mail-readonly"
```

Put the one mailbox you want readable into a mail-enabled security group, and
scope the assignment to that group's membership:

```powershell
New-DistributionGroup `
  -Name "radiatus-mail-scope" `
  -Type Security `
  -Members "support@yourdomain.com"

New-ManagementScope `
  -Name "radiatus-mail-scope" `
  -RecipientRestrictionFilter "MemberOfGroup -eq '<distinguished-name-of-the-group>'"
```

Get the group's distinguished name with
`(Get-DistributionGroup "radiatus-mail-scope").DistinguishedName`.

Assign the metadata-only role, scoped:

```powershell
New-ManagementRoleAssignment `
  -Role "Application Mail.ReadBasic" `
  -App "<GRAPH_CLIENT_ID>" `
  -CustomResourceScope "radiatus-mail-scope"
```

`Application Mail.ReadBasic` is the whole point: it grants message metadata and
excludes message bodies **at the grant**, not in our code. Do not substitute
`Application Mail.Read` because a snippet somewhere used it.

## Step 4 — Verify the scope actually binds

```powershell
Test-ServicePrincipalAuthorization -Identity "<GRAPH_CLIENT_ID>" -Resource "support@yourdomain.com"
```

Read the output carefully. You are checking two things:

1. The in-scope mailbox is **granted** `Mail.ReadBasic`.
2. A mailbox **outside** the group is **denied** — run the same command against
   another address and confirm it comes back denied. If it comes back granted,
   an Entra consent is in play (see Step 2) or the scope filter is wrong.

Allow **30 minutes to 2 hours** for the assignment to propagate before trusting
either result. A denial immediately after assignment usually means "not yet",
not "misconfigured" — wait before you start changing things.

## Step 5 — Set the variables

Local dev and the deployed Worker are separate; `wrangler` does not sync them.

```bash
# local (.dev.vars is gitignored)
cp .dev.vars.example .dev.vars   # then fill in the four GRAPH_* values

# deployed Worker
npx wrangler secret put GRAPH_TENANT_ID
npx wrangler secret put GRAPH_CLIENT_ID
npx wrangler secret put GRAPH_CLIENT_SECRET
npx wrangler secret put GRAPH_MAILBOX
```

Then search a customer in `/admin` and click **Load correspondence**.

## What this integration has NOT verified against a live tenant

All three are honest unknowns. Treat the first as a risk to your setup time and
the other two as risks to what the panel can show you.

1. **Whether a client-credentials token with zero Entra `Mail.*` consent is
   accepted at all.** Microsoft's RBAC-for-Applications documentation implies
   access can come from the Exchange assignment alone, but never states it
   normatively. If Graph returns `403` even after propagation and
   `Test-ServicePrincipalAuthorization` says granted, that is the case failing —
   and the only known workaround is an Entra consent, which reintroduces exactly
   the tenant-wide grant this design exists to avoid. Prefer to leave the
   feature off rather than take that trade.
2. **Whether `$search` works under `Mail.ReadBasic`.** If it does not, the
   integration falls back automatically to filtering on sender and returns
   `mode: 'sender-only'`; the panel then says in plain words that only messages
   *from* the customer are listed and your replies are not. That degradation is
   built in and needs no action — but it means the panel may show half the
   conversation.
3. **Whether the fallback's own query is accepted.** The sender-only fallback
   filters on `from/emailAddress/address` while sorting on `receivedDateTime`.
   Exchange rejects some filter/sort combinations across different properties
   with "the restriction or sort order is too complex to perform". If that
   happens, the fallback has nothing further to fall back to and the panel
   reports a Graph error. Nothing else in the deployment is affected.

Note also that in `search` mode Graph orders results by relevance, and `$search`
cannot be combined with `$orderby` on messages — so the 25 messages listed are
not necessarily the 25 most recent. The panel says so above the table.

## Operational notes

- **The client secret expires within 24 months** and the failure is silent: the
  panel starts returning a Graph error and nothing else in the deployment
  complains. Put the expiry date in a calendar now.
- **`ADMIN_API_TOKEN` is a shared secret**, not a per-operator identity. Anyone
  holding it can list this mailbox's message metadata through the API, and there
  is no record of who did. Exchange's own `MailItemsAccessed` audit record is
  enabled by default only on E3/E5 licences. If you cannot live with that,
  do not enable this feature — or put `/admin` behind Cloudflare Access first.
- **Turning it off** is removing the variables (`wrangler secret delete
  GRAPH_CLIENT_SECRET`, etc.). Remove the RBAC assignment too if you are done
  with it: `Remove-ManagementRoleAssignment`.

## Background

[docs/decisions/2026-09-01-office365-mail.md](./decisions/2026-09-01-office365-mail.md)
records why the first attempt (an Outlook deep link) was abandoned and why this
integration is shaped the way it is.
