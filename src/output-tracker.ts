/** Output tracker for Codex app-server message deltas and completed items. */

interface MessageOutput {
  delta: string;
  completed: string | null;
  phase: string | null;
}

/** Tracks assistant output without duplicating completed full-text notifications. */
export interface OutputTracker {
  /** Append a text delta for an item. */
  onDelta: (itemId: string, text: string) => void;
  /** Record a completed full-text item. */
  onCompleted: (itemId: string, text?: string, phase?: string) => void;
  /** Return the best accumulated output. */
  getOutput: () => string;
}

/** Create a Codex output tracker. */
export function createOutputTracker(): OutputTracker {
  const messages = new Map<string, MessageOutput>();

  const ensure = (itemId: string): MessageOutput => {
    const existing = messages.get(itemId);
    if (existing) return existing;
    const next: MessageOutput = { delta: "", completed: null, phase: null };
    messages.set(itemId, next);
    return next;
  };

  return {
    onDelta(itemId, text) {
      ensure(itemId).delta += text;
    },
    onCompleted(itemId, text, phase) {
      const msg = ensure(itemId);
      if (typeof text === "string") msg.completed = text;
      if (typeof phase === "string") msg.phase = phase;
    },
    getOutput() {
      const all = [...messages.values()];
      const finalAnswer = all.find((msg) => msg.phase === "final_answer" && msg.completed != null);
      if (finalAnswer?.completed != null) return finalAnswer.completed;
      return all.map((msg) => msg.completed ?? msg.delta).join("");
    },
  };
}
