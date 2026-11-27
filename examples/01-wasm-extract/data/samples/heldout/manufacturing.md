---
domain: manufacturing
genre: maintenance log summary
synthetic: true
note: Written for example 01 of relate-examples, under its curated Manufacturing ontology, after create-context-graph's maintenance log template (707b168); held out from the page. Every person, company, plant, part, lot, machine and report number is fictional; Rotherham and the press-shop vocabulary are real.
---

# Maintenance log summary: Line 2, October 2026

**From:** Priti Desai, Maintenance · **To:** Production and quality leads, Northgate Plant · **Date:** 4 November 2026 · **Period:** 1 to 31 October 2026

## The line

Line 2 is the press and weld line at Northgate Plant, the group's bracket and tank plant in Rotherham. It runs three shifts, five days a week, and makes the steel mounting brackets that the pump plants fit to their gear pumps. PR-201, a 630-tonne servo press, and PR-202, a 400-tonne transfer press, are installed on Line 2, together with RW-210, a twin-robot weld cell, and VS-215, the camera inspection station at the end of the line.

Priti Desai and Stuart Hale, the two maintenance engineers for the line, both work at Northgate Plant. Stuart Hale maintains PR-201 and PR-202; Priti Desai maintains RW-210 and VS-215.

## Availability

| Machine | Planned hours | Downtime, hours | Availability | Main cause |
|---|---|---|---|---|
| PR-201 | 352 | 6.5 | 98.2% | die change overran |
| PR-202 | 352 | 21.0 | 94.0% | cracked die insert, servo amplifier |
| RW-210 | 352 | 4.0 | 98.9% | torch cable |
| VS-215 | 352 | 1.5 | 99.6% | lens cleaning |

Line availability was 93.1% against a target of 95%, almost all of the shortfall on PR-202.

## Planned maintenance

- PR-201: annual hydraulic and clutch-brake service on 11 October, with the overload system tested at 110%.
- RW-210: 2,000-hour service on both robots, new torch liners and a replacement torch cable on robot 2.
- VS-215: camera recalibration on 20 October after the drawing change to the bracket's slot width.
- PR-202: lubrication and transfer-finger inspection, carried out on schedule each Friday.

## Breakdowns

On 9 October at 14:20, VS-215 began rejecting brackets for a burr on the mounting hole, 46 of them in twenty minutes. NCR-2026-0398, raised on 9 October 2026, was detected at VS-215 that afternoon. NCR-2026-0398 was found in L26-0988, a lot of 4,000 brackets of part 41207-03. L26-0988 was pressed on PR-202 from the start of the early shift.

Jade Kirby, the setter-operator on PR-202, stopped the press at 14:45. Stuart Hale found a crack across the piercing insert at station 3 of the die and fitted a spare insert, part 77310-14, from stores. Harrowgate Tool & Die Ltd supplies 77310-14 and has two more on order for us. PR-202 was back in production at 23:10, after 8.5 hours down.

CA-1179 addresses NCR-2026-0398. It adds a crack check of the piercing inserts at every die change and a hit counter that stops the press at 250,000 strokes, and CA-1179 was implemented on PR-202 on 14 October. CA-1179 is owned by Stuart Hale.

The second stoppage on PR-202, on 22 October, lasted 12.5 hours while a replacement servo amplifier came from the press maker. No parts were affected.

## Quality impact

The 1,260 brackets of L26-0988 made before the press stopped were sorted on 10 October: 212 were reworked by deburring and 58 were scrapped. L26-0988 was released on 12 October. Records do not show whether L26-0985 was pressed on PR-202 or on PR-201 that morning, so it was sorted as a precaution and found clean.

## Next month

- CA-1183, the same crack check for the insert holders, will be implemented on PR-201 during the December shutdown.
- The torch cable on robot 1 of RW-210 is showing wear and will be changed at the next service.
- Spare servo amplifiers are to be held in stores for both presses.
