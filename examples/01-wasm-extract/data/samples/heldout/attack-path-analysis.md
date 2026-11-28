---
domain: attack-path-analysis
genre: red-team exercise summary
synthetic: true
note: Written for example 01 of relate-examples from the endpoints, hosts, vulnerabilities, identities, policies and cloud resources in the sample data of Neo4j's attack-path-analysis package (studio-agent-use-cases at b76f767), so its facts agree with those records; a different case from the penetration test report. Northwind, its hosts, identities, policies, resources and applications, the red team and the exercise are synthetic, and northwind.example is a reserved domain. The CVE identifiers and the flaws they name are real; their CVSS and EPSS scores are the package's sample values.
---

# Red-team exercise RT-2026-07 "Backorder": summary

**To:** Chief Information Security Officer, Northwind · **From:** Red Team Lead, Security Engineering · **Date:** 20 November 2026 · **Reference:** RT-2026-07 · **Exercise window:** 2 to 13 November 2026

## Objective

The exercise asked one question: can an outside attacker reach restricted backup data without going near the payment estate that penetration test NW-PT-2026-014 covered? The red team started with no credentials and used only the commerce, mail and status endpoints. The blue team knew an exercise was running but not where. The objective was met on 6 November, day five.

## Routes attempted

| Route | Entry endpoint | First host | Vulnerability | CVSS | Outcome |
|---|---|---|---|---|---|
| A | api.northwind.example | web-front-01 | CVE-2024-2961 | 8.8 | Objective reached |
| B | mail.northwind.example | mail-relay-01 | CVE-2023-38545 | 8.1 | No foothold |
| C | status.northwind.example | monitoring-01 | CVE-2022-40982 | 5.5 | Not remotely exploitable |

## Route A: from the storefront API to the backups

api.northwind.example resolves to web-front-01 and web-front-02, the two web-tier hosts of Order Management. web-front-01 is vulnerable to CVE-2024-2961, the glibc iconv overflow, rated high (EPSS 0.02), which the team reached through the API's image filter on 4 November.

web-front-01 runs as svc-web-front, and svc-web-front holds shared-config-read. shared-config-read grants access to shared-config, an internal bucket in which the team found the password for the orders database.

web-front-01 can reach app-orders-01 and app-orders-02 on port 8443. app-orders-01 hosts Order Management and is vulnerable to CVE-2023-29491, a local ncurses flaw (CVSS 7.8, high) that gave the team root on 5 November. app-orders-01 runs as svc-app-orders, which holds order-events-write. order-events-write grants access to order-event-stream, so the team could also have forged order events.

app-orders-01 can reach db-orders-01 on port 5432. With the password from the bucket, the team logged in to the orders database and ran commands as the database's service account. db-orders-01, which runs as svc-db-backup, carries the same CVE-2023-29491. svc-db-backup holds backup-bucket-write, and backup-bucket-write grants access to db-backups, Northwind's restricted backup store. The team wrote a marker file to db-backups at 15:40 on 6 November and read nothing.

## Routes B and C

mail.northwind.example (port 25) and sftp.northwind.example (port 22) both resolve to mail-relay-01. mail-relay-01 is vulnerable to CVE-2023-38545, rated high, but the curl SOCKS5 overflow needs the host to fetch through a hostile proxy, and the team could not make it do so. mail-relay-01 can reach monitoring-01 on port 443, so a foothold there would have been worth having.

status.northwind.example resolves to monitoring-01, which hosts Status Page. The host's one finding, CVE-2022-40982, rated medium, is a local CPU side channel and was not attempted. monitoring-01 can reach app-orders-01, app-payments-01 and db-orders-01 on port 9100, and runs as svc-monitoring. svc-monitoring holds only metrics-read, which grants access to platform-metrics and to Status Page. monitoring-01 cannot reach db-payments-01.

## Detection

- 4 November: the blue team saw the API errors from web-front-01 and closed them as a failed deployment.
- 5 November: the read of shared-config raised a low-severity alert, which no one reviewed.
- 6 November: nothing fired when the database host wrote to db-backups.

## Open questions

- web-front-02 may also be vulnerable to CVE-2024-2961; the scanner record covers web-front-01 only, and the team did not test the second host.
- Northwind plans to move Inventory Sync onto app-orders-02 next quarter, which would put a second application on route A.

## Recommendations

1. Patch CVE-2024-2961 on both web-tier hosts and confirm the scanner covers web-front-02.
2. Move database passwords out of shared-config into the secrets vault.
3. Restrict backup-bucket-write to the backup job's own prefix, and alert on any other writer.
4. Route the low-severity cloud-storage alerts to a reviewed queue.
