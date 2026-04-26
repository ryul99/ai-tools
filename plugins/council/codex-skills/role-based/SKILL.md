---
name: council-role-based
description: Convene a role-based Codex LLM Council when the user explicitly asks for a role-based council, multiple distinct perspectives, or parallel subagent review. Assigns roles, uses diverse available GPT model slots, runs anonymous peer evaluation, and synthesizes the strongest answer.
---

# Role-Based Council

Use this workflow only when the user explicitly asks to run a role-based council, asks for multiple named perspectives, or asks for parallel/subagent council work. That request counts as permission to use Codex subagents for this workflow.

The user's question is the current request or the explicit question supplied with the council request.

Follow the stages below exactly. Each stage must complete before the next begins.

## Model Diversity Policy

The core value of this council is independent judgment from diverse model configurations. When spawning subagents, choose from the GPT model aliases that are already known in the current session, runtime, or user request. Prefer distinct aliases across council members when more than one is available.

Use these model slots:

- `strong-reasoning`: strongest available reasoning-capable GPT model, `reasoning_effort: "high"`
- `balanced-reasoning`: a different available reasoning-capable GPT model when possible, `reasoning_effort: "medium"`
- `compact-or-mini`: an available mini, compact, or lower-cost GPT model when possible, `reasoning_effort: "medium"` or `"low"`
- `low-effort-variant`: any available GPT model suited to a quick independent check, `reasoning_effort: "low"`
- `chairman`: strongest available reasoning-capable GPT model, `reasoning_effort: "high"`

Prefer diversity in this order:

1. Different concrete model aliases across answerers.
2. Different model tiers, for example strongest reasoning, balanced reasoning, and mini or compact.
3. Different reasoning efforts if only one model alias is available.
4. Different role briefs as a final fallback.

If no concrete model alias is known at execution time, omit `model` and vary only `reasoning_effort`. Never invent or guess a model alias.

## Stage 0: Question Analysis, Prompt Design, and Role Selection

Before launching any subagents, inspect the user question and determine the dimensions that should shape both the answering prompt and the evaluation criteria. Consider factors such as:

- the task nature, for example factual, analytical, coding, creative, or advisory
- the stakes or cost of being wrong
- the ideal answer shape, for example direct recommendation, comparison, step-by-step plan, code, or concise summary
- whether uncertainty, assumptions, tradeoffs, edge cases, or failure modes should be emphasized

Then create these four internal artifacts for later stages:

- `STAGE1_PROMPT`: a question-specific answering prompt that tells each council member how to answer this exact question well
- `STAGE2_EVAL_CRITERIA`: a short list of the most relevant evaluation criteria for this exact question
- `ROLE_ASSIGNMENTS`: three distinct role briefs tailored to the question, one for each council member
- `EVALUATOR_ASSIGNMENTS`: three distinct evaluator briefs tailored to the question, one for each Stage 2 evaluator

Choose roles that create real perspective diversity instead of superficial title changes. Favor complementary roles such as:

- practical answerer
- skeptical critic
- edge-case or failure-mode hunter
- strategic or systems thinker
- domain specialist
- user advocate

If the question clearly benefits from a different set of roles, choose those instead. Do not use a fixed template library for this step. Generate all four artifacts dynamically from the actual user question.

For `EVALUATOR_ASSIGNMENTS`, create three non-overlapping verification lenses that fit the question rather than reusing generic reviewer labels. Make them meaningfully different in emphasis and method, but keep them all in verifier mode rather than answer-writing mode. As a guardrail, ensure the three evaluator briefs collectively cover:

- accuracy, grounding, or logical soundness
- usefulness, completeness, or synthesis value
- risk, edge cases, uncertainty, or failure modes

If the question is unusual, reinterpret those buckets appropriately instead of forcing awkward labels.

## Stage 1: Independent Role-Based Answering

Spawn 3 answerer subagents in parallel. Each subagent answers independently with no knowledge of the others.

For each Stage 1 subagent, use this structure:

