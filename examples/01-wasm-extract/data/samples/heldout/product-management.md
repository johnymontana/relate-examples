---
domain: product-management
genre: user interview notes
synthetic: true
note: Written for example 01 of relate-examples, under its curated Product Management ontology, after create-context-graph's user interview notes template (707b168); a held-out document, never listed in the page. Every person, company, product, team, feature, customer account and reference is fictional; the research method is a standard one.
---

# Interview notes: reassigning emergency work at Brackwater Gas Networks

**Interviewer:** Priyanka Dass, user research · **Notes:** Owen Fairley, product manager, dispatch · **Date:** 11 November 2026 · **Session:** UR-2026-044, 60 minutes, remote, recorded with consent

## Participant

Sunniva Okafor is the dispatch supervisor for the northern region of Brackwater Gas Networks, an enterprise account worth £640,000 a year, with 410 technicians on Crewline. She has planned engineers' days for nine years, the last two in our product. She fits the Dispatcher persona closely: she owns the schedule, takes the calls when a job overruns, and is measured on how fast an emergency reaches an engineer.

## Why we spoke to her

Live Dispatch Board is a map-first view of the day that will replace the job list in the dispatch console. Live Dispatch Board is part of the Dispatcher Workspace epic and is designed for the Dispatcher persona. It ships in Release 26.5, on 13 April 2027. Live Dispatch Board is built by the Dispatch squad, which also owns the Dispatcher Workspace epic.

We wanted to learn how Sunniva moves work when an emergency comes in, and what she needs to see to do it in one step rather than several.

## What we heard

1. **Reassignment is a phone exercise.** A reported gas escape must be attended within an hour, and Brackwater handles 15 to 20 of them a day in the northern region alone. "Every reassignment takes me four phone calls," Sunniva said. She keeps a paper map on the wall because the job list shows no locations.
2. **Customers are given the wrong arrival time.** When a job moves, the customer's text message still shows the first engineer's arrival time. Sunniva estimates that a third of the complaints her team handles are about arrival times that turned out to be wrong.
3. **Certification matters as much as distance.** Only engineers with the right gas-safe ticket may take a meter job. "The nearest van is no use if the engineer in it can't touch the meter," she said.
4. **The list still has a place.** She liked the board prototype, especially the colour for overrunning jobs, but asked for the old list to stay one click away for the night shift, when there are only six engineers to place.

## Feedback logged

| Feedback | Account | Type | Summary | Addressed by |
|---|---|---|---|---|
| FB-3218 | Brackwater Gas Networks | feature request | Drag an emergency job from one engineer to another on the map | Drag-to-Reassign |
| FB-3219 | Brackwater Gas Networks | complaint | Customer arrival times are not updated after a job is reassigned | Technician ETA Sharing |
| FB-3220 | Brackwater Gas Networks | feature request | Show each engineer's certifications on the map | none yet |

## What it means for the roadmap

Drag-to-Reassign depends on Live Dispatch Board, since there is nothing to drag until the map exists. Live Dispatch Board is measured by time to reassign, which Sunniva put at about eight minutes for an emergency today. Technician ETA Sharing, a fast-follow that sends the new engineer's arrival time to the customer, is measured by ETA complaint rate.

EXP-230, a prototype test with five Brackwater dispatchers in December, tests Drag-to-Reassign. It measures time to reassign against the current phone process, with the paper map as the baseline.

Live Dispatch Board does not address FB-3220 as designed: the certification layer has no owner yet, and the squad will raise it at the next planning review. If the routing vendor's API allows it, Technician ETA Sharing would ship in Release 26.5 alongside the board. Sunniva thought Drag-to-Reassign might also suit the Field Technician persona, for swapping jobs between colleagues on site, but we did not test that idea.

## Follow-ups

- Owen Fairley to link FB-3218, FB-3219 and FB-3220 to the Dispatcher Workspace epic in the roadmap tool.
- Priyanka Dass to recruit two more dispatch supervisors, from mid-market accounts, before EXP-230 begins.
- Share the night-shift finding with the Dispatch squad at Thursday's review.
