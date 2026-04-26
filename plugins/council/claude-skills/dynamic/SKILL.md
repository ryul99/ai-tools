---
description: Convene an adaptive LLM Council that decides its member count, model mix, and optional second-round refinement based on the question. Use when you want depth to scale with complexity and stakes.
argument-hint: [the question to ask the council]
allowed-tools: Agent
---

# Dynamic Council

You are orchestrating a dynamically sized LLM Council. The user's question is:

> $ARGUMENTS

Follow the stages below **exactly**. Each stage must complete before the next begins.

---

## Model Diversity Policy

The core value of this council is independent judgment from diverse model configurations. Do not hardcode concrete model IDs in this skill. Instead, before Stage 0, build an internal `MODEL_SLOT_MAP` from model aliases and full model IDs that are explicitly available at execution time.

Use these sources, in order:

1. Full model IDs or aliases visible in the current session context, for example from the active session's `--model` configuration, runtime metadata, or system context.
2. Full model IDs or model aliases explicitly supplied by the user in the council request.
3. Model aliases already present in the current session instructions.

Never invent or guess a model ID. When at least two concrete models are available, assign distinct models to council members whenever possible.

Use these model slots:

- `strong`: strongest available model
- `balanced`: a different available model when possible; otherwise the next strongest
- `compact`: a faster or lower-cost available model when possible
- `chairman`: strongest available model

Prefer diversity in this order:

1. Different concrete full model IDs across members (for example, two different versions of the same tier, or models from different tiers).
2. Different model tiers using shorthand aliases (`opus`, `sonnet`, `haiku`).
3. Different member briefs as a final fallback if only one model is distinguishable.

If no concrete version IDs are exposed at execution time beyond the shorthand aliases, use the shorthand aliases for tier diversity and note in `Council Details` that version-level model diversity could not be verified.

---

## Stage 0: Question Analysis and Council Planning

Before launching any agents, inspect the user question and determine the dimensions that should shape both the answering prompt and the council structure. Consider factors such as:
- the task nature (for example: factual, analytical, coding, creative, advisory)
- the stakes or cost of being wrong
- the ideal answer shape (for example: direct recommendation, comparison, step-by-step plan, code, concise summary)
- whether uncertainty, assumptions, trade-offs, edge cases, or failure modes should be emphasized
- whether the question is simple enough for a small council or complex enough to justify more coverage

Then create these five internal artifacts for use in later stages:
- `STAGE1_PROMPT`: a question-specific answering prompt that tells each council member how to answer this exact question well
- `STAGE2_EVAL_CRITERIA`: a short list of the most relevant evaluation criteria for this exact question
- `COUNCIL_PLAN`: a compact plan describing how large the council should be and whether a second round is needed
- `MEMBER_BRIEFS`: short differentiated briefs for each planned member so the council explores multiple angles rather than producing near-duplicates
- `EVALUATOR_ASSIGNMENTS`: differentiated evaluator briefs matched to `COUNCIL_PLAN.evaluator_count`

`COUNCIL_PLAN` must use this exact structure:

```
COUNCIL_PLAN:
- agent_count: <integer from 3 to 7>
- evaluator_count: <integer from 2 to 4>
- model_mix: <brief allocation using slots from `MODEL_SLOT_MAP`, such as "strong x1, balanced x2, compact x1">
- second_round: <true or false>
- rationale: <one short sentence>
```

Use these guardrails:
- default to **3-4** answerers for ordinary questions
- use **5-7** answerers only when the question is high-stakes, highly ambiguous, or benefits from multiple distinct angles
- use **2** evaluators by default, **3-4** only when answer count or stakes justify it
- set `second_round: true` only when a meaningful gap-filling round is likely worth the extra cost
- never exceed the limits above

Do NOT use a fixed template library for this step. Generate all artifacts dynamically from the actual user question.

For `EVALUATOR_ASSIGNMENTS`, generate exactly the same number of evaluator briefs as `COUNCIL_PLAN.evaluator_count`. Make them meaningfully different in emphasis and method, but keep them all in verifier mode rather than answer-writing mode. As a guardrail, make sure the set of evaluator briefs collectively covers:
- accuracy, grounding, or logical soundness
- usefulness, completeness, or synthesis value
- risk, edge cases, uncertainty, or failure modes

If `evaluator_count` is 4, use the fourth evaluator to cover the most decision-relevant extra lens for this question rather than duplicating the first three. If the question is unusual, reinterpret these buckets appropriately instead of forcing awkward labels.

---

## Stage 1: Adaptive Independent Answering

Launch the number of Agent tool calls specified by `COUNCIL_PLAN.agent_count` **in a single message** so they run in parallel. Each agent answers the user's question independently with no knowledge of the others.

For each Stage 1 agent, use this structure:
- `description`: "Council member <letter> answering"
- `model`: assign according to `COUNCIL_PLAN.model_mix`
- `prompt`: "<insert STAGE1_PROMPT>\n\nMember brief: <insert corresponding brief from MEMBER_BRIEFS>\n\nAnswer independently from this angle. Prioritize insight and honesty over agreement.\n\nQuestion: $ARGUMENTS"

