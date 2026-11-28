---
domain: patient-journey
genre: longitudinal care summary
synthetic: true
note: Written for example 01 of relate-examples from one patient's records in the sample data of Neo4j's patient-journey package (studio-agent-use-cases at b76f767), with its names, encounter and result identifiers, codes and readings. Every patient and clinician is synthetic; the organisations and their towns are the package's sample data, and the conditions, medicines and their SNOMED CT, RxNorm and LOINC codes are real vocabulary.
---

# Longitudinal care summary: Andrew Krajcik

**From:** Care Coordination, Milford Regional Medical Center · **To:** Dr Wilton Pollich, General Practice · **Copy:** PCP1477, PCP9022 and VA Boston Healthcare System · **Date:** 19 February 2024 · **Reference:** LCS-2024-0219

**Patient:** Andrew Krajcik · **Born:** 1 October 1951 · **Record ID:** e2bf66a2-2766-4fa4-978f-f9e8c6e18f93

Encounters are cited by the first eight characters of their record ID, and results by their result ID.

## Why this summary

Andrew Krajcik, 72, has lived with coronary heart disease and hypertension for almost fifteen years. In that time his care has passed through five encounters, four clinicians and four organisations, and each organisation's record holds only its own part of the pathway. This summary joins the records together in date order ahead of his post-discharge review, and sets out three gaps that only the joined record shows.

## Encounters at a glance

| Encounter | Date | Class | Attended by | Organisation | Followed by |
|---|---|---|---|---|---|
| 039551b6 | 8 Jun 2009 | emergency | Lyle Dibbert | PCP1477 | b97c8e64 |
| b97c8e64 | 10 Jan 2011 | wellness | Martha Ledner | PCP9022 | ae5a4a36 |
| ae5a4a36 | 27 Nov 2017 | wellness | Wilton Pollich | Milford Regional Medical Center | 4b541b7c |
| 4b541b7c | 10 Jul 2019 | outpatient | Sondra Botsford | VA Boston Healthcare System | 8214f803 |
| 8214f803 | 2 Feb 2024 | inpatient | Wilton Pollich | Milford Regional Medical Center | (latest) |

## Problem list

- coronary heart disease (SNOMED CT 53741008), first diagnosed at encounter 039551b6 on 8 June 2009
- hypertension (SNOMED CT 59621000), first diagnosed at encounter 039551b6 on 8 June 2009

## The pathway

### 2009: an emergency attendance at PCP1477

Mr Krajcik was first seen at encounter 039551b6, classed as emergency, at PCP1477 on 8 June 2009. Encounter 039551b6 was attended by Dr Lyle Dibbert. Dr Dibbert works at PCP1477 and is listed under General Practice. Encounter 039551b6 diagnosed coronary heart disease and hypertension. Three medicines were prescribed there: clopidogrel, lisinopril and hydrochlorothiazide. The shared record holds no blood pressure from that attendance.

### 2011: a wellness review at PCP9022

On 10 January 2011, encounter 039551b6 was followed by encounter b97c8e64. Andrew Krajcik was seen at encounter b97c8e64, classed as wellness, by Dr Martha Ledner. Dr Ledner works at PCP9022. The review recorded obs-n001985, a systolic blood pressure of 158 mmHg, well above target. Coronary heart disease was recorded again at encounter b97c8e64. At encounter b97c8e64, Dr Ledner continued clopidogrel and added a nitroglycerin spray for use as needed. Lisinopril and hydrochlorothiazide were not prescribed at encounter b97c8e64, and the record does not say whether he was still taking them.

### 2017: a wellness visit at Milford Regional Medical Center

After almost seven years without a recorded encounter, encounter b97c8e64 was followed by encounter ae5a4a36. Mr Krajcik was seen at encounter ae5a4a36, classed as wellness, on 27 November 2017 for his annual review. Dr Wilton Pollich attended encounter ae5a4a36. Dr Pollich works at Milford Regional Medical Center. Encounter ae5a4a36 recorded obs-n002059, a systolic blood pressure of 129 mmHg and the best reading on record. At encounter ae5a4a36, hypertension was diagnosed and hydrochlorothiazide and lisinopril were prescribed again.

### 2019: an outpatient review at VA Boston

