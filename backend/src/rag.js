import { ChatOpenAI } from "@langchain/openai";
import {
  HumanMessage,
  SystemMessage,
  AIMessage,
} from "@langchain/core/messages";
import { config } from "./config.js";
import { searchSimilar } from "./retrieval.js";

const NO_DOCS_MSG =
  "I could not find anything in the help docs for that. Try rephrasing or run ingest first.";

/** Max prior messages (user + assistant combined) sent to the model. */
const MAX_HISTORY_MESSAGES = 8;

function assertOpenAI() {
  if (!config.openai.apiKey) {
    const err = new Error("OPENAI_API_KEY is not set");
    err.code = "NO_OPENAI_KEY";
    throw err;
  }
}

/**
 * @param {unknown} raw
 * @returns {{ role: "user" | "assistant", content: string }[]}
 */
export function parseChatHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const role =
      item.role === "assistant"
        ? "assistant"
        : item.role === "user"
          ? "user"
          : null;
    if (!role) continue;
    const content = String(item.content ?? "")
      .trim()
      .slice(0, 12_000);
    if (!content) continue;
    out.push({ role, content });
  }
  return out.slice(-MAX_HISTORY_MESSAGES);
}

function systemPrompt(context) {
  return `You are TaxOne Help Assistant. Answer only using the context below. If the answer is not there, say you do not have that in the help docs. Keep the reply short (spoken-style): no markdown, no bullet lists, no URLs.

Use the conversation history only for tone and follow-ups; facts must still come from the context.

Context:
${context}`;
}

function hitsToContextAndSources(hits) {
  const context = hits
    .map(([doc], i) => `[${i + 1}] ${doc.pageContent}`)
    .join("\n\n");
  const sources = hits.map(([doc]) => ({
    title: doc.metadata.title ?? "",
    url: doc.metadata.url ?? "",
  }));
  return { context, sources };
}

/** @param {{ role: string, content: string }[]} history */
function historyToMessages(history) {
  const msgs = [];
  for (const h of history) {
    if (h.role === "user") msgs.push(new HumanMessage(h.content));
    else msgs.push(new AIMessage(h.content));
  }
  return msgs;
}

/** @param {import("@langchain/core/messages").AIMessageChunk} chunk */
function textFromChunk(chunk) {
  const c = chunk?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => (typeof p === "string" ? p : (p?.text ?? "")))
      .join("");
  }
  return "";
}

function buildLlmMessages(context, history, question) {
  return [
    new SystemMessage(systemPrompt(context)),
    ...historyToMessages(history),
    new HumanMessage(question),
  ];
}

/**
 * Retrieve from Chroma, then answer with OpenAI using only that context.
 * @param {string} question
 * @param {{ role: "user" | "assistant", content: string }[]} [history]
 */
export async function ragAnswer(question, history = []) {
  assertOpenAI();
  const safeHistory = parseChatHistory(history);

  const hits = await searchSimilar(question, 4);
  if (hits.length === 0) {
    return { answer: NO_DOCS_MSG, sources: [] };
  }

  const { context, sources } = hitsToContextAndSources(hits);
  const llm = new ChatOpenAI({
    model: config.openai.model,
    temperature: 0.2,
    apiKey: config.openai.apiKey,
  });

  const reply = await llm.invoke(
    buildLlmMessages(context, safeHistory, question),
  );

  return {
    answer:
      typeof reply.content === "string"
        ? reply.content
        : String(reply.content),
    sources,
  };
}

/**
 * Same RAG as ragAnswer, but streams tokens via emit({ type, ... }).
 * @param {string} question
 * @param {(ev: { type: string, text?: string, sources?: object[], code?: string }) => void} emit
 * @param {{ role: "user" | "assistant", content: string }[]} [history]
 * @param {AbortSignal} [signal] — when aborted, stop emitting (interrupted by a newer question)
 */
export async function streamRagAnswer(question, emit, history = [], signal) {
  assertOpenAI();
  const safeHistory = parseChatHistory(history);

  const hits = await searchSimilar(question, 4);
  if (signal?.aborted) return;

  if (hits.length === 0) {
    emit({ type: "token", text: NO_DOCS_MSG });
    if (!signal?.aborted) emit({ type: "done", sources: [] });
    return;
  }

  const { context, sources } = hitsToContextAndSources(hits);
  const llm = new ChatOpenAI({
    model: config.openai.model,
    temperature: 0.2,
    apiKey: config.openai.apiKey,
  });

  const stream = await llm.stream(
    buildLlmMessages(context, safeHistory, question),
    { signal },
  );

  for await (const chunk of stream) {
    if (signal?.aborted) return;
    const text = textFromChunk(chunk);
    if (text) emit({ type: "token", text });
  }

  if (!signal?.aborted) emit({ type: "done", sources });
}
