---
domain: retail-banking
genre: AML investigation report
synthetic: true
note: Written for example 01 of relate-examples from the customers, accounts, payments, identifiers and logins in the sample data of Neo4j's retail-banking package (studio-agent-use-cases at b76f767), whose records it narrates. Every person, account, payment, device, session and identifier is synthetic; the e-mail addresses are at reserved domains, the telephone numbers in Ofcom's drama range and the IP address in the IPv6 documentation prefix. The towns, the countries and the National Crime Agency are real; the case references are invented.
---

# Investigation report FCI-2023-0917: mule activity on 12-34-56 24563467

**To:** Money Laundering Reporting Officer · **From:** Financial Crime Investigations, Leeds · **Date:** 19 December 2023 · **Reference:** FCI-2023-0917 · **Alert:** mule-account monitoring rule, 11 December 2023

## Summary

12-34-56 24563467 is a current account that Priya Collins opened online on 2 November 2023. In the five weeks that followed it received seven Faster Payments, £20,900.00 in all, from seven senders who have nothing in common except this account, and it sent £19,855.00 of that abroad by SWIFT, each time within five hours of a payment arriving. Two foreign accounts took the money, LT169404837175302881 in Lithuania and BG69TVNK94831093024404 in Bulgaria, a high-risk jurisdiction under our policy. Every outgoing payment was instructed from one Android phone, and that phone also operates the new accounts of three other customers. We assess 12-34-56 24563467 as a money mule account run by a third party. Outbound payments were restricted on 11 December, and we recommend a suspicious activity report to the National Crime Agency and closure of the account.

## The account holder

Priya Collins (customer CUS10869, born 18 May 1999) is the sole holder of 12-34-56 24563467, her only product with us. During the online application Priya Collins registered priya.collins10@example.net and gave +44 7700 900561 as her mobile number; both were new to us that day. Her address, 78 Ivy Court, Nottingham NG2 5EW, is located in the United Kingdom and is unique to her on our records. Her identity was verified electronically against credit reference data, which our online journey allows for a current account without an overdraft, so she presented neither a passport nor a driving licence.

## Money in

The account received seven Faster Payments between 14 November and 10 December: TXN4719, TXN4881, TXN5062, TXN5803, TXN6245, TXN6475 and TXN6549 were all paid to 12-34-56 24563467.

| Payment | Date | Paid from | Account holder | Amount |
|---|---|---|---|---|
| TXN4719 | 14 Nov 2023 | 12-34-58 94453932 | Daniel Stevens | £4,800.00 |
| TXN4881 | 18 Nov 2023 | 12-34-56 15502307 | Priya Foster | £1,650.00 |
| TXN5062 | 22 Nov 2023 | 12-34-56 61195664 | Priya Lee | £3,950.00 |
| TXN5803 | 27 Nov 2023 | 53-36-33 90304800 | held at another bank | £2,200.00 |
| TXN6245 | 3 Dec 2023 | 12-34-56 38357453 | Poppy Jackson | £4,000.00 |
| TXN6475 | 8 Dec 2023 | 12-34-58 42326828 | Rosie Phillips | £2,500.00 |
| TXN6549 | 10 Dec 2023 | 26-61-87 35345910 | held at another bank | £1,800.00 |

Five of the senders are our own customers, and none of them had paid Priya Collins before. Daniel Stevens, Priya Lee and Poppy Jackson have since told us that they did not make their payments; in each case a login from a computer they did not recognise came minutes earlier, and the fraud team is handling the three as account takeovers under FRD-2023-1184. Priya Foster and Rosie Phillips paid for concert tickets advertised on social media that never arrived. The two external senders, 53-36-33 90304800 and 26-61-87 35345910, are held in the United Kingdom, and both banks have asked for their customers' money back.

## Money out

12-34-56 24563467 sent TXN4720, TXN4883, TXN5067, TXN5813, TXN6247, TXN6480 and TXN6551 abroad by SWIFT, each within five hours of the inflow before it.

| Payment | Date | Amount | Beneficiary | Held in |
|---|---|---|---|---|
| TXN4720 | 15 Nov 2023 | £4,560.00 | LT169404837175302881 | Lithuania |
| TXN4883 | 18 Nov 2023 | £1,570.00 | LT169404837175302881 | Lithuania |
| TXN5067 | 22 Nov 2023 | £3,750.00 | LT169404837175302881 | Lithuania |
| TXN5813 | 27 Nov 2023 | £2,090.00 | LT169404837175302881 | Lithuania |
| TXN6247 | 3 Dec 2023 | £3,800.00 | BG69TVNK94831093024404 | Bulgaria |
| TXN6480 | 8 Dec 2023 | £2,375.00 | BG69TVNK94831093024404 | Bulgaria |
| TXN6551 | 10 Dec 2023 | £1,710.00 | BG69TVNK94831093024404 | Bulgaria |