- `message`: `<insert STAGE1_PROMPT>\n\nYour assigned role: <insert role brief from ROLE_ASSIGNMENTS>\n\nAnswer from that perspective. Lean into the role's strengths, but remain honest, evidence-aware, and useful.\n\nQuestion: <insert the user's question>`

Use this model slot mix:

- Subagent 1: `strong-reasoning`
- Subagent 2: `balanced-reasoning`
- Subagent 3: `compact-or-mini`

Record each response. Assign anonymous labels:

- first response -> `Response A`
- second response -> `Response B`
- third response -> `Response C`

Record the role associated with each response internally as:

- `Role A`
- `Role B`
- `Role C`

Important: do not reveal which model slot or model alias produced which response in any subsequent stage or in the final output. You may refer to role labels because role identity is part of this skill's design.

## Stage 2: Anonymized Peer Evaluation

Spawn 3 evaluator subagents in parallel. Each subagent evaluates all Stage 1 responses anonymously as a verifier, not just as an editor.

Before launching evaluators, create one shared `STAGE2_SCORECARD_FORMAT` artifact containing the exact structured output shape below. All three evaluators must use this same output format so their judgments remain comparable, even though their evaluation prompts differ.

`STAGE2_SCORECARD_FORMAT`:

```text
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

```text
You are evaluating anonymous answers to a question. Act strictly as a verifier, not as a replacement answerer. Your job is to determine what is reliable, what is missing, what is fragile, and what should or should not survive into a synthesized final answer.

Your assigned evaluation lens:
<insert evaluator brief from EVALUATOR_ASSIGNMENTS>

Apply that lens strongly, but still judge the full quality of each response against the shared evaluation criteria. Do not ignore major issues just because they fall outside your primary lens.

Original Question:
<insert the user's question>

Evaluation Criteria:
<insert STAGE2_EVAL_CRITERIA>

Response A (Role A):
<insert Response A text>

Response B (Role B):
<insert Response B text>

Response C (Role C):
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

Use this evaluator model slot mix:

- Evaluator 1: `strong-reasoning`
- Evaluator 2: `balanced-reasoning`
- Evaluator 3: `compact-or-mini` or `low-effort-variant` for low-risk questions

After collecting all evaluations, parse each `SCORECARD:` block and compute an internal `AGGREGATE_SCORECARD`. For each response:

- total the reported `Score` values
- count how many evaluators flagged a non-`none` `Fatal flaw`
- collect the union of `Key omissions`
- count how many evaluators marked it in `OVERALL RECOMMENDED`
- summarize how evaluators described `Role adherence`

If a scorecard is partially malformed or missing fields, degrade conservatively instead of aborting. Use whatever structured fields are available, treat unknown items as unknown, and continue.

## Stage 3: Chairman Synthesis

Spawn 1 chairman subagent using the `chairman` slot. The chairman sees everything but with anonymous labels and no model slot or model alias names.

Use this prompt:

```text
You are the chairman of a role-based LLM Council. Your job is to synthesize the best possible answer by combining insights from multiple anonymous responses and their peer evaluations, while explicitly filtering out weak or unsafe material.

Original Question:
<insert the user's question>

Role A:
<insert Role A brief>

Response A:
<insert Response A text>

Role B:
<insert Role B brief>

Response B:
<insert Response B text>

Role C:
<insert Role C brief>

Response C:
<insert Response C text>

Evaluator 1 Scorecard:
<insert Evaluator 1 full scorecard>

Evaluator 2 Scorecard:
<insert Evaluator 2 full scorecard>

Evaluator 3 Scorecard:
<insert Evaluator 3 full scorecard>

Aggregate Scorecard:
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

## Final Output

Present the result to the user in this format:

```markdown
### Role-Based Council Result

**Final Answer** (from Chairman synthesis):
<chairman's final answer from the FINAL ANSWER section>

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
```

If any subagent fails or times out, continue with the remaining responses and mention the reduced sample size in `Council Details`.
