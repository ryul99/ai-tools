---
name: council-dynamic
description: Convene an adaptive Codex LLM Council when the user explicitly asks for a dynamic council or wants council depth to scale with complexity, uncertainty, or stakes. Selects member count, diverse available GPT model slots, optional gap filling, peer evaluation, and chairman synthesis.
---

# Dynamic Council

Use this workflow only when the user explicitly asks to run a dynamic council, asks for adaptive multi-agent review, or asks for parallel/subagent council work. That request counts as permission to use Codex subagents for this workflow.

The user's question is the current request or the explicit question supplied with the council request.

Follow the stages below exactly. Each stage must complete before the next begins.

## Model Diversity Policy

The core value of this council is independent judgment from diverse model configurations. When spawning subagents, choose from the GPT model aliases that are already known in the current session, runtime, or user request. Prefer distinct aliases across council members when more than one is available.

Use these model slots:

- `strong-reasoning`: strongest available reasoning-capable GPT model, `reasoning_effort: "high"`
- `balanced-reasoning`: a different available reasoning-capable GPT model when possible, `reasoning_effort: "medium"`
- `compact-or-mini`: an available mini, compact, or lower-cost GPT model when possible, `reasoning_effort: "medium"` or `"low"`
- `alternate-current-or-previous`: another available current or previous GPT model alias when exposed by the runtime, `reasoning_effort: "medium"`
- `low-effort-variant`: any available GPT model suited to a quick independent check, `reasoning_effort: "low"`

Prefer diversity in this order:

1. Different concrete model aliases across answerers.
2. Different model tiers, for example strongest reasoning, balanced reasoning, mini or compact, and previous or alternate current model.
3. Different reasoning efforts if only one model alias is available.
4. Different member briefs as a final fallback.

If no concrete model alias is known at execution time, omit `model` and vary only `reasoning_effort`. Never invent or guess a model alias.

## Stage 0: Question Analysis and Council Planning

Before launching any subagents, inspect the user question and determine the dimensions that should shape both the answering prompt and the council structure. Consider factors such as:

- the task nature, for example factual, analytical, coding, creative, or advisory
- the stakes or cost of being wrong
- the ideal answer shape, for example direct recommendation, comparison, step-by-step plan, code, or concise summary
- whether uncertainty, assumptions, tradeoffs, edge cases, or failure modes should be emphasized
- whether the question is simple enough for a small council or complex enough to justify more coverage

Then create these five internal artifacts for later stages:

- `STAGE1_PROMPT`: a question-specific answering prompt that tells each council member how to answer this exact question well
- `STAGE2_EVAL_CRITERIA`: a short list of the most relevant evaluation criteria for this exact question
- `COUNCIL_PLAN`: a compact plan describing how large the council should be and whether a second round is needed
- `MEMBER_BRIEFS`: short differentiated briefs for each planned member so the council explores multiple angles rather than producing near-duplicates
- `EVALUATOR_ASSIGNMENTS`: differentiated evaluator briefs matched to `COUNCIL_PLAN.evaluator_count`

`COUNCIL_PLAN` must use this exact structure:

```text
COUNCIL_PLAN:
- agent_count: <integer from 3 to 7>
- evaluator_count: <integer from 2 to 4>
- model_mix: <brief allocation such as "strong-reasoning x1, balanced-reasoning x1, compact-or-mini x1, alternate-current-or-previous x1">
- second_round: <true or false>
- rationale: <one short sentence>
```

Use these guardrails:

- default to 3-4 answerers for ordinary questions
- use 5-7 answerers only when the question is high-stakes, highly ambiguous, or benefits from multiple distinct angles
- use 2 evaluators by default, 3-4 only when answer count or stakes justify it
- set `second_round: true` only when a meaningful gap-filling round is likely worth the extra cost
- never exceed the limits above
- include at least one `compact-or-mini` slot when `agent_count` is 4 or higher and such a model is available, unless the user requests only high-reasoning models
- include `alternate-current-or-previous` when `agent_count` is 5 or higher and such a model is available
- use `strong-reasoning` for the chairman on high-stakes or complex questions
- use `low-effort-variant` only for narrow, low-risk subtasks

Do not use a fixed template library for this step. Generate all artifacts dynamically from the actual user question.

