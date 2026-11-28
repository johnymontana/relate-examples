---
domain: software-engineering
genre: design document
synthetic: true
note: Written for example 01 of relate-examples, under its curated Software Engineering ontology, after create-context-graph's design document template (707b168); a companion to the INC-2291 postmortem. Every person, team, company, service, repository, internal library, pull request, ticket and release is fictional; PostgreSQL is real.
---

# Design: explicit connection pools for ledger-api and a retry budget for its callers

**Author:** Daniel Osei, Ledger team · **Approvers:** Grace Adebayo, Marcus Feld · **Date:** 23 October 2026 · **Tracking:** LEDGER-412, CHK-208 · **Status:** approved

## Context

INC-2291 was triggered by DEP-5521, which rolled out v4.12.0 of ledger-api on 14 October. The incident review kept INC-2291 at SEV-1. v4.12.0, cut on 13 October 2026, included PR #1842, and PR #1842 upgraded dbkit to 3.0, whose pool size follows the CPU count. ledger-api uses dbkit for every PostgreSQL call, and checkout-api depends on ledger-api for every payment, so a pool of eight connections per pod was enough to fail one checkout in five.

The Ledger team owns ledger-api. The Checkout team owns checkout-api, which is built from vantorra/checkout. LEDGER-412 and CHK-208 are follow-ups to INC-2291. LEDGER-412 is assigned to Daniel Osei. CHK-208 is assigned to Hana Kimura and is due on 7 November 2026.

## Goals

- A pool size that a library upgrade cannot change silently.
- A pool that tells us when it is nearly full, before callers time out.
- Callers that back off when ledger-api is slow, instead of multiplying its load.

Moving ledger-db behind a connection proxy, and changing the dbkit defaults for other teams, are out of scope.

## Proposal

### 1. Size the pool in config

ledger-api will read its pool size from its deployment config and pass it to dbkit explicitly. We start at 48 connections per pod, which keeps the 40 production pods under the 2,000-connection limit of ledger-db with room for a rolling deploy.

```yaml
database:
  pool:
    max_conns: 48
    min_conns: 8
    acquire_timeout: 500ms
```

### 2. Make saturation visible

ledger-api will log its pool size at startup and export the share of connections in use. OBS-77, assigned to Ravi Menon, adds the page that fires when that share stays above 80% for five minutes.

### 3. A retry budget for callers

payouts-worker already uses retrykit, the Platform team's retry library, with a budget of 10% extra requests and jittered exponential backoff. checkout-api will use retrykit with the same budget from its next release, replacing its three immediate retries. storefront-web does not depend on ledger-api directly, so nothing in the storefront changes.

## Alternatives considered

- **Pin dbkit at 2.4.** Rejected: it postpones the problem and blocks the security fixes that only ship in 3.x.
- **Change the default back in dbkit.** Rejected: other services already rely on the new default, and the library belongs to the Platform team.
- **Raise the timeout in checkout-api.** Rejected: a longer timeout hides saturation instead of preventing it.

## Rollout

PR #1857, authored by Daniel Osei against vantorra/ledger, implements parts 1 and 2. Lena Okafor reviewed PR #1857 on 22 October and asked for a startup check that refuses a pool smaller than 16 connections. PR #1857 fixes LEDGER-412. v4.12.1 is expected to be cut on 3 November 2026 and will include PR #1857, with a canary held through the evening peak. PR #1857 might also fix LEDGER-415, but the SRE team doubts that a startup check can replace a longer canary.
