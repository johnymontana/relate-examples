---
domain: software-engineering
genre: pull request description and review thread
synthetic: true
note: Written for example 01 of relate-examples, under its curated Software Engineering ontology, after create-context-graph's pull request description template (707b168); a held-out document, a different company and case from the INC-2291 postmortem. Every person, team, company, service, repository, library, pull request, ticket, release, incident and commit is fictional; PostgreSQL is real.
---

# PR #731: notify-worker: write order emails to an outbox before sending them

**Repository:** pintail/notify · **Author:** Camille Laurent · **Base branch:** main · **Opened:** 12 November 2026 · **State:** merged, 17 November 2026

## Summary

Camille Laurent opened PR #731 against pintail/notify to stop notify-worker from sending the same order confirmation twice. PR #731 fixes NOTIFY-96, a follow-up to INC-388, in which about 9,400 customers received two or three copies of their confirmation email on 2 November after a node drain restarted the workers in the middle of a batch. NOTIFY-96 is assigned to Camille Laurent, who is on the Notifications team.

PR #731 does not fix NOTIFY-101, the template bug that sent some emails with a blank first name; that needs its own change. NOTIFY-101 stays open.

## Background

The Notifications team owns notify-worker. notify-worker consumes order events from the event bus, renders each email and sends it with mailgate, our internal client for the email provider. notify-worker depends on notify-db, a PostgreSQL database, to record each send, but it writes that record only after the provider accepts the message. A worker that dies between the two steps never writes the record, so the event is redelivered and the customer gets the email again. INC-388 was declared at SEV-2 and affected notify-worker for about forty minutes during a routine node drain.

## What changed

- notify-worker now writes each rendered email to a new `email_outbox` table in notify-db, in the same transaction that marks the order event consumed.
- A relay loop reads unsent rows, sends each one with an idempotency key derived from the order and the template, and then marks it sent.
- PR #731 upgrades mailgate from 1.8 to 2.1, the first version that passes the idempotency key through to the provider, so a repeated send is dropped there.
- The old `sent_emails` table stays, read-only, for 30 days.

The diff is 612 lines added and 148 removed, most of it the relay and its tests.

## Testing

- Unit tests for the relay, including a crash between the provider call and marking the row sent.
- A chaos run in staging: we killed notify-worker pods every 30 seconds for an hour while replaying 50,000 order events, and every test customer received exactly one email.
- Load: the relay keeps up with 400 emails a second, four times last year's peak.

## Rollout

The outbox sits behind the `outbox_enabled` flag, turned on for 5% of traffic first and for everyone after a day without duplicates. v2.8.0, the next notify-worker release, will include PR #731 and is expected to be cut on 19 November 2026.

## Review

**Jonah Whitfield** requested changes on PR #731 on 13 November.

> The relay marks a row sent only after the provider call returns. If the call times out but the provider did deliver, we resend with the same key, which is fine, but please add a test for exactly that case.

> Also, receipts-worker may depend on notify-db directly; can you check before we freeze sent_emails?

**Camille Laurent** replied on 13 November.

> Added the timeout test in commit 4f2c9e1. I checked receipts-worker: it calls the notify-worker status endpoint and never reads notify-db, so freezing the table is safe.

**Jonah Whitfield** approved PR #731 on 14 November.

> Thanks, this reads well, and the chaos run is convincing.

**Amara Nwosu** approved PR #731 on 14 November.

> I'm on call for notify-worker this week, so I'll watch the dashboards during the 5% step. Please post in the team channel before you turn the flag up.

**Camille Laurent** merged PR #731 into main on 17 November.
