---
domain: product-management
genre: product requirements document
synthetic: true
note: Written for example 01 of relate-examples, under its curated Product Management ontology, after create-context-graph's product requirements document template (707b168). Every person, company, product, team, feature, customer account and reference is fictional; the planning practices and the metrics are standard ones.
---

# PRD: Offline Job Pack

**Author:** Maren Holt, product manager, Field Apps · **Reviewers:** Tobias Wren (engineering lead), Ines Abara (design), Kofi Mensah (customer success) · **Date:** 4 November 2026 · **Status:** approved for build · **Reference:** PRD-FA-031

## Summary

Crewline technicians work in plant rooms, basements and rural sites where the signal drops for hours at a time. Today the app needs a connection to open a job, so technicians fall back to paper and re-key the work at the end of the day. Offline Job Pack downloads each technician's jobs at the start of the shift, with their forms, asset history and site notes, and lets them complete a job with no signal at all. Offline Job Pack is part of the Offline-First Technician App epic and ships in Release 26.3 on 19 January 2027.

## Problem and evidence

Offline working is the most requested capability in the feedback log for the utilities segment. The four items below come from mid-market accounts with field teams of 40 to 300 technicians.

| Feedback | Account | ARR | Source | What they told us |
|---|---|---|---|---|
| FB-3107 | Ashgrove Water | £184,000 | support ticket | Completed forms are lost when the app times out in pump stations. |
| FB-3122 | Pellham Heating Services | £96,500 | sales call | Offline working is a condition of their renewal in March. |
| FB-3150 | Northmere Facilities | £212,000 | interview | Technicians need the parts catalogue on site, not only the job. |
| FB-3164 | Coastway Elevators | £58,000 | support ticket | Engineers want video calls with the office from inside lift shafts. |

Pellham Heating Services would grow to about £150,000 a year if offline working ships before that renewal, its account manager says. Offline Job Pack addresses FB-3107 and FB-3122. Offline Parts Lookup, the fast-follow described below, addresses FB-3150. Offline Job Pack does not address FB-3164, because a live video call needs a connection by definition.

## Who it is for

The primary persona is the Field Technician: a qualified engineer who completes four to eight jobs a day, mostly alone, and is judged on fixing the fault at the first visit. Offline Job Pack is designed for the Field Technician. The secondary persona is the Dispatcher, who plans the day from the office and has to untangle jobs that two people changed while one of them was offline. Sync Conflict Review is designed for the Dispatcher persona.

## Goals and success metrics

The Offline-First Technician App epic contributes to Grow Mid-Market Utilities (O2), one of the company's three objectives for H1 2027. Grow Mid-Market Utilities is tracked by first-time fix rate and net revenue retention in the utilities segment.

Offline Job Pack is measured by offline job completion rate, the share of jobs completed without a connection that reach the server intact. Its second success metric is first-time fix rate, since a technician with the asset history in hand is less likely to need a return visit. Sync Conflict Review is measured by sync conflict rate, which the dispatch console already reports.

| Metric | Baseline | Target by end of Q1 2027 |
|---|---|---|
| offline job completion rate | not measured (jobs cannot be opened offline) | 98% |
| first-time fix rate | 71% | 76% |
| sync conflict rate | 2.4% of synced jobs | below 1% |
| support tickets per account | 3.1 a month | 2.5 a month |

## Scope

| Feature | Release | Planned date | Priority | Notes |
|---|---|---|---|---|
| Offline Job Pack | Release 26.3 | 19 January 2027 | P0 | Core of the epic. |
| Sync Conflict Review | Release 26.3 | 19 January 2027 | P1 | Dispatch console only. |
| Offline Parts Lookup | Release 26.4 | 2 March 2027 | P1 | Fast-follow. |

- **Offline Job Pack:** the day's jobs downloaded at shift start over Wi-Fi or mobile data, with forms, photos, asset history and site notes; completed work queues on the device and uploads when the signal returns.
- **Sync Conflict Review:** a screen in the dispatch console that lists every job edited in two places and lets the dispatcher keep one version or merge the two.
- **Offline Parts Lookup:** the van stock and the parts catalogue, searchable on the device.

Out of scope: editing the schedule offline, and offline video. Technicians will see the schedule as it was at download.

## Dependencies and delivery

Offline Job Pack depends on Background Sync Engine, the queue-and-retry service that the Sync Platform team built for the Unified Sync epic. Background Sync Engine shipped in Release 26.2 and has run on 30% of Android devices since October without data loss. Sync Conflict Review also depends on Background Sync Engine, because it reads the engine's conflict log. Offline Parts Lookup depends on Offline Job Pack, which provides the local store it searches.

The Sync Platform team owns the Unified Sync epic, and Unified Sync contributes to Reduce Cost to Serve (O4). That objective is tracked by support tickets per account, since sync failures are the largest single cause of tickets from field teams.

The Offline-First Technician App epic is owned by the Field Apps squad, which builds Offline Job Pack and Sync Conflict Review. Offline Parts Lookup belongs to the same epic. It is built by the Field Apps squad as well, by the two engineers who joined from inventory in September.

## Experiment and rollout

EXP-214, a holdout test that starts with Release 26.3, tests Offline Job Pack with 120 technicians at Ashgrove Water and Pellham Heating Services, against a holdout group of 40 who keep the online-only app for four weeks. EXP-214 measures offline job completion rate as its primary metric and first-time fix rate as a guardrail. EXP-221 will test Offline Parts Lookup with Northmere Facilities once Release 26.4 reaches beta.

The rollout widens from 10% of each account's technicians in the first week to 50% in the second and all of them by the fourth, as long as offline job completion rate stays above 98%.

## Open questions

- If the catalogue API is ready by 8 December, Offline Parts Lookup could ship in Release 26.3 instead.
- Unified Sync may also contribute to Grow Mid-Market Utilities, since two utilities cited sync failures in their renewal calls, but finance has not agreed to count it.
- An earlier draft said that Sync Conflict Review was designed for the Field Technician persona; that was wrong, because technicians never see the conflict queue.
- How long may a pack stay on a device before its data is stale? The security review asks for 72 hours; account managers would prefer seven days.

## Milestones

1. Design sign-off: 18 November 2026.
2. Internal dogfooding on the staging cluster: from 9 December.
3. Release 26.3 to all accounts: 19 January 2027.
4. EXP-214 read-out to the Field Apps squad: 23 February 2027.
