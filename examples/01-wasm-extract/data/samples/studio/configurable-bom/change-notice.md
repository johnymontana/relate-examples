---
domain: configurable-bom
genre: engineering change notice
synthetic: true
note: Written for example 01 of relate-examples from the product, assemblies, configuration groups and parts in the sample data of Neo4j's configurable-bom package (studio-agent-use-cases at b76f767), with its identifiers, quantities, costs and weights as the package records them. The catalog is the package's synthetic one; the people, the notice, the variant V-275-TRAIL and the future part P-TIRE-275-PLUS are fictional.
---

# Engineering change notice ECN-0147: 27.5-inch wheel option for MB1

**From:** Product Engineering, mountain bike platform · **To:** Configuration Engineering, Cost Engineering, Procurement, Quality · **Date:** March 9, 2026 · **Revision:** B · **Change class:** II (options added; existing variants unchanged)

## Summary

ECN-0147 adds a third wheel size to MB1, the configurable mountain bike in trail specification. A new built wheel, A-WHEEL-275, is added as an option of CG-WHEELSET, the wheel size decision. It brings two configuration decisions of its own and five new part numbers. Every existing assembly, part and option keeps its number and its quantities, so a variant resolved before this notice resolves to the same bill of materials after it.

## Reason for change

Dealers asked for a size between the two we build. The 26-inch wheel now sells mainly on small frames, and riders under 165 cm find the 29-inch wheel hard to manage on tight trails. A 27.5-inch wheel fits all three of our frames without new tooling, and it reuses the hub and the brakes.

## Product structure after the change

MB1 requires three fixed assemblies, one of each: A-DRIVETRAIN, A-FRAMESET and A-BRAKESET. MB1 also requires CG-WHEELSET, with a quantity of two, because the front and rear wheels are always the same size. After this notice CG-WHEELSET offers A-WHEEL-26, A-WHEEL-275 and A-WHEEL-29, and resolution keeps exactly one of them for both wheels.

The drawing for A-WHEEL-275 started as a copy of A-WHEEL-29. That assembly requires CG-RIM-29 and CG-TIRE-29, one of each, and both decisions were copied and renumbered for the new size:

- **Fixed parts.** A-WHEEL-275 contains one P-HUB, the hub already used in A-WHEEL-26 and A-WHEEL-29, and 32 of the new spoke, P-SPOKE-275.
- **Rim decision.** CG-RIM-275, required once by A-WHEEL-275, offers P-RIM-275-ALLOY and P-RIM-275-CARBON.
- **Tread decision.** CG-TIRE-275 is required once by A-WHEEL-275 and offers two treads, P-TIRE-275-TRAIL and P-TIRE-275-MUD.

Neither existing spoke can be reused: P-SPOKE-26 is about 12 mm too short for the new rims and P-SPOKE-29 about 20 mm too long, so A-WHEEL-275 uses neither of them.

## Impact on other assemblies

Tire clearance on A-FRAMESET depends on a single decision, the frame. CG-FRAME offers P-FRAME-ALU, P-FRAME-STEEL and P-FRAME-CARBON, and all three clear a 27.5 × 2.4 inch tire by at least 6 mm at the chainstay, so the frameset is unchanged.

A-BRAKESET is unaffected as well. Because A-WHEEL-275 uses the same P-HUB as the other wheels, the brake disc sits where it always has, and A-BRAKESET still requires CG-CALIPER with a quantity of two, one caliper per wheel. Both options of CG-CALIPER, P-CALIPER-MECH and P-CALIPER-HYD, remain orderable with the new wheel. A-DRIVETRAIN is untouched.

## Configuration rules

Constraints match decisions by category, so this notice needs no new rule. CG-RIM-275 carries the category rim and the option property material, as CG-RIM-26 and CG-RIM-29 do, so a rim deny list such as material Carbon now reaches the new wheel without any edit. CG-TIRE-275 joins CG-TIRE-26 and CG-TIRE-29 under the category tire, with pattern as its option property. A specification that sets wheelSize to 27.5 selects A-WHEEL-275; one that leaves the size open is settled by scoring, which compares whole wheels, rim and tire included.

## Cost and weight

Per wheel, the four builds of A-WHEEL-275 cost and weigh as follows, hub and 32 spokes included:

