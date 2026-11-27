---
domain: options-intelligence
genre: pre-market options brief
synthetic: true
note: Written for example 01 of relate-examples, under its curated Options Intelligence ontology, after create-context-graph's daily options market brief template (707b168). Every person, desk, ticket and position is fictional, and so are Corvane Systems, its ticker CVNX and every price, level, exposure and economic figure; the SPX and NDX indices, the CPI and jobs releases, monthly expiration and the OCC option symbol format are real.
---

# Pre-market options brief: CPI morning

**From:** Owen Achterberg, strategist, Index Volatility desk · **To:** index and single-stock options traders · **Date:** Thursday 12 November 2026, 07:10 ET · **Reference:** PMB-2026-1112

## Summary

- SPX closed at 6,742 and is in the positive-gamma regime, pinned between the 6,700 gamma flip and the 6,800 call wall.
- NDX has been in the negative-gamma regime since Tuesday and closed 215 points above the 24,000 put wall.
- The October CPI release at 08:30 ET is the risk of the day: options price a 0.9% move in SPX, against 0.6% on a normal session.
- Corvane Systems (CVNX) reports after the close, and the Equity Derivatives desk is positioned for the print.

## Dealer positioning and key levels

| Underlying | Level | Net dealer gamma | What it does |
|---|---|---|---|
| SPX | 6,800 call wall | +$3.1bn per 1% | caps rallies; dealers sell into it |
| SPX | 6,700 gamma flip | about zero | the boundary between regimes |
| SPX | 6,600 put wall | +$1.4bn per 1% | support below the flip |
| NDX | 24,400 gamma flip | about zero | broken on Tuesday |
| NDX | 24,000 put wall | +$0.6bn per 1% | the first support that matters |

The October jobs report on 6 November, softer than expected, flipped SPX back into the positive-gamma regime, and the index has held there for four sessions. With dealers long $3.1bn of gamma per 1% move, their hedging sells strength and buys weakness: ten-day realized volatility has fallen to 9.4, and SPX has spent most of the week within ten points of 6,750. SPX tested the 6,800 call wall twice on Wednesday afternoon but did not break it.

NDX is a different market. The 10 November chip sell-off took NDX through its 24,400 gamma flip on Tuesday. It also pushed the index into the negative-gamma regime, where dealers hedge by selling into declines and buying into rallies, so moves extend rather than fade. Below the flip, dealer gamma does not turn positive again until the 24,000 put wall, the largest open-interest strike in the November chain.

## Today's events

- **October CPI release, 08:30 ET.** Consensus is 0.3% for core, month on month. The October CPI release moves SPX and NDX at once, and it is the only scheduled print this year that has moved either index by more than 1%.
- **Corvane Q3 earnings report, after the close.** On average over the last eight quarters, the Corvane Q3 earnings report has moved CVNX by 6.1%, and options now price 7.8%. The Corvane Q3 earnings report may also move NDX, where Corvane Systems makes up about 1.2% of the index, but past quarters show little spillover.
- **November monthly expiration, Friday 20 November.** About a third of the open interest at the 6,800 call wall expires that day, and November monthly expiration will loosen the cap on SPX into the following week.

## The book going into the open

| Ticket | Underlying | Strategy | Contracts | Qty | Expiry | Mark P&L |
|---|---|---|---|---|---|---|
| TKT-58213 | SPX | iron condor | SPXW261112C06800000, SPXW261112P06650000 | 50 | 12 Nov | +$18,400 |
| TKT-58207 | NDX | put spread | NDXP261120P24000000 | 20 | 20 Nov | +$41,900 |
| TKT-58219 | SPX | put spread | SPXW261113P06650000 | 100 | 13 Nov | −$6,200 |
| TKT-58216 | CVNX | long straddle | CVNX261113C00145000, CVNX261113P00145000 | 300 | 13 Nov | −$2,700 |

The table lists the legs that carry the risk; the wings are 25 points wide in SPX and 400 in NDX.

Hana Ito runs the iron condor book on the Index Volatility desk. She sold 50 lots of TKT-58213 at 15:40 yesterday for a credit of $4.10. TKT-58213 has its short call struck at the 6,800 call wall and its short put at 6,650, fifty points under the flip, and it keeps the full credit if SPX settles inside that range at today's close.

Marcus Feld, a trader on the Index Volatility desk, bought TKT-58207 on Tuesday, an hour after NDX broke the 24,400 gamma flip. An earlier version of yesterday's brief said that TKT-58207 was struck at the 24,400 gamma flip. That was wrong: TKT-58207 is struck at the 24,000 put wall, and it is now up $41,900. Marcus Feld also bought TKT-58219 yesterday afternoon as a hedge for the October CPI release. The ticket holds 100 lots of the SPX 13 Nov 6650P against the book's downside. Hana Ito will place TKT-58224 once the opening range has settled after the print, for an expected credit of about $2.80.

Priyanka Desai, the earnings trader on the Equity Derivatives desk, bought TKT-58216 at Wednesday's close for a debit of $10.95. The position is the only trade the desk has on for the Corvane Q3 earnings report, and it needs a move of more than 7.6% to pay.

## Desks and coverage

The Index Volatility desk covers SPX and NDX and runs two strategies into today's print: the iron condor and the put spread. The Equity Derivatives desk covers Corvane Systems and runs the long straddle into most of its earnings names.

## Playbook for today

1. The iron condor is at its best in the positive-gamma regime, where dealer hedging dampens moves; keep TKT-58213 on while SPX holds above the flip.
2. The put spread is at its best in the negative-gamma regime, where dealers sell into declines, so the NDX downside stays on through the print.
3. If the October CPI release comes in hot, SPX could break the 6,700 gamma flip and fall into the negative-gamma regime; close TKT-58213 at once if it does.
4. Do not add to TKT-58216 before the print; Priyanka Desai sets the exit with the desk head at 15:30.

## Risk at the open

The book is long $1.2m of delta in SPX terms and short $85,000 of vega per volatility point, most of it through TKT-58213. The largest single loss in a hot-CPI scenario, SPX down 1.5% at the open, is $212,000, inside the desk's $350,000 daily limit.
