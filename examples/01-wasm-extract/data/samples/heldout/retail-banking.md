---
domain: retail-banking
genre: account takeover case note
synthetic: true
note: Written for example 01 of relate-examples, as its held-out document, from the logins, devices and payments of one customer in the sample data of Neo4j's retail-banking package (studio-agent-use-cases at b76f767). Every person, account, payment, device, session and identifier is synthetic; the e-mail address is at a reserved domain, the telephone number in Ofcom's drama range and the IP addresses in the documentation blocks. The towns, the countries and the Payment Services Regulations 2017 are real; the case reference is invented.
---

# Account takeover case note ATO-2023-0388

**From:** Fraud Operations, Cardiff · **To:** case file; Financial Crime Investigations · **Date:** 8 December 2023 · **Case:** ATO-2023-0388 · **Customer:** Ioana Cooper (CUS10775)

## The report

Ioana Cooper telephoned at 08:10 on 7 December to report a payment she did not recognise. TXN6393, a SWIFT payment of £6,200.00, left 12-34-58 88291999, her current account, at 23:40 on 6 December. TXN6393 was paid to LT051363754385334748, an account held in Lithuania and new to her payment history. Ioana Cooper holds 12-34-58 88291999 alone and has banked with us since April 2015.

She told us that a caller claiming to be from our fraud team rang at about 22:00 that evening and asked her to read out a passcode sent to her phone, which she did.

## Logins on 6 December

Four logins came from one computer in the hour before the payment:

| Session | Time | Device | IP address | Status |
|---|---|---|---|---|
| SESS005871 | 22:18 | DEV-626ae42f56 | 203.0.113.254 | failed |
| SESS005872 | 22:21 | DEV-626ae42f56 | 203.0.113.253 | failed |
| SESS005873 | 22:24 | DEV-626ae42f56 | 203.0.113.253 | failed |
| SESS005875 | 22:30 | DEV-626ae42f56 | 203.0.113.254 | success |

SESS005871, SESS005872 and SESS005873 were rejected logins to Ioana Cooper's online banking, and SESS005875, her fourth, got in with her password and the passcode she had read out. TXN6393 executed seventy minutes after SESS005875 began.

## Why we treat it as a takeover

- **New device.** DEV-626ae42f56 is a desktop running a headless browser on Linux. It was new to her profile. Her own logins run on DEV-0124b11781, her mobile, and on DEV-acdb3f32cf, a desktop at home. Her last session before the attack, SESS003926 on 5 November, ran on DEV-0124b11781.
- **New country.** 203.0.113.254 and 203.0.113.253 are located in Romania. 192.0.2.19, her home broadband line, is located in the United Kingdom, like every other address she has logged in from.
- **New payee, unusual size.** TXN6393 is by far the largest payment from 12-34-58 88291999 in the last three months. Her one regular inflow is a monthly pension of £2,136.00 paid from 28-06-74 43982424, most recently as TXN5724 on 27 November.
- **A known computer.** Since 14 November DEV-626ae42f56 has attempted logins to the accounts of ten customers from addresses in Romania and Nigeria, and has got into four of them.

## Contact details

Ioana Cooper registered ioana.cooper502@example.net when she opened the account and gave +44 7700 900183 as her mobile number. She lives at 36 Sycamore Road, London SW11 8XJ, as our records show. None of these details was changed during the session, and the passcode went to her own number.

## What we could not establish

- Ioana Cooper does not hold LT051363754385334748 and had never paid it.
- 203.0.113.253 may be located in Bulgaria instead; two geolocation services disagree.
- If the Lithuanian bank freezes the funds, TXN6393 would be returned to 12-34-58 88291999 within ten working days.

## Actions

1. DEV-626ae42f56 was blocked across online banking, and Ioana Cooper's password and passcode device were reset at 08:25 on 7 December.
2. A recall for TXN6393 was sent to the beneficiary bank by SWIFT on 7 December.
3. Refund £6,200.00 to Ioana Cooper by close of business today under regulation 76 of the Payment Services Regulations 2017: she was deceived into reading out the passcode, which we do not treat as gross negligence.
4. Refer DEV-626ae42f56 and the four takeovers it achieved to Financial Crime Investigations.
