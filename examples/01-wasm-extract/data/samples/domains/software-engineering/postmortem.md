---
domain: software-engineering
genre: incident postmortem
synthetic: true
note: Written for example 01 of relate-examples, under its curated Software Engineering ontology, after create-context-graph's incident report template (707b168). Every person, team, company, service, repository, internal library, pull request, ticket, release and deployment is fictional; PostgreSQL, Go and the open-source pgx driver are real.
---

# Postmortem: INC-2291, failed checkouts after the ledger-api v4.12.0 rollout

**Author:** Marcus Feld (incident commander) · **Reviewed by:** Grace Adebayo, Lena Okafor · **Date:** 21 October 2026 · **Severity:** SEV-1 · **Status:** final, blameless

## Summary

Between 14:06 and 14:49 UTC on 14 October 2026, about one checkout attempt in five failed with the message "We couldn't confirm your payment", some 41,300 failed attempts in all. INC-2291 was triggered by DEP-5521, the production rollout of v4.12.0. INC-2291 affected ledger-api, checkout-api and payouts-worker. No customer was charged twice and no ledger entry was lost.

The cause was a changed default in dbkit, our internal database library. dbkit 3.0 sizes its connection pool from the number of CPUs, and ledger-api had relied on the old fixed default of 50 connections per pod. At the afternoon peak the smaller pool filled, ledger calls queued behind it, and retries from checkout-api roughly quadrupled the load.

## Services and owners

| Service | Tier | Owning team | Built from | Part in the incident |
|-----|-----|-----|-----|-----|
| ledger-api | 0 | Ledger team | vantorra/ledger | connection pool saturated |
| payouts-worker | 1 | Ledger team | vantorra/ledger | payout queue fell behind |
| ledger-db | 0 | Ledger team | managed PostgreSQL | not affected |
| checkout-api | 0 | Checkout team | vantorra/checkout | returned the errors |
| storefront-web | 0 | Checkout team | vantorra/storefront | showed the errors to customers |

checkout-api depends on ledger-api to confirm every payment before an order is placed, and payouts-worker depends on ledger-api for the balances it pays out each hour. ledger-api depends on ledger-db, a PostgreSQL 16 cluster, and storefront-web depends on checkout-api. ledger-api uses dbkit, which wraps the open-source pgx driver and adds our metrics and tracing. payouts-worker uses dbkit as well, but its pool size is set explicitly in its config, so the new default never reached it.

## Timeline

All times are UTC on 14 October 2026.

- **13:20** DEP-5519 rolls out v4.12.0 to the canary, 5% of ledger-api pods; its checks pass after 20 minutes.
- **14:02** DEP-5521 starts rolling out v4.12.0 to every production pod.
- **14:06** The checkout-api error rate passes 5%, and ledger-api p99 latency reaches 2.1 seconds.
- **14:08** Lena Okafor, on call for ledger-api, is paged.
- **14:11** Hana Kimura, on call for checkout-api, joins the incident channel.
- **14:12** Marcus Feld declares INC-2291 at SEV-1 and takes incident command.
- **14:21** The first status page update goes out (see below).
- **14:38** Rollback ordered.
- **14:41** DEP-5527 starts rolling back to v4.11.3.
- **14:49** Error rates are back to baseline, and INC-2291 is mitigated.
- **16:30** The payouts-worker backlog has drained, and INC-2291 is resolved.

## What happened

### The change

On 9 October Daniel Osei authored PR #1842, which upgraded dbkit from 2.4 to 3.0 in vantorra/ledger. It was reviewed and approved by Sofia Brandt the next day. The diff touched only go.mod, go.sum and two call sites, and the dbkit 3.0 release notes, which say that the pool now defaults to four connections per CPU, were not linked from the description.

Release v4.12.0 of ledger-api was cut on 13 October 2026 and included PR #1842 and PR #1838. PR #1838, a change by Sofia Brandt that adds idempotency keys to the transfer endpoint, played no part in the incident.

