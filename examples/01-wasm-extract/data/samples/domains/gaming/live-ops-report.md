---
domain: gaming
genre: live-ops incident report
synthetic: true
note: Written for example 01 of relate-examples, under its curated Gaming ontology, after create-context-graph's patch notes and player report templates (707b168). The game, every player handle, character, guild, item, quest, zone, patch, exploit and case number is fictional, and nothing here describes a real game or a real player; the terms of the trade (realm, hotfix, realm first) are the industry's own.
---

# Live-ops incident report: the Kindling Loop (EXP-2026-031) and Patch 7.3.2

**From:** Live Operations, Thornwake Online · **To:** Game Design, Community, Customer Support · **Date:** 2 July 2026 · **Reference:** LO-IR-2026-019 · **Severity:** S1

## Summary

From 14 to 23 June 2026, a damage loop let small groups defeat the final encounter of the Hollow Forge in under forty seconds. We track it as EXP-2026-031, and players soon called it the Kindling Loop. Patch 7.3.2, the balance patch that reached every realm on 24 June 2026, fixed EXP-2026-031. The loop was abused knowingly by three accounts, which have been sanctioned, and the achievement their characters earned with it has been revoked. The raid's loot economy was barely touched, because the loop shortened kills rather than repeating them, but it decided the realm-first race on two EU realms, and that is why this report is rated S1.

## How the loop worked

The Ember Tithe, a weekly quest given in Cinderfall Basin, rewards the Cinderbrand Talisman. The talisman is an epic trinket whose on-use effect deals fire damage and refunds its own cooldown when it strikes a burning target. Kindled Vestments, the raid's four-piece armour set, sets a target burning on every critical hit. EXP-2026-031 uses the Cinderbrand Talisman and the four-piece bonus of Kindled Vestments together: with both equipped, every critical hit reset the talisman, and a pyromancer with a high critical chance could fire it eleven times a second.

The loop paid off only in the Hollow Forge, because the arena of its final encounter keeps every target burning. Elsewhere the refund fired a few times a minute at most, which is why internal testing never caught it.

## Timeline

- 11 June: Tessellate9 reported the Gatehouse Clip (EXP-2026-027), a geometry clip in the Hollow Forge that let groups skip the gatehouse and its two mini-bosses.
- 12 June 2026: Hotfix 7.3.1a went live. It closed the clip within the hour.
- 14 June: Vexmora and Ostrid unlocked the Forge Undone achievement, awarded for the final encounter, with a kill of 38 seconds that was also the first on their realm.
- 16 June: Morrowgale reported EXP-2026-031 through the in-game bug report, with a combat log attached.
- 19 June: Kaelith unlocked the Forge Undone achievement with a pick-up group.
- 21 June: Lirien, Morrowgale's pyromancer, unlocked the Forge Undone achievement while reproducing the loop for our support team.
- 24 June: Patch 7.3.2 reached every realm, and the loop stopped.
- 26 June: the sanctions below took effect.

## The accounts

Only four characters reset the talisman more than fifty times in one fight. The table lists them with the accounts that play them.

| Account | Character | Class and level | Guild | Most resets in one fight |
|---|---|---|---|---|
| Nightjar77 | Vexmora | pyromancer, 60 | Ashen Covenant | 412 |
| AshfallCorvid | Ostrid | pyromancer, 60 | Ashen Covenant | 268 |
| Brannoch42 | Kaelith | pyromancer, 60 | Grey Tide | 97 |
| Morrowgale | Lirien | pyromancer, 60 | Lantern Watch | 64 |

Nightjar77 plays Vexmora and leads Ashen Covenant. Ostrid, played by AshfallCorvid, is the guild's other pyromancer. Kaelith is a member of Grey Tide, a weekend raiding guild, and Brannoch42 found the loop in a forum video. Lirien is not a member of Ashen Covenant; she raids with Lantern Watch and joined one of Ashen Covenant's runs as a guest.

Vexmora, Ostrid and Kaelith completed The Ember Tithe in its first week, the only way to get the talisman before the raid opened. In every flagged kill, Vexmora equipped the Cinderbrand Talisman and all four pieces of Kindled Vestments. Ostrid and Kaelith equipped the Cinderbrand Talisman too, with three pieces of the set and a crafted fourth.

Nightjar77, AshfallCorvid and Brannoch42 abused EXP-2026-031 knowingly: each kept using it after their realm's forum had posted it as a bug, and two of them asked guildmates in chat not to report it. Morrowgale's resets all came from the reproduction runs behind her report, and we treat her as the reporter, not an abuser. Nightjar77 had also abused EXP-2026-027 on two runs on 11 June, the day before it was closed. A forum thread alleges that Grimhollow abused EXP-2026-031 on an NA realm; our logs show no more than five resets in any fight for that account's characters.

## Patch 7.3.2

Patch 7.3.2 fixed EXP-2026-031 by giving the talisman's refund an internal cooldown of 20 seconds. Because it was already a balance patch, it also retuned the items the loop had exposed. Patch 7.3.2 changed the Cinderbrand Talisman. Its on-use damage is down 18%, and its cooldown rises from 30 to 45 seconds. The notes for the other changes read as follows.

- Kindled Vestments: the four-piece bonus now sets a target burning on one critical hit in three.
- The Ember Tithe: rewards the Cinderbrand Talisman once per account, not once per character.

Patch 7.4.0 is expected to reach the live servers on 15 July 2026 and will change the Cinderbrand Talisman again, returning part of the lost damage to pyromancers who never used the loop. An earlier draft of this report said that Hotfix 7.3.1a fixed EXP-2026-031; that was wrong, since the hotfix touched only the gatehouse geometry.

## Enforcement

| Case | Account | Action | Issued for | Revoked |
|---|---|---|---|---|
| ENF-30117 | Nightjar77 | permanent ban | EXP-2026-031, EXP-2026-027 | Forge Undone |
| ENF-30118 | AshfallCorvid | 30-day suspension | EXP-2026-031 | Forge Undone |
| ENF-30119 | Brannoch42 | 14-day suspension | EXP-2026-031 | Forge Undone |

ENF-30117 was issued to Nightjar77 on 26 June 2026 for both EXP-2026-031 and EXP-2026-027, and it is a permanent ban because the account had served a suspension in 2025. ENF-30118 and ENF-30119, the two suspensions, were issued for EXP-2026-031 alone. ENF-30118 suspends AshfallCorvid for 30 days. ENF-30119 runs for 14 days. ENF-30118 revoked the Forge Undone achievement from Ostrid, and ENF-30119 revoked it from Kaelith; on each realm the realm-first title passes to the next group that killed the encounter without the loop. If the support team confirms that the 21 June kill used the loop, ENF-30124 would revoke Forge Undone from Lirien as well, with no other penalty. Morrowgale may also have reported EXP-2026-027 a day before Tessellate9, but that ticket came from a shared household account and we could not match it.

## What we are changing

1. Raise a combat-log alarm for any cooldown that resets more than ten times in five seconds.
2. Test every on-use trinket against every set bonus of the raid it drops alongside, before the raid opens.
3. Publish the realm-first corrections on 3 July, with the summary of this report.
4. Review the 21 June kill and close ENF-30124 either way by 10 July.
