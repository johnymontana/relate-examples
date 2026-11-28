---
domain: data-journalism
genre: fact-check report
synthetic: true
note: Written for example 01 of relate-examples, under its curated Data Journalism ontology, after create-context-graph's fact-check report template (707b168). Every person, newsroom, company, city office, claim, dataset, record, story and reference is fictional, the city of Port Ellery included; Oregon and its public records law are real.
---

# Fact-check report: the mayor's pothole numbers

**From:** Renata Szabo, data desk · **To:** Alan Petrakis, standards editor · **Date:** November 24, 2026 · **Reference:** FCR-26-118

## Summary

Mayor Graham Whitlow made FC-26-0193, FC-26-0194 and FC-26-0195 at his budget briefing on March 3, and he repeated all three in his State of the City address on September 14. Our March 4 story, “Pothole repairs double in a year, city says”, repeated FC-26-0194 and FC-26-0195 as fact. We tested each claim against the city's own data. One holds up on its own terms, one is misleading, and one is false.

| Claim | Statement | Checked by | Rating |
|---|---|---|---|
| FC-26-0193 | "We filled 41,000 potholes last year" | Renata Szabo | Mostly accurate |
| FC-26-0194 | "That is more than double what the last administration managed" | Renata Szabo | Misleading |
| FC-26-0195 | "Every pothole reported to 311 was fixed within 72 hours" | Owen Mbeki | False |

## The data

We built the checks on three datasets, each covering 2022 to 2025.

| Dataset | Provided by | Received | Rows |
|---|---|---|---|
| DPW Work Order Database | Port Ellery Department of Public Works | October 16, 2026 | 118,604 |
| Asphalt Purchasing Ledger | Port Ellery Department of Public Works | October 16, 2026 | 2,311 |
| 311 Service Request Archive | Nadia Kowalczyk | October 9, 2026 | 96,420 |

Renata Szabo obtained the DPW Work Order Database and the Asphalt Purchasing Ledger through a public records request filed on October 2 under Oregon's public records law. The department released both files in full. Nadia Kowalczyk, the city's chief data officer, sent the 311 archive as a complete extract, with the field definitions that the public portal leaves out. Owen Mbeki rebuilt every count in this report from the raw files, and the code is in the desk's repository.

## FC-26-0193: "We filled 41,000 potholes last year"

FC-26-0193 is based on the 2025 Streets Annual Report, which the department published in February. The DPW Work Order Database supports FC-26-0193: it lists 41,212 pothole jobs closed in 2025.

The number is right, but it counts something different from what it counted three years ago. In January 2024 the department began logging each pothole as its own work order; before that, a crew logged one order per block. Work order WO-25-031877, one entry in the DPW Work Order Database, shows the effect: it is the first of fourteen orders raised for a single block of Harbor Street on May 6, 2025, all filled by one crew in one morning.

**Rating: Mostly accurate.** The count is correct as the department now keeps it.

## FC-26-0194: "More than double"

The comparison does not survive the change in counting. Counted the old way, one order per block, the database shows 19,870 jobs in 2022 and 23,950 in 2025, a rise of 21 percent.

The Asphalt Purchasing Ledger contradicts FC-26-0194 as well. The city bought 1,940 tons of patching asphalt in 2022 and 2,310 tons in 2025: more material, but nowhere near twice as much.

**Rating: Misleading.** More potholes were filled, but the doubling comes from the new way of counting them.

## FC-26-0195: "Within 72 hours"

Imani Brooks, a spokesperson for Graham Whitlow, said the mayor took the figure from the city's contract. FC-26-0195 rests on Contract PW-24-117, the pothole-repair contract with Ridgeline Paving, which requires a reported pothole to be filled within 72 hours. A contract standard is a promise, not a result.

FC-26-0195 is contradicted by the 311 Service Request Archive. Of 31,880 pothole reports in 2025, 12,114 (38 percent) were closed within 72 hours, and the median report took 6.4 days to close. Imani Brooks argues that the 311 Service Request Archive supports FC-26-0195 once duplicate reports of the same pothole are set aside. We set them aside, and the share closed within 72 hours rose only to 44 percent.

**Rating: False.**

## How the March 4 story went wrong

“Pothole repairs double in a year, city says” was written by Tomás Ibarra and edited by Joan Ferreira, the metro editor. It quoted Imani Brooks and nobody at the department. Tomás Ibarra may have checked FC-26-0195 with DPW before the story ran, but his notes do not show it.

Correction C-26-041 was appended to “Pothole repairs double in a year, city says” on November 18, 2026. Alan Petrakis issued it after a reader sent us the department's own response-time dashboard. The correction withdraws the 72-hour line; the headline's "double" stands until this report runs.

## The Paved Over investigation

This check grew out of the Paved Over investigation, led by Keisha Montgomery. Its subject is Ridgeline Paving, which holds six of the city's paving contracts, Contract PW-24-117 among them. “One firm, six contracts”, the first Paved Over story, ran on June 9 under Keisha Montgomery's byline and quoted Victor Haldane, an independent pavement engineer, on how rarely the city enforces the 72-hour standard. Victor Haldane does not speak for Ridgeline Paving; he last consulted for the company in 2019. If the ledger's delivery dates do not match the contractor's invoices, the Paved Over investigation would extend to Calder Asphalt Supply, the contractor's asphalt supplier.

## Limits of this check

- An earlier draft of this report said that Contract PW-24-117 is an entry in the DPW Work Order Database; it is not, and the contract sits in the city's procurement system.
- FC-26-0196, the mayor's newer claim about sidewalk repairs, is expected to be checked by Owen Mbeki in December and is likely to be rated Misleading.
- We could not establish whether the 2025 Streets Annual Report counts orders closed or orders raised, and the department has not said.

## Recommendations

1. Publish the three ratings on November 27, with the datasets and our code linked.
2. Add a line to C-26-041 once the ratings run, so that readers of the March 4 story can find them.
3. Check any figure from the mayor's office against the DPW Work Order Database, counted both ways, before it runs.
4. Share the counting change with Keisha Montgomery before the next Paved Over story.
