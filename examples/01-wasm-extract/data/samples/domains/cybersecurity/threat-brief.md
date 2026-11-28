---
domain: cybersecurity
genre: threat intelligence brief
synthetic: true
note: Written for example 01 of relate-examples, under its curated Cybersecurity ontology, after create-context-graph's threat intelligence brief template (707b168); a companion to the post-incident review PIR-2025-004. Every person, organisation, host, incident, threat actor, malware family other than Mimikatz and Rclone, and indicator is fictional; the IP addresses are from the documentation ranges and the domain is under example.net. The CVE and MITRE ATT&CK identifiers, the products they describe, Mimikatz and Rclone are real.
---

# Threat intelligence brief: Pale Cormorant

**From:** Hannah Ferris, Threat Intelligence · **To:** Security Operations, Kellmere Logistics · **Date:** 3 March 2025 · **Reference:** TIB-2025-007 · **TLP:** AMBER

## Key judgements

- Pale Cormorant is a financially motivated data-extortion group, active since 2023, that steals data and threatens to publish it.
- INC-2025-0031, the February intrusion at Kellmere Logistics, is attributed to Pale Cormorant. We hold that judgement with moderate confidence.
- We expect another attempt on our edge appliances this quarter, most likely against whichever gateway is patched last.

## How it gets in

Pale Cormorant exploits CVE-2023-46805 to bypass authentication on Ivanti Connect Secure gateways, then exploits CVE-2024-21887 to run commands on them, usually within days of an unpatched appliance becoming reachable from the internet. CVE-2024-21887 carries a CVSS score of 9.1. Pale Cormorant may also exploit CVE-2024-21762 in FortiOS, but the two reports that say so share one source, and we rate the claim as unconfirmed.

## What it runs

Pale Cormorant deploys Tidecaller, a small web shell written for VPN appliances, as its foothold. It then dumps credentials with Mimikatz and moves stolen archives out with Rclone: in every case we can verify, Pale Cormorant deploys Mimikatz and Rclone rather than tools of its own. One vendor alleges that Pale Cormorant deploys Brinehold ransomware against victims who refuse to pay; we have not seen Brinehold in any case we can check.

Pale Cormorant uses T1190 (Exploit Public-Facing Application) to get in, T1505.003 (Web Shell) to stay in, T1003.001 to take credentials and T1567.002 (Exfiltration to Cloud Storage) to take data. Pale Cormorant does not use T1486: in eleven reported cases it has never encrypted a victim's files.

## Indicators

| Indicator | Type | Associated with | First seen |
|---|---|---|---|
| 198.51.100.77 | IPv4 | Tidecaller | November 2024 |
| 198.51.100.140 | IPv4 | Tidecaller | January 2025 |
| update-relay.example.net | domain | Tidecaller | January 2025 |

198.51.100.77 was observed in INC-2025-0031, where it sent the exploit to VPN-GW-02 and, later, the web shell's commands. The response team rated INC-2025-0031 SEV2. In that incident Tidecaller was found on VPN-GW-02 within an hour of the exploit.

## Recommendations

1. Search DNS logs for update-relay.example.net back to 1 November 2024.
2. Keep CTL-019 checked on every gateway after each change: CTL-019 mitigates CVE-2023-46805 and CVE-2024-21887 only while it is installed.
3. Alert on any process that reads LSASS memory on a server, not only on workstations.
