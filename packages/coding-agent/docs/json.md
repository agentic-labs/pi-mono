# JSON Assistant Message Mode

```bash
pi --mode json "Your prompt"
```

Outputs assistant messages as JSON lines after each assistant turn completes. Streaming deltas, tool execution events, session lifecycle events, and the session header are not written in JSON mode.

## Message Types

Base messages from [`packages/ai/src/types.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/types.ts#L134):
- `AssistantMessage` (line 140)

## Output Format

Each line is a complete `AssistantMessage` object:

```json
{"role":"assistant","content":[{"type":"text","text":"Hello"}],"provider":"openai","model":"gpt-4o-mini","stopReason":"stop",...}
```

Runs with multiple assistant turns output one completed assistant-turn message per line.

For a persistent protocol with streaming events and command responses, use [`--mode rpc`](rpc.md).

## Example

```bash
pi --mode json "List files" 2>/dev/null | jq -r '.content[] | select(.type == "text") | .text'
```
