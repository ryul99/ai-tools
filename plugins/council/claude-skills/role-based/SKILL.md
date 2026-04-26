---
description: Convene a role-based LLM Council to answer a question. Assigns each member a distinct perspective, then uses anonymous peer evaluation and chairman synthesis to combine strong ideas while filtering weak ones.
argument-hint: [the question to ask the council]
allowed-tools: Agent
---

# Role-Based Council

You are orchestrating a role-based LLM Council. The user's question is:

> $ARGUMENTS

Follow the stages below **exactly**. Each stage must complete before the next begins.

---

## Model Diversity Policy

The core value of this council is independent judgment from diverse model configurations. Do not hardcode concrete model IDs in this skill. Instead, before Stage 1, build an internal `MODEL_SLOT_MAP` from model aliases and full model IDs that are explicitly available at execution time.

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

## Stage 0: Question Analysis, Prompt Design, and Role Selection

Before launching any agents, inspect the user question and determine the dimensions that should shape both the answering prompt and the evaluation criteria. Consider factors such as:
- the task nature (for example: factual, analytical, coding, creative, advisory)
- the stakes or cost of being wrong
- the ideal answer shape (for example: direct recommendation, comparison, step-by-step plan, code, concise summary)
- whether uncertainty, assumptions, trade-offs, edge cases, or failure modes should be emphasized

Then create these four internal artifacts for use in later stages:
- `STAGE1_PROMPT`: a question-specific answering prompt that tells each council member how to answer this exact question well
- `STAGE2_EVAL_CRITERIA`: a short list of the most relevant evaluation criteria for this exact question
- `ROLE_ASSIGNMENTS`: three distinct role briefs tailored to the question, one for each council member
- `EVALUATOR_ASSIGNMENTS`: three distinct evaluator briefs tailored to the question, one for each Stage 2 evaluator

Choose roles that create real perspective diversity instead of superficial title changes. Favor complementary roles such as:
- practical answerer
- skeptical critic
- edge-case or failure-mode hunter
- strategic or systems thinker

If the question clearly benefits from a different set of roles, choose those instead. Do NOT use a fixed template library for this step. Generate all four artifacts dynamically from the actual user question.

For `EVALUATOR_ASSIGNMENTS`, create three non-overlapping verification lenses that fit the question rather than reusing generic reviewer labels. Make them meaningfully different in emphasis and method, but keep them all in verifier mode rather than answer-writing mode. As a guardrail, ensure the three evaluator briefs collectively cover:
- accuracy, grounding, or logical soundness
- usefulness, completeness, or synthesis value
- risk, edge cases, uncertainty, or failure modes

If the question is unusual, reinterpret those buckets appropriately instead of forcing awkward labels.

---

## Stage 1: Independent Role-Based Answering

Launch **3 Agent tool calls in a single message** (so they run in parallel). Each agent answers the user's question independently with no knowledge of the others.

For each Stage 1 agent, use this structure:
- `description`: one of the labels below
- `model`: as specified below
- `prompt`: "<insert STAGE1_PROMPT>\n\nYour assigned role: <insert role brief from ROLE_ASSIGNMENTS>\n\nAnswer from that perspective. Lean into the role's strengths, but remain honest, evidence-aware, and useful.\n\nQuestion: $ARGUMENTS"

**Agent 1:**
- `description`: "Council member A answering"
- `model`: `strong` slot from `MODEL_SLOT_MAP`

**Agent 2:**
- `description`: "Council member B answering"
- `model`: `balanced` slot from `MODEL_SLOT_MAP`

**Agent 3:**
- `description`: "Council member C answering"
- `model`: `compact` slot from `MODEL_SLOT_MAP`

Record each agent's response. Assign anonymous labels:
- first response -> **Response A**
- second response -> **Response B**
- third response -> **Response C**

Record the role associated with each response internally as:
- **Role A**
- **Role B**
- **Role C**

**Important:** Do NOT reveal which model produced which response in any subsequent stage or in the final output. You may refer to the role labels because role identity is part of this skill's design.

---

## Stage 2: Anonymized Peer Evaluation

Launch **3 Agent tool calls in a single message** (parallel). Each agent evaluates all Stage 1 responses anonymously as a verifier, not just as an editor.

Before launching the evaluators, create one shared `STAGE2_SCORECARD_FORMAT` artifact containing the exact structured output shape below. All three evaluators must use this same output format so their judgments remain comparable, even though their evaluation prompts differ.

`STAGE2_SCORECARD_FORMAT`:

```
SCORECARD:
Response A:
  - Score: <integer 1-10>
  - Fatal flaw: <one sentence or "none">
  - Key omissions: <brief list or "none">
  - Role adherence: <brief judgment>
  - Criteria assessments:
    - <criterion 1>: <brief judgment or score>
    - <criterion 2>: <brief judgment or score>
    - <criterion 3>: <brief judgment or score>
    - <add more only if needed>
Response B:
  - Score: <integer 1-10>
  - Fatal flaw: <one sentence or "none">
  - Key omissions: <brief list or "none">
  - Role adherence: <brief judgment>
  - Criteria assessments:
    - <criterion 1>: <brief judgment or score>
    - <criterion 2>: <brief judgment or score>
    - <criterion 3>: <brief judgment or score>
    - <add more only if needed>
Response C:
  - Score: <integer 1-10>
  - Fatal flaw: <one sentence or "none">
  - Key omissions: <brief list or "none">
  - Role adherence: <brief judgment>
  - Criteria assessments:
    - <criterion 1>: <brief judgment or score>
    - <criterion 2>: <brief judgment or score>
    - <criterion 3>: <brief judgment or score>
    - <add more only if needed>
OVERALL RECOMMENDED: Response [letter]
```

