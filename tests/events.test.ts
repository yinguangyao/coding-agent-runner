import { describe, expect, it } from "vitest";
import { mapStreamEventToAgentEvents } from "../src/index.js";

describe("stream event mapping", () => {
  it("maps ACP assistant text, thoughts, and tool lifecycle events", () => {
    expect(mapStreamEventToAgentEvents({
      sessionUpdate: "agent_message_chunk",
      content: [{ type: "text", text: "hello" }],
    })).toEqual([{ type: "message_delta", text: "hello" }]);

    expect(mapStreamEventToAgentEvents({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking" },
    })).toEqual([{ type: "thinking_delta", text: "thinking" }]);

    expect(mapStreamEventToAgentEvents({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Read file",
      rawInput: { path: "README.md" },
    })).toEqual([{
      type: "tool_start",
      id: "tool-1",
      name: "Read file",
      input: { path: "README.md" },
    }]);

    expect(mapStreamEventToAgentEvents({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      title: "Read file",
      status: "completed",
      content: [{ type: "text", text: "done" }],
    })).toEqual([{
      type: "tool_end",
      id: "tool-1",
      name: "Read file",
      output: "done",
      isError: false,
    }]);
  });

  it("maps Claude stream-json assistant and result events", () => {
    expect(mapStreamEventToAgentEvents({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    })).toEqual([{ type: "message_delta", text: "hi" }]);

    expect(mapStreamEventToAgentEvents({
      type: "result",
      subtype: "success",
      result: "final answer",
    })).toEqual([{ type: "result", text: "final answer", isError: false }]);
  });

  it("maps Codex raw v2 message deltas and command execution", () => {
    expect(mapStreamEventToAgentEvents("item/agentMessage/delta", {
      item: { id: "msg-1", delta: "hello" },
    })).toEqual([{ type: "message_delta", text: "hello" }]);

    expect(mapStreamEventToAgentEvents("item/completed", {
      item: {
        id: "cmd-1",
        type: "commandExecution",
        command: "npm test",
        exitCode: 1,
        aggregatedOutput: "failed",
      },
    })).toEqual([{
      type: "tool_end",
      id: "cmd-1",
      name: "shell",
      output: "failed",
      isError: true,
    }]);
  });
});
