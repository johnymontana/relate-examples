---
domain: digital-twin
genre: root-cause analysis report
synthetic: true
note: Written for example 01 of relate-examples, under its curated Digital Twin ontology, after create-context-graph's maintenance log and alert digest templates (707b168). Every person, plant, asset, sensor, twin, alert and work order is fictional; Teesside, ISO 14224 and its failure-mode codes are real.
---

# Root cause analysis: trip and seal leak on cooling water pump P-301B

**From:** Morag Ellison, Reliability Engineering · **To:** Unit 3 operations and maintenance leads · **Date:** 2 April 2026 · **Reference:** RCA-2026-007

## Summary

At 02:47 on 14 March 2026, cooling water pump P-301B tripped on high vibration, and its mechanical seal leaked cooling water onto the pump plinth. The standby pump started automatically, header pressure held, and reactors R-301 and R-302 never lost cooling. Nobody was hurt and nothing left site.

The failure began eleven weeks earlier, when the pump's flexible coupling was replaced and the pump went back into service without a laser alignment check. The pump's digital twin, DT-0417, saw the result twelve days before the trip. Its first alert was acknowledged and closed as instrument noise, and no work order followed.

## The plant, the system and the pump

Greythorpe Works is a speciality chemicals plant on Teesside. The Unit 3 Cooling Water System (CW-3) belongs to Greythorpe Works and supplies jacket cooling to the Unit 3 reactors. P-301A and P-301B are part of CW-3, as is E-310, the plate heat exchanger they supply. P-301B is the duty pump and feeds E-310 through the common discharge header; P-301A, the standby, feeds E-310 through the same header when it runs. E-310 in turn feeds cooled jacket water to R-301 and R-302.

P-301B is a single-stage end-suction centrifugal pump rated at 420 m³/h and driven by a 132 kW motor. The drive-end bearing, the mechanical seal, the impeller and the flexible coupling of P-301B are the components this review is concerned with.

Four sensors monitor P-301B and stream to the plant historian at one-second resolution: VT-3012 and TT-3014 on the drive-end bearing housing, PT-3010 on the suction branch and LT-3016 on the seal pot.

P-301B's digital twin runs on the site's asset performance platform. DT-0417 mirrors P-301B with a hybrid model: a physics-based model of the pump's head–flow curve and a data-driven model of its bearing temperature and vibration, trained on eighteen months of healthy running. DT-0416 mirrors P-301A in the same way.

## What the twin saw

| Alert | Raised | Type | Triggered by | Reading |
|---|---|---|---|---|
| AL-20931 | 2 Mar 2026, 06:10 | anomaly | VT-3012 | 2.9 mm/s RMS against 2.1 predicted |
| AL-20988 | 9 Mar 2026, 14:32 | anomaly | TT-3014 | 71 °C against 65 °C predicted |
| AL-21010 | 14 Mar 2026, 02:47 | trip | VT-3012 | 11.2 mm/s RMS, trip limit 9.0 |
| AL-21012 | 14 Mar 2026, 02:55 | alarm | LT-3016 | seal pot level 18%, alarm limit 30% |

On 2 March, DT-0417 raised AL-20931 when the drive-end vibration drifted 38% above the twin's prediction, though still well below the 7.1 mm/s alarm limit. AL-20931 indicated bearing fatigue at the drive end, with a diagnostic confidence of 0.62. The shift supervisor acknowledged the alert that morning and closed it as instrument noise.

Seven days later the twin raised AL-20988, because at constant load the bearing temperature ran 6 °C above prediction. AL-20988 indicated bearing fatigue as well, and it too was acknowledged without a work order.

At 02:41 on 14 March the vibration began to climb steeply. VT-3012 triggered AL-21010, the high-high vibration trip, six minutes later, and P-301A took over. LT-3016 triggered AL-21012 at 02:55 as the seal pot drained. That alarm indicated external leakage at the seal.

## Inspection findings

WO-418207 was raised against P-301B on 14 March and addressed AL-21010. Ewan Harcourt and Sunita Bhatt, both based at Greythorpe Works, carried out WO-418207 over the next two days.

Before the strip-down, a laser alignment check found 0.42 mm of parallel offset across the flexible coupling against a tolerance of 0.05 mm: shaft misalignment, eight times the limit.

- The drive-end bearing suffered bearing fatigue, with spalling over a third of the outer race and a wear band offset towards the motor, the pattern a misaligned shaft leaves.
- The mechanical seal suffered seal face damage: the carbon face was chipped at its outer edge and the silicon carbide seat was heat-checked.
- The impeller showed no sign of cavitation, and its wear rings were within tolerance.

WO-418207 replaced the drive-end bearing and the mechanical seal, and Ewan Harcourt realigned the pump to 0.03 mm before it went back to standby duty.

## The failure chain

The flexible coupling was replaced on 28 December 2025 under WO-417733, after the original elastomer element hardened. The job was carried out by Liam Doherty, a contract fitter, on a night shift; the job card records the coupling as fitted but holds no alignment readings.

The review panel traced the chain from that job to the trip:

1. The shaft misalignment led to bearing fatigue, because the offset loaded the drive-end bearing at roughly twice its design load.
2. In turn, bearing fatigue led to seal face damage, as the vibration from the spalled race opened the seal faces at every revolution.
3. Finally, seal face damage led to external leakage (ELP in ISO 14224), which drained the seal pot.

## What we ruled out

Operations suggested that cavitation might have led to the bearing fatigue, but the suction pressure from PT-3010 never fell below the pump's NPSH requirement. An early draft of the incident report said that WO-417733 addressed AL-20931; it did not, since the job closed nine weeks before the alert.

## Work orders

| Work order | Raised | Asset | Type | Status |
|---|---|---|---|---|
| WO-417733 | 22 Dec 2025 | P-301B | corrective | closed 28 Dec 2025 |
| WO-418207 | 14 Mar 2026 | P-301B | corrective | closed 16 Mar 2026 |
| WO-418240 | 18 Mar 2026 | P-301A | inspection | open |

## Actions

1. Make a laser alignment record a mandatory step on every coupling or bearing work order, and refuse closure without one.
2. Route every twin anomaly alert on a critical pump to the reliability engineer as well as the control room, and require a work order or a written reason before an alert is closed.
3. WO-418240, an alignment check on P-301A, is expected to be carried out by Sunita Bhatt in April and to be closed on 30 April 2026.
4. Retrain the bearing model in DT-0417 on post-repair data, and review the limits in DT-0416 against the same baseline.
