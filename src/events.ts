/** Event mappers from provider-specific streams into a small stable event union. */
import type { AgentStreamEvent } from "./types.js";

/** Map an ACP/Claude event or a Codex method+params pair into normalized events. */
export function mapStreamEventToAgentEvents(event: unknown): AgentStreamEvent[];
export function mapStreamEventToAgentEvents(method: string, params: unknown): AgentStreamEvent[];
export function mapStreamEventToAgentEvents(
  first: unknown,
  second?: unknown,
): AgentStreamEvent[] {
  if (typeof first === "string") return mapCodexNotification(first, second);
  return mapNativeOrAcpEvent(first);
}

function mapNativeOrAcpEvent(event: unknown): AgentStreamEvent[] {
  const claude = mapClaudeNative(event);
  if (claude.length > 0) return claude;
  const update = extractSessionUpdate(event);
  return update ? mapAcpSessionUpdate(update) : [];
}

function mapAcpSessionUpdate(update: Record<string, unknown>): AgentStreamEvent[] {
  const kind = update.sessionUpdate;
  if (kind === "agent_message_chunk") {
    const text = readContentText(update.content);
    return text ? [{ type: "message_delta", text }] : [];
  }
  if (kind === "agent_thought_chunk") {
    const text = readContentText(update.content);
    return text ? [{ type: "thinking_delta", text }] : [];
  }
  if (kind === "tool_call") {
    return [{
      type: "tool_start",
      id: readString(update.toolCallId),
      name: readString(update.title) || readString(update.kind) || "tool",
      input: update.rawInput ?? {},
    }];
  }
  if (kind === "tool_call_update") {
    const status = readString(update.status);
    const base = {
      id: readString(update.toolCallId),
      name: readString(update.title) || readString(update.kind) || "tool",
      input: update.rawInput ?? {},
    };
    if (status !== "completed" && status !== "failed") {
      return [{ type: "tool_update", ...base, output: readContentText(update.content) }];
    }
    return [{
      type: "tool_end",
      id: base.id,
      name: base.name,
      output: readContentText(update.content) || stringifyOutput(update.rawOutput),
      isError: status === "failed",
    }];
  }
  if (kind === "plan") {
    const text = formatPlan(update.entries);
    return text ? [{ type: "thinking_delta", text }] : [];
  }
  return [];
}

function mapClaudeNative(event: unknown): AgentStreamEvent[] {
  if (!event || typeof event !== "object") return [];
  const obj = event as Record<string, unknown>;
  if (obj.type === "assistant") {
    const message = obj.message as { content?: unknown } | undefined;
    const text = readClaudeContent(message?.content, "text");
    const thinking = readClaudeContent(message?.content, "thinking");
    return [
      ...(text ? [{ type: "message_delta" as const, text }] : []),
      ...(thinking ? [{ type: "thinking_delta" as const, text: thinking }] : []),
    ];
  }
  if (obj.type === "result") {
    const text = readString(obj.result);
    const subtype = readString(obj.subtype);
    const isError = obj.is_error === true || (subtype.length > 0 && subtype !== "success");
    return text ? [{ type: "result", text, isError }] : [];
  }
  return [];
}

