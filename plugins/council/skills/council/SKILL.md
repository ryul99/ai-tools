---
name: council
description: Convene an LLM Council to answer a question. Launches multiple Claude models (opus, sonnet, haiku) independently, has them anonymously evaluate each other's answers, then synthesizes the best response. Use when you want diverse perspectives, high-quality answers, or a second opinion on complex questions.
allowed-tools: Agent
---

# LLM Council

You are orchestrating an LLM Council. The user's question is:

> $ARGUMENTS

Follow the three stages below **exactly**. Each stage must complete before the next begins.

---

## Stage 1: Independent Answering

Launch **3 Agent tool calls in a single message** (so they run in parallel). Each agent answers the user's question independently with no knowledge of the others.

**Agent 1 (Opus):**
- `description`: "Council member A answering"
- `model`: "opus"
- `prompt`: "Answer the following question thoroughly and thoughtfully. Provide your best, most complete answer.\n\nQuestion: $ARGUMENTS"

**Agent 2 (Sonnet):**
- `description`: "Council member B answering"
- `model`: "sonnet"
- `prompt`: "Answer the following question thoroughly and thoughtfully. Provide your best, most complete answer.\n\nQuestion: $ARGUMENTS"

**Agent 3 (Haiku):**
- `description`: "Council member C answering"
- `model`: "haiku"
- `prompt`: "Answer the following question thoroughly and thoughtfully. Provide your best, most complete answer.\n\nQuestion: $ARGUMENTS"

Record each agent's response. Assign anonymous labels:
- Opus response -> **Response A**
- Sonnet response -> **Response B**
- Haiku response -> **Response C**

**Important:** Do NOT reveal which model produced which response in any subsequent stage.

---

## Stage 2: Anonymized Peer Evaluation

Launch **3 Agent tool calls in a single message** (parallel). Each agent evaluates all Stage 1 responses anonymously.

For each agent, use this prompt (inserting the actual response texts):

```
You are evaluating answers to a question. The answers are anonymous -- you do not know which model produced which response. Evaluate purely on quality.

**Original Question:** $ARGUMENTS

**Response A:**
<insert Response A text>

**Response B:**
<insert Response B text>

**Response C:**
<insert Response C text>

Evaluate each response on:
1. Accuracy and correctness
2. Completeness and depth
3. Clarity and organization
4. Practical usefulness

Write a brief evaluation of each response, then provide your final ranking in this exact format:

FINAL RANKING:
1. Response [letter]
2. Response [letter]
3. Response [letter]
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

After collecting all evaluations, parse each `FINAL RANKING:` section. Tally rankings across all evaluators to determine the aggregate ranking.

---

## Stage 3: Chairman Synthesis (Anonymized)

Launch **1 Agent tool call**. The chairman sees everything but with anonymous labels -- no model names.

**Chairman Agent (Opus):**
- `description`: "Council chairman synthesizing"
- `model`: "opus"
- `prompt`:

```
You are the chairman of an LLM Council. Your job is to synthesize the best possible answer by combining insights from multiple anonymous responses and their peer evaluations.

**Original Question:** $ARGUMENTS

**Response A:**
<insert Response A text>

**Response B:**
<insert Response B text>

**Response C:**
<insert Response C text>

**Evaluator 1's Assessment:**
<insert Evaluator 1's full evaluation>

**Evaluator 2's Assessment:**
<insert Evaluator 2's full evaluation>

**Evaluator 3's Assessment:**
<insert Evaluator 3's full evaluation>

Based on all responses and evaluations, synthesize the best possible answer. You should:
1. Identify the strongest points from each response
2. Correct any errors found in individual responses
3. Combine complementary insights
4. Produce a comprehensive, well-structured final answer

Your synthesized answer:
```

---

## Final Output

Present the results to the user in this format:

### Council Result

**Final Answer** (from Chairman synthesis):
<chairman's synthesized answer>

<details>
<summary>Council Details</summary>

**Aggregate Ranking:** <show the tallied ranking, e.g., "Response A: avg rank 1.3, Response B: avg rank 2.0, Response C: avg rank 2.7">

**Individual Responses:**
- Response A (Opus): <brief summary>
- Response B (Sonnet): <brief summary>
- Response C (Haiku): <brief summary>
</details>

**Important notes:**
- In the final output (and ONLY in the final output), you may reveal which model produced which response
- The `<details>` block gives users optional transparency without cluttering the main answer
- If any agent fails, continue with the remaining responses -- graceful degradation
