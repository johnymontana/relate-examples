---
domain: scientific-research
genre: grant progress report
synthetic: true
note: Written for example 01 of relate-examples, under its curated Scientific Research ontology, after create-context-graph's grant proposal and experiment log templates (707b168). Every person, institution, funder, grant, instrument, dataset, paper, venue, DOI and result is fictional; the cities, the methods, the test conditions and the materials are real.
---

# DuraTandem: year-two progress report

**From:** Dr Ines Halloran, principal investigator · **To:** Grants Committee, Aurelian Energy Foundation · **Date:** 16 October 2026 · **Reference:** AEF-2024-118, report 2 of 3

## Summary

DuraTandem asks whether perovskite–silicon tandem solar cells can last long enough in the damp, cool and often overcast climate of northern Europe to be worth building. Year two has gone broadly to plan. The Damp-Heat Study is complete and its main result has been reproduced by our industrial partner. The Outdoor Tracking Trial has logged twelve months on a Sunderland rooftop, and two papers have appeared. Spend at 30 September 2026 was £742,300 of the £1,240,000 award, 2% behind profile.

## The grant and the team

Grant AEF-2024-118, worth £1,240,000, was awarded by the Aurelian Energy Foundation in July 2024, and it is held at the University of Wearmouth. The term of AEF-2024-118 starts on 1 October 2024 and runs for 36 months. DuraTandem is led by Dr Ines Halloran, a reader in physics at the University of Wearmouth. Prof Tomasz Wierzbicki of the Ashworth Materials Institute in Manchester is a co-investigator on AEF-2024-118 and leads its computational work.

The research staff in year two were:

- Dr Amara Osei, a postdoctoral researcher at the University of Wearmouth, who runs the ageing work;
- Lukas Brandt, a PhD student at the University of Wearmouth, who runs the outdoor work;
- Dr Mei-Ling Cho, a computational scientist at the Ashworth Materials Institute, who joined in January 2025.

Our industrial partner is Solenne Photovoltaics Ltd in Gateshead, where Dr Rhys Penhallow is reliability lead. A second award supports the outdoor work: TCET-2025-031, an equipment grant of £86,000 from the Tyne Clean Energy Trust, which is also held at the University of Wearmouth. Dr Halloran is principal investigator on both awards.

## Experiments in year two

| Experiment | Work package | Funded by | Status at 30 September 2026 |
|---|---|---|---|
| Cation Screening Study | WP1 | AEF-2024-118 | complete |
| Damp-Heat Study | WP2 | AEF-2024-118 | complete |
| Solenne Repeat Study | WP2 | the partner's own funds | complete |
| Outdoor Tracking Trial | WP3 | AEF-2024-118 and TCET-2025-031 | in progress (month 12 of 24) |

### WP1: cation screening

The Cation Screening Study, conducted by Dr Mei-Ling Cho, used density functional theory (DFT) to rank 1,240 caesium–formamidinium–rubidium compositions by their predicted resistance to hydration. The calculations took 410,000 core-hours on the Kittiwake cluster, which the Ashworth Materials Institute runs for its own groups and their partners. The CsFA Cation Library, produced by the Cation Screening Study, lists the formation energy and hydration barrier of every composition, and it narrowed the candidates for WP2 from twelve to four.

### WP2: damp-heat ageing and its replication

The Damp-Heat Study, run by Dr Amara Osei, used damp-heat testing to age 412 encapsulated tandem cells at 85 °C and 85% relative humidity for 1,000 hours in the Tern climate chamber. The chamber held its set point to within 0.5 °C for the whole run. At each 250-hour interval the Damp-Heat Study measured the cells by X-ray diffraction (XRD) on the Osprey diffractometer and by photoluminescence mapping, to follow phase segregation in the perovskite top cell.

Cells with 15% caesium lost 6.1% of their initial power conversion efficiency over 1,000 hours, against 23.4% for the year-one baseline, and showed no iodide-rich phase in XRD. The Damp-Heat Study produced TandemAge-DH, which holds every current–voltage curve, diffraction pattern and photoluminescence map from the run.

