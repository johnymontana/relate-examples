---
domain: manufacturing
genre: 8D quality report
synthetic: true
note: Written for example 01 of relate-examples, under its curated Manufacturing ontology, after create-context-graph's quality audit template (707b168). Every person, company, plant, part, lot, machine and report number is fictional; Brighouse, Selby and Barnsley, the 8D method and the die-casting and leak-test vocabulary are real.
---

# 8D report 8D-26-014: oil leaks through the HG40 pump body

**From:** Rachel Okonkwo, Quality Engineering, Calder Bridge Plant · **To:** Plant Quality Review; Brackenfold Diecasting Ltd · **Date:** 20 November 2026 · **Reference:** 8D-26-014, covering NCR-2026-0412 and NCR-2026-0415

## Summary

On 14 October 2026 a customer found hydraulic oil weeping from the body of three HG40 gear pumps on its tractor line in Selby. The leak path is gas porosity in the pump body casting, opened up where the relief-valve bore is machined. The porosity came from a failing vacuum valve at the casting supplier, and our end-of-line leak test let the leakers through because its test time had been shortened in August. All suspect stock is contained, both causes have permanent actions in place, and we ask the review to close this 8D when the 60-day verification ends on 15 January 2027.

## D1: Team

| Member | Role in the 8D | Function |
|---|---|---|
| Rachel Okonkwo | Team leader | Quality engineer |
| Tom Ashworth | Supplier root cause | Supplier quality engineer |
| Imran Sadiq | Leak test and machining | Manufacturing engineer |
| Gareth Lloyd | Equipment condition | Maintenance engineer |
| Kasia Wróbel | Containment re-test | Leak-test operator |
| Neil Fairbank | Casting process | Process engineer, Brackenfold Diecasting Ltd |

Rachel Okonkwo, Tom Ashworth, Imran Sadiq and Gareth Lloyd work at Calder Bridge Plant, the company's gear pump plant in Brighouse. Line 3, which machines the pump bodies, and Line 5, which assembles and tests the pumps, are both located at Calder Bridge Plant.

## D2: Problem description

NCR-2026-0412 was reported by Fenmoor Tractors Ltd on 14 October 2026, after three pumps failed the customer's 250 bar circuit test. The three pumps came from L26-1003, a lot of 480 HG40 gear pumps (part 51240-00) built on 3 October and shipped to Fenmoor Tractors Ltd on 6 October. NCR-2026-0412 was found in L26-1003, and in every case the leak sat at the relief-valve boss.

The pump bodies in that lot all came from one casting lot. L26-1003 was built from L26-0917. L26-1008, a lot of 520 HG40 gear pumps built on 8 October, was also built from L26-0917. L26-1008 was shipped to Aldwick Compact Equipment Ltd on 10 October; none of L26-1008 was shipped to Fenmoor Tractors Ltd.

L26-0917 is a lot of 1,200 pump body castings of part 30418-02. Brackenfold Diecasting Ltd supplies 30418-02 to us as a single source. L26-0917 was delivered by Brackenfold on 22 September and was machined on MC-412 from 24 September. MC-412, the horizontal machining centre on Line 3, bores the relief-valve seat through the thickest section of the casting. Sectioning of the returned pumps showed rounded gas pores of 0.3 to 0.8 mm in the wall between that bore and the outside face.

## D3: Containment

On 16 October 2026, NCR-2026-0415 was detected at LT-107, the end-of-line leak tester on Line 5, during the re-test of the 308 pumps of L26-1008 still in our finished-goods store. Kasia Wróbel, who operates LT-107, ran every pump at the original 18-second test time and found five leakers. NCR-2026-0415 was found in L26-1008.

| Lot | Location | Suspect stock | Re-tested | Leakers |
|---|---|---|---|---|
| L26-1003 | Fenmoor Tractors Ltd, Selby | 477 pumps | 477 | 4 |
| L26-1008 | Aldwick Compact Equipment Ltd | 212 pumps | 212 | 2 |
| L26-1008 | Calder Bridge Plant | 308 pumps | 308 | 5 |
| L26-0917 | Calder Bridge Plant stores | 190 castings | not tested | returned to supplier |

