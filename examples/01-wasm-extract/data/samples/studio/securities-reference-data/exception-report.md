---
domain: securities-reference-data
genre: security master exception report
synthetic: true
note: Written for example 01 of relate-examples from the securities, issuers, identifiers, listings, offerings and funds in the sample data of Neo4j's securities-reference-data package (studio-agent-use-cases at b76f767). Every issuer, bank, fund, manager, security, listing, offering and identifier is synthetic; the exchanges and the identifier schemes are real.
---

# Security master exception report SMX-2026-10

**From:** Reference Data Operations, London · **To:** Data Governance Committee; Investment Risk · **Date:** 3 November 2026 · **Reference:** SMX-2026-10 · **Snapshot:** 30 October 2026

## Summary

The month-end checks ran against the security master snapshot of 30 October 2026 and raised eight exceptions: two look-through concentration breaches, three identifier defects and three listing defects. No price or position has been misstated, but one exception needs a decision this week. Once its holdings of other funds are followed down, Aldermoor Global Allocation Fund of Funds has 10.70% of its net assets in one issuer group, against a limit of 10%.

## Exceptions at a glance

| # | Check | Record | Finding | Owner |
|:---|:---|:---|:---|:---|
| 1 | Look-through concentration | FND-002 | 10.70% in the Kairo Denki group, 3.50% direct | Investment Risk |
| 2 | Look-through concentration | FND-006 | 10.50% in Calder Brennan plc, no line above 4.00% | Investment Risk |
| 3 | Shared identifier | SEDOL HBX4BB7 | on SEC-00055 and SEC-00528 | Reference Data |
| 4 | Shared identifier | CUSIP 240345520 | on SEC-00548 and SEC-00549 | Reference Data |
| 5 | ISIN against national number | SEC-00552 | ISIN embeds a mistyped CUSIP | Reference Data |
| 6 | Matured but listed | LST-00384 | matured 15 July 2024, still active | Reference Data |
| 7 | Matured but listed | LST-00385 | matured 3 March 2025, still active | Reference Data |
| 8 | Ticker reuse | LST-00371 | 2017 trades booked to the wrong company | Operations |

## Records in this report

| Record | Security | Issuer | Exception |
|---|---|---|---|
| SEC-00518 | Kairo Denki Holdings Ordinary Shares | Kairo Denki Holdings K.K. | 1 |
| SEC-00519 | Kairo Denki Finance 2.750% Sr Notes 2029 | Kairo Denki Finance B.V. | 1 |
| SEC-00520 | Kairo Denki Holdings 0.000% Convertible Bonds 2029 | Kairo Denki Holdings K.K. | 1 |
| SEC-00521 | Kairo Denki Holdings American Depositary Receipts | Harrowgate Depositary Trust Company | 1 |
| SEC-00523 | Sakuragi Capital 0.250% Exchangeable Bonds 2028 | Sakuragi Capital K.K. | 1 |
| SEC-00567 | Aldermoor Japan Equity ETF Shares | Aldermoor Investment Funds ICAV | 1 |
| SEC-00573 | Northgate Asia Income Fund Units | Northgate Funds Trust | 1 |
| SEC-00055 | Wexcombe Breweries Ordinary Shares | Wexcombe Breweries plc | 3 |
| SEC-00528 | Wexcombe Breweries plc American Depositary Receipts | Calloway Trust Bank, N.A. | 3 |
| SEC-00548 | Ostrander Energy 1.625% Sr Notes 2030 | Ostrander Energy Inc. | 4 |
| SEC-00549 | Ostrander Energy 3.750% Sr Notes 2030 | Ostrander Energy Inc. | 4 |
| SEC-00552 | Varnell Aerospace 1.625% Sr Notes 2031 | Varnell Aerospace Inc. | 5 |
| SEC-00559 | Tessaly Water plc 1.500% Sr Notes 2024 | Tessaly Water plc | 6 |
| SEC-00560 | Rostova Shipping Finance 3.500% Sr Notes 2025 | Rostova Shipping Finance B.V. | 7 |
| SEC-00543 | Kestrel Vale Resources Common Stock | Kestrel Vale Resources Inc. | 8 |
| SEC-00544 | Korvara Robotics Common Stock | Korvara Robotics Inc. | 8 |

## 1. Kairo Denki Holdings K.K. through two layers of funds

The funds concerned are FND-002, Aldermoor Global Allocation Fund of Funds; FND-001, Aldermoor Japan Equity ETF; and FND-005, Northgate Asia Income Fund.

Aldermoor Global Allocation Fund of Funds has net assets of $2.4bn. Its own report shows one line in the group: FND-002 holds SEC-00518 directly, at 3.50%. Most of the fund sits in two other funds: FND-002 holds SEC-00567 at 60.00% and SEC-00573 at 25.00%. SEC-00567 is a unit of FND-001. SEC-00573 is a unit of FND-005. Aldermoor Japan Equity ETF is a $1.85bn exchange-traded fund. Northgate Asia Income Fund is a $780m mutual fund. FND-002 is managed by Aldermoor Investors Limited, and so is FND-001. FND-005 is managed by Northgate Capital Management LLC.