For `EVALUATOR_ASSIGNMENTS`, generate exactly the same number of evaluator briefs as `COUNCIL_PLAN.evaluator_count`. Make them meaningfully different in emphasis and method, but keep them all in verifier mode rather than answer-writing mode. As a guardrail, make sure the set of evaluator briefs collectively covers:

- accuracy, grounding, or logical soundness
- usefulness, completeness, or synthesis value
- risk, edge cases, uncertainty, or failure modes

If `evaluator_count` is 4, use the fourth evaluator to cover the most decision-relevant extra lens for this question rather than duplicating the first three.

## Stage 1: Adaptive Independent Answering

Spawn the number of answerer subagents specified by `COUNCIL_PLAN.agent_count` in parallel. Each subagent answers independently with no knowledge of the others.

For each Stage 1 subagent, use this structure:

- `message`: `<insert STAGE1_PROMPT>\n\nMember brief: <insert corresponding brief from MEMBER_BRIEFS>\n\nAnswer independently from this angle. Prioritize insight and honesty over agreement.\n\nQuestion: <insert the user's question>`
- `model` and `reasoning_effort`: assign according to `COUNCIL_PLAN.model_mix`; set `model` only when a concrete available model alias is known

Assign anonymous labels sequentially based on collection order:

- first response -> `Response A`
- second response -> `Response B`
- third response -> `Response C`
- continue sequentially up to `Response G` if needed

Important: do not reveal which model slot or model alias produced which response in any subsequent stage or in the final output.

## Optional Stage 1B: Gap-Filling Second Round

If `COUNCIL_PLAN.second_round` is `false`, skip this stage entirely.

If `COUNCIL_PLAN.second_round` is `true`, inspect the Stage 1 responses and identify the one or two most important missing angles, unresolved tensions, or weakly covered edge cases. Then spawn 1 or 2 focused gap-filler subagents in parallel. These are not full re-runs of the entire council.

For each Stage 1B subagent, use this structure:

- `message`: `You are filling a gap in an existing council discussion.\n\nOriginal question: <insert the user's question>\n\nExisting responses:\n<insert concise summaries of Stage 1 responses>\n\nGap to fill: <insert the specific missing angle>\n\nProvide only the missing insight needed to improve the eventual synthesis. Avoid repeating what is already well covered.`
- Use `strong-reasoning` for complex gaps and `low-effort-variant` for narrow, low-risk gaps.

Assign any gap-filler outputs labels such as `Gap Note X` and `Gap Note Y`. These do not replace existing responses; they become supplemental material for evaluation and synthesis.

## Stage 2: Adaptive Peer Evaluation

Spawn the number of evaluator subagents specified by `COUNCIL_PLAN.evaluator_count` in parallel.

Each evaluator should assess all available responses, and if Stage 1B ran, also assess whether the gap notes provide useful corrective information.

Before launching evaluators, create one shared `STAGE2_SCORECARD_FORMAT` artifact containing the exact structured output shape below. All evaluators must use this same output format so their judgments remain comparable even when their assigned lenses differ.

`STAGE2_SCORECARD_FORMAT`:

```text
SCORECARD:
Response A:
  - Score: <integer 1-10>
  - Fatal flaw: <one sentence or "none">
  - Key omissions: <brief list or "none">
  - Criteria assessments:
    - <criterion 1>: <brief judgment or score>
    - <criterion 2>: <brief judgment or score>
    - <criterion 3>: <brief judgment or score>
    - <add more only if needed>
Repeat the same block structure for every response label actually present.
Gap Notes:
  - Usefulness: <brief judgment or "none">
  - Cautions: <brief judgment or "none">
OVERALL RECOMMENDED: Response [letter]
```

Use evaluator-specific prompts so the dynamic council gets question-matched verification lenses instead of near-duplicate evaluators. Keep the same question, criteria, responses, gap notes, and output format across evaluators; vary only the evaluator assignment and the way it is told to inspect the material.

For each evaluator, use this prompt:

