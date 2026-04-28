# JSON Transcript Mode

```bash
pi --mode json "Your prompt"
```

Outputs a compact transcript as JSON lines. Streaming deltas, tool execution events, queue updates, compaction events, retry events, and the session header are not written in JSON mode.

## Record Types

- `{"type":"agent_start"}` when a run starts.
- Complete `UserMessage` objects when user messages are accepted.
- Complete `AssistantMessage` objects after each assistant turn completes.
- `{"type":"agent_end"}` when a run ends.

## Output Format

Each line is one transcript record:

```json
{"type":"agent_start"}
{"role":"user","content":"Hello","timestamp":...}
{"role":"assistant","content":[{"type":"text","text":"Hello"}],"provider":"openai","model":"gpt-4o-mini","stopReason":"stop",...}
{"type":"agent_end"}
```

Runs with multiple assistant turns output one completed assistant-turn message per turn.

For a persistent protocol with streaming events and command responses, use [`--mode rpc`](rpc.md).

## Example

```bash
pi --mode json "List files" 2>/dev/null | jq -r 'select(.role == "assistant") | .content[] | select(.type == "text") | .text'
```
