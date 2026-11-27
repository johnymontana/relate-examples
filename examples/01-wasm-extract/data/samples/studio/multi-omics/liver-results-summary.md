---
domain: multi-omics
genre: study results summary
synthetic: true
note: Written for example 01 of relate-examples from the liver biopsy cohort in the sample data of Neo4j's multi-omics package (studio-agent-use-cases at b76f767), whose project, sample, experiment and comparison codes, results, associations and interactions it narrates. The cohort, its donors and every result are synthetic; the genes, proteins and their UniProt accessions, the diseases, phenotypes and Gene Ontology terms, the Reactome pathways and the instruments are real.
---

# Liver multi-omics results: MASLD against control

**From:** Translational Omics, liver programme · **To:** Target review board · **Study:** PRJ-LIVER, the liver biopsy steatotic liver disease cohort · **Date:** November 19, 2026 · **Reference:** TRB-2026-114

## Summary

This summary reads the RNA-seq and TMT proteomics results of the liver biopsy cohort side by side. The main contrast found fifteen genes changed in the same direction at both layers, six proteins that changed without their transcripts, and five concordant genes with no curated association with the disease. We propose PIK3CG for target validation and SQSTM1 as a protein-only marker, and we ask the board to approve a second DIA-PASEF run.

## Cohort and samples

PRJ-LIVER collected 30 needle biopsies of the liver, S-LIV-001 to S-LIV-030, one from each donor. Hepatic steatosis was recorded in the 22 biopsies graded as MASLD, S-LIV-009 to S-LIV-030, and S-LIV-021 to S-LIV-028 also show hepatic fibrosis. Two control donors, S-LIV-003 and S-LIV-007, show obesity but no steatosis. Like every biopsy in the cohort, S-LIV-021 was taken from the liver; a typical fibrotic case, it shows hepatic fibrosis, insulin resistance and obesity.

## Experiments

EXP-LIV-RNA, the transcriptomics experiment, sequenced all 30 biopsies by poly(A) RNA-seq on an Illumina NovaSeq 6000. EXP-LIV-TMT is the proteomics experiment: the same biopsies were labeled with TMTpro 16-plex and run on an Orbitrap Fusion Lumos. S-LIV-001 to S-LIV-016, the biopsies with tissue to spare, were also assayed in EXP-LIV-DIA, a second proteomics experiment, by DIA-PASEF on a timsTOF Pro. S-LIV-016 was therefore assayed in EXP-LIV-RNA, EXP-LIV-TMT and EXP-LIV-DIA.

## Comparisons

CMP-LIV-MASLD studies metabolic dysfunction-associated steatotic liver disease, MASLD. CMP-LIV-MASLD analyzes EXP-LIV-RNA for transcripts and EXP-LIV-TMT for proteins, and includes S-LIV-009 to S-LIV-030 as cases and S-LIV-001 to S-LIV-008 as controls. CMP-LIV-MASH studies metabolic dysfunction-associated steatohepatitis, MASH, within the cases. A biopsy can sit in different groups: CMP-LIV-MASH includes S-LIV-009 as a control and S-LIV-021 as a case. CMP-LIV-DIA analyzes EXP-LIV-DIA alone and repeats the MASLD contrast on the sixteen biopsies it covers; having no RNA-seq data, it can confirm protein changes but never concordance.

## Concordant changes

At an adjusted p-value of 0.05 and an absolute log2 fold change of at least 1 in each layer, CMP-LIV-MASLD found 22 genes and 23 proteins changed. In CMP-LIV-MASLD, eleven genes rose at both layers (PLIN2, CD36, SCD, CXCL10, SPP1, SREBF1, CCL2, FASN, PPARG, PIK3CG and TIMP1) and four fell (ADH4, ACADL, PPARA and CPT1A). The largest change is in PLIN2: CMP-LIV-MASLD found its transcript up 2.6 log2 units and perilipin-2, the lipid droplet coat it encodes, up 2.9. On the falling side, CMP-LIV-MASLD found ACADL and its protein P28330 down 1.4 and 1.5 log2 units.

