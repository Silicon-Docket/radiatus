# Office 365 correspondence panel (optional)

This is an **optional** feature. Radiatus runs fine without it: leave the four
`GRAPH_*` variables blank and `/api/mail/lookup` answers `501 Not Implemented`,
which the admin page renders as a plain "not configured" note, while the
auto-flagging cron fires on schedule and returns immediately without doing
anything. Nothing else in the template changes. It is deliberately kept out of
[Quick start](../README.md#quick-start).

## What it does

Two things, both from the same four variables.

**The correspondence panel.** On the customer view in `/admin`, a
**Correspondence** panel with a **Load correspondence** button. Clicking it
lists message *metadata* — received date, sender, subject, attachment flag —
from one shared mailbox, searched for messages involving the customer's email
address. Each row links out to the message's Outlook `webLink`.

**Auto-flagging.** A [Cron Trigger](#auto-flagging-and-the-cron-trigger) polls
the same mailbox every 15 minutes and flags the accounts of people who wrote in,
according to rules you edit in `src/flag-rules.ts`. The **Accounts** table at
the top of `/admin` is that queue.

Read "searched for" literally rather than as a security boundary. The address
becomes a term in a Graph KQL `$search` query, and only quote characters are
stripped from it, so someone who already holds `ADMIN_API_TOKEN` can pass KQL
operators and broaden the query to enumerate metadata in that mailbox beyond one
customer's correspondence. That is a small step up from what the token already
allows — it can query any address — which is why it is not treated as a hole to
plug. The two properties that *are* boundaries hold regardless: the mailbox
comes from configuration and no request can change it, and message bodies are
excluded by the Exchange grant rather than by our filtering.

## What it deliberately does not do

- **No message bodies.** Not `body`, not `bodyPreview`. `shapeMessage()` in
  `src/graph.ts` is an explicit allow-list, and `$select` asks Graph for the
  same short list. But the real guarantee is the Exchange grant below: the
  `Application Mail.ReadBasic` role does not include message content at all, so
  a leaked `ADMIN_API_TOKEN` still cannot pull mail bodies through this route.
  This applies to the flag rules too — they match on subject and sender only,
  and [cannot be given body text](#rules-see-the-subject-and-sender-only-never-the-body).
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

## Auto-flagging and the cron trigger

`wrangler.toml` declares a schedule:

```toml
[triggers]
crons = ["*/15 * * * *"]
```

It is already there and you do not need to add it. The Worker's `scheduled`
handler checks for the four `GRAPH_*` variables first and returns immediately
when any is missing, so on a deployment that never enabled this feature the
cron fires, does nothing, touches no database, and costs nothing. That is why
shipping it enabled is safe. Change the expression if every 15 minutes is the
wrong cadence; delete the `[triggers]` block if you want no schedule at all.

Each run reads the watermark (the newest `received_at` in `processed_messages`),
asks Graph for messages at or after it, evaluates the rules against each one,
and records every message it examined. The first run on a fresh database looks
back 24 hours — a new deployment should start flagging what arrives from now
on, not manufacture a queue out of a year of mailbox history.

**Flags do not come back once cleared** — provided Graph honours the immutable
ID request. Idempotency is by Graph message ID: a message already in
`processed_messages` is skipped entirely, so a retried, overlapping, or re-run
poll cannot re-raise a flag an operator just resolved.

There is a wrinkle worth knowing, because it bites the natural operator
workflow. Graph message IDs are **not stable by default** — filing a message
into a folder reassigns the ID, which would make the same message look new and
re-raise the flag you just cleared. The poll therefore sends
`Prefer: IdType="ImmutableId"`. **This is one of the unverified items below**:
if your tenant does not honour it, the symptom is a flag reappearing after an
agent handles a ticket, clears it, and files the mail — all within one 15-minute
tick. If you see that, say so in an issue; the fallback is to key idempotency on
`internetMessageId` instead.

Separately, the poll reads **the Inbox only**, not the whole mailbox, so the
team's own replies from Sent Items do not flag the support mailbox as a
customer account. A second guard in `src/flagging.ts` skips any message whose
sender is `GRAPH_MAILBOX` itself, so that failure cannot occur even if the
folder scoping is refused.
(For the same reason, `processed_messages` must never be pruned — it holds the
watermark as well as the idempotency keys. The comment on the table in
`db/schema.ts` explains what breaks if you do.)

### Rules see the SUBJECT and SENDER only. Never the body.

> A flag rule receives the shaped metadata object — `subject`, `from`,
> `toRecipients`, `receivedDateTime`. **There is no message body in it, and
> there is no setting that adds one.**

This is deliberate, and it is the same decision as Step 2 above wearing a
different hat. Message content is excluded **at the Exchange grant**: the
`Application Mail.ReadBasic` role does not include bodies, so they never reach
the Worker to be matched against. Making body text available to rules would
mean asking for `Application Mail.Read` — and at that point a leaked
`ADMIN_API_TOKEN` could pull the full contents of every message in the mailbox
through this deployment.

Automatic flagging is not worth that trade. A rule that needs body text cannot
be expressed here, by design: the `ShapedMessage` type a rule is handed declares
no such field, so the rule does not compile. The honest workaround is a narrower
subject rule plus a human reading the message in Outlook — not a wider grant.

`src/flag-rules.ts` ships with exactly one rule, marked as an example to
replace: subject matching `/\brefund\b/i`. That pattern matches the standalone
word only — **not** "refunds", "refunded", or "non-refundable" — which is a
documented choice, explained in the file along with how to widen it. Exporting
an empty `FLAG_RULES` array turns flagging off while leaving the poll harmless.
A rule that throws is caught and skipped so one bad regex cannot stop the run,
which also means a broken rule fails silently: test yours.

## What this integration has NOT verified against a live tenant

All five are honest unknowns. Treat the first as a risk to your setup time,
the next two as risks to what the panel can show you, and the last two as risks
to how the flag queue behaves in daily use.

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
4. **Whether `Prefer: IdType="ImmutableId"` is honoured on the poll.** If it is
   not, message IDs revert to changing when mail is filed into a folder, and a
   flag can reappear after an agent handles the ticket, clears it, and files the
   message — the exact sequence a tidy operator performs. Symptom: a flag you
   just cleared is back within a tick, on the same subject. Fallback: key
   `processed_messages` on `internetMessageId`, which is stable and included
   under `Mail.ReadBasic`.
5. **Whether `/mailFolders/inbox/messages` is permitted under the scoped
   grant.** The poll reads the Inbox rather than the whole mailbox so the team's
   own replies do not flag the support mailbox as a customer. If that path is
   refused the poll errors every 15 minutes, visible only in the Cloudflare cron
   log. Note the self-flag failure itself is guarded independently in
   `src/flagging.ts`, so a fallback to the mailbox-wide path would still not
   flag the mailbox against itself — it would only widen what the poller reads
   to include Sent and Deleted items.

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
  GRAPH_CLIENT_SECRET`, etc.). Both the panel and auto-flagging go inert
  together; the cron keeps firing and keeps doing nothing. Remove the RBAC
  assignment too if you are done with it: `Remove-ManagementRoleAssignment`.
- **Auto-flagging runs unattended and logs nothing an operator reads.** A rule
  that throws is skipped silently and a poll that fails is a failed cron
  invocation in the Cloudflare dashboard, nowhere else. If flags stop appearing,
  check the Worker's cron invocation log before assuming the mailbox is quiet.

## Background

[docs/decisions/2026-09-01-office365-mail.md](./decisions/2026-09-01-office365-mail.md)
records why the first attempt (an Outlook deep link) was abandoned and why this
integration is shaped the way it is.
