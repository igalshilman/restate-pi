import type {AgentMessage} from "@earendil-works/pi-agent-core";

/** The last assistant text in a pi transcript, or "" if there is none. */
export function lastAssistantText(messages: readonly AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "assistant") continue;
    const parts = message.content
      .filter((block): block is {type: "text"; text: string} => block.type === "text" && block.text.length > 0)
      .map((block) => block.text);
    if (parts.length) return parts.join("\n");
  }
  return "";
}

/** The text of a message's content: a string, or its text blocks joined by spaces. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (block?.type === "text" ? String(block.text ?? "") : "")).join(" ");
}