To test whether the result depends on our encapsulation, our partner repeated the comparison on cells from its pilot line in Gateshead. The Solenne Repeat Study, conducted by Dr Rhys Penhallow between March and June 2026, replicated the Damp-Heat Study and measured a loss of 6.8% for the 15% caesium cells, within the uncertainty of our own figure. The Solenne Repeat Study did not use the Osprey diffractometer. Solenne characterised its cells by photoluminescence mapping alone, on its own equipment.

### WP3: outdoor tracking

Lukas Brandt has conducted the Outdoor Tracking Trial since October 2025 on the Fulmar rooftop rig, which TCET-2025-031 paid for. The Outdoor Tracking Trial uses maximum power point tracking (MPPT) to hold 24 tandem modules and six silicon reference modules at their maximum power point, logging power, irradiance and module temperature every minute. Its first twelve months, October 2025 to September 2026, are released as TandemAge-Outdoor.

The tandem modules lost 4.2% of their energy yield over the year, most of it in the first winter, while the silicon references lost 0.6%. We cannot yet say whether the Outdoor Tracking Trial replicates the Damp-Heat Study in the field: the outdoor losses are smaller so far and may have a different cause.

## Instruments

| Instrument | Type | Housed at | Use in year two |
|---|---|---|---|
| Tern climate chamber | climate chamber | University of Wearmouth | 1,000 h at 85 °C and 85% RH |
| Osprey diffractometer | diffractometer | University of Wearmouth | 96 h of scans |
| Fulmar rooftop rig | outdoor test rig | University of Wearmouth | 12 months of logging |
| Kittiwake cluster | computing cluster | Ashworth Materials Institute | 410,000 core-hours |

## Data outputs

| Dataset | Contents | Size | Access |
|---|---|---|---|
| TandemAge-DH | J–V curves, diffraction patterns and PL maps from 1,000 h of damp heat | 1.8 TB | open, CC BY 4.0 |
| TandemAge-Outdoor | one-minute logs of power, irradiance and temperature | 42 GB | open, CC BY 4.0 |
| CsFA Cation Library | formation energies and hydration barriers for 1,240 compositions | 6 GB | embargoed until the WP1 paper is accepted |

## Publications

| Paper | Venue | Date | DOI | Acknowledges |
|---|---|---|---|---|
| Phase segregation in caesium-rich perovskites under damp heat | Solar Materials Letters | November 2025 | 10.5555/sml.2025.04117 | AEF-2024-118 |
| Outdoor stability of perovskite–silicon tandems in a northern climate | Northern Photovoltaics Conference 2026 | June 2026 | 10.5555/npvc.2026.0212 | AEF-2024-118, TCET-2025-031 |

Osei et al. (2025), written by Amara Osei with Ines Halloran and Tomasz Wierzbicki, reports the Damp-Heat Study and analyses TandemAge-DH. Osei et al. (2025) cites Halloran et al. (2023), the paper that first made the case for caesium-rich compositions in humid climates. Our year-one report listed Dr Mei-Ling Cho as an author of Osei et al. (2025); that was an error, and she is thanked in its acknowledgements instead.

Brandt et al. (2026), by Lukas Brandt and Ines Halloran, was presented at the Northern Photovoltaics Conference in Glasgow in June 2026. Brandt et al. (2026) reports the first eight months of the Outdoor Tracking Trial, uses TandemAge-DH as its laboratory baseline and cites Osei et al. (2025).

A third manuscript, Mixed-cation stability maps from first principles, drafted by Mei-Ling Cho and Tomasz Wierzbicki, will be submitted to Photovoltaic Reliability Reports in December 2026.

## Deviations and risks

- The Fulmar rooftop rig was commissioned three months late because of a roofing permit, so the first year of WP3 ends in September rather than June.
- Dr Mei-Ling Cho's contract ends in March 2027; the Ashworth Materials Institute has agreed to extend it from its own funds if WP1 needs more time.
- If the Aurelian Energy Foundation awards AEF-2026-207, our follow-on application for £1,480,000, it would fund the Outdoor Tracking Trial through two further winters.

## Plans for year three

1. Extend the damp-heat ageing of the four best compositions to 2,000 hours.
2. Run a second winter of outdoor tracking and add two bifacial modules to the rig.
3. Submit the WP1 manuscript and release the CsFA Cation Library once it is accepted.
4. Agree a data-sharing plan with Solenne Photovoltaics Ltd before any further repeat work.