| Rim | Tire | Cost per wheel (EUR) | Weight per wheel (kg) |
|---|---|---|---|
| P-RIM-275-ALLOY | P-TIRE-275-TRAIL | 146.80 | 1.69 |
| P-RIM-275-ALLOY | P-TIRE-275-MUD | 149.80 | 1.75 |
| P-RIM-275-CARBON | P-TIRE-275-TRAIL | 326.80 | 1.57 |
| P-RIM-275-CARBON | P-TIRE-275-MUD | 329.80 | 1.63 |

The rim drives the spread. P-RIM-275-ALLOY, an alloy rim, costs 40.00 EUR and weighs 0.48 kg. Procurement quotes P-RIM-275-CARBON, a carbon rim, at 220.00 EUR and 0.36 kg per rim.

Configuration engineering resolved two variants against the revised structure. V-WELL, the reference build (29-inch wheels, 9-speed drivetrain, alloy rims, trail tread, aluminum frame, black paint, hydraulic disc calipers), still rolls up to 8.95 kg and 1,164.80 EUR. V-275-TRAIL takes the same constraints with wheelSize 27.5 and rolls up to 8.74 kg and 1,147.60 EUR: the pair of 27.5-inch wheels is 17.20 EUR cheaper and 0.21 kg lighter than the 29-inch pair. The check for unsatisfied decisions returned nothing for either variant.

## Affected items

| Item | Description | Action | Where used | Qty | Unit cost (EUR) | Unit weight (kg) |
|---|---|---|---|---|---|---|
| A-WHEEL-275 | Built wheel, 27.5 inch | Add | Option of CG-WHEELSET | 2 per bike | – | – |
| CG-RIM-275 | Rim material choice for the 27.5 inch wheel | Add | Required by A-WHEEL-275 | 1 | – | – |
| CG-TIRE-275 | Tire tread choice for the 27.5 inch wheel | Add | Required by A-WHEEL-275 | 1 | – | – |
| P-SPOKE-275 | Stainless spoke for 27.5 inch wheel | Add | A-WHEEL-275 | 32 | 0.90 | 0.0065 |
| P-RIM-275-ALLOY | Rim, 27.5 inch, alloy | Add | Option of CG-RIM-275 | 1 | 40.00 | 0.48 |
| P-RIM-275-CARBON | Rim, 27.5 inch, carbon | Add | Option of CG-RIM-275 | 1 | 220.00 | 0.36 |
| P-TIRE-275-TRAIL | Tire, 27.5 inch, trail tread | Add | Option of CG-TIRE-275 | 1 | 36.00 | 0.66 |
| P-TIRE-275-MUD | Tire, 27.5 inch, mud tread | Add | Option of CG-TIRE-275 | 1 | 39.00 | 0.72 |
| P-HUB | Sealed-bearing hub | Where-used extended | A-WHEEL-26, A-WHEEL-275, A-WHEEL-29 | 1 | 42.00 | 0.34 |

## Corrections and open points

- Revision A wrongly listed P-RIM-29-ALLOY as an option of CG-RIM-275; the line was copied from the 29-inch structure and has been withdrawn.
- If 27.5 inches ever became the only size, MB1 would require A-WHEEL-275 directly; this notice keeps it an option of CG-WHEELSET.
- A plus-size tread, P-TIRE-275-PLUS, will be proposed as a third option of CG-TIRE-275 in a later notice, once clearance tests with 2.8-inch tires are complete. P-TIRE-275-PLUS is expected to cost about 48.00 EUR.

## Effectivity and disposition

The change is effective for MB1 orders acknowledged from April 6, 2026. Procurement will release purchase orders for P-SPOKE-275, the two rims and the two treads, and will raise the P-HUB forecast for a 27.5-inch share of about 40% of orders. Stock of 26-inch and 29-inch parts is unaffected.

## Approvals

| Role | Name | Signed |
|---|---|---|
| Originator, product engineering | Tomasz Brennan | March 2, 2026 |
| Configuration engineering | Ines Achterberg | March 5, 2026 |
| Cost engineering | Callum Reyes | March 6, 2026 |
| Quality | Martina Oduya | March 9, 2026 |
