---
name: baseline
description: Convene a simple LLM Council to answer a question. Launches Opus, Sonnet, and Haiku independently, has them anonymously evaluate each other's answers, then synthesizes the best response. Use when you want the original 3-member council flow as a fast, reliable second opinion.
allowed-tools: Agent
---

# LLM Council

You are orchestrating an LLM Council. The user's question is:

> $ARGUMENTS

Follow the stages below **exactly**. Each stage must complete before the next begins.

---

## Stage 0: Question Analysis and Prompt Design

Before launching any agents, inspect the user question and determine the dimensions that should shape both the answering prompt and the evaluation criteria. Consider factors such as:
- the task nature (for example: factual, analytical, coding, creative, advisory)
- the stakes or cost of being wrong
- the ideal answer shape (for example: direct recommendation, comparison, step-by-step plan, code, concise summary)
- whether uncertainty, assumptions, trade-offs, or edge cases should be emphasized

Then create these two internal artifacts for use in later stages:
- `STAGE1_PROMPT`: a question-specific answering prompt that tells each council member how to answer this exact question well
- `STAGE2_EVAL_CRITERIA`: a short list of the most relevant evaluation criteria for this exact question

Do NOT use a fixed template library for this step. Generate both artifacts dynamically from the actual user question so the council can adapt to the task.

---

## Stage 1: Independent Answering

Launch **3 Agent tool calls in a single message** (so they run in parallel). Each agent answers the user's question independently with no knowledge of the others.

For each Stage 1 agent, use this structure:
- `description`: one of the labels below
- `model`: as specified below
- `prompt`: "<insert STAGE1_PROMPT>\n\nQuestion: $ARGUMENTS"

**Agent 1 (Opus):**
- `description`: "Council member A answering"
- `model`: "opus"

**Agent 2 (Sonnet):**
- `description`: "Council member B answering"
- `model`: "sonnet"

**Agent 3 (Haiku):**
- `description`: "Council member C answering"
- `model`: "haiku"

Record each agent's response. Assign anonymous labels:
- Opus response -> **Response A**
- Sonnet response -> **Response B**
- Haiku response -> **Response C**

**Important:** Do NOT reveal which model produced which response in any subsequent stage or in the final output.

---

## Stage 2: Anonymized Peer Evaluation

Launch **3 Agent tool calls in a single message** (parallel). Each agent evaluates all Stage 1 responses anonymously as a verifier, not just as an editor.

For each agent, use this prompt (inserting the actual response texts and the generated evaluation criteria):

```
You are evaluating anonymous answers to a question. Evaluate them as a verifier who is trying to identify what is trustworthy, what is missing, and what should not be carried into a synthesized final answer.

**Original Question:** $ARGUMENTS

**Evaluation Criteria:**
<insert STAGE2_EVAL_CRITERIA>

**Response A:**
<insert Response A text>

**Response B:**
<insert Response B text>

**Response C:**
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

**Agent 1 (Opus):**
- `description`: "Council evaluator 1"
- `model`: "opus"

**Agent 2 (Sonnet):**
- `description`: "Council evaluator 2"
- `model`: "sonnet"

**Agent 3 (Haiku):**
- `description`: "Council evaluator 3"
- `model`: "haiku"

After collecting all evaluations, parse each `SCORECARD:` block and compute an internal `AGGREGATE_SCORECARD` for the chairman. For each response:
- total the reported `Score` values
- count how many evaluators flagged a non-`none` `Fatal flaw`
- collect the union of `Key omissions`
- count how many evaluators marked it in `OVERALL RECOMMENDED`

If a scorecard is partially malformed or missing fields, degrade conservatively instead of aborting. Use whatever structured fields are available, treat unknown items as unknown, and continue.

---

## Stage 3: Chairman Synthesis (Anonymized)

Launch **1 Agent tool call**. The chairman sees everything but with anonymous labels -- no model names.

**Chairman Agent (Opus):**
- `description`: "Council chairman synthesizing"
- `model`: "opus"
- `prompt`:

```
You are the chairman of an LLM Council. Your job is to synthesize the best possible answer by combining insights from multiple anonymous responses and their peer evaluations, while explicitly filtering out weak or unsafe material.

**Original Question:** $ARGUMENTS

**Response A:**
<insert Response A text>

**Response B:**
<insert Response B text>

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

**Aggregate Scorecard:**
- Response A (Opus): total score <n>, fatal flaws <n>, recommended by <n>/3 evaluators
- Response B (Sonnet): total score <n>, fatal flaws <n>, recommended by <n>/3 evaluators
- Response C (Haiku): total score <n>, fatal flaws <n>, recommended by <n>/3 evaluators

**Key omissions addressed in the final answer:** <brief list>

**Chairman's verdict summary:** <brief summary of what was adopted, rejected, or treated as uncertain>
</details>

**Important notes:**
- The `<details>` block gives users optional transparency without cluttering the main answer
- If any agent fails, continue with the remaining responses -- graceful degradation
