---
domain: patient-journey
genre: referral letter
synthetic: true
note: Written for example 01 of relate-examples as a held-out general practice referral letter (a different patient and case from the care summary), from one patient's records in the sample data of Neo4j's patient-journey package (studio-agent-use-cases at b76f767), with its names, encounter and result identifiers and readings. Every patient and clinician is synthetic; the organisations are the package's sample data, and the conditions, medicines and measurements are real vocabulary.
---

# Referral: Patricia Lopez, type 2 diabetes on insulin with hypertension

**From:** Dr Lyle Dibbert, General Practice, PCP1477, Springfield, Massachusetts · **To:** Consultant in Endocrinology, Milford Regional Medical Center · **Date:** 24 April 2017 · **Reference:** encounter e36baea2

**Patient:** Patricia Lopez · **Born:** 21 April 1943 · **Record ID:** e6e0a44e-874d-452b-b8cd-8ad7dc8b11a5

Dear colleague,

I would be grateful if you would see Mrs Patricia Lopez, 74, who has had type 2 diabetes treated with insulin since 2006 and hypertension since 2008. I saw Mrs Lopez at encounter e36baea2, classed as wellness, on 17 April 2017. Her care has been spread across four organisations, so I have put the shared record together below. Encounters are cited by the first eight characters of their record ID.

## Diagnoses

- diabetes mellitus type 2, first diagnosed at encounter 0635890a on 25 September 2006
- hypertension, first diagnosed at encounter 16ec0853 on 26 November 2008

## Encounters

| Encounter | Date | Class | Clinician | Organisation |
|---|---|---|---|---|
| 0635890a | 25 Sep 2006 | outpatient | Lyle Dibbert | PCP1477 |
| 16ec0853 | 26 Nov 2008 | outpatient | Wilton Pollich | Milford Regional Medical Center |
| 2254d707 | 9 Sep 2012 | emergency | Martha Ledner | PCP9022 |
| 1571c16e | 25 Jan 2017 | outpatient | Sondra Botsford | VA Boston Healthcare System |
| e36baea2 | 17 Apr 2017 | wellness | Lyle Dibbert | PCP1477 |

## History

Mrs Lopez was seen at encounter 0635890a, classed as outpatient, on 25 September 2006. Encounter 0635890a diagnosed diabetes mellitus type 2, and insulin isophane was prescribed there. Hypertension may have been present at encounter 0635890a as well, but it was not diagnosed until two years later.

Encounter 0635890a was followed by encounter 16ec0853 at Milford Regional Medical Center. Dr Wilton Pollich diagnosed hypertension at encounter 16ec0853 and started hydrochlorothiazide. Encounter 16ec0853 recorded obs-n001476, a systolic blood pressure of 171 mmHg, and obs-n001908, a body weight of 85.9 kg. Lisinopril was not prescribed at encounter 16ec0853.

Her next encounter was an emergency attendance at PCP9022 on 9 September 2012. Encounter 2254d707, classed as emergency, was attended by Dr Martha Ledner. Hypertension and diabetes mellitus type 2 were both recorded at encounter 2254d707, which prescribed hydrochlorothiazide, insulin isophane and lisinopril. Encounter 2254d707 recorded obs-n001861, a body weight of 120.6 kg. Mrs Lopez believes she was also given metformin at encounter 2254d707, but the PCP9022 record does not show it.

Encounter 2254d707 was followed by encounter 1571c16e on 25 January 2017. Encounter 1571c16e, classed as outpatient, took place at VA Boston Healthcare System. Dr Sondra Botsford attended encounter 1571c16e. It recorded obs-n001321, a diastolic blood pressure of 99 mmHg, and obs-n003266, a body weight of 64.1 kg. Hypertension was diagnosed again at encounter 1571c16e, and hydrochlorothiazide and lisinopril were prescribed again.

Encounter 1571c16e was followed by encounter e36baea2 last week. At encounter e36baea2, hypertension was recorded again. I did not change her medicines.

## Measurements

| Result | Encounter | Measure | Value | Units |
|---|---|---|---|---|
| obs-n001476 | 16ec0853 | systolic blood pressure | 171 | mmHg |
| obs-n001908 | 16ec0853 | body weight | 85.9 | kg |
| obs-n001861 | 2254d707 | body weight | 120.6 | kg |
| obs-n001321 | 1571c16e | diastolic blood pressure | 99 | mmHg |
| obs-n003266 | 1571c16e | body weight | 64.1 | kg |

The three weights cannot all be right, and I have asked her to be weighed at your clinic.

## Clinicians

Dr Wilton Pollich works at Milford Regional Medical Center, Dr Martha Ledner at PCP9022 and Dr Sondra Botsford at VA Boston Healthcare System. Dr Pollich, Dr Ledner and Dr Botsford are all listed under General Practice, as I am.

## What I am asking

1. A review of her insulin isophane dose once her weight is confirmed. The shared record holds no HbA1c.
2. Advice on her blood pressure, since her diastolic reading at VA Boston Healthcare System was 99 mmHg.
3. Screening for the complications of long-standing diabetes.

Yours sincerely,

Dr Lyle Dibbert, General Practice, PCP1477
