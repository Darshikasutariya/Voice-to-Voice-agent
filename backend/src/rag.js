import { ChatOpenAI } from "@langchain/openai";
import {
  HumanMessage,
  SystemMessage,
  AIMessage,
} from "@langchain/core/messages";
import { config } from "./config.js";
import { searchSimilar } from "./retrieval.js";
import { detectLanguage } from "./utils/langDetect.js";

const NO_DOCS_MSG_EN =
  "I could not find anything in the help docs for that. Please try rephrasing your question.";
const NO_DOCS_MSG_HI =
  "मुझे इसके लिए सहायता दस्तावेज़ों में कुछ नहीं मिला। कृपया अपना प्रश्न दूसरे शब्दों में पूछें।";
const NO_DOCS_MSG_GU =
  "મને આ માટે મદદ દસ્તાવેજોમાં કંઈ મળ્યું નથી. કૃપા કરીને તમારો પ્રશ્ન બીજા શબ્દોમાં પૂછો.";

function getNoDocsMsg(lang) {
  if (lang === "hi") return NO_DOCS_MSG_HI;
  if (lang === "gu") return NO_DOCS_MSG_GU;
  return NO_DOCS_MSG_EN;
}

/** Max prior messages sent to the model. Shorter = faster first token. */
const MAX_HISTORY_MESSAGES = 6;

/**
 * Chroma cosine distance threshold. If the BEST hit is above this,
 * treat retrieval as low-confidence and refuse to answer.
 */
const LOW_CONFIDENCE_THRESHOLD = 0.85;

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

/** Voice-optimized system prompt with language-locked output. */
function systemPrompt(context, detectedLang = "en") {
  let langInstruction;
  if (detectedLang === "hi") {
    langInstruction =
      "Respond strictly in Hindi using Devanagari script. Do not mix English words unless they are proper product names (Tally, Vyapar TaxOne, GST, Excel).";
  } else if (detectedLang === "gu") {
    langInstruction =
      "Respond strictly in Gujarati using Gujarati script. Do not mix English words unless they are proper product names (Tally, Vyapar TaxOne, GST, Excel).";
  } else {
    langInstruction = "Respond strictly in English.";
  }

  return `You are the Vyapar TaxOne voice help assistant. Your responses will be spoken aloud to the user.

ANSWER RULES:
- Try HARD to answer from the CONTEXT below. The CONTEXT contains help docs about Vyapar TaxOne features (Banking, Sales, Purchase, GST, OCR, User Management, Tally integration, etc.).
- If the CONTEXT mentions the topic even briefly or partially, give a useful answer based on what IS there. Do not refuse just because the answer is not perfect.
- Only say "I do not have that information in the help docs" if the CONTEXT is COMPLETELY unrelated to the question (e.g. user asks about cooking and context is about banking).
- When in doubt between refusing and giving a partial answer, ALWAYS prefer giving the partial answer using what's in CONTEXT.
- Keep responses short and conversational. Aim for 2 to 3 sentences. Never exceed 4 sentences (EXCEPTION: when giving all steps of a full process as described below, up to 8 sentences is allowed).
- Use plain spoken language. No markdown, no bullet points, no numbered lists, no asterisks, no URLs, no file paths.
- Never read keyboard shortcuts character-by-character. Say "press control plus S" not "C-T-R-L plus S".
- Refer to the product as Vyapar TaxOne. Never say Suvit.
- For procedural / step-by-step questions, default to giving the FIRST step only and asking "would you like the next step?" before continuing.
- EXCEPTION: If the user EXPLICITLY asks for the complete / full / entire process or all steps in any language (phrases like "complete process", "full process", "all steps", "everything", "entire process", "puri process", "poora process", "sare steps", "sab steps", "puri jankari", "sab batao", "sab kuch batao", "પૂરી process", "બધી steps", "બધું", "पूरी process", "सारे steps", "सब बताओ", "सब कुछ", "सारी जानकारी"), give ALL the steps in order in a single concise response. Do NOT ask "would you like the next step?" in this case. Do NOT pause between steps. Use short sentences for each step. Keep total response under 8 sentences (it will be read aloud).
- If the user responds affirmatively ("yes", "हाँ", "haan", "aage batao", "next") after you asked "would you like the next step?", continue with the NEXT step and ask again.
- Use the conversation history for tone and follow-ups only. Facts must come from the CONTEXT.

LANGUAGE:
${langInstruction}

CONTEXT:
${context}`;
}

/**
 * Build context string with source labels so the LLM knows where each fact comes from.
 */
