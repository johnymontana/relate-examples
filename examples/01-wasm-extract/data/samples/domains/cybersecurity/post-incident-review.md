---
domain: cybersecurity
genre: post-incident review
synthetic: true
note: Written for example 01 of relate-examples, under its curated Cybersecurity ontology, after create-context-graph's incident report template (707b168). Every person, organisation, host, account, alert, incident, control, threat actor, malware family other than Mimikatz and Rclone, and indicator is fictional, and the IP addresses are from the documentation ranges. The CVE and MITRE ATT&CK identifiers, the products they describe, Mimikatz, Rclone and the city are real.
---

# Post-incident review: INC-2025-0031, VPN appliance compromise and data theft

**From:** Maya Okafor, Security Operations · **To:** Chief Information Security Officer and IT Risk Committee, Kellmere Logistics · **Date:** 14 March 2025 · **Reference:** PIR-2025-004 · **Classification:** internal

## Summary

Between 17 and 20 February 2025 an intruder broke into a remote-access appliance, moved to our file servers and copied 38 GB of customer shipping manifests out of the network. INC-2025-0031 was opened at 23:31 on 19 February, contained at 21:40 on 20 February and closed on 3 March. No ransomware was deployed and nothing was encrypted. INC-2025-0031 is attributed to Pale Cormorant, a data-extortion group, with moderate confidence. The intrusion was possible because a rebuilt appliance came back without the vendor's mitigation, and it ran for two days because the first alert was closed as noise. The incident commander rated INC-2025-0031 SEV2. This review is blameless: it describes decisions, not people at fault.

## The response team

INC-2025-0031 was led by Maya Okafor as incident commander. Leila Haddad, a tier-2 SOC analyst, ran the forensic work on the servers; Tomasz Wierzbicki, a tier-1 analyst, handled the first alert; and Hannah Ferris, the threat intelligence lead, made the attribution.

## How the intruder got in

VPN-GW-02 is the secondary Ivanti Connect Secure gateway in our Leeds data centre. It failed in December 2024 and was rebuilt from a configuration export taken in January 2024, before the vendor's fixes were applied. CVE-2023-46805 and CVE-2024-21887 both affect VPN-GW-02 as rebuilt: the first is an authentication bypass, the second a command injection, and together they let an unauthenticated attacker run commands on the appliance. CTL-019, the vendor's mitigation file for the gateways, mitigates CVE-2023-46805 and CVE-2024-21887, but importing the old configuration removed it, and nothing checked that it was still there. CVE-2023-46805 carries a CVSS score of 8.2. CVE-2024-21887 carries a CVSS score of 9.1. CVE-2024-21887 does not affect VPN-GW-01, which ran a patched release throughout.

The exploit reached the appliance from 198.51.100.77 at 22:58 on 17 February. A Tidecaller web shell was found on VPN-GW-02, planted that night according to its file timestamps.

## Detection and triage

ALR-77120 fired on VPN-GW-02 at 02:41 on 18 February, when the appliance's integrity checker reported eleven files it did not recognise. ALR-77120 was triaged by Tomasz Wierzbicki, who closed it as a known false positive: an upgrade earlier that month had raised the same message. The integrity checker had rated ALR-77120 low. That decision followed our runbook at the time, and the runbook was wrong.

From the appliance, the intruder read the stored password of svc-vpnldap, the service account that binds the gateways to the directory. On the evening of 19 February svc-vpnldap accessed FS-ARCH-01 over RDP from the appliance's internal address. ALR-77134, an EDR alert for LSASS memory access on FS-ARCH-01, detected T1003.001 (LSASS Memory) at 23:05. The EDR rated ALR-77134 high. ALR-77134 was triaged by Leila Haddad and escalated to INC-2025-0031 at 23:31.

| Alert | Raised | Fired on | Detected | Triaged by | Outcome |
|---|---|---|---|---|---|
| ALR-77120 | 18 Feb 02:41 | VPN-GW-02 | unknown files | Tomasz Wierzbicki | closed as a false positive |
| ALR-77134 | 19 Feb 23:05 | FS-ARCH-01 | T1003.001 | Leila Haddad | escalated |
| ALR-77152 | 20 Feb 14:22 | FS-ARCH-01 | T1567.002 | Leila Haddad | added to INC-2025-0031 |

## What the intruder did

Leila Haddad's image of FS-ARCH-01 holds most of the story. Mimikatz and Rclone were found on FS-ARCH-01 in a folder named after a printer driver. The dumped memory held the credentials of adm-dbrennan, a domain administrator account. With them the intruder logged on to DC-02 at 00:47 on 20 February and exported the directory's users and groups. From 13:50 that day Rclone uploaded the compressed manifest archive to a cloud storage account; ALR-77152, a web proxy alert, came at 14:22, when most of it had already gone.

INC-2025-0031 impacted three hosts: VPN-GW-02, FS-ARCH-01 and DC-02. Two accounts were compromised in INC-2025-0031, svc-vpnldap and adm-dbrennan. CTL-027, our endpoint detection and response service, protects FS-ARCH-01 and DC-02; without it we would not have seen the intruder at all.

## Containment and recovery

At 21:40 on 20 February we took VPN-GW-02 offline, disabled both accounts and blocked 198.51.100.77 and 203.0.113.18 at the firewall. Both addresses were observed in INC-2025-0031, and they have been shared with our sector's information-sharing group with the file hash below.

| Indicator | Type | Associated with | Where we saw it |
|---|---|---|---|
| 198.51.100.77 | IPv4 | Tidecaller | exploit traffic and web shell commands |
| 203.0.113.18 | IPv4 | no known family | the upload destination |
| 69c7cbe9342d1d134b6091df573465ec51fd7257933d4f5cfd6fd99212735a4e | SHA-256 | Tidecaller | the web shell file on VPN-GW-02 |

VPN-GW-02 was rebuilt from the vendor's current image, every credential the appliance held was rotated, and FS-ARCH-01 and DC-02 were restored from backups taken before 17 February.

## Attribution

Hannah Ferris attributes INC-2025-0031 to Pale Cormorant on three grounds:

- Pale Cormorant deploys Tidecaller on the appliances it breaks into, and no other group is known to use it.
- 198.51.100.77 is associated with Tidecaller as its command-and-control address in two earlier intrusions.
- Pale Cormorant exploits CVE-2023-46805 and CVE-2024-21887 together, as here, and has done since early 2024.

A commercial feed alleges that Pale Cormorant deploys Brinehold ransomware once it has the data; we found no trace of Brinehold ransomware on any host.

## What we could not establish

- ALR-77152 is expected to be rerated critical at the next severity review.
- The intruder may also have accessed DC-02 with svc-vpnldap, but the domain controller's logs for that hour rolled over before we collected them.
- The first draft of the timeline said that ALR-77120 was escalated to INC-2025-0031; it was not, and that is the central finding of this review.
- If it had been re-imported after the rebuild, CTL-019 would have protected VPN-GW-02 and the exploit would have failed.

## Actions

1. After any restore, check every gateway for CTL-019 or the vendor's fixed release before it goes back into service. Owner: network engineering, by 31 March.
2. Escalate integrity-checker alerts on internet-facing appliances to tier 2; tier 1 no longer closes them.
3. CTL-031, privileged access tiering, will protect DC-02 from April, so that domain administrator accounts never log on to file servers.
4. Replace svc-vpnldap with a managed service account whose password rotates every 30 days.
5. ALR-77152 is expected to be rerated critical at the next severity review.
