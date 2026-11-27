---
domain: business-entities
genre: beneficial-ownership due-diligence memo
synthetic: true
note: Written for example 01 of relate-examples from the legal entities, people, trusts, addresses and reported parents in the sample data of Neo4j's business-entities package (studio-agent-use-cases at b76f767). Every person, company, trust, address and identifier is synthetic; the jurisdictions, the cities and the regulations cited are real.
---

# Beneficial ownership review: Larkspur Freight Ltd

**To:** Commercial Banking Onboarding Committee · **From:** Corporate KYC, Financial Crime Compliance · **Date:** 9 March 2026 · **Reference:** EDD-2026-0218 · **Risk rating:** high, enhanced due diligence

## Summary

Larkspur Freight Ltd has applied for a £6 million invoice-discounting facility, most of it secured on invoices owed by Pellingham Retail Ltd, a national retailer. The applicant's register of members names no individual above the 25 per cent threshold in regulation 5 of the Money Laundering Regulations 2017, but the register is not the answer. Behind the majority shareholder sit three offshore holding companies, a politically exposed person and the chief financial officer of the debtor's parent. We recommend that the committee defer the application until the conditions at the end of this memo are met.

## The applicant

Larkspur Freight Ltd is a private limited company incorporated in the United Kingdom on 5 October 2011 (company number 03655717, LEI RNDR00WY8XAEDRFTQJ11). The company's registered office is 217 Ash Avenue, London, and it runs its fleet from a depot in Tilbury.

The board of Larkspur Freight Ltd has two executive directors: Daniel Kershaw, who has served since incorporation and is also the chief executive officer, and Niamh Halvorsen, appointed on 2 March 2020. The register of members of Larkspur Freight Ltd lists three holders: Saint Ouen Investments Ltd with 80 per cent of the shares, Daniel Kershaw with 12 per cent and Takumi Lehmann with 8 per cent.

## The chain above Saint Ouen

The table follows the majority shareholder up to the natural person at the top. Each row is one direct holding, taken from the registers we obtained in Jersey, the Cayman Islands and the British Virgin Islands.

| Owner | Owner incorporated in | Company owned | Stake |
|---|---|---|---|
| Saint Ouen Investments Ltd | Jersey | Larkspur Freight Ltd | 80.0% |
| Blue Lantern Holdings Ltd | Cayman Islands | Saint Ouen Investments Ltd | 70.0% |
| Ashgrove Ventures Ltd | British Virgin Islands | Blue Lantern Holdings Ltd | 60.0% |
| Rodrigo Valente | (individual) | Ashgrove Ventures Ltd | 100.0% |

The minority holders sit one level up. Fiona Marchetti, a British national living in Bristol, holds the other 30 per cent of Saint Ouen Investments Ltd, and Gareth Holloway holds the other 40 per cent of Blue Lantern Holdings Ltd.

Saint Ouen Investments Ltd is a private limited company with its registered office at 174 Queen Way, St Helier. Blue Lantern Holdings Ltd, a privately held company, is registered at Seagrape Place, 88 Harbour Drive, George Town, a formation agent's address that ten other companies on our screening database share. Ashgrove Ventures Ltd is registered at Coralstone Chambers, 7 Wharf Cay Road, Road Town, which hosts 23 others. None of the three holding companies has an LEI.

Multiplying the stakes along each chain gives the effective interests in Larkspur Freight Ltd: Rodrigo Valente 33.6 per cent, Fiona Marchetti 24.0 per cent, Gareth Holloway 22.4 per cent, Daniel Kershaw 12.0 per cent and Takumi Lehmann 8.0 per cent. Rodrigo Valente is therefore the only beneficial owner by ownership. He is a Portuguese national resident at 35 Juniper Way, Madrid, and our screening provider lists him as a politically exposed person, so regulation 35 applies. Fiona Marchetti sits one point below the threshold; we would treat her as a beneficial owner if any arrangement with either of the others came to light.

## Control without ownership

None of the three holding companies is run by its owners:

