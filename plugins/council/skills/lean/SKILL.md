---
name: lean
description: Convene a lightweight LLM Council with broader answer coverage and simpler evaluation. Uses 4-5 answerers and a single evaluation pass to improve diversity without the full overhead of the original council.
allowed-tools: Agent
---

# Lean Council

You are orchestrating a lightweight LLM Council. The user's question is:

> $ARGUMENTS

Follow the stages below **exactly**. Each stage must complete before the next begins.

---

## Stage 0: Lightweight Prompt Setup

Before launching any agents, inspect the user question and determine:
- the task nature (for example: factual, analytical, coding, creative, advisory)
- the desired answer shape (for example: recommendation, comparison, checklist, code, concise summary)
- whether the question benefits more from breadth, caution, or actionability

Then create these two internal artifacts:
- `STAGE1_PROMPT`: a concise question-specific answering prompt optimized for useful first-pass responses
- `MEMBER_STANCE_SET`: a set of 4 or 5 lightweight answer stances that create some diversity without requiring a full role-based framework

Keep this setup short and practical. Avoid over-designing the prompt.

Choose either:
- **4 members** for ordinary questions
- **5 members** only if the question is nuanced enough to justify the extra coverage

Recommended stance examples:
- direct practical answer
- skeptical answer
- edge-case aware answer
- concise synthesis answer
- optional fifth: long-term trade-off answer

---

## Stage 1: Expanded Lightweight Answering

Launch **4 or 5 Agent tool calls in a single message** (so they run in parallel), depending on the `MEMBER_STANCE_SET` selected in Stage 0. Each agent answers independently.

For each Stage 1 agent, use this structure:
- `description`: "Council member <letter> answering"
- `prompt`: "<insert STAGE1_PROMPT>\n\nUse this answering stance: <insert stance from MEMBER_STANCE_SET>. Keep the answer practical and do not spend much space narrating the stance itself.\n\nQuestion: $ARGUMENTS"

Use this default model mix unless the question strongly suggests otherwise:
- Member A: `opus`
- Member B: `sonnet`
- Member C: `haiku`
- Member D: `sonnet`
- Optional Member E: `haiku`

Assign anonymous labels sequentially as **Response A**, **Response B**, **Response C**, **Response D**, and optionally **Response E**.

**Important:** Do NOT reveal which model produced which response in any subsequent stage or in the final output.

---

## Stage 2: Single Evaluation Pass

Launch **1 Agent tool call** to evaluate all Stage 1 responses in a single pass. This evaluator acts as a verifier, not just as an editor.

**Evaluator Agent:**
- `description`: "Lean council evaluator"
- `model`: "opus"
- `prompt`:

```
You are evaluating anonymous answers to a question. Evaluate them as a verifier who is trying to identify what is trustworthy, what is missing, and which response gives the strongest foundation for a synthesized final answer.

**Original Question:** $ARGUMENTS

**Responses:**
<insert all response texts with labels A-E as applicable>

For each response:
1. Judge its usefulness and trustworthiness.
2. Identify likely mistakes, unsupported claims, or material that should not be trusted.
3. Identify important omissions.
4. Give a total score from 1 to 10.
5. Flag a fatal flaw if present; otherwise write "none".

Return your evaluation in this exact format:

SCORECARD:
Response A:
  - Score: <integer 1-10>
  - Fatal flaw: <one sentence or "none">
  - Key omissions: <brief list or "none">
  - Notes: <brief judgment>
Response B:
  - Score: <integer 1-10>
  - Fatal flaw: <one sentence or "none">
  - Key omissions: <brief list or "none">
  - Notes: <brief judgment>
Response C:
  - Score: <integer 1-10>
  - Fatal flaw: <one sentence or "none">
  - Key omissions: <brief list or "none">
  - Notes: <brief judgment>
Response D:
  - Score: <integer 1-10>
  - Fatal flaw: <one sentence or "none">
  - Key omissions: <brief list or "none">
  - Notes: <brief judgment>
Response E:
  - Score: <integer 1-10 or "n/a">
  - Fatal flaw: <one sentence, "none", or "n/a">
  - Key omissions: <brief list, "none", or "n/a">
  - Notes: <brief judgment or "n/a">
OVERALL RECOMMENDED: Response [letter]
```

If there is no Response E, still include the Response E block and mark it `n/a`.

After collecting the evaluation, compute an internal `AGGREGATE_SCORECARD` from it. Since there is only one evaluator, the aggregate can simply mirror the structured evaluation while preserving the same labels.

If the scorecard is partially malformed or missing fields, degrade conservatively instead of aborting. Use whatever structured fields are available, treat unknown items as unknown, and continue.

---

## Stage 3: Chairman Synthesis

Launch **1 Agent tool call** for synthesis.

**Chairman Agent:**
- `description`: "Lean council chairman synthesizing"
- `model`: "opus"
- `prompt`:

```
You are the chairman of a lightweight LLM Council. Your job is to synthesize the best possible answer by combining insights from multiple anonymous responses and their evaluation, while explicitly filtering out weak or unsafe material.

**Original Question:** $ARGUMENTS

**Responses:**
<insert all response texts with labels A-E as applicable>

**Evaluator Scorecard:**
<insert the full scorecard>

**Aggregate Scorecard:**
<insert AGGREGATE_SCORECARD>

First, perform a response triage before writing the final answer. Use one block per available response in this exact format:

VERDICT A:
- ADOPT: <strongest points or "none">
- REJECT: <claims to discard and why, or "none">
- UNCERTAIN: <claims that may be useful but should be softened, qualified, or omitted, or "none">

Repeat the same structure for each available response label.

Then, write the final answer using the adopted material, correcting issues identified by the evaluator, incorporating important missing points, and clearly signaling any residual uncertainty that remains relevant.

Your output must end with:

FINAL ANSWER:
<your synthesized answer>
```

---

## Final Output

Present the results to the user in this format:

### Lean Council Result

**Final Answer** (from Chairman synthesis):
<chairman's final answer from the `FINAL ANSWER:` section>

**Evaluation recap:**
- strongest foundation: <recommended response label>
- omissions addressed: <brief list>
- cautions filtered out: <brief list>

**Important notes:**
- This variant intentionally uses a single evaluation pass to reduce overhead
- If any answering agent fails, continue with the remaining responses -- graceful degradation