Both funds hold the group, so once each line is weighted by FND-002's share of the fund that holds it, the exposure comes to 10.70%:

| Held by | Security | Weight in holder | Look-through |
|---|---|---|---|
| FND-002 | SEC-00518 | 3.50% | 3.50% |
| FND-001 | SEC-00518 | 6.00% | 3.60% |
| FND-001 | SEC-00520 | 3.50% | 2.10% |
| FND-005 | SEC-00519 | 4.00% | 1.00% |
| FND-005 | SEC-00521 | 2.00% | 0.50% |
| **Total** | | | **10.70%** |

Two of the five lines name an issuer other than the parent, which is why the issuer-name screen missed them. SEC-00519 has €1.25bn outstanding and was issued by Kairo Denki Finance B.V. Kairo Denki Finance B.V., a Dutch financing vehicle, is a subsidiary of Kairo Denki Holdings K.K. Harrowgate Depositary Trust Company, a subsidiary of Harrowgate Bancorp Inc., issued SEC-00521. SEC-00521 represents SEC-00518 at two receipts per share.

SEC-00520 has ¥60bn outstanding and converts into SEC-00518 at 4.1667 shares per bond. OFF-00351 sold SEC-00520 in September 2022 as an exempt offering. OFF-00351 was underwritten by Shinonome International plc as bookrunner, with Meridian Kapital Markets AG as co-manager.

One more route is held by no fund in scope. SEC-00523 has ¥25bn outstanding and was issued by Sakuragi Capital K.K. SEC-00523 is exchangeable into SEC-00518 at 3.8462 shares per bond. The issuer, Sakuragi Capital K.K., is not a subsidiary of Kairo Denki Holdings K.K., so an issuer-group screen never reaches the bond. OFF-00352 sold SEC-00523 on 21 February 2023. OFF-00352 was also an exempt offering and was underwritten by Shinonome International plc. Our record was set up from its offering file without the exchange terms.

The same screen puts Northgate Global Leaders Fund (FND-006) at 10.50% in Calder Brennan plc, though no single line is above 4.00%: the shares, the receipts and a subsidiary's notes each stay under the limit. Northgate Capital Management LLC, which manages the fund, is reporting that breach separately.

## 2. Identifier defects

SEC-00055 is identified by SEDOL HBX4BB7 and by ISIN GB00HBX4BB70, which embeds the SEDOL, as a GB ISIN should. SEC-00528 represents SEC-00055 at four receipts per share. SEC-00528 is identified by its own CUSIP 339743726 and ISIN US3397437266, and a vendor mapping copied the local share's SEDOL onto it.

SEC-00548 has $500m outstanding and is identified by CUSIP 240345520 and by ISIN US2403455205. The same CUSIP was keyed against SEC-00549, the $1.25bn tranche issued two years later. SEC-00549 is already identified by CUSIP 384465A91 and by ISIN US384465A917.

SEC-00552 is identified by CUSIP 143405E95 and by ISIN US14340E5969, but the CUSIP embedded in that ISIN has two characters transposed. The offering circular confirms the CUSIP, so the ISIN is the record to correct.

## 3. Listing defects

LST-00384 is on the London Stock Exchange and still lists SEC-00559, although the notes matured on 15 July 2024, when the £1.5bn issue was repaid in full. LST-00385 is on the Luxembourg Stock Exchange and still lists SEC-00560, a €400m issue that matured on 3 March 2025.

KVR has named two companies on the New York Stock Exchange. LST-00371 listed SEC-00543 under KVR from 14 April 2008 until 28 June 2019. LST-00372 has listed SEC-00544 under the same ticker since 15 March 2021. A broker file of trades dated 3 May 2017 was resolved against today's ticker, so fourteen trades in Kestrel Vale Resources Common Stock were booked to Korvara Robotics Common Stock.

## What we could not establish

- SEC-00521 may at first have been issued by Calloway Trust Bank, N.A. One vendor still shows that bank as depositary, but the programme documents we hold name only Harrowgate.
- The vendor claims that SEC-00528 also carries ISIN GB00HBX4BB70; the exchange shows that ISIN on SEC-00055 alone.
- An earlier draft of this report said that LST-00385 lists Rostova Shipping Finance 0.875% Sr Notes 2051; that was wrong, as those notes do not mature until 2051.
- Aldermoor Investors Limited plans to add SEC-00523 to FND-002 in the November rebalance, taking the fund further over the limit.
- If the tap announced in October goes ahead, SEC-00519 would have about €1.5bn outstanding.

## Actions

1. Investment Risk to decide on FND-002 by 6 November; cutting the direct holding below 2.80% would bring the fund under the limit.
2. Reference Data to remove SEDOL HBX4BB7 from SEC-00528 and CUSIP 240345520 from SEC-00549, and to ask the vendor to reissue the ISIN of SEC-00552.
3. Reference Data to close LST-00384 and LST-00385 once the exchanges confirm their delisting dates.
4. Operations to rebook the 3 May 2017 trades and to resolve every ticker by exchange and trade date.
5. Add exchange terms to the issuer-group screen, so that exchangeable bonds count toward their target's group.
