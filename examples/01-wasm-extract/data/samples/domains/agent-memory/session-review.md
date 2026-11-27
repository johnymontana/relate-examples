---
domain: agent-memory
genre: agent session review
synthetic: true
note: Written for example 01 of relate-examples, under its curated Agent Memory ontology, after create-context-graph's agent session log template (707b168). Every person, company, product, agent, tool and identifier is fictional; the cities are real.
---

# Session review: ses-40218, a faulty kettle and a stale address

**From:** Nadia Kerrigan, platform engineering · **To:** Support Automation review group · **Date:** 20 November 2026 · **Reference:** SR-2026-117

## Summary

On 18 November 2026, Marlow handled ses-40218, a web-chat session about a Kettlewise K2 kettle that had stopped heating. The customer got what she asked for: a replacement, booked for a weekday morning, and her express delivery charge refunded. Two things went wrong on the way. Marlow offered to send the replacement to an address the customer had left in August, because the memory that held it had never been superseded, and when the session closed the memory service stored a preference she did not state. Neither did harm this time: she corrected the address herself, and the preference was deleted before any session recalled it.

## The agent, the user and the session

Marlow is Corvane Home's customer-support agent, deployed as agt-marlow-support at version 4.2 on 4 November. Marlow can call five tools: lookup_order, check_warranty, create_replacement, issue_refund and handoff_to_human. Recall is not a tool. The memory service retrieves up to five memories about the user when a session opens, and writes new ones when it closes.

Ines Halloran opened ses-40218 at 10:31 from the chat panel on her account page. She agreed to memory in March 2025, so the store knows her as usr-20417 and keeps what her earlier sessions taught it. The session ran for 23 minutes and fourteen messages. At 10:52 ses-40218 was escalated to Aled Pritchard, a support specialist on the returns team, because goodwill refunds need a person's approval.

## What Marlow recalled

When ses-40218 opened, the memory service returned three memories:

| Memory | Written | Content | Recall score |
|---|---|---|---|
| mem-1180 | 9 May 2025 | "Delivery address: Bristol, BS6" | 0.91 |
| mem-1402 | 14 August 2026 | "Says she has moved to Leeds; update her address" | 0.62 |
| mem-1417 | 14 August 2026 | "Wants email-only contact" | 0.58 |

mem-1180 was recalled in ses-40218 ahead of the others, because its slot, delivery address, matched the word "delivery" in her first message and its importance was 0.9. mem-1402 holds the new address, but the writer stored it in August as a free-text note rather than in the address slot, so it never superseded mem-1180. mem-1417 records her preference for email-only contact, and Marlow honoured it: every confirmation went by email.

## The conversation and the tool calls

Her first message, msg-3305, was sent in ses-40218 at 10:31 and mentions order CV-55102 and the Kettlewise K2 it contained, which had stopped heating after nine days. Marlow answered with two read-only calls, then asked whether she wanted a refund or a replacement. In msg-3307 she chose a replacement. Marlow's reply, msg-3308, offered to send it to "your address in Bristol, BS6", which is the content of mem-1180. Her next message, msg-3309, corrected it: "I moved to Leeds in August, please don't send it to Bristol."

| Call | Tool | Triggered by | Acted on | Result |
|---|---|---|---|---|
| call-8811 | lookup_order | msg-3305 | CV-55102 | delivered 2 November, one item |
| call-8812 | check_warranty | msg-3305 | Kettlewise K2 | in warranty until November 2028 |
| call-8814 | create_replacement | msg-3309 | CV-55102 | RMA-77310 opened, courier booked to Leeds |
| call-8815 | issue_refund | msg-3313 | CV-55102 | refused: goodwill refunds need approval |
| call-8816 | handoff_to_human | msg-3313 | — | session passed to the returns queue |

call-8814, which invoked create_replacement, was triggered by msg-3309, the correction, so the courier was booked to Leeds. In msg-3311 she asked for the confirmation by email, as she cannot take calls at work. msg-3313 asked for delivery on a weekday morning and for the £14.99 express charge back. call-8815 invoked issue_refund for the charge and was refused, and Marlow handed the session over. The specialist approved the refund himself and closed the session at 10:54.

## What the memory service wrote

The memory service wrote mem-2231, mem-2233, mem-2234 and mem-2236 in ses-40218 when the session closed:

- **mem-2231** ("Delivery address: Leeds, LS7") came from msg-3309 and supersedes mem-1180, whose status is now superseded.
- **mem-2233** ("Kettlewise K2 from order CV-55102 replaced under RMA-77310") refers to the Kettlewise K2, order CV-55102 and RMA-77310.
- **mem-2234** ("Wants weekday morning delivery") came from msg-3313 and records her preference for weekday morning delivery.
- **mem-2236** ("Wants phone callbacks") records a preference for phone callbacks.

Ines Halloran prefers email-only contact and weekday morning delivery, and both preferences are now on record.

## The preference nobody stated

mem-2236 is about Ines Halloran, and it is wrong. Ines Halloran never asked for phone callbacks: in msg-3311 she wrote that she cannot take calls at work. The session-close summariser read the handoff note, saw the word "calls" and wrote the opposite of what she meant. On 19 November at 09:10, mem-2236 was flagged by Aled Pritchard. Nadia Kerrigan deleted it the same morning, before a later session recalled it, and mem-2236 now has the status deleted.

## Why it happened

- The writer picks a memory's slot from the one message in front of it. In August it read "I've moved to Leeds" as an event, not as an address, and stored mem-1402 as a note without a slot.
- Supersession runs only within a slot, so the August note was never compared with the May address.
- Recall ranks by similarity times importance, and an address memory starts at 0.9.
- The summariser may write a preference that no message supports.

## What the record does not show

- The retrieval log suggests that mem-0966 may also have been recalled in ses-40218, but the entry for that turn is truncated.
- An earlier draft of this review said that call-8815 acted on RMA-77310; it acted on order CV-55102, as the table shows.
- The nightly consolidation job is expected to make mem-2231 supersede mem-1402 as well.
- mem-1402 is expected to be marked superseded when that job has run.

## Recommendations

1. Map moves and address changes to the delivery address slot, so that a new address supersedes the old one in the same write.
2. Give the agent a tool for addresses. If the change is approved, Marlow would also be able to call update_address and correct the record itself.
3. Hold any preference memory that came from no message for review instead of writing it.
4. Re-run the recall evaluation on the 40 sessions this month that recalled an address memory, and report to this group on 4 December.