function hitsToContextAndSources(hits) {
  const contextParts = [];
  const sources = [];

  hits.forEach(([doc], i) => {
    const meta = doc.metadata ?? {};
    const moduleLabel = meta.module
      ? meta.module.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
      : "General";
    const title = meta.title ?? "Untitled";

    contextParts.push(
      `[${i + 1}] (${moduleLabel} — ${title})\n${doc.pageContent}`,
    );

    sources.push({
      title,
      url: meta.url ?? "",
      module: meta.module ?? "general",
      priority: meta.priority ?? "medium",
    });
  });

  return {
    context: contextParts.join("\n\n"),
    sources,
  };
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

function buildLlmMessages(context, history, question, detectedLang = "en") {
  return [
    new SystemMessage(systemPrompt(context, detectedLang)),
    ...historyToMessages(history),
    new HumanMessage(question),
  ];
}

/** True if at least the top hit is below the distance threshold. */
function hasConfidentMatch(hits) {
  if (!hits || hits.length === 0) return false;
  const topScore = hits[0][1];
  return topScore <= LOW_CONFIDENCE_THRESHOLD;
}

/**
 * Non-streaming RAG. Used by HTTP endpoints.
 * @param {string} question
 * @param {{ role: "user" | "assistant", content: string }[]} [history]
 */
export async function ragAnswer(question, history = []) {
  assertOpenAI();
  const safeHistory = parseChatHistory(history);
  const detectedLang = detectLanguage(question);

  const hits = await searchSimilar(question, 5);

  if (hits.length === 0 || !hasConfidentMatch(hits)) {
    return { answer: getNoDocsMsg(detectedLang), sources: [] };
  }

  const { context, sources } = hitsToContextAndSources(hits);
  const llm = new ChatOpenAI({
    model: config.openai.model,
    temperature: 0.2,
    apiKey: config.openai.apiKey,
  });

  const reply = await llm.invoke(
    buildLlmMessages(context, safeHistory, question, detectedLang),
  );

  return {
    answer:
      typeof reply.content === "string"
        ? reply.content
        : String(reply.content),
    sources,
  };
}

function ts() {
  const d = new Date();
  return `${d.toLocaleTimeString("en-IN", { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/**
 * Streaming RAG for voice. Detects language ONCE from the user question,
 * then passes it through to the TTS chunker — single source of truth.
 *
 * @param {string} question
 * @param {(ev: { type: string, text?: string, sources?: object[], code?: string }) => void} emit
 * @param {{ role: "user" | "assistant", content: string }[]} [history]
 * @param {AbortSignal} [signal]
 * @param {"en"|"hi"|"gu"} [detectedLang] - if not provided, will detect from question
 */
export async function streamRagAnswer(
  question,
  emit,
  history = [],
  signal,
  detectedLang,
) {
  assertOpenAI();
  const safeHistory = parseChatHistory(history);

  // Single source of truth: detect once, pass through.
  const lang = detectedLang || detectLanguage(question);

  console.log(`[${ts()}] [RAG] Lang=${lang} | Searching: "${question.slice(0, 80)}"`);
  const startSearch = Date.now();
  const hits = await searchSimilar(question, 5);
  const searchDuration = Date.now() - startSearch;

  const topScore = hits[0]?.[1];
  console.log(
    `[${ts()}] [RAG] Search done in ${searchDuration}ms. Hits=${hits.length}, topScore=${topScore?.toFixed(4) ?? "n/a"}`,
  );

  if (signal?.aborted) {
    console.log(`[${ts()}] [RAG] Aborted after search.`);
    return;
  }

  if (hits.length === 0 || !hasConfidentMatch(hits)) {
    console.log(`[${ts()}] [RAG] Low confidence (top=${topScore?.toFixed(4)}). Returning no-docs message.`);
    emit({ type: "token", text: getNoDocsMsg(lang) });
    if (!signal?.aborted) emit({ type: "done", sources: [] });
    return;
  }

  const { context, sources } = hitsToContextAndSources(hits);

  const moduleHits = sources.map((s) => s.module).join(", ");
  console.log(`[${ts()}] [RAG] Modules in context: ${moduleHits}`);

  const llm = new ChatOpenAI({
    model: config.openai.model,
    temperature: 0.2,
    apiKey: config.openai.apiKey,
  });

  console.log(`[${ts()}] [RAG] Starting LLM stream...`);
  const startLlmStream = Date.now();
  const stream = await llm.stream(
    buildLlmMessages(context, safeHistory, question, lang),
    { signal },
  );

  let firstChunkReceived = false;
  for await (const chunk of stream) {
    if (signal?.aborted) {
      console.log(`[${ts()}] [RAG] Aborted during stream.`);
      return;
    }
    const text = textFromChunk(chunk);
    if (text) {
      if (!firstChunkReceived) {
        firstChunkReceived = true;
        const ttft = Date.now() - startLlmStream;
        console.log(`[${ts()}] [RAG] First token in ${ttft}ms.`);
      }
      emit({ type: "token", text });
    }
  }

  const streamDuration = Date.now() - startLlmStream;
  console.log(`[${ts()}] [RAG] Stream done in ${streamDuration}ms.`);
  if (!signal?.aborted) emit({ type: "done", sources });
}