Each outflow was close to 95 per cent of the inflow before it, the margin a mule is typically allowed to keep. TXN4720 left at midnight on 15 November, two and a half hours after TXN4719 arrived from Daniel Stevens's account, and TXN6551 left 145 minutes after TXN6549. TXN6551 was probably the last of the run: the £1,016.45 still in the account would have followed it had outbound payments not been restricted.

## Logins and devices

Priya Collins logged in thirteen times between 2 November and 12 December, always successfully, from two phones. Priya Collins started SESS003738 on DEV-bf436fd924, an iPhone and her own mobile, eight minutes after the account was opened. The other phone, DEV-45b24a72d3, is an Android mobile that always connects from one fixed broadband address, 2001:db8:5c75:c395::46, located in the United Kingdom. Nine of her sessions ran on DEV-45b24a72d3, and each SWIFT payment was instructed fifteen minutes after one of them began: SESS004521, for example, started at 23:45 on 14 November, a quarter of an hour before TXN4720 left.

The same device and address run the accounts of three other customers. The table shows the first session DEV-45b24a72d3 ran for each of the four customers, and the session behind TXN4720.

| Session | Started | Customer | Device | IP address | Status |
|---|---|---|---|---|---|
| SESS000889 | 15 Sep 2023, 21:56 | Isabella Ellis | DEV-45b24a72d3 | 2001:db8:5c75:c395::46 | success |
| SESS000995 | 17 Sep 2023, 15:40 | Joseph Mitchell | DEV-45b24a72d3 | 2001:db8:5c75:c395::46 | success |
| SESS002972 | 20 Oct 2023, 11:30 | Zara King | DEV-45b24a72d3 | 2001:db8:5c75:c395::46 | success |
| SESS003740 | 2 Nov 2023, 11:00 | Priya Collins | DEV-45b24a72d3 | 2001:db8:5c75:c395::46 | success |
| SESS004521 | 14 Nov 2023, 23:45 | Priya Collins | DEV-45b24a72d3 | 2001:db8:5c75:c395::46 | success |

## Other accounts on the device

Each of the three opened a current account online two hours or less before that first session, and uses it as Priya Collins's account was used:

- Isabella Ellis holds 12-34-56 42205594, opened on 15 September 2023, and provided driving licence ELLIS012181I99DJ as proof of identity. Her account has passed both of its inflows on to LT169404837175302881, the Lithuanian beneficiary above.
- Joseph Mitchell, who provided driving licence MITCH051021J99YZ, is the holder of 12-34-57 10466685, opened two days later. It too forwards each inflow to LT169404837175302881 within three hours.
- Zara King opened two current accounts on 20 October 2023. The first, 12-34-56 45223673, has made one card payment; the second, 12-34-57 31478046, took five Faster Payments worth £7,450.00 and passed £6,928.50 of them to AE820016973547453642788, an account held in the United Arab Emirates. Zara King provided driving licence KING9810265Z99QG and gave +44 7700 900606 as her mobile number, a number three other recent customers also gave. Those three are described in the draft report.

## What we could not establish

- An earlier version of the alert said that 12-34-56 15502307 sent TXN5803; that was a matching error and has been corrected.
- Neither Priya Foster nor Priya Lee holds 12-34-56 24563467 jointly; the first name they share with its holder is a coincidence.
- Priya Collins may have provided driving licence KING9810265Z99QG in an application abandoned on 19 October, but the application log is incomplete.
- If Zara King started SESS004521 herself, she would be the person running these accounts; the IP address alone cannot show who held the phone.

## Recommendation

1. Submit the suspicious activity report drafted as SAR-2023-0412 to the National Crime Agency, with Priya Collins as subject and Isabella Ellis, Joseph Mitchell and Zara King as associated subjects.
2. Keep the restriction on 12-34-56 24563467 and close the account once the report is submitted, giving the customer no reason, so as to avoid tipping off.
3. Restrict 12-34-56 42205594, 12-34-57 10466685 and 12-34-57 31478046, and open a case for each.
4. Return the £1,016.45 held to the senders' banks, in proportion to what each sent.