- Marie-Claire Pillay is the sole director of Saint Ouen Investments Ltd, appointed on 10 October 2022, and holds 22 directorships on our database, half of them for companies incorporated in Seychelles.
- Desmond Ellery, of 2 Station Street, George Town, is the sole director of Blue Lantern Holdings Ltd and sits on 18 other boards, including nine more of the companies at Seagrape Place.
- Andreas Christodoulou has been the director of Ashgrove Ventures Ltd since 28 October 2024; he lives in Limassol and holds 27 seats, 19 of them on companies registered at Coralstone Chambers.

These are professional nominee directors. They explain why the companies have boards, not who instructs them.

## The link to the debtor

Gareth Holloway is an executive director and the chief financial officer of Pellingham Retail Group plc, the listed parent of our debtor. Pellingham Retail Group plc, a publicly held company, owns all of the shares in Pellingham Retail Ltd, its trading subsidiary. Pellingham Retail Ltd reports Pellingham Retail Group plc as both its direct and its ultimate parent. Pellingham Retail Ltd, a private limited company with the LEI BVDW001X3PJBPD909J29, is registered at 180 Canal Street, Birmingham.

Four steps therefore separate Pellingham Retail Group plc from Larkspur Freight Ltd: a board seat, then three shareholdings. The debtor confirmation that Pellingham Retail Ltd returned in January was signed by Gareth Holloway, of 24 Ash Avenue, Edinburgh, and declares no interest in our client. A connected debtor can confirm invoices for goods that were never delivered, so we treat the link as a credit risk as well as a conflict of interest.

## Read-across to Coastway Hotels Ltd

Desmond Ellery also sits on the board of Calloway Holdings Ltd, a private limited company incorporated in Guernsey and registered at 214 Juniper Lane, St Peter Port, which holds 45 per cent of Coastway Hotels Ltd, an existing client of the bank. Calloway Holdings Ltd is wholly owned by the Calloway Family Trust, an irrevocable trust established in Jersey on 12 August 2016. Edmund Calloway is the settlor of the Calloway Family Trust, and Harriet Calloway and Thomas Calloway are its beneficiaries. The sole trustee is Saltmarsh Trust Company Ltd, a Jersey trust company owned in equal shares by its two directors, Priya Kapoor and Mateo Nyberg. The other shareholders of Coastway Hotels Ltd are Victoria Lockhart, with 35 per cent, and Emma Fontaine, with 20 per cent.

Nothing in the Coastway file is wrong. A nominee director common to two client structures is still a link the committee should know about, and we have brought the periodic review of Coastway Hotels Ltd forward to April.

## What we could not establish

- Larkspur Freight Ltd does not report Saint Ouen Investments Ltd as its direct parent, and no LEI record names any parent for it; we have asked the company why.
- Daniel Kershaw claims that Desmond Ellery also sits on the board of Saint Ouen Investments Ltd, but the Jersey register lists only Marie-Claire Pillay.
- Blue Lantern Holdings Ltd may since have re-registered as a limited liability company; the Cayman extract we hold is dated 14 November 2025.
- Fiona Marchetti may hold a further stake in Blue Lantern Holdings Ltd through a nominee; the Cayman register we obtained does not show one.
- An earlier draft of this memo recorded Gareth Holloway as a director of Blue Lantern Holdings Ltd; that was wrong, and he is a shareholder only.
- Daniel Kershaw has said that Larkspur Freight Ltd will report Ashgrove Ventures Ltd as its ultimate parent at its next LEI renewal.

## Recommendation

Defer the application until we hold:

1. Certified identity and source-of-wealth evidence for Rodrigo Valente, and senior management approval for a relationship with a politically exposed person.
2. Certified registers of members and directors for Saint Ouen Investments Ltd, Blue Lantern Holdings Ltd and Ashgrove Ventures Ltd, and the name of whoever instructs their nominee directors.
3. Written confirmation that the board of Pellingham Retail Group plc knows of Gareth Holloway's interest.

If the facility then goes ahead, invoices owed by Pellingham Retail Ltd should be capped at 20 per cent of the eligible ledger.