```text
You are evaluating anonymous answers to a question. Act strictly as a verifier, not as a replacement answerer. Your job is to determine what is reliable, what is missing, what is fragile, and what should or should not survive into a synthesized final answer.

Your assigned evaluation lens:
<insert matching evaluator brief from EVALUATOR_ASSIGNMENTS>

Apply that lens strongly, but still judge the full quality of each response against the shared evaluation criteria. Do not ignore major issues just because they fall outside your primary lens.

Original Question:
<insert the user's question>

Evaluation Criteria:
<insert STAGE2_EVAL_CRITERIA>

Responses:
<insert Response A through the highest response label actually present>

Gap Notes:
<insert Gap Note X/Y if present, otherwise write "none">

For each response:
1. Judge it against the evaluation criteria above.
2. Identify likely mistakes, unsupported claims, brittle assumptions, or other weaknesses most relevant to your assigned evaluation lens.
3. Identify important omissions.
4. Give a total score from 1 to 10.
5. Flag a fatal flaw if present; otherwise write "none".

Then assess the gap notes:
- whether they add genuinely useful missing information
- whether they introduce any unsupported, brittle, or misleading material
- whether their value or weakness is especially visible through your assigned evaluation lens

Use this exact output format:

<insert STAGE2_SCORECARD_FORMAT>
```

When assigning evaluator model slots:

- use `strong-reasoning` for the accuracy or risk evaluator
- use `balanced-reasoning` for the usefulness or synthesis evaluator
- use `compact-or-mini` or `low-effort-variant` for the lowest-risk evaluator when `evaluator_count` is 3 or more
- prefer distinct concrete model aliases across evaluators when available

After collecting all evaluations, parse each `SCORECARD:` block and compute an internal `AGGREGATE_SCORECARD`. For each response:

- total the reported `Score` values
- count how many evaluators flagged a non-`none` `Fatal flaw`
- collect the union of `Key omissions`
- count how many evaluators marked it in `OVERALL RECOMMENDED`

Also aggregate the `Gap Notes` judgments if any exist.

If a scorecard is partially malformed or missing fields, degrade conservatively instead of aborting. Use whatever structured fields are available, treat unknown items as unknown, and continue.

## Stage 3: Chairman Synthesis

Spawn 1 chairman subagent. Use `strong-reasoning` for high-stakes or complex questions; otherwise use `balanced-reasoning`. The chairman sees everything but with anonymous labels and no model slot or model alias names.

Use this prompt:

```text
You are the chairman of a dynamically sized LLM Council. Your job is to synthesize the best possible answer by combining insights from multiple anonymous responses, optional gap-filling notes, and their peer evaluations, while explicitly filtering out weak or unsafe material.

Original Question:
<insert the user's question>

Council Plan:
<insert COUNCIL_PLAN>

Responses:
<insert Response A through the highest response label actually present>

Gap Notes:
<insert Gap Note X/Y if present, otherwise write "none">

Evaluator Scorecards:
<insert every evaluator scorecard>

Aggregate Scorecard:
<insert AGGREGATE_SCORECARD>

First, perform a response triage before writing the final answer. Use one block per available response in this exact format:

VERDICT A:
- ADOPT: <strongest points or "none">
- REJECT: <claims to discard and why, or "none">
- UNCERTAIN: <claims that may be useful but should be softened, qualified, or omitted, or "none">

Repeat the same structure for each available response label.

If gap notes are present, add:

VERDICT GAP NOTES:
- ADOPT: <useful supplemental insights or "none">
- REJECT: <claims to discard and why, or "none">
- UNCERTAIN: <claims that may be useful but should be softened, qualified, or omitted, or "none">

Then, write the final answer using the adopted material, correcting issues identified by evaluators, incorporating important missing points, and clearly signaling any residual uncertainty that remains relevant.

Your output must end with:

FINAL ANSWER:
<your synthesized answer>
```

## Final Output

Present the result to the user in this format:

```markdown
### Dynamic Council Result

**Final Answer** (from Chairman synthesis):
<chairman's final answer from the FINAL ANSWER section>

<details>
<summary>Council Details</summary>

**Council plan:**
<insert the COUNCIL_PLAN rationale and shape in readable form>

**Aggregate Scorecard:**
- For each response label present, report total score, fatal flaws, and recommendation count

**Gap-filling notes:** <brief summary or "none">

**Key omissions addressed in the final answer:** <brief list>

**Chairman's verdict summary:** <brief summary of what was adopted, rejected, or treated as uncertain>
</details>
```

If any subagent fails or times out, continue with the remaining responses and mention the reduced sample size in `Council Details`.