Assign anonymous labels sequentially based on launch order:
- first response -> **Response A**
- second response -> **Response B**
- third response -> **Response C**
- continue sequentially up to **Response G** if needed

**Important:** Do NOT reveal which model produced which response in any subsequent stage or in the final output.

---

## Optional Stage 1B: Gap-Filling Second Round

If `COUNCIL_PLAN.second_round` is `false`, skip this stage entirely.

If `COUNCIL_PLAN.second_round` is `true`, launch **1 or 2 Agent tool calls in a single message** to fill the most important missing gaps identified after Stage 1. These are not full re-runs of the entire council.

Before launching them, inspect the Stage 1 responses and identify the one or two most important missing angles, unresolved tensions, or weakly covered edge cases.

For each Stage 1B agent, use this structure:
- `description`: "Council gap-filler <letter>"
- `model`: choose the model most suitable for the missing angle
- `prompt`: "You are filling a gap in an existing council discussion.\n\nOriginal question: $ARGUMENTS\n\nExisting responses:\n<insert concise summaries of the Stage 1 responses>\n\nGap to fill: <insert the specific missing angle>\n\nProvide only the missing insight needed to improve the eventual synthesis. Avoid repeating what is already well covered."

Assign any gap-filler outputs labels such as **Gap Note X** and **Gap Note Y**. These do not replace existing responses; they become supplemental material for evaluation and synthesis.

---

## Stage 2: Adaptive Peer Evaluation

Launch the number of evaluator Agent tool calls specified by `COUNCIL_PLAN.evaluator_count` **in a single message** so they run in parallel.

Each evaluator should assess all available responses, and if Stage 1B ran, also assess whether the gap notes provide useful corrective information.

Before launching the evaluators, create one shared `STAGE2_SCORECARD_FORMAT` artifact containing the exact structured output shape below. All evaluators must use this same output format so their judgments remain comparable even when their assigned lenses differ.

`STAGE2_SCORECARD_FORMAT`:

```
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

```
You are evaluating anonymous answers to a question. Act strictly as a verifier, not as a replacement answerer. Your job is to determine what is reliable, what is missing, what is fragile, and what should or should not survive into a synthesized final answer.

Your assigned evaluation lens:
<insert matching evaluator brief from EVALUATOR_ASSIGNMENTS>

Apply that lens strongly, but still judge the full quality of each response against the shared evaluation criteria. Do not ignore major issues just because they fall outside your primary lens.

**Original Question:** $ARGUMENTS

**Evaluation Criteria:**
<insert STAGE2_EVAL_CRITERIA>

**Responses:**
<insert Response A through the highest response label actually present>

**Gap Notes:**
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

When generating evaluator prompts:
- create exactly `COUNCIL_PLAN.evaluator_count` prompts
- assign `EVALUATOR_ASSIGNMENTS` sequentially to those prompts
- keep the prompts parallel and structurally comparable
- make sure the evaluator briefs are genuinely distinct, not paraphrases

After collecting all evaluations, parse each `SCORECARD:` block and compute an internal `AGGREGATE_SCORECARD` for the chairman. For each response:
- total the reported `Score` values
- count how many evaluators flagged a non-`none` `Fatal flaw`
- collect the union of `Key omissions`
- count how many evaluators marked it in `OVERALL RECOMMENDED`

Also aggregate the `Gap Notes` judgments if any exist.

If a scorecard is partially malformed or missing fields, degrade conservatively instead of aborting. Use whatever structured fields are available, treat unknown items as unknown, and continue.

---

## Stage 3: Chairman Synthesis (Anonymized)

Launch **1 Agent tool call**. The chairman sees everything but with anonymous labels -- no model names.

**Chairman Agent:**
- `description`: "Dynamic council chairman synthesizing"
- `model`: `chairman` slot from `MODEL_SLOT_MAP`
- `prompt`:

```
You are the chairman of a dynamically sized LLM Council. Your job is to synthesize the best possible answer by combining insights from multiple anonymous responses, optional gap-filling notes, and their peer evaluations, while explicitly filtering out weak or unsafe material.

**Original Question:** $ARGUMENTS

**Council Plan:**
<insert COUNCIL_PLAN>

**Responses:**
<insert Response A through the highest response label actually present>

**Gap Notes:**
<insert Gap Note X/Y if present, otherwise write "none">

**Evaluator Scorecards:**
<insert every evaluator scorecard>

**Aggregate Scorecard:**
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

---

## Final Output

Present the results to the user in this format:

### Dynamic Council Result

**Final Answer** (from Chairman synthesis):
<chairman's final answer from the `FINAL ANSWER:` section>

<details>
<summary>Council Details</summary>

**Council plan:**
<insert the `COUNCIL_PLAN` rationale and shape in readable form>

**Aggregate Scorecard:**
- For each response label present, report total score, fatal flaws, and recommendation count

**Gap-filling notes:** <brief summary or "none">

**Key omissions addressed in the final answer:** <brief list>

**Chairman's verdict summary:** <brief summary of what was adopted, rejected, or treated as uncertain>
</details>

**Important notes:**
- This variant intentionally scales cost and depth with the question
- If any agent fails, continue with the remaining responses -- graceful degradation
