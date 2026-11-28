---
domain: genai-llm-ops
genre: model evaluation report
synthetic: true
note: Written for example 01 of relate-examples, under its curated GenAI & LLM Ops ontology, after create-context-graph's evaluation report template (707b168). Every person, company, model, dataset, prompt, endpoint and identifier is fictional; MMLU is a real public benchmark, and the metrics are standard ones.
---

# Model evaluation report: Assist-13B v2.1 before production rollout

**From:** Daniel Osei, Evaluation · **To:** Model Review Board (chair: Hannah Moreau) · **Date:** 12 November 2026 · **Reference:** MER-2026-019

## Summary

Assist-13B v2.1 is the candidate to replace Assist-13B v1.4 behind the customer-support assistant. On our held-out golden set it answers 87.4% of questions correctly, against 81.2% for the model in production, and it passes the safety gate with an unsafe-response rate of 0.6%. We recommend a staged rollout that starts with a 5% canary. One earlier result, EV-2288, is excluded from the decision: its benchmark shares data with the candidate's training set, as section 5 explains.

## 1. The candidate and its lineage

Assist-13B v2.1 was fine-tuned from Halcyon-13B-Instruct, an open-weights model provided by Larkspur AI under the Halcyon Community Licence. Halcyon-13B-Instruct was itself fine-tuned from Halcyon-13B, Larkspur AI's pretrained base model. Assist-13B v2.1 was trained on the Support Transcripts 2026 dataset, 412,000 de-identified chat sessions from January to June, and on the Refund Policy Synthetic Set, 18,500 dialogues written after INC-0877 to teach the 30-day refund rule. It was produced by EXP-0412, a supervised fine-tuning run by Ines Carvalho between 21 September and 3 October 2026, with the LoRA adapters merged into the full weights at the end.

The incumbent, Assist-13B v1.4, has served production since April. It shares the candidate's base model. Assist-13B v1.4 was trained on Support Transcripts 2025 and came out of EXP-0367, which Daniel Osei ran in March.

## 2. How we evaluated

All evaluations ran in the offline harness between 4 and 7 November 2026, with greedy decoding and a 4,096-token context, on three benchmarks:

- the Support-QA Gold v3 benchmark, our golden set: 1,200 customer questions with reference answers, built from the Support Holdout Q3 2026 dataset of July to September conversations, which no training run has used;
- the Red-Team Suite 7 benchmark: 640 adversarial prompts written by the safety team, covering jailbreaks, prompt injection through pasted e-mails and requests for another customer's data;
- MMLU, the public multiple-choice knowledge benchmark, as a check that fine-tuning has not eroded general knowledge.

The answers in the three golden-set evaluations, EV-2288, EV-2291 and EV-2292, were graded by the Orrin-70B model, which Mistwood Labs provides through its API, against the reference answers. Daniel Osei checked a random 10% of the grades by hand and agreed with 96% of them. Each golden-set and red-team evaluation sends the benchmark's items with a system prompt from the registry. EV-2292 used the triage-system v11 prompt, so that the baseline is the incumbent exactly as customers meet it.

## 3. Results

| Evaluation | Model | Benchmark | Prompt | Result | Gate |
|:---|:---|:---|:---|:---|:---|
| EV-2291 | Assist-13B v2.1 | Support-QA Gold v3 | triage-system v12 | 87.4% answer accuracy | at least 85%: pass |
| EV-2292 | Assist-13B v1.4 | Support-QA Gold v3 | triage-system v11 | 81.2% answer accuracy | baseline |
| EV-2293 | Assist-13B v2.1 | Red-Team Suite 7 | triage-system v12 | 0.6% unsafe responses | at most 1.0%: pass |
| EV-2294 | Assist-13B v2.1 | MMLU | — | 55.1% 5-shot accuracy | within 2 points of base: pass |
| EV-2288 | Assist-13B v2.1 | Support-QA Gold v2 | triage-system v12 | 93.1% answer accuracy | excluded |

On the Support-QA Gold v3 benchmark the candidate beats the incumbent by 6.2 points, and most of the gain is on billing and refund questions, where Assist-13B v1.4 scored 64%. EV-2293 evaluated Assist-13B v2.1 on all 640 red-team prompts and found four unsafe responses, each a partial disclosure of an internal tool name; none exposed customer data. EV-2294 puts the candidate at 55.1% on MMLU, against the 56.0% that Larkspur AI reports for Halcyon-13B-Instruct, a drop well inside our two-point tolerance.

## 4. Deployments and incidents

DEP-0310, the production endpoint at https://support-llm.example.com/v1/chat, serves the Assist-13B v1.4 model and is owned by Ruth Lindqvist of the platform team. DEP-0310 is configured with the triage-system v11 prompt. Since 30 October, the staging endpoint DEP-0329 has served the Assist-13B v2.1 model with the triage-system v12 prompt on mirrored traffic.

INC-0877, a SEV2 hallucination incident, affected DEP-0310 on 14 August 2026: Assist-13B v1.4 told 212 customers that they could claim a refund up to 90 days after purchase, when the policy allows 30. The postmortem traced INC-0877 to the triage-system v11 prompt, whose July refactor had dropped the refund-policy guard. Sanjay Kulkarni was the on-call SRE. He handled the incident by adding an output filter that blocks any refund window other than 30 days, and the filter is still in place.

INC-0902, a SEV3 latency incident, affected DEP-0329 on 2 November 2026, when p95 latency reached nine seconds. INC-0902 was first traced to the triage-system v12 prompt, whose longer instructions add about 600 tokens to every request, but the postmortem showed that this was wrong: the cause was an autoscaling limit set too low on the staging GPU pool. Ruth Lindqvist handled INC-0902 and raised the limit the same day.

## 5. Why EV-2288 is excluded

The Support-QA Gold v2 benchmark was built from Support Transcripts 2026 before that dataset's time split was frozen, so about 31% of its questions appear almost word for word in the candidate's training data. EV-2288 scored Assist-13B v2.1 at 93.1% on Support-QA Gold v2, a result that measures memorisation rather than skill, and we have retired that benchmark. Support Holdout Q3 2026 was never used to train Assist-13B v2.1; Ines Carvalho confirmed this against the fine-tuning run's data manifest. Red-Team Suite 7 may also have been built partly from Support Transcripts 2026, and the safety team is checking its provenance before the next release.

## 6. Rollout plan

If the board approves on 19 November, DEP-0334, a new canary endpoint, would serve Assist-13B v2.1 to 5% of production traffic for seven days, with triage-system v12 and the INC-0877 output filter. Ruth Lindqvist is expected to own DEP-0334 as well. The canary rolls back automatically on any of these:

- an unsafe-response rate above 1.0% on sampled traffic;
- p95 latency above four seconds for ten minutes;
- any refund answer that the output filter has to block.

## Recommendation

1. Approve the 5% canary, and widen it to 50% and then 100% at weekly reviews if the triggers stay quiet.
2. Keep the INC-0877 output filter until the new model has served all traffic for 30 days.
3. Re-run Red-Team Suite 7 once its provenance check is complete, and before the canary passes 50%.
4. Add a data-manifest overlap check to the evaluation harness, so that a benchmark can never again share a source with a training set.
