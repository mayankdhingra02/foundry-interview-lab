# Friends-and-family pilot coordination

Mayank will coordinate recruitment and collect pilot evidence. He has proposed asking friends and family; no participant, reviewer, date or completed review is confirmed by that decision. The intended infrastructure is Engineering Foundry's existing setup, subject to the separate deployment qualification. This document turns recruitment into a concrete handoff without changing the [design's acceptance gates](design.md#16-evaluation-and-release-gates).

## People and responsibilities

| Role | Current assignment and next action |
| --- | --- |
| Recruitment and evidence coordinator | Mayank: ask volunteers, arrange consent and private storage, schedule attempts, and preserve actual outcomes. |
| Learner participants | Friends and family are the proposed pool. Confirm relevant interview-preparation goals, experience, availability, prior task exposure and participation choices privately. The design proposes 20–30 learners; a smaller usability trial can find defects but does not close that gate. |
| Content reviewer | Obtain an experienced independent engineer's review of each proposed task version using [content review](content-review.md). Relationship to the coordinator neither establishes nor rules out relevant expertise. |
| AI benchmark reviewers | Select two experienced reviewers who can inspect code, execution evidence and rubric judgments independently. Confirm relevant experience and conflicts; two distinct names alone do not establish expertise or independence. |
| Independent adjudicator | Name a separate qualified person to resolve meaningful disagreements after both reviews. In the private evaluation workflow, neither reviewers nor adjudicator may be the model operator, source preparer or corpus custodian; the adjudicator also cannot be either reviewer. See [private model evaluation](private-model-evaluation.md). |
| Deployment, security, accessibility and release owners | Still unassigned. Recruitment does not supply these approvals. The release owner records the decision after the applicable gates pass. |

Learners and reviewers may come from the same recruitment pool, but a learner's satisfaction response is not an expert annotation. Reviewers must not see peer judgments before completing their own review. Use the existing bound [role review](role-review.md) or [private evaluation](private-model-evaluation.md) packets and blank templates; do not replace their artifact bindings with this worksheet.

## Prepare the first trial

1. Confirm the people, purpose and dates. Start with usability if qualified model outputs or matched fresh tasks are not yet available; describe that scope to participants. Record relevant engineering experience before assigning expert review.
2. Have the deployment owner qualify accounts, separate execution, saves/recovery, deletion and operational limits. Follow [operations](operations.md) and [rollout](rollout.md). Use exact staff/invite account allowlists and reviewed scenario versions; retain closed public admission. Keep voice, billing and unqualified inference off.
3. Approve private storage, access and retention. Keep contacts, identity mappings, code, conversations, consent records, reviews and recordings outside this public repository. Separate consent to participate from optional use of attempts for evaluation or training; ordinary practice/support consent does not authorize those uses. Explain any enabled provider processing before participation.
4. Select independently reviewed tasks. Record exposure to public source, reference solutions and earlier attempts. New private attempts on public tasks can support feedback review; they do not make the task family an unseen holdout. Use independently reviewed matched fresh tasks for transfer measurement and protect their custody from prompt development.
5. Rehearse the end-to-end task with a synthetic account, including an interrupted attempt, resume, report limitations, export and deletion. Verify consent and withdrawal instructions. A successful rehearsal is operational evidence, not a participant result.
6. Run voluntary attempts without prompting learners toward a particular solution. Record assistance, timing/accommodations, bugs and outcomes. Distinguish withdrawal from technical failure; do not turn missing evidence into a weakness.
7. Collect task-specific usability feedback and separately bound expert annotations. Compare fresh-task performance before/after coaching at matched difficulty and assistance for the learning-value part of the pilot. Report uncertainty, coverage and disagreements. Do not infer hiring outcomes, demographic fairness or demonstrated improvement from satisfaction or a tiny sample.

## Private roster and outcome worksheet

Copy these blank fields into approved private storage. This is a coordination worksheet, not an annotation importer, consent form or release approval. Do not fill it with hypothetical participants or labels.

| Record | Fields to collect |
| --- | --- |
| Recruitment | Pseudonymous participant ID; separate restricted contact mapping; learner/reviewer role; relevant experience; availability; relationship/conflicts; confirmed or declined. |
| Participation choices | Purpose explained; consent version/date; allowed processing and optional evaluation reuse; written/voice choice; accommodations; withdrawal contact; retention/deletion notice acknowledged. |
| Attempt | Attempt ID; exact deployment commit; scenario/version/digest; rubric and model/prompt versions when used; prior task/source exposure; assistance policy and actual assistance; start/end times. |
| Outcome | Completed, resumed, voluntary withdrawal or technical failure; failure stage; acknowledged-work recovery; private evidence references; participant feedback; actual cost where available. |
| Transfer | Matched fresh-task identity/version; exposure and custody record; before/after evidence; timing/assistance comparability; missing observations and limitations. |
| Expert review | Actual reviewer qualifications/independence; bound packet digest; private review/adjudication artifact references and dates; unresolved disagreements and critical findings. |
| Closure | Follow-up owner; fixes/retest evidence; export/deletion request and result; approved retention deadline; release decision and evidence references. |

## Invitation draft — not sent

> I'm building Engineering Foundry Interview Lab to help people prepare for engineering interviews. Would you be interested in a voluntary trial? It involves working through a coding task and giving feedback on the experience. I'll share the time commitment, data-processing details, participation choices and withdrawal instructions before you decide. This is practice, not a hiring assessment. If you have relevant engineering or interviewing experience and would prefer to review task/feedback quality, please let me know separately.

Mayank sends invitations and confirms actual volunteers. No outreach is performed by adding this draft to the repository. Completed participation agreements need a separately approved process; this draft is not a legal consent instrument.

## Evidence still required

Actual volunteers and availability; qualified independent reviewers/adjudicator; content approval and curated acceptance/holdout material; approved private storage/consent/retention; qualified deployment and provider budget; security and screen-reader review; recorded participant and fresh-task outcomes; and the release owner's decision remain pending. Use [measurement](measurement.md), [content review](content-review.md), [private corpus preparation](acceptance-corpus.md), and [the design acceptance audit](design-acceptance.md) as the existing contracts. No model training or synthetic human approvals are needed to organize the pilot.