Use evaluator-specific prompts so the council gets question-matched verification lenses instead of three fixed reviewer personas. Keep the same question, criteria, responses, and output format across evaluators; vary only the evaluator assignment and the way it is told to inspect the material.

For each evaluator, use this prompt structure, inserting the actual response texts, role labels, generated evaluation criteria, and the matching brief from `EVALUATOR_ASSIGNMENTS`:

```
You are evaluating anonymous answers to a question. Act strictly as a verifier, not as a replacement answerer. Your job is to determine what is reliable, what is missing, what is fragile, and what should or should not survive into a synthesized final answer.

Your assigned evaluation lens:
<insert evaluator brief from EVALUATOR_ASSIGNMENTS>

Apply that lens strongly, but still judge the full quality of each response against the shared evaluation criteria. Do not ignore major issues just because they fall outside your primary lens.

**Original Question:** $ARGUMENTS

**Evaluation Criteria:**
<insert STAGE2_EVAL_CRITERIA>

**Response A (Role A):**
<insert Response A text>

**Response B (Role B):**
<insert Response B text>

**Response C (Role C):**
<insert Response C text>

For each response:
1. Judge it against the evaluation criteria above.
2. Identify likely mistakes, unsupported claims, brittle assumptions, or other weaknesses most relevant to your assigned evaluation lens.
3. Identify important omissions.
4. Assess whether it used its assigned role well.
5. Give a total score from 1 to 10.
6. Flag a fatal flaw if present; otherwise write "none".

Use this exact output format:

<insert STAGE2_SCORECARD_FORMAT>
```

When generating the three evaluator prompts:
- Evaluator 1 uses `EVALUATOR_ASSIGNMENTS[1]`
- Evaluator 2 uses `EVALUATOR_ASSIGNMENTS[2]`
- Evaluator 3 uses `EVALUATOR_ASSIGNMENTS[3]`
- keep the prompts parallel and structurally comparable
- make sure the three evaluator briefs are genuinely distinct, not paraphrases

**Agent 1:**
- `description`: "Council evaluator 1"
- `model`: `strong` slot from `MODEL_SLOT_MAP`
- `prompt`: <insert Stage 2 template with Evaluator Assignment 1>

**Agent 2:**
- `description`: "Council evaluator 2"
- `model`: `balanced` slot from `MODEL_SLOT_MAP`
- `prompt`: <insert Stage 2 template with Evaluator Assignment 2>

**Agent 3:**
- `description`: "Council evaluator 3"
- `model`: `compact` slot from `MODEL_SLOT_MAP`
- `prompt`: <insert Stage 2 template with Evaluator Assignment 3>

After collecting all evaluations, parse each `SCORECARD:` block and compute an internal `AGGREGATE_SCORECARD` for the chairman. For each response:
- total the reported `Score` values
- count how many evaluators flagged a non-`none` `Fatal flaw`
- collect the union of `Key omissions`
- count how many evaluators marked it in `OVERALL RECOMMENDED`
- summarize how evaluators described `Role adherence`

If a scorecard is partially malformed or missing fields, degrade conservatively instead of aborting. Use whatever structured fields are available, treat unknown items as unknown, and continue.

---

## Stage 3: Chairman Synthesis (Anonymized)

Launch **1 Agent tool call**. The chairman sees everything but with anonymous labels -- no model names.

**Chairman Agent:**
- `description`: "Council chairman synthesizing"
- `model`: `chairman` slot from `MODEL_SLOT_MAP`
- `prompt`:

```
You are the chairman of a role-based LLM Council. Your job is to synthesize the best possible answer by combining insights from multiple anonymous responses and their peer evaluations, while explicitly filtering out weak or unsafe material.

**Original Question:** $ARGUMENTS

**Role A:**
<insert Role A brief>

**Response A:**
<insert Response A text>

**Role B:**
<insert Role B brief>

**Response B:**
<insert Response B text>

**Role C:**
<insert Role C brief>

**Response C:**
<insert Response C text>

**Evaluator 1's Scorecard:**
<insert Evaluator 1's full scorecard>

**Evaluator 2's Scorecard:**
<insert Evaluator 2's full scorecard>

**Evaluator 3's Scorecard:**
<insert Evaluator 3's full scorecard>

**Aggregate Scorecard:**
<insert AGGREGATE_SCORECARD>

First, perform a response triage before writing the final answer. Use this exact format:

VERDICT A:
- ADOPT: <strongest points or "none">
- REJECT: <claims to discard and why, or "none">
- UNCERTAIN: <claims that may be useful but should be softened, qualified, or omitted, or "none">

VERDICT B:
- ADOPT: <strongest points or "none">
- REJECT: <claims to discard and why, or "none">
- UNCERTAIN: <claims that may be useful but should be softened, qualified, or omitted, or "none">

VERDICT C:
- ADOPT: <strongest points or "none">
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

### Council Result

**Final Answer** (from Chairman synthesis):
<chairman's final answer from the `FINAL ANSWER:` section>

<details>
<summary>Council Details</summary>

**Role lineup:**
- Response A: <Role A brief>
- Response B: <Role B brief>
- Response C: <Role C brief>

**Aggregate Scorecard:**
- Response A: total score <n>, fatal flaws <n>, recommended by <n>/3 evaluators
- Response B: total score <n>, fatal flaws <n>, recommended by <n>/3 evaluators
- Response C: total score <n>, fatal flaws <n>, recommended by <n>/3 evaluators

**Key omissions addressed in the final answer:** <brief list>

**Chairman's verdict summary:** <brief summary of what was adopted, rejected, or treated as uncertain>
</details>

**Important notes:**
- The `<details>` block gives users optional transparency without cluttering the main answer
- If any agent fails, continue with the remaining responses -- graceful degradation