CA-1187 and CA-1188 address NCR-2026-0412. CA-1187, the quarantine and re-test of everything built from L26-0917, is owned by Rachel Okonkwo. CA-1188 covered the third-party sort of the stock at Selby and at Aldwick. Tom Ashworth arranged it with the customers and owns it until both have signed off. The eleven leakers found in containment have been scrapped, and no complaint has been received since 21 October.

## D4: Root cause

**Occurrence.** Brackenfold cast the whole lot on DC-104, a 900-tonne cold-chamber machine with vacuum assist, on 15 and 16 September. Neil Fairbank's shot records show that the machine's vacuum shut-off valve was sticking from 14 September, so the die cavity reached only 180 mbar against a limit of 60 mbar, and the trapped air formed porosity in the last section to fill, the relief-valve boss. The vacuum alarm on the cell had been bypassed in August after a sensor fault and was never reinstated. NCR-2026-0412 was attributed to Brackenfold Diecasting Ltd on 28 October, and Brackenfold accepted the finding the same day.

Machining did not create the porosity, but it exposed it. MC-412 machined every casting in the lot to drawing and within its capability. Darren Pike, who runs it on the night shift, recorded no tool breaks and no change of coolant.

**Escape.** LT-107 runs a pressure-decay test at 6 bar with a reject limit of 0.8 cm³/min. In August the test time was cut from 18 to 11 seconds to relieve a bottleneck on Line 5, and the trial that approved the change used no leak master below 2 cm³/min. At 11 seconds, a leak of 0.5 to 1 cm³/min passes. Gareth Lloyd maintains LT-107 and confirmed that the tester was calibrated and its seals were sound: the fault lay in the change, not the equipment.

## D5 and D6: Permanent corrective actions

| Action | Type | What | Owner | Status |
|---|---|---|---|---|
| CA-1192 | corrective | Restore the 18-second test time on LT-107 and check a 0.8 cm³/min leak master at every shift start | Imran Sadiq | verified 6 Nov |
| CA-1193 | corrective | Replace the vacuum valve on DC-104 and interlock the vacuum alarm so the cell stops | Tom Ashworth | implemented 30 Oct |
| CA-1195 | preventive | X-ray five castings from every lot of 30418-02 at goods-in | Tom Ashworth | open, due 15 Dec |

CA-1192 addresses NCR-2026-0415, the escape, while CA-1193 and CA-1195 address NCR-2026-0412. Since 6 November, LT-107 has tested 3,940 pumps at 18 seconds with no leak complaint from either customer, and the three lots of castings delivered since the repair have passed X-ray. CA-1195 is expected to be closed on 15 December 2026, once six lots in a row have passed.

## D7: Preventing recurrence

- The PFMEA for the pump body now rates porosity at the relief-valve boss, and the control plan adds the X-ray check.
- Any change to a leak-test time now needs a trial with a leak master at the reject limit before release.
- Brackenfold Diecasting Ltd also supplies 30419-01, the HG40 rear cover, which runs on the same cell and has been added to the X-ray check.
- CA-1196, a second leak tester for Line 5, will be owned by Gareth Lloyd once the capital request is approved.

## What the record does not show

- Brackenfold believes L26-0921 may also have been cast on DC-104 before the valve was replaced; the lot is on hold at goods-in until it has been X-rayed.
- An interim issue of this report said that NCR-2026-0415 was detected at MC-412; that was a transcription error.

## D8: Closure

The team thanks Kasia Wróbel and the Line 5 night shift for re-testing 308 pumps in one weekend. We ask the Plant Quality Review to close 8D-26-014 on 15 January 2027 if no leak complaint has been received for HG40 pumps built after 6 November.
