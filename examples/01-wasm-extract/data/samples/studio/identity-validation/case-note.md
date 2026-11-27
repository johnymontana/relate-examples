---
domain: identity-validation
genre: fraud analyst case note
synthetic: true
note: Written for example 01 of relate-examples from the identity records in the sample data of Neo4j's identity-validation package (studio-agent-use-cases at b76f767). Every person, record, phone number, SSN, email address, street address and date-of-birth hash is synthetic, as the package's are, and masked as the package masks them; the cities, states and ZIP codes are real, and the IP addresses come from the documentation ranges.
---

# Case note FC-2026-1147: a synthetic-identity cluster of three near-duplicate SSN pairs

**From:** Application Fraud Analytics · **To:** Fraud Operations, application review · **Date:** 19 November 2026 · **Case:** FC-2026-1147 · **Status:** open, six applications on hold

## Summary

Six profile records, captured through two channels, form three pairs. In each pair the two records share one phone number and declare SSNs that differ by a single digit. A reused contact detail beside a perturbed SSN is the signature of a synthetic identity: the second record borrows enough of the first to pass contact verification, while its SSN never collides with the first under exact-match deduplication. Our confidence-scored match report ranked none of the three pairs above 1, because exact matching sees only the shared phone. The near-duplicate SSN check found all three. We recommend holding all six applications for documentary verification.

## How the cluster surfaced

The weekly near-duplicate SSN run on 17 November 2026 returned three pairs, each corroborated by a shared phone number. The placeholder flags were applied first, so the filler email that ID-4002 and ID-5001 both carry played no part in any match. All names below are in the masked display form the identity graph holds.

| Record | Source system | Name on record | Phone | SSN |
|---|---|---|---|---|
| ID-7001 | Ecommerce | Carlos M***z | 555-904-9125 | XXX-XX-4598 |
| ID-7002 | CallCenter | Carla M***z | 555-904-9125 | XXX-XX-4508 |
| ID-7003 | Ecommerce | Tyler B***n | 555-711-6482 | XXX-XX-8517 |
| ID-7004 | CallCenter | Taylor B***n | 555-711-6482 | XXX-XX-8017 |
| ID-4001 | Ecommerce | David K** | 555-334-6689 | XXX-XX-4821 |
| ID-4002 | CallCenter | Daniel K** | 555-334-6689 | XXX-XX-4831 |

In every pair the Ecommerce record came first and the CallCenter record followed within six weeks.

## Pair 1: ID-7001 and ID-7002

ID-7001, an Ecommerce application in the name of Carlos M***z, uses the email will***@maild.net and was submitted from 198.51.100.55. Five weeks later the CallCenter channel took an application for Carla M***z, ID-7002, reachable on the same number, 555-904-9125. ID-7002 declares XXX-XX-4508, one digit away from the XXX-XX-4598 that ID-7001 declares. Its email, trac***@maild.net, and its IP address, 203.0.113.168, are its own.

The two records give different birth years. ID-7001 carries the DOB hash 74c352df9e9cea5f, a 1995 birth year, and ID-7002 carries bcbc7f5f7770720a, a 1970 one. ID-7002 is registered at 1085 Martin Knoll in Portland, OR 97201, more than 2,000 miles from the address on ID-7001. The names are a near-miss as well: Carlos M***z and Carla M***z score 0.948 on our name-similarity check, which corroborates the link but would not establish it alone.

## Pair 2: ID-7003 and ID-7004

The second pair repeats the pattern with one swapped digit. Tyler B***n is the name on ID-7003, which declares XXX-XX-8517. The CallCenter record ID-7004, in the name of Taylor B***n, declares XXX-XX-8017, and both records are reachable on 555-711-6482. Tyler B***n and Taylor B***n score 0.923. The other attributes differ:

- ID-7003 is registered at 9198 Frank Light in Nashville, TN 37206, uses eliz***@maild.net and was submitted from 192.0.2.57.
- ID-7004 is registered at 9578 Mayo Route in Columbus, OH 43201, uses lync***@maild.net and was submitted from 198.51.100.36.
- ID-7004 carries the DOB hash e3a6cd9ef212dc10, a 1973 birth year.

The date of birth on ID-7003, hash be117fe32bbe744b, also appears on ID-9120, a separate Ecommerce record for Tyler S***g in Sacramento. ID-9120 shares nothing else with the cluster. A shared birth date is a descriptor rather than an identifier, so we have left ID-9120 out of the holds.

## Pair 3: ID-4001 and ID-4002

The third pair is the closest of the three. David K** applied through Ecommerce as ID-4001, and Daniel K** called in as ID-4002 eleven days later; the two names score 0.861. ID-4001 uses dkim***@maild.net, while ID-4002 holds only the placeholder our call-center system stores when a caller declines to give an email. ID-4001 was submitted from 203.0.113.150 and ID-4002 from 203.0.113.164. ID-4001 carries the DOB hash b04b901304439730 and ID-4002 carries b7013fdfeabe2f2b, so the birth dates differ too. Both addresses are in the 78704 ZIP code of Austin.

## Addresses and geocoding

We geocoded every address in the cluster before scoring proximity. Each address on a record geocodes to one point:

| Record | Street address | City | State | ZIP | Geocoded point |
|---|---|---|---|---|---|
| ID-7001 | 5169 Ramirez Roads | Columbus | OH | 43201 | 40.003812,-82.996425 |
| ID-7002 | 1085 Martin Knoll | Portland | OR | 97201 | 45.511028,-122.664973 |
| ID-7003 | 9198 Frank Light | Nashville | TN | 37206 | 36.179878,-86.736247 |
| ID-7004 | 9578 Mayo Route | Columbus | OH | 43201 | 40.002002,-82.99728 |
| ID-4001 | 19 Birchwood Ct | Austin | TX | 78704 | 30.2422,-97.7618 |
| ID-4002 | 340 Sunset Blvd | Austin | TX | 78704 | 30.2438,-97.7601 |

The two Austin points are about 242 meters apart, close enough to corroborate pair 3 under our 500-meter rule. 9578 Mayo Route geocodes to a point about 210 meters from the one on ID-7001, although ID-7004 and ID-7001 are in different pairs and share no identifier.

## What we could not establish

Several points in the file do not hold up, and we have left them out of the pattern above:

- ID-7004 may also have been submitted from 198.51.100.55, the IP address behind ID-7001, but the session logs for that week were rotated before we could check.
- An earlier triage note that ID-7001 declares XXX-XX-4508 was a transcription error and has been corrected.
- ID-4002 does not use dkim***@maild.net, whatever the first export suggested: the export had copied the email from ID-4001.
- According to the caller, ID-4002 is registered at 19 Birchwood Ct, his brother's house; the record itself gives 340 Sunset Blvd.
- ID-5001, the other record with the placeholder email, is in the name of Sara L**z and appears to be a MobileApp record, though its source label was blank in our extract.

## Actions

1. Hold ID-7001, ID-7002, ID-7003, ID-7004, ID-4001 and ID-4002 pending documentary verification of each SSN.
2. Request the recordings of the calls behind ID-7002, ID-7004 and ID-4002.
3. Leave ID-9120 and ID-5001 open: neither shares an identifier with the cluster once the placeholder is excluded.
4. Re-run the near-duplicate check with a two-edit window across all four source systems.