| Comparison | Gene | Protein | Transcript log2FC | Protein log2FC |
|---|---|---|---|---|
| CMP-LIV-MASLD | PLIN2 | Q99541 | 2.6 | 2.9 |
| CMP-LIV-MASLD | CD36 | P16671 | 2.4 | 2.1 |
| CMP-LIV-MASLD | SCD | O00767 | 2.2 | 1.9 |
| CMP-LIV-MASLD | PIK3CG | P48736 | 1.4 | 1.2 |
| CMP-LIV-MASLD | CPT1A | P50416 | -1.2 | -1.1 |
| CMP-LIV-MASLD | SQSTM1 | Q13501 | not changed | 1.8 |
| CMP-LIV-MASLD | LPL | P06858 | 1.2 | -1.1 |
| CMP-LIV-DIA | PLIN2 | Q99541 | no RNA data | 2.5 |
| CMP-LIV-MASH | TIMP1 | P01033 | 1.8 | 1.5 |
| CMP-LIV-MASH | SPP1 | P10451 | 1.6 | 1.4 |

## Proteins that moved without their transcripts

Six proteins changed while their transcripts, measured in the same biopsies, stayed flat or moved the other way. In CMP-LIV-MASLD, Q13501 rose 1.8 log2 units while the SQSTM1 transcript did not change. Q13501 is sequestosome-1, the autophagy receptor encoded by SQSTM1. EXP-LIV-RNA detected SQSTM1 at a mean of 1,484 normalized reads, so the flat transcript was measured, not missed. FABP1, PTEN and SOD2 lost protein and APOB gained it, each with an unchanged transcript, while LPL moved both ways: its transcript rose and lipoprotein lipase, the protein, fell.

Adiponectin is the case the check exists for. EXP-LIV-TMT detected Q15848, adiponectin, with 8 peptides, but EXP-LIV-RNA did not detect ADIPOQ at all. The protein is made in fat and carried to the liver in blood, so its fall of 1.6 log2 units in CMP-LIV-MASLD says nothing about hepatic transcription.

## Known biology and new leads

CD36 is associated with MASLD, the disease under study, at a score of 0.71. PPARA is associated with MASLD at 0.68, and PPARG at 0.62. PPARG is also associated with type 2 diabetes mellitus, at 0.89. CPT1A is associated with MASLD only weakly, at 0.22 on literature evidence. Five concordant genes, CXCL10, ACADL, ADH4, PIK3CG and TIMP1, have no recorded association with MASLD at all. TIMP1 is associated with MASH instead, at 0.66, and its rise in CMP-LIV-MASH points to fibrosis rather than fat.

PIK3CG is the strongest new lead. Its only curated association is with atherosclerosis, at 0.38, from animal models.

## Network and pathways

PIK3CG encodes P48736, a lipid kinase best known in immune cells. P48736 interacts with P27986 at a STRING score of 0.95 and with P31749 at 0.91, and four more partners clear 0.7, among them P60484. Of the six, only P60484 changed beyond the cutoffs in CMP-LIV-MASLD, falling 1.2 log2 units. PTEN encodes P60484, the phosphatase that switches the pathway off, so the axis looks rewired rather than simply switched on.

Among the concordant proteins, Q99541, P16671 and O00767 are annotated with lipid storage, and P28330 and P50416 with fatty acid beta-oxidation. Q99541, P16671, Q07869 and P50416 participate in R-HSA-1989781, PPARA activates gene expression: four of its ten members. R-HSA-400206, Regulation of lipid metabolism by PPARalpha, holds five concordant genes among its fourteen members. MASLD involves both, and also R-HSA-75105, fatty acyl-CoA biosynthesis, the pathway of SCD and FASN.

## Replication

CMP-LIV-DIA reproduced seven of the MASLD protein changes in the same direction: P28330, P16671, P50416, P49327, Q99541, O00767 and Q13501. In CMP-LIV-DIA, Q99541 rose 2.5 log2 units. EXP-LIV-DIA detected P48736 with 8 peptides, but its rise of 0.9 log2 units fell short of the cutoff, so the PIK3CG lead rests on one platform for now.

## Caveats

- SQSTM1 may be associated with MASLD through its role in autophagy, but no curated association is recorded.
- An earlier draft said S-LIV-029 shows hepatic fibrosis; that was a transcription error, and S-LIV-029 shows hepatic steatosis only.
- Fold changes are cases over controls in log2 units; the two proteomics methods are not on one scale.

## Recommendations

1. Take PIK3CG to target validation in primary hepatocytes, with P60484 as a pathway readout.
2. Follow SQSTM1 as a protein-only marker: Q13501 participates in R-HSA-1632852, Macroautophagy.
3. Approve the second DIA-PASEF run. If the board approves it, EXP-LIV-DIA would be re-acquired on an Orbitrap Astral, and CMP-LIV-DIA would then include S-LIV-017 to S-LIV-030.
