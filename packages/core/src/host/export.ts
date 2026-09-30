/**
 * Conversation export.
 *
 * `md` for humans and pasting into an issue; `json` for the full tree including
 * usage and tool calls, so an import can restore it losslessly.
 */

import { basename, relativePath } from "../platform/paths.js";
import type { PlatformInfo } from "../platform/platform.js";
import type { Conversation, StoredMessage } from "../storage/repositories.js";
import type { ConversationExport } from "./api.js";

export function buildExport(
  conversation: Conversation,
  messages: readonly StoredMessage[],
  format: "md" | "json",
  platform: PlatformInfo,
): ConversationExport {
  const name = sanitizeFilename(conversation.title ?? "conversation");
  if (format === "json") {
    return {
      filename: `${name}.json`,
      mimeType: "application/json",
      content: JSON.stringify(
        {
          version: 1,
          exportedAt: new Date().toISOString(),
          conversation,
          messages: messages.map(serializeMessage),
        },
        null,
        2,
      ),
    };
  }
  return { filename: `${name}.md`, mimeType: "text/markdown", content: toMarkdown(conversation, messages, platform) };
}

export function toMarkdown(
  conversation: Conversation,
  messages: readonly StoredMessage[],
  platform: PlatformInfo,
): string {
  const lines: string[] = [];
  lines.push(`# ${conversation.title ?? "Untitled conversation"}`);
  lines.push("");
  const meta: string[] = [`Mode: ${conversation.mode}`];
  if (conversation.model) meta.push(`Model: ${conversation.model}`);
  if (conversation.workspace) meta.push(`Workspace: \`${conversation.workspace}\``);
  meta.push(`Exported: ${new Date().toISOString()}`);
  lines.push(...meta);
  lines.push("");

  for (const message of messages) {
    switch (message.role) {
      case "user":
        lines.push("## You");
        lines.push("");
        lines.push(...renderParts(message.content));
        lines.push("");
        break;
      case "assistant":
        lines.push("## Atomic");
        lines.push("");
        lines.push(...renderParts(message.content));
        if (message.toolCalls?.length) {
          lines.push("");
          lines.push("### Tool calls");
          lines.push("");
          for (const call of message.toolCalls) {
            lines.push(`- \`${call.name}\` \`${truncate(call.rawArgs, 200)}\``);
          }
          lines.push("");
        }
        if (message.usage) {
          lines.push("");
          lines.push(
            `> ${message.usage.inputTokens} in · ${message.usage.outputTokens} out` +
              (message.usage.cacheReadTokens ? ` · ${message.usage.cacheReadTokens} cached` : ""),
          );
        }
        lines.push("");
        break;
      case "tool":
        lines.push(`<details><summary>Tool: ${escapeHtml(message.toolName ?? "")}</summary>`);
        lines.push("");
        lines.push("```");
        lines.push(textOf(message.content).slice(0, 20_000));
        lines.push("```");
        lines.push("");
        lines.push("</details>");
        lines.push("");
        break;
      case "system":
        lines.push(`> System: ${textOf(message.content)}`);
        lines.push("");
        break;
    }
  }
  void platform;
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

function serializeMessage(message: StoredMessage): Record<string, unknown> {
  return {
    id: message.id,
    parentId: message.parentId,
    role: message.role,
    content: message.content,
    reasoning: message.reasoning,
    model: message.model,
    providerId: message.providerId,
    toolCalls: message.toolCalls,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    usage: message.usage,
    finishReason: message.finishReason,
    createdAt: message.createdAt,
    seq: message.seq,
  };
}

function renderParts(content: StoredMessage["content"]): string[] {
  const out: string[] = [];
  for (const part of content) {
    if (part.type === "text") out.push(part.text);
    else if (part.type === "image") out.push("*[image]*");
    else if (part.type === "file") out.push(`*[file: ${part.name ?? "attachment"}]*`);
    else if (part.type === "thinking") out.push(`> _Reasoning:_ ${part.text}`);
  }
  return out.length ? out : ["*(empty)*"];
}

function textOf(content: StoredMessage["content"]): string {
  return content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function sanitizeFilename(value: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80);
  return cleaned || "conversation";
}

export { basename, relativePath };