### Why the canary passed

DEP-5519 ran v4.12.0 on 5% of ledger-api pods for twenty minutes in the early afternoon. At that share of traffic each pod held fewer than six connections, so the new pool of eight never filled, and the canary's error-rate and latency checks passed.

### Saturation and the retry storm

DEP-5521 rolled out v4.12.0 to every production pod from 14:02, just as the afternoon peak began. ledger-api runs on two-vCPU pods, so each pod now had eight connections where it used to have fifty. By 14:06 ledger calls were waiting up to two seconds for a connection, and checkout-api, which gives up on a ledger call after 1.5 seconds, began failing payments. checkout-api retries a failed ledger call three times with no backoff, so each timeout turned into four requests. payouts-worker, which calls ledger-api in hourly batches, fell 40 minutes behind.

INC-2291 did not affect ledger-db: its CPU stayed below 40% and its connection count fell, because the pods were holding fewer connections than before.

### Response

The page for ledger-api went to the Ledger team's primary on-call. That week the primary was Lena Okafor, who acknowledged within two minutes. Lena Okafor and Hana Kimura responded to INC-2291 alongside Marcus Feld of the SRE team, who took incident command at 14:12. Hana Kimura has been on the Checkout team for three years. She wrote most of its ledger client and recognized the retry pattern in the request logs.

The first status page update, at 14:21, said that INC-2291 was triggered by DEP-5520, a config push to checkout-api twenty minutes earlier; that was wrong, and the update was corrected at 14:30.

Lena Okafor saw the pool-wait metric climb on every ledger-api pod at once, and the deploy log showed DEP-5521 four minutes before the first errors. At 14:38 Marcus Feld ordered a rollback. DEP-5527 restored v4.11.3, the previous ledger-api release, on every pod by 14:49, and error rates returned to baseline within a minute.

search-api may also have been affected by INC-2291, but its error rate stayed within its normal daily range and we could not tie it to the incident.

## Impact

- 41,300 checkout attempts failed, 18% of attempts at the peak.
- 6,200 customers abandoned their cart; each was sent a recovery email on 15 October.
- payouts-worker delayed 2,140 merchant payouts by up to 90 minutes.
- No duplicate charges and no lost ledger entries.

## Root cause and contributing factors

1. dbkit 3.0 changed the default pool size, and ledger-api took the default instead of setting it.
2. The canary ran at too little traffic, for too short a time, to fill even the smaller pool.
3. checkout-api retries without a budget or backoff, which turned slow responses into a retry storm.
4. Nothing alerted on pool saturation; we found it on a dashboard.

## Action items

LEDGER-412, LEDGER-415, CHK-208 and OBS-77 are follow-ups to INC-2291.

| Issue | Action | Assignee | Due | Status |
|-----|-----|-----|-----|-----|
| LEDGER-412 | Set the ledger-api pool size explicitly and log it at startup | Daniel Osei | 31 Oct 2026 | in review |
| LEDGER-415 | Hold the canary through a traffic peak before promoting it | unassigned | 30 Nov 2026 | open |
| CHK-208 | Add a retry budget and jittered backoff to the checkout-api ledger client | Hana Kimura | 7 Nov 2026 | open |
| OBS-77 | Page on connection-pool saturation for every service that uses dbkit | Ravi Menon | 14 Nov 2026 | open |

PR #1857, also authored by Daniel Osei, fixes LEDGER-412 and is in review. v4.12.1 will include PR #1857 once it is approved. v4.12.1 is expected to be cut on 3 November 2026. If the SRE team signs off on a longer canary, Lena Okafor would take LEDGER-415 in the next sprint.

## What went well, and what did not

- The rollback took eleven minutes from decision to recovery, and no data had to be repaired.
- The upgrade's risk sat in a release note that nobody on the review read. Library upgrades in vantorra/ledger now need a link to the changelog in the pull request description.
