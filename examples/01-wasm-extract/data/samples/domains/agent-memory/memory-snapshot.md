---
domain: agent-memory
genre: memory snapshot
synthetic: true
note: Written for example 01 of relate-examples, under its curated Agent Memory ontology, after create-context-graph's memory snapshot template (707b168); a companion to the session review SR-2026-117. Every person, company, product, agent and identifier is fictional; the cities are real.
---

# Memory snapshot: usr-20417 (Ines Halloran)

**Exported by:** the memory service, for Nadia Kerrigan · **Date:** 21 November 2026 · **Store:** Marlow, production · **For:** SR-2026-117

## Scope

This is the memory store's view of one user, taken three days after ses-40218 and annotated for the session review. mem-1180, mem-1402, mem-1417, mem-2231, mem-2233 and mem-2234 are about Ines Halloran, and so was mem-2236 until it was deleted. Recall returns only the memories marked current.

## The memories

| Memory | Status | Content | Written in | Came from |
|---|---|---|---|---|
| mem-1180 | superseded | "Delivery address: Bristol, BS6" | ses-11930 | msg-0412 |
| mem-1402 | current | "Says she has moved to Leeds; update her address" | ses-38870 | msg-2954 |
| mem-1417 | current | "Wants email-only contact" | ses-38870 | msg-2956 |
| mem-2231 | current | "Delivery address: Leeds, LS7" | ses-40218 | msg-3309 |
| mem-2233 | current | "Kettlewise K2 from order CV-55102 replaced under RMA-77310" | ses-40218 | none |
| mem-2234 | current | "Wants weekday morning delivery" | ses-40218 | msg-3313 |
| mem-2236 | deleted | "Wants phone callbacks" | ses-40218 | none |

mem-2231 supersedes mem-1180, so recall no longer returns the Bristol address. mem-1417 records her preference for email-only contact, which Ines Halloran stated in msg-2956 on 14 August. mem-2234 records her preference for weekday morning delivery, and mem-2233 refers to the Kettlewise K2 that order CV-55102 delivered.

## Where the older memories came from

Ines Halloran opened ses-11930 on 9 May 2025 about a missing parcel. msg-0412 was sent in ses-11930, and the address in it became mem-1180.

Marlow, then at version 4.1, handled ses-38870 on 14 August 2026. Ines Halloran opened ses-38870 to report her move. msg-2954 and msg-2956 were both sent in that session, eleven seconds apart. mem-1402 came from msg-2954, in which she wrote "I've moved to Leeds, can you update my details". The writer stored it as a note without a slot, which is why the May address stayed current for three months.

## Flags and open questions

- mem-2236 was flagged by Aled Pritchard, the returns specialist who took over ses-40218, on 19 November and deleted the same morning. Deletion keeps the record for audit and removes it from recall.
- mem-2234 may be flagged by Aled Pritchard as well, once he has checked whether msg-3313 asked for one morning delivery or for every delivery.
- mem-2233 did not come from msg-3313: the summariser wrote it from the results of the tool calls.
- A support note claims that mem-1180 came from msg-0415, but the export shows msg-0412.

## Counts

| Status | Memories |
|---|---|
| current | 5 |
| superseded | 1 |
| deleted | 1 |
