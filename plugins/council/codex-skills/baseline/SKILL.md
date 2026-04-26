---
name: council-baseline
description: Convene a baseline Codex LLM Council when the user explicitly asks for a council, baseline council, multi-agent second opinion, or parallel subagent review. Runs independent answerers, anonymous peer evaluation, and chairman synthesis while prioritizing diversity across available GPT models and reasoning settings.
---

# Baseline Council

Use this workflow only when the user explicitly asks to run or convene a council, asks for the baseline council, or asks for parallel/subagent review. That request counts as permission to use Codex subagents for this workflow.

The user's question is the current request or the explicit question supplied with the council request.

Follow the stages below exactly. Each stage must complete before the next begins.

## Model Diversity Policy

The core value of this council is independent judgment from diverse model configurations. Do not hardcode concrete model aliases in this skill. Instead, before Stage 1, build an internal `MODEL_SLOT_MAP` from model override aliases that are explicitly available at execution time.

Use these sources, in order:

1. Model override aliases exposed by the active `spawn_agent` tool declaration or runtime metadata.
2. Model aliases explicitly supplied by the user in the council request.
3. Model aliases already present in the current session instructions.

Never invent or guess a model alias. When at least two concrete aliases are available, assign distinct aliases to council members whenever possible. When a slot has a concrete alias in `MODEL_SLOT_MAP`, every `spawn_agent` call for that slot must include both `model: <alias>` and the slot's `reasoning_effort`.

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
4. Different member briefs as a final fallback.

If fewer concrete aliases are available than slots, reuse the best available aliases only after maximizing diversity. If no concrete model alias is exposed at execution time, omit `model`, vary only `reasoning_effort`, and mention in `Council Details` that the runtime did not expose model override aliases so model diversity could not be verified.

## Stage 0: Question Analysis and Prompt Design

Before launching any subagents, inspect the user question and determine the dimensions that should shape both the answering prompt and the evaluation criteria. Consider factors such as:

- the task nature, for example factual, analytical, coding, creative, or advisory
- the stakes or cost of being wrong
- the ideal answer shape, for example direct recommendation, comparison, step-by-step plan, code, or concise summary
- whether uncertainty, assumptions, tradeoffs, or edge cases should be emphasized

Then create these two internal artifacts for later stages:

- `STAGE1_PROMPT`: a question-specific answering prompt that tells each council member how to answer this exact question well
- `STAGE2_EVAL_CRITERIA`: a short list of the most relevant evaluation criteria for this exact question

Do not use a fixed template library for this step. Generate both artifacts dynamically from the actual user question so the council can adapt to the task.

## Stage 1: Independent Answering

Spawn 3 answerer subagents in parallel. Each subagent answers the user's question independently with no knowledge of the others.

For each Stage 1 subagent, use this structure:

- `message`: `<insert STAGE1_PROMPT>\n\nQuestion: <insert the user's question>`
- Tell the subagent to answer independently, surface assumptions, preserve uncertainty, and avoid predicting consensus.

Use this model slot mix:

- Subagent 1: `strong-reasoning`
- Subagent 2: `balanced-reasoning`
- Subagent 3: `compact-or-mini`

Record each response. Assign anonymous labels:

- Subagent 1 response -> `Response A`
- Subagent 2 response -> `Response B`
- Subagent 3 response -> `Response C`

Important: do not reveal which model slot or model alias produced which response in any subsequent stage or in the final output.

## Stage 2: Anonymized Peer Evaluation

Spawn 3 evaluator subagents in parallel. Each evaluator assesses all Stage 1 responses anonymously as a verifier, not just as an editor.

Use this prompt for each evaluator, inserting the actual response texts and generated evaluation criteria:

```text
You are evaluating anonymous answers to a question. Evaluate them as a verifier who is trying to identify what is trustworthy, what is missing, and what should not be carried into a synthesized final answer.

Original Question:
<insert the user's question>

Evaluation Criteria:
<insert STAGE2_EVAL_CRITERIA>

Response A:
<insert Response A text>

Response B:
<insert Response B text>

Response C:
<insert Response C text>

For each response:
1. Judge it against the evaluation criteria above.
2. Identify any likely mistakes, unsupported claims, or parts that should not be trusted.
3. Identify important omissions.
4. Give a total score from 1 to 10.
5. Flag a fatal flaw if present; otherwise write "none".

Return your evaluation in this exact format:

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
Response B:
  - Score: <integer 1-10>
  - Fatal flaw: <one sentence or "none">
  - Key omissions: <brief list or "none">
  - Criteria assessments:
    - <criterion 1>: <brief judgment or score>
    - <criterion 2>: <brief judgment or score>
    - <criterion 3>: <brief judgment or score>
    - <add more only if needed>
Response C:
  - Score: <integer 1-10>
  - Fatal flaw: <one sentence or "none">
  - Key omissions: <brief list or "none">
  - Criteria assessments:
    - <criterion 1>: <brief judgment or score>
    - <criterion 2>: <brief judgment or score>
    - <criterion 3>: <brief judgment or score>
    - <add more only if needed>
OVERALL RECOMMENDED: Response [letter]
```

Use this model slot mix:

- Evaluator 1: `strong-reasoning`
- Evaluator 2: `balanced-reasoning`
- Evaluator 3: `compact-or-mini` or `low-effort-variant` for low-risk questions

After collecting all evaluations, parse each `SCORECARD:` block and compute an internal `AGGREGATE_SCORECARD`. For each response:

- total the reported `Score` values
- count how many evaluators flagged a non-`none` `Fatal flaw`
- collect the union of `Key omissions`
- count how many evaluators marked it in `OVERALL RECOMMENDED`

If a scorecard is partially malformed or missing fields, degrade conservatively instead of aborting. Use whatever structured fields are available, treat unknown items as unknown, and continue.

## Stage 3: Chairman Synthesis

Spawn 1 chairman subagent using the `chairman` slot. The chairman sees everything but with anonymous labels and no model slot or model alias names.

Use this prompt:

```text
You are the chairman of an LLM Council. Your job is to synthesize the best possible answer by combining insights from multiple anonymous responses and their peer evaluations, while explicitly filtering out weak or unsafe material.

Original Question:
<insert the user's question>

Response A:
<insert Response A text>

Response B:
<insert Response B text>

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
### Council Result

**Final Answer** (from Chairman synthesis):
<chairman's final answer from the FINAL ANSWER section>

<details>
<summary>Council Details</summary>

**Aggregate Scorecard:**
- Response A: total score <n>, fatal flaws <n>, recommended by <n>/3 evaluators
- Response B: total score <n>, fatal flaws <n>, recommended by <n>/3 evaluators
- Response C: total score <n>, fatal flaws <n>, recommended by <n>/3 evaluators

**Key omissions addressed in the final answer:** <brief list>

**Chairman's verdict summary:** <brief summary of what was adopted, rejected, or treated as uncertain>
</details>
```

If any subagent fails or times out, continue with the remaining responses and mention the reduced sample size in `Council Details`.