function mapCodexNotification(method: string, params: unknown): AgentStreamEvent[] {
  if (!params || typeof params !== "object") return [];
  if (method === "item/agentMessage/delta") {
    const obj = params as { delta?: unknown; text?: unknown; item?: { delta?: unknown; text?: unknown } };
    const text = readString(obj.delta) || readString(obj.text) || readString(obj.item?.delta) || readString(obj.item?.text);
    return text ? [{ type: "message_delta", text }] : [];
  }
  if (method === "item/started") {
    const item = (params as { item?: Record<string, unknown> }).item;
    if (!item) return [];
    if (item.type === "commandExecution") {
      return [{ type: "tool_start", id: readString(item.id), name: "shell", input: { command: readString(item.command) } }];
    }
    if (item.type === "fileChange") {
      return [{ type: "tool_start", id: readString(item.id), name: "edit", input: { path: readString(item.path) } }];
    }
    if (item.type === "reasoning") {
      return [{ type: "thinking_start", id: readString(item.id) }];
    }
    if (item.type === "agentMessage") {
      const text = readString(item.text);
      return text ? [{ type: "message_delta", text }] : [];
    }
  }
  if (method === "item/progress") {
    const item = (params as { item?: Record<string, unknown> }).item;
    if (item?.type === "commandExecution") {
      return [{
        type: "tool_update",
        id: readString(item.id),
        name: "shell",
        input: { command: readString(item.command) },
        output: readString(item.output),
      }];
    }
  }
  if (method === "item/completed") {
    const item = (params as { item?: Record<string, unknown> }).item;
    if (!item) return [];
    if (item.type === "agentMessage") {
      return [];
    }
    if (item.type === "reasoning") {
      return [{ type: "thinking_end", id: readString(item.id) }];
    }
    if (item.type === "commandExecution") {
      return [{
        type: "tool_end",
        id: readString(item.id),
        name: "shell",
        output: readString(item.aggregatedOutput) || [readString(item.output), readString(item.stderr)].filter(Boolean).join("\n"),
        isError: typeof item.exitCode === "number" && item.exitCode !== 0,
      }];
    }
    if (item.type === "fileChange") {
      return [{
        type: "tool_end",
        id: readString(item.id),
        name: "edit",
        output: readString(item.diff) || readString(item.path),
        isError: false,
      }];
    }
  }
  if (method === "codex/event") return mapLegacyCodexEvent(params);
  return [];
}

function mapLegacyCodexEvent(params: unknown): AgentStreamEvent[] {
  const msg = (params as { msg?: Record<string, unknown> } | undefined)?.msg;
  if (!msg) return [];
  const type = readString(msg.type);
  if (type === "agent_message") {
    const text = readString(msg.message);
    return text ? [{ type: "message_delta", text }] : [];
  }
  if (type === "exec_command_begin") {
    return [{ type: "tool_start", id: readString(msg.call_id), name: "shell", input: { command: readString(msg.command) } }];
  }
  if (type === "exec_command_end") {
    return [{
      type: "tool_end",
      id: readString(msg.call_id),
      name: "shell",
      output: readString(msg.output),
      isError: typeof msg.exit_code === "number" && msg.exit_code !== 0,
    }];
  }
  if (type === "patch_apply_begin") {
    return [{ type: "tool_start", id: readString(msg.call_id), name: "edit", input: { path: readString(msg.path) } }];
  }
  if (type === "patch_apply_end") {
    return [{ type: "tool_end", id: readString(msg.call_id), name: "edit", output: readString(msg.path), isError: false }];
  }
  return [];
}

function extractSessionUpdate(event: unknown): Record<string, unknown> | null {
  if (!event || typeof event !== "object") return null;
  const obj = event as Record<string, unknown>;
  if (typeof obj.sessionUpdate === "string") return obj;
  if ((obj.type === "session_update" || obj.type === "session/update") && obj.update && typeof obj.update === "object") {
    return obj.update as Record<string, unknown>;
  }
  if (obj.method === "session/update") {
    const params = obj.params as { update?: unknown } | Record<string, unknown> | undefined;
    const candidate = params && typeof params === "object" && "update" in params ? params.update : params;
    if (candidate && typeof candidate === "object") return candidate as Record<string, unknown>;
  }
  return null;
}

function readContentText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(readContentText).join("");
  if (typeof content === "object") {
    const obj = content as { type?: unknown; text?: unknown; content?: unknown };
    if (typeof obj.text === "string") return obj.text;
    if (obj.content) return readContentText(obj.content);
  }
  return "";
}

function readClaudeContent(content: unknown, contentType: "text" | "thinking"): string {
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const obj = part as Record<string, unknown>;
    if (obj.type !== contentType) return "";
    return contentType === "thinking" ? readString(obj.thinking) : readString(obj.text);
  }).join("");
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringifyOutput(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatPlan(entries: unknown): string {
  if (!Array.isArray(entries)) return "";
  return entries.map((entry) => {
    if (!entry || typeof entry !== "object") return "";
    const obj = entry as Record<string, unknown>;
    return [readString(obj.status), readString(obj.content) || readString(obj.title)].filter(Boolean).join(": ");
  }).filter(Boolean).join("\n");
}
