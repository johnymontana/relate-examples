---
domain: retail-banking
genre: suspicious activity report draft
synthetic: true
note: Written for example 01 of relate-examples as the report the investigation FCI-2023-0917 recommends, from the same records in the sample data of Neo4j's retail-banking package (studio-agent-use-cases at b76f767). Every person, account, payment, device and identifier is synthetic; the e-mail addresses are at reserved domains, the telephone numbers in Ofcom's drama range and the IP address in the IPv6 documentation prefix. The towns, the countries and the National Crime Agency are real; the references are invented.
---

# Suspicious activity report SAR-2023-0412 (draft for MLRO approval)

**From:** Money Laundering Reporting Officer · **To:** UK Financial Intelligence Unit, National Crime Agency · **Date:** 19 December 2023 · **Internal case:** FCI-2023-0917 · **Request:** defence against money laundering

Identifiers below are as held on our systems: passports by issuing country and number.

## Subject

Priya Collins, born 18 May 1999, lives at 78 Ivy Court, Nottingham NG2 5EW and holds current account 12-34-56 24563467, which she opened online on 2 November 2023.

## Reason for suspicion

Between 14 November and 10 December 2023, 12-34-56 24563467 received seven Faster Payments totalling £20,900.00 from unrelated senders, three of whom report that their own accounts were taken over, and sent £19,855.00 abroad by SWIFT within hours of each arrival. The beneficiaries were LT169404837175302881, held in Lithuania, and BG69TVNK94831093024404, held in Bulgaria. The largest outflow, TXN4720 for £4,560.00, was paid to LT169404837175302881 at midnight on 15 November; the last, TXN6551 for £1,710.00, was paid to BG69TVNK94831093024404 on 10 December.

Every outflow was instructed in a session on the same phone. SESS004521, the session behind TXN4720, ran on DEV-45b24a72d3, an Android mobile, and connected from 2001:db8:5c75:c395::46, a fixed broadband line. The account holder's own iPhone was used for other logins.

## Associated subjects

The same device operates accounts held by Isabella Ellis (12-34-56 42205594), Joseph Mitchell (12-34-57 10466685) and Zara King (12-34-57 31478046), each opened online in the autumn and used to forward payments abroad.

Zara King, of 146 Queens Road, Manchester M8 5HS, gave +44 7700 900606 as her mobile number. The number +44 7700 900606 was also given by Rahul Richards, Joseph James and James Hill, who list 146 Queens Road, Manchester M8 5HS as their address as well. Rahul Richards, Joseph James and James Hill each registered j.reynolds.lettings@inbox.example beside an e-mail address of their own. Joseph James and James Hill presented the same passport, GB:983208276, which expires on 4 April 2024. Rahul Richards provided driving licence RICHA953287R99RX. Rahul Richards holds 12-34-57 94014491, Joseph James holds 12-34-56 32998681 and James Hill holds 12-34-57 39133045; so far each has made only small card payments.

We consider the last three to be identities assembled from shared details around one passport, and the four accounts on DEV-45b24a72d3 to be mule accounts run by one controller.

## Points to note

- Zara King did not present GB:983208276; her identity rests on her driving licence.
- Rahul Richards may also have access to 12-34-57 39133045, but the login records do not show it.
- One sending bank alleges that Priya Collins lives at 146 Queens Road, Manchester M8 5HS as well.

## Request

We ask for a defence against money laundering to return the £1,016.45 still held on 12-34-56 24563467 to the sending banks, and to exit the four mule accounts. No customer has been told of this report.
