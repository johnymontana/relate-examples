---
domain: ev-route-planning
genre: road-trip charging plan
synthetic: true
note: Written for example 01 of relate-examples from the vehicles, cities, charging sites, road segments and charge tiers in the sample data of Neo4j's ev-route-planning package (studio-agent-use-cases at b76f767), and from the route its best-route query returns for EV-013 from Paris to Marseille. The fleet, the charging sites and their operators are synthetic; the cities and road numbers are real, the distances and speeds the package's.
---

# Charging plan CP-2026-1208-013: EV-013, Paris to Marseille

**From:** Fleet planning desk, Lyon · **To:** Duty driver, Paris pool · **Date:** 7 December 2026 · **Run:** 8 December 2026, departing 06:00 · **Ref:** CP-2026-1208-013

## Summary

EV-013, an Aurex Estate 77 from the Paris pool, takes the Paris to Marseille run on 8 December. The plan covers 800.0 km on the A6 and the A7 with three 15-minute top-up charges, at CS-A6-01, CS-LYON-02 and CS-A7-01, and reaches Marseille at 13:28 with 32% state of charge. That is 7 h 28 min from departure to arrival, well inside the 900-minute shift, and the battery never falls below the 10% floor. The route is the one the best-route query returns for this car with a 1.35 corridor; the figures below come from its energy model and are a plan, not a promise.

## The vehicle

| Fleet no. | Model | Class | Usable battery (kWh) | Consumption (kWh/km) | Max charge power (kW) | SoC at 05:40 |
|---|---|---|---|---|---|---|
| EV-013 | Aurex Estate 77 | Fleet Car | 77.0 | 0.17 | 150 | 95% |

At 95% and a 10% reserve, EV-013 can use 85% of its battery, or about 385 km: less than half of the run. It has to charge at least twice, and on this network it charges three times.

## The route

| Leg | From | To | Road | Class | Distance (km) | Speed used (km/h) | SoC on arrival |
|---|---|---|---|---|---|---|---|
| 1 | Paris | CS-A6-01 | A6 | Express | 206.5 | 130 | 49% |
| 2 | CS-A6-01 | Lyon | A6 | Express | 258.5 | 105 (peak) | 41% |
| 3 | Lyon | CS-LYON-02 and back | D701 | Local | 2 × 10.0 | 80 | 53% |
| 4 | Lyon | CS-A7-01 | A7 | Express | 159.8 | 130 | 18% |
| 5 | CS-A7-01 | Marseille | A7 | Express | 155.2 | 130 | 32% |

Leg 2 starts at 07:50, inside the morning peak, so it is planned at 105 km/h; every other leg runs at free-flow speed.

## Charging stops

| Stop | Site | Operator | Site power (kW) | Energy added (kWh) | Tier | Arrive | SoC |
|---|---|---|---|---|---|---|---|
| 1 | CS-A6-01 | ElectraRoute | 150 | 37.5 | top-up, 15 min | 07:35 | 49% to 98% |
| 2 | CS-LYON-02 | VoltWay | 50 | 12.5 | top-up, 15 min | 10:26 | 39% to 55% |
| 3 | CS-A7-01 | ElectraRoute | 300 | 37.5 | top-up, 15 min | 12:02 | 18% to 66% |

Every site also offers a 40-minute full charge. The plan takes none: three top-ups keep the car above the floor at every step, and the longer tier only adds time. CS-A7-01 is rated at 300 kW, but the car takes only what its own charging limit allows.

### Why the Lyon stop

The Lyon stop is the one a driver will question. EV-013 reaches Lyon at 41%, and the 159.8 km from Lyon to CS-A7-01 use 35% of the battery, which would leave it at 6% on arrival, under the floor. Even a full 40-minute charge at CS-A6-01 lifts that only to 8%.

Seven charging sites are one road segment from Lyon, and CS-LYON-02 is the nearest of them, at the end of a 10.0 km spur on the D701. The others are long legs: CS-A89-02 is 74.7 km west of Lyon on the A89, and CS-A31-02 is 94.5 km north of it on the A31. CS-LYON-02, a VoltWay site, delivers only 50 kW, so the 15-minute stop adds 12.5 kWh. That is enough to reach CS-A7-01 at 18%.

## Alternatives we ran

- **Via the A31.** The alternative leaves Paris for CS-A31-01, an AmperGrid site 174.9 km out. From the site it is another 140.1 km to Dijon. From Dijon the A31 continues 100.5 km to CS-A31-02 and then 94.5 km into Lyon, where it rejoins this plan for the A7. With top-ups at CS-A31-01, CS-A31-02 and CS-A7-01 it covers 825.0 km in 7 h 32 min and arrives with 54%. It is four minutes slower but keeps more charge in hand, and it is the fallback if CS-LYON-02 is out of service.
- **Fewest hops.** Paris, CS-A6-01, Lyon, CS-A7-01 and Marseille, four segments and 780.0 km, is the fewest-hop route the query returns, but without the Lyon stop it breaks the floor, as above.
- **Another car.** EV-016, a Selene GT 110, would make the run from its current charge with two stops in 6 h 58 min, but it is booked on the Strasbourg shuttle that day. EV-018, the pool's other Aurex Estate 77, is at 69% and would need a full 40-minute charge at CS-A6-01 or CS-LYON-02, arriving 25 minutes later; it stays in Paris as the standby car.

## The valley road

Planners asked whether the A7 through the valley towns could replace the express segments south of Lyon. For this car it cannot. The valley road leaves Lyon for Valence, 107.3 km down the A7. Montelimar comes 50.1 km after that. The town has no charging station within two road hops, and its exit to Orange is 54.4 km further on. From Orange the A7 runs 24.3 km to Avignon, and Avignon is joined to Marseille by 99.3 km of the same road. No charging site sits on any of these segments, so the 335.4 km from Lyon to Marseille that way would have to be driven on one charge, and EV-013 leaves Lyon with 53%.

## What this plan does not rely on

- CS-A7-01 has no road to Valence; the site is reached only from Lyon and from Marseille.
- A local road from Villeurbanne may also reach CS-LYON-02, but the network does not record one and the plan does not use it.
- ElectraRoute plans a slip road from Montelimar to CS-A7-01 in 2027, which would give the valley road its first charger.
- An earlier draft of this plan routed the car from Dijon to CS-A6-01; there is no such segment, and that draft has been withdrawn.
- A driver on the November run reported a direct road from Valence to CS-LYON-02; we found no such segment on the network.
- VoltWay is expected to raise CS-LYON-02 to 150 kW in the spring; until it does, the plan uses the site's 50 kW.

## Caveats for the driver

1. Consumption is modelled at a constant 0.17 kWh/km. In December an estate car can use a third more, so if EV-013 reaches CS-A6-01 below 40%, take the 40-minute full charge there and call the desk.
2. Every stop assumes a free connector on arrival: the model has no queueing.
3. In Marseille, take the D702 for 8.3 km to CS-MARSEILLE-03, an ElectraRoute site rated at 200 kW, and charge there for the return run on 9 December.

Approved for dispatch by the fleet planning desk, Lyon.