On 10 July 2019, encounter ae5a4a36 was followed by encounter 4b541b7c. Encounter 4b541b7c, classed as outpatient, took place at VA Boston Healthcare System. He was seen there by Dr Sondra Botsford, a general practitioner at VA Boston Healthcare System. Dr Botsford recorded hypertension again and continued hydrochlorothiazide on its own. According to the patient, clopidogrel was also prescribed at encounter 4b541b7c; the VA Boston medication list does not show it. No blood pressure was taken at that visit.

### 2024: an inpatient admission at Milford Regional Medical Center

After four and a half years, encounter 4b541b7c was followed by encounter 8214f803. Andrew Krajcik was admitted to Milford Regional Medical Center under Dr Wilton Pollich at encounter 8214f803, classed as inpatient, on 2 February 2024. The admission began in the emergency department, and encounter 8214f803 may first have been coded as emergency. Encounter 8214f803 recorded obs-n000689, a systolic blood pressure of 143 mmHg on admission. Coronary heart disease and hypertension were both diagnosed again at encounter 8214f803. Encounter 8214f803 prescribed all four of his medicines together for the first time: clopidogrel, lisinopril, hydrochlorothiazide and the nitroglycerin spray.

## Medicines

| Medicine | RxNorm | First prescribed at | Latest prescribed at |
|---|---|---|---|
| Clopidogrel 75 MG Oral Tablet | 309362 | 039551b6 | 8214f803 |
| Lisinopril 10 MG Oral Tablet | 314076 | 039551b6 | 8214f803 |
| Hydrochlorothiazide 25 MG Oral Tablet | 310798 | 039551b6 | 8214f803 |
| Nitroglycerin 0.4 MG/ACTUAT Mucosal Spray | 705129 | b97c8e64 | 8214f803 |

## Blood pressure readings

| Result | Date | Measure | Value | Units |
|---|---|---|---|---|
| obs-n001985 | 10 Jan 2011 | systolic blood pressure | 158 | mmHg |
| obs-n002059 | 27 Nov 2017 | systolic blood pressure | 129 | mmHg |
| obs-n000689 | 2 Feb 2024 | systolic blood pressure | 143 | mmHg |

All three are systolic readings (LOINC 8480-6). The shared record holds no diastolic reading, weight or lipid result for him.

## Care team

| Clinician | Speciality | Organisation | Town |
|---|---|---|---|
| Lyle Dibbert | General Practice | PCP1477 | Springfield, Massachusetts |
| Martha Ledner | General Practice | PCP9022 | Grafton, Massachusetts |
| Wilton Pollich | General Practice | Milford Regional Medical Center | Milford, Massachusetts |
| Sondra Botsford | General Practice | VA Boston Healthcare System | Jamaica Plain, Massachusetts |

Dr Martha Ledner, Dr Wilton Pollich and Dr Sondra Botsford are listed under General Practice too, so every clinician he has seen is a general practitioner. Mr Krajcik has had no cardiology review, although coronary heart disease has been on his problem list since 2009. Dr Martha Ledner may also hold sessions at Milford Regional Medical Center, but its staff list does not show her.

## Comorbidity context

Across the 3,000 patients in the shared record, 1,615 have a diagnosis of hypertension. Coronary heart disease and hypertension were diagnosed together at 190 encounters, so his pairing is common rather than unusual. The commonest companion of hypertension in the network is diabetes mellitus type 2, diagnosed alongside it at 537 encounters. Diabetes mellitus type 2 was not diagnosed at encounter 8214f803, and his glucose has never been measured in the shared record.

## Gaps and recommendations

1. **Blood pressure.** Two of his three readings are above target, and obs-n000689 was taken on admission. Please repeat the reading at the review.
2. **Medicines between 2011 and 2017.** The record cannot show what he took between encounter b97c8e64 and encounter ae5a4a36. A medicines reconciliation with Mr Krajcik and his pharmacy is needed.
3. **Cardiology.** We suggest Dr Pollich considers a cardiology referral and a fasting glucose and lipid profile at the review.

An earlier draft of this summary said that encounter b97c8e64 was attended by Dr Sondra Botsford. That came from a merged record and has been corrected: Dr Martha Ledner attended it.
