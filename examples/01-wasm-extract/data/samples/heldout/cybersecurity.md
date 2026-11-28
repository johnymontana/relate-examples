---
domain: cybersecurity
genre: vulnerability advisory
synthetic: true
note: Written for example 01 of relate-examples, under its curated Cybersecurity ontology, after create-context-graph's vulnerability advisory template (707b168); a held-out document, a different organisation and case from the post-incident review. Every person, organisation, host, alert, control and indicator is fictional, and the IP address is from a documentation range. CVE-2024-3400, the product it affects, the MITRE ATT&CK identifiers and the cities are real.
---

# Security advisory SA-2024-011: CVE-2024-3400 in PAN-OS GlobalProtect

**From:** Nadia Rahman, Vulnerability Management · **To:** Network Engineering, the Service Desk and IT Risk, Brackwell Engineering · **Date:** 17 April 2024 · **Reference:** SA-2024-011 · **Priority:** P1, patch within 48 hours

## Summary

CVE-2024-3400 is a command injection flaw in the GlobalProtect feature of Palo Alto Networks PAN-OS. An unauthenticated attacker who can reach a GlobalProtect portal or gateway can send a crafted request and run commands as root on the firewall. CVE-2024-3400 carries a CVSS score of 10.0, the top of the CVSS scale; it has been exploited in the wild since late March, and CISA added it to the Known Exploited Vulnerabilities catalogue on 12 April. CVE-2024-3400 affects FW-EDGE-01 and FW-EDGE-02, our two internet-facing firewalls, which both run PAN-OS 11.1.2 with GlobalProtect enabled. We have no evidence that either has been compromised, but one exploitation attempt has already reached FW-EDGE-02.

## Affected and unaffected assets

| Asset | Role | PAN-OS | GlobalProtect | Status |
|---|---|---|---|---|
| FW-EDGE-01 | head office internet edge, Derby | 11.1.2 | portal and gateway | affected |
| FW-EDGE-02 | data centre internet edge, Nottingham | 11.1.2 | gateway | affected |
| FW-LAB-01 | engineering lab | 10.1.11 | not configured | not affected |

CVE-2024-3400 does not affect FW-LAB-01, which runs PAN-OS 10.1 and has no GlobalProtect configuration. The vendor's management and cloud services are outside the scope of the flaw, and so are our remote sites, which reach the internet through the two edge firewalls.

## Exploitation and detection

Public reporting describes attackers using T1190 (Exploit Public-Facing Application) against the GlobalProtect interface, then T1059.004 (Unix Shell) to install a backdoor and copy the firewall's running configuration. Working exploit code is now public, so we expect scanning to grow over the coming week.

ALR-40218 fired on FW-EDGE-02 at 06:12 on 13 April, when the threat log recorded a request from 203.0.113.61 that matched the vendor's exploit signature. The firewall rated ALR-40218 medium. ALR-40218 detected T1190 and was triaged by Owen Mbeki of the SOC. He found no follow-on activity: no new files under the GlobalProtect directories, no unexpected outbound connections and no change to the configuration. The alert stays open while the forensic check below runs. 203.0.113.61 is now blocked at both edges, and teams with their own internet links should search their logs for it.

## Mitigation

CTL-022, Threat Prevention with vulnerability protection applied to the GlobalProtect interfaces, mitigates CVE-2024-3400 until the hotfix is installed. Network Engineering switched it on during the night of 12 April, and CTL-022 now protects FW-EDGE-01 and FW-EDGE-02. CTL-022 will protect FW-LAB-01 as well once the lab's Threat Prevention licence is renewed in May.

Our first notice, sent on 12 April, said that CTL-035, which turns off device telemetry, mitigates CVE-2024-3400; the vendor has since withdrawn that advice, and CTL-035 should not be relied on for this flaw.

## Remediation

1. Install the PAN-OS 11.1.2-h3 hotfix on FW-EDGE-02 on 18 April and on FW-EDGE-01 on 19 April, in the emergency change windows. Owner: Network Engineering.
2. Before and after each upgrade, generate a tech support file and run the vendor's check for signs of compromise. Owner: the SOC.
3. Keep CTL-022 in place after the hotfix; it costs little and will catch the next variant.
4. If either firewall shows signs of compromise, take it out of service and rotate every credential, key and certificate it holds before it returns.

## Why P1

Both firewalls face the internet, exploitation needs no credentials, and the attempt on FW-EDGE-02 shows that we are already being probed. Questions about this advisory go to Nadia Rahman; questions about the change windows go to Network Engineering.
