#!/usr/bin/env bash
# acknowledge: https://github.com/crescent-stdio for prompt

INPUT="$(cat)"

if [[ "${ENGLISH_LECTURER_CHILD:-}" == "1" ]]; then
    exit 0
fi

# Ignore subagent response
if [[ "$(echo "$INPUT" | jq -r '.agent_id // .agent_type // empty')" != "" ]]; then
    exit 0
fi

INPUT_PROMPT="$(echo "$INPUT" | jq -r '.prompt')"

# Ignore subagent response
if [[ "$INPUT_PROMPT" == "<task-notification>"* ]]; then
    exit 0
fi

TARGET_LANGUAGE="Korean"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SCHEMA_PATH="$PLUGIN_DIR/schemas/response.json"
JSON_SCHEMA="$(<"$SCHEMA_PATH")"

INPUT_PROMPT="\
You are a supportive, encouraging English coach for a $TARGET_LANGUAGE developer. Analyze the prompt below and return structured JSON.

Rules:
1. enhanced_prompt: Rewrite to be clear, natural, professional English. Preserve the original intent exactly. If the prompt is code-only or already perfect English, return it unchanged.
2. has_corrections: true if you made any meaningful improvements, false if the prompt was already correct or is pure code/commands.
3. corrections: List up to 3 gentle improvement suggestions. Each must have:
   - original: the phrase from the original prompt
   - suggestion: the improved phrase
   - category: one of grammar, vocabulary, style, spelling, word_order
   - explanation: brief explanation in $TARGET_LANGUAGE (1 sentence, max 20 words).
4. tip: One memorable tip in $TARGET_LANGUAGE (1 sentence, max 30 words) about the most useful pattern. If no corrections, share a useful English expression tip.

Focus on patterns $TARGET_LANGUAGE speakers commonly struggle with: articles (a/the), prepositions, singular/plural, tense consistency, word order.

<PROMPT>
$INPUT_PROMPT
</PROMPT>\
"

hook_output() {
    if [[ -n "${PLUGIN_ROOT:-}" ]]; then
        printf '%s' "$1" | jq -Rs '{ systemMessage: . }'
    else
        printf '%s' "$1" | jq -Rs '{ suppressOutput: false, systemMessage: . }'
    fi
}

ERROR_FILE="$(mktemp "${TMPDIR:-/tmp}/english-lecturer.XXXXXX")"
trap 'rm -f "$ERROR_FILE"' EXIT

if [[ -n "${PLUGIN_ROOT:-}" ]]; then
    CODEX_COMMAND=(
        codex exec
        --ephemeral
        --ignore-user-config
        --disable hooks
        --sandbox read-only
        --skip-git-repo-check
        --output-schema "$SCHEMA_PATH"
        --config 'model_reasoning_effort="low"'
    )
    if [[ -n "${ENGLISH_LECTURER_CODEX_MODEL:-}" ]]; then
        CODEX_COMMAND+=(--model "$ENGLISH_LECTURER_CODEX_MODEL")
    fi
    if ! RESPONSE="$(
        printf '%s' "$INPUT_PROMPT" |
            ENGLISH_LECTURER_CHILD=1 "${CODEX_COMMAND[@]}" - 2>"$ERROR_FILE"
    )"; then
        ERROR_DETAIL="$(<"$ERROR_FILE")"
        hook_output "Failed to generate lesson with Codex: ${ERROR_DETAIL:-unknown error}"
        exit 0
    fi
    STRUCTURED_OUTPUT="$RESPONSE"
else
    CLAUDE_MODEL="${ENGLISH_LECTURER_CLAUDE_MODEL:-haiku}"
    if ! RESPONSE="$(
        CLAUDE_CODE_EFFORT_LEVEL=low MAX_THINKING_TOKENS=2000 \
        CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
        CLAUDE_CODE_SIMPLE=0 \
        ENGLISH_LECTURER_CHILD=1 \
        claude \
        --tools='' \
        --strict-mcp-config \
        --no-session-persistence \
        --safe-mode \
        --disable-slash-commands \
        --model "$CLAUDE_MODEL" \
        --settings '{ "disableAllHooks": true }' \
        --output-format json \
        --json-schema "$JSON_SCHEMA" \
        -p "$INPUT_PROMPT" \
        2>"$ERROR_FILE"
    )"; then
        ERROR_DETAIL="$(<"$ERROR_FILE")"
        hook_output "Failed to generate lesson with Claude: ${ERROR_DETAIL:-unknown error}"
        exit 0
    fi
    STRUCTURED_OUTPUT="$(echo "$RESPONSE" | jq -r '.structured_output')"
fi

if [[ -z "$STRUCTURED_OUTPUT" || "$STRUCTURED_OUTPUT" == "null" ]]; then
    ERROR_DETAIL="$(echo "$RESPONSE" | jq -r '.result // "unknown error"')"
    hook_output "Failed to generate lesson: $ERROR_DETAIL"
    exit 0
fi

ENHANCED="$(echo "$STRUCTURED_OUTPUT" | jq -r '.enhanced_prompt')"
CORRECTIONS_DISPLAY=""
TIP="$(echo "$STRUCTURED_OUTPUT" | jq -r '.tip')"

HAS_CORRECTIONS="$(echo "$STRUCTURED_OUTPUT" | jq -r '.has_corrections')"
if [[ "$HAS_CORRECTIONS" == "true" ]]; then
    CORRECTIONS_DISPLAY="$(echo "$STRUCTURED_OUTPUT" | jq -r '
        .corrections[] |
        "- ✅ \(.category): \(.original) → \(.suggestion)\n  - \(.explanation)\n"
    ')"
fi

hook_output "

$ENHANCED
${CORRECTIONS_DISPLAY:+
$CORRECTIONS_DISPLAY
}
✨ $TIP"

exit 0
