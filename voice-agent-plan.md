# Voice Agent for Vyapar TaxOne Help Center — Build Plan

> **Goal:** Build a voice-first AI assistant that answers customer questions about Vyapar TaxOne (formerly Suvit) by retrieving from `https://taxone.vyapar.com/help` using RAG. The user speaks, the agent listens, retrieves, reasons, and speaks back.

**Current repository status (this workspace):** Only `backend/` and this plan file exist. The backend is a **CLI** (`node index.js ingest|query`): custom crawler → chunker → local **BGE-M3** embeddings (ONNX via `@huggingface/transformers`) → **ChromaDB**. There is **no** Express API, **no** LLM/RAG chain in code yet, and **no** React frontend. Ingest/query require Chroma running (e.g. `npm run chroma:up` in `backend`, default `CHROMA_URL=http://localhost:8000`). If ingest fails with `ChromaConnectionError`, start Chroma first.

---

## 1. Project Overview

Vyapar TaxOne's help center has **~250+ articles** across 12 collections (Getting Started, Banking, Sales, Purchase, Journal, Bulk Master, Client Management, GST Automation, Data Collection, OCR, Vyapar Integration, FAQs). A traditional search forces users to read; a voice agent lets a CA or accountant ask "How do I sync Vyapar with Tally?" hands-free while working in their accounting software.

**Core flow:** `User voice → STT → RAG over help docs → LLM → TTS → User`

---

## 2. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React (Vite) + Tailwind | Fast dev, modern DX |
| STT (Speech → Text) | Web Speech API (MVP), Deepgram Nova-2 (prod) | Free in browser; Deepgram for accuracy + Indian-English |
| TTS (Text → Speech) | Web Speech API (MVP), ElevenLabs / OpenAI TTS (prod) | Quality + multilingual |
| Backend | Node.js + Express (or Fastify) | JS end-to-end |
| Orchestration | **LangChain.js** | Loaders, splitters, retrievers, chains |
| Vector DB | Pinecone (managed) OR Chroma (local dev) | Pinecone for serverless; Chroma free locally |
| Embeddings | OpenAI `text-embedding-3-small` (1536-dim) | Cheap, strong on English+Hindi mix |
| LLM | GPT-4o-mini OR Claude Haiku 4.5 | Low latency is critical for voice |
| Streaming | **WebSocket** (e.g. `ws` on Node) | Bi-directional real-time tokens + future voice/audio signaling |
| Scraping | LangChain `RecursiveUrlLoader` + Cheerio | Built-in, handles the sitemap |
| Observability | LangSmith | Trace every RAG call |
| Deployment | Vercel (FE) + Railway / Fly.io (BE) | Simple, scales |

---

## 3. System Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                         React Frontend                         │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐    │
│  │ Mic Button   │──▶│ Web Speech   │──▶│ Transcript Panel │    │
│  │ (VAD)        │   │ Recognition  │   │                  │    │
│  └──────────────┘   └──────────────┘   └────────┬─────────┘    │
│                                                 │              │
│  ┌──────────────────────────┐   ┌───────────────▼───────────┐  │
│  │ Speech Synthesis (TTS)   │◀──│ WebSocket `/ws/chat`       │  │
│  └──────────────────────────┘   └───────────────┬───────────┘  │
└─────────────────────────────────────────────────┼──────────────┘
                                                  │ WebSocket
┌─────────────────────────────────────────────────▼──────────────┐
│                    Node.js + Express Backend                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              LangChain.js RAG Chain                      │  │
│  │  Query → Embed → Retrieve(k=4) → Prompt → LLM → Stream   │  │
│  └────────┬──────────────────────────────────┬──────────────┘  │
│           │                                  │                 │
│           ▼                                  ▼                 │
│  ┌─────────────────┐              ┌────────────────────┐       │
│  │  Pinecone       │              │  OpenAI / Claude   │       │
│  │  (vector index) │              │  (LLM API)         │       │
│  └─────────────────┘              └────────────────────┘       │
└────────────────────────────────────────────────────────────────┘
                  ▲
                  │ (offline, runs weekly)
        ┌─────────┴──────────┐
        │  Ingestion Worker  │
        │  Scrape → Chunk    │
        │  → Embed → Upsert  │
        └────────────────────┘
```

---

## 4. Data Ingestion Pipeline (Offline)

This runs once during setup and then on a weekly cron to pick up new articles.

### 4.1 Crawl strategy

Vyapar TaxOne help URLs follow the pattern:
- `https://taxone.vyapar.com/help/collections/<slug>` (12 collections)
- `https://taxone.vyapar.com/help/articles/<slug>` (individual articles)

Use `RecursiveUrlLoader` with a depth of 3 and a URL filter that keeps only `/help/...` paths.

```js
// ingest/crawl.js
import { RecursiveUrlLoader } from "@langchain/community/document_loaders/web/recursive_url";
import { compile } from "html-to-text";

const compiledConvert = compile({ wordwrap: 130, selectors: [
  { selector: "nav", format: "skip" },
  { selector: "footer", format: "skip" },
  { selector: "script", format: "skip" },
]});

const loader = new RecursiveUrlLoader("https://taxone.vyapar.com/help", {
  extractor: compiledConvert,
  maxDepth: 3,
  excludeDirs: ["https://taxone.vyapar.com/help/search"],
});

const docs = await loader.load();
// Each doc has { pageContent, metadata: { source, title } }
```

### 4.2 Chunking

Articles vary from 150 to 2000 words. Use `RecursiveCharacterTextSplitter` so chunks stop at natural boundaries.

```js
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 1000,
  chunkOverlap: 150,
  separators: ["\n\n", "\n", ". ", " ", ""],
});

const chunks = await splitter.splitDocuments(docs);
// Enrich each chunk with metadata: collection, article_title, url
```

### 4.3 Embed + upsert

```js
import { OpenAIEmbeddings } from "@langchain/openai";
import { PineconeStore } from "@langchain/pinecone";
import { Pinecone } from "@pinecone-database/pinecone";

const pinecone = new Pinecone();
const index = pinecone.index("taxone-help");

await PineconeStore.fromDocuments(chunks, new OpenAIEmbeddings({
  model: "text-embedding-3-small",
}), { pineconeIndex: index, namespace: "v1" });
```

**Index hygiene:**
- Use a `namespace` per version (`v1`, `v2`) so re-indexing doesn't break live queries
- Atomic swap: write to `v2`, switch the env var, delete `v1`
- Store `last_scraped_at` and content hash per URL to skip unchanged pages

---

## 5. RAG Backend

### 5.1 WebSocket chat (real-time stream)

Use one persistent WebSocket per session (e.g. `ws://host/ws/chat` or WSS in production). Client sends a JSON message with `question` and `history`; server runs retrieve → LLM stream and pushes **JSON frames** (`{ type: "token", text }`, then `{ type: "done", sources }` or `{ type: "error", message }`). Same RAG chain as before; only the transport changes from SSE to WebSocket (better for future bi-directional audio, reconnect hints, and cancel messages).

```js
// Sketch: server attaches WebSocketServer to the HTTP server (express + ws)
import { WebSocketServer } from "ws";
import { ChatOpenAI } from "@langchain/openai";
import { PromptTemplate } from "@langchain/core/prompts";

const SYSTEM = `You are TaxOne Assistant, ...`; // same as before

const prompt = PromptTemplate.fromTemplate(SYSTEM);
const llm = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0.2, streaming: true });
const retriever = vectorStore.asRetriever({ k: 4 });

export function attachChatWss(wss) {
  wss.on("connection", (socket) => {
    socket.on("message", async (raw) => {
      try {
        const { question, history = [] } = JSON.parse(raw.toString());
        const docs = await retriever.invoke(question);
        const context = docs.map((d, i) => `[${i + 1}] ${d.pageContent}`).join("\n\n");
        const historyStr = history.slice(-4).map((m) => `${m.role}: ${m.content}`).join("\n");

        const stream = await prompt.pipe(llm).stream({ question, context, history: historyStr });
        for await (const chunk of stream) {
          if (chunk.content) {
            socket.send(JSON.stringify({ type: "token", text: chunk.content }));
          }
        }
        socket.send(
          JSON.stringify({ type: "done", sources: docs.map((d) => d.metadata.source ?? d.metadata.url) }),
        );
      } catch (err) {
        socket.send(JSON.stringify({ type: "error", message: String(err.message || err) }));
      }
    });
  });
}
```

### 5.2 Why these choices for voice

- **k=4** keeps context small → faster LLM response → less time-to-first-token
- **Short answers** because TTS reading 200 words is painful — aim for ≤60 words
- **No markdown** because the TTS would read "asterisk asterisk bold"
- **Streaming** so TTS can start speaking after the first sentence rather than waiting for full completion

---

## 6. Voice Layer

### 6.1 MVP: Browser-only

```js
// hooks/useVoice.js
import { useState, useRef } from "react";

export function useVoice() {
  const [transcript, setTranscript] = useState("");
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef(null);

  const start = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = "en-IN";

    rec.onresult = (e) => {
      const text = Array.from(e.results).map(r => r[0].transcript).join("");
      setTranscript(text);
    };
    rec.onend = () => setListening(false);
    rec.start();
    recognitionRef.current = rec;
    setListening(true);
  };

  const stop = () => recognitionRef.current?.stop();

  const speak = (text) => {
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "en-IN";
    utter.rate = 1.05;
    window.speechSynthesis.speak(utter);
  };

  return { transcript, listening, start, stop, speak };
}
```

### 6.2 Production upgrade

**STT — Deepgram Nova-2** (`en-IN` model handles Indian accents better than browser native):
- Stream mic audio via WebSocket → get interim + final transcripts
- ~300ms latency vs ~1s for browser API

**TTS — ElevenLabs streaming** or **OpenAI `tts-1`**:
- Start audio playback while LLM is still generating
- Sentence-by-sentence: every time you see `. ` in the stream, ship that sentence to TTS
- Use `MediaSource` API in the browser to play chunks as they arrive

**VAD (Voice Activity Detection):**
- Use `@ricky0123/vad-web` to auto-stop recording when the user stops speaking
- Removes the need for a "stop" button

### 6.3 Sentence-level pipelining (latency hack)

The big win for voice UX: don't wait for the full LLM response. The moment the LLM emits a complete sentence, send it to TTS. By the time the user has heard sentence 1, sentence 2 audio is ready.

```js
let buffer = "";
for await (const chunk of llmStream) {
  buffer += chunk.content;
  const match = buffer.match(/^(.+?[.!?])\s+/);
  if (match) {
    sendToTTS(match[1]);            // start synthesizing
    buffer = buffer.slice(match[0].length);
  }
}
if (buffer.trim()) sendToTTS(buffer);
```

---

## 7. React Frontend

### 7.1 Component tree

```
<App>
  ├── <Header />
  ├── <ConversationView>
  │     ├── <MessageBubble role="user" />
  │     ├── <MessageBubble role="assistant" />
  │     └── ...
  ├── <SourceCitations />        // collapsible "where did this come from?"
  ├── <MicButton />              // big circular FAB, pulses while listening
  └── <SettingsDrawer />         // voice, language, push-to-talk vs VAD
```

### 7.2 State management

Use `zustand` (lighter than Redux for this scope):

```js
// store/chatStore.js
import { create } from "zustand";

export const useChat = create((set, get) => ({
  messages: [],
  isListening: false,
  isThinking: false,
  isSpeaking: false,

  addUserMessage: (text) => set(s => ({ messages: [...s.messages, { role: "user", content: text }] })),
  startAssistant: () => set(s => ({ messages: [...s.messages, { role: "assistant", content: "" }], isThinking: true })),
  appendToken: (token) => set(s => {
    const msgs = [...s.messages];
    msgs[msgs.length - 1].content += token;
    return { messages: msgs };
  }),
  finishAssistant: (sources) => set(s => {
    const msgs = [...s.messages];
    msgs[msgs.length - 1].sources = sources;
    return { messages: msgs, isThinking: false };
  }),
}));
```

### 7.3 WebSocket consumer (streaming tokens)

```js
function askAgent(question, history) {
  const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws/chat`);
  ws.onopen = () => ws.send(JSON.stringify({ question, history }));

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "token" && msg.text) {
      useChat.getState().appendToken(msg.text);
      sentenceBuffer.feed(msg.text);
    }
    if (msg.type === "done") useChat.getState().finishAssistant(msg.sources);
    if (msg.type === "error") console.error(msg.message);
  };

  ws.onerror = () => { /* surface in UI */ };
}
```

---

## 8. Prompt Engineering Notes

Voice answers fail differently from chat answers. Things to bake into the system prompt:

- **No URLs spoken aloud** — instead, say "I'll add the link to the screen"
- **Spell out abbreviations on first use** — "G S T" the first time, "GST" thereafter is fine (TTS handles this anyway)
- **Numbered steps become "first / then / finally"** — at most 3 steps spoken, the rest shown on screen
- **Confirm before destructive actions** — "Should I walk you through deleting that ledger?" not "Here's how to delete..."
- **Fallback path** — when retrieval confidence is low (score < 0.7), the agent should offer to connect to support rather than hallucinate

---

## 9. Project Structure

```
taxone-voice-agent/
├── frontend/                    # React + Vite
│   ├── src/
│   │   ├── components/
│   │   │   ├── MicButton.jsx
│   │   │   ├── ConversationView.jsx
│   │   │   ├── MessageBubble.jsx
│   │   │   └── SourceCitations.jsx
│   │   ├── hooks/
│   │   │   ├── useVoice.js
│   │   │   └── useStreamingChat.js
│   │   ├── store/chatStore.js
│   │   └── App.jsx
│   └── vite.config.js
│
├── backend/
│   ├── src/
│   │   ├── routes/chat.js
│   │   ├── chains/ragChain.js
│   │   ├── retrieval/vectorStore.js
│   │   └── server.js
│   └── package.json
│
├── ingest/                      # one-off + cron
│   ├── crawl.js
│   ├── chunk.js
│   ├── embed.js
│   └── run.js                   # orchestrator
│
└── README.md
```

---

## 10. Implementation Phases

### Phase 1 — Data foundation (Days 1–3)
- [ ] Scrape `taxone.vyapar.com/help` with `RecursiveUrlLoader`
- [ ] Inspect output, tune HTML-to-text extractor (kill nav/footer/related-articles)
- [ ] Chunk + embed + push to Pinecone
- [ ] Build a CLI `node ingest/query.js "how do I import bank statement"` to sanity-check retrieval

### Phase 2 — Text RAG backend (Days 4–6)
- [ ] Express (or Fastify) HTTP server + **WebSocket** endpoint (e.g. `/ws/chat`) for streamed tokens
- [ ] LangChain chain: retrieve → prompt → stream
- [ ] Conversation memory (last 4 turns)
- [ ] LangSmith tracing wired up

### Phase 3 — React UI, text only (Days 7–9)
- [ ] Chat interface, streaming render over WebSocket
- [ ] Source citation chips below each assistant message
- [ ] Markdown-free, voice-friendly responses verified

### Phase 4 — Voice layer (Days 10–13)
- [ ] Web Speech API for STT + TTS (MVP)
- [ ] Sentence-level TTS pipelining
- [ ] VAD-based auto-stop
- [ ] Mic permission UX, error states

### Phase 5 — Polish + production swap (Days 14–17)
- [ ] Swap to Deepgram STT for accuracy
- [ ] Swap to ElevenLabs / OpenAI TTS for quality
- [ ] Confidence-based fallback to human handoff
- [ ] Caching layer (Redis) for top-50 questions
- [ ] Rate limiting, auth (if internal users)

### Phase 6 — Deploy + monitor (Days 18–20)
- [ ] Frontend → Vercel
- [ ] Backend → Railway with autoscale
- [ ] Pinecone production index
- [ ] Cron: weekly re-ingestion (GitHub Actions)
- [ ] Dashboards: latency p50/p95, retrieval hit rate, fallback rate

---

## 11. Key Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Indian-English STT accuracy on accounting terms ("GSTR-2B", "Tally Prime") | Use Deepgram with a custom keyword boost list of TaxOne-specific vocab |
| LLM hallucinates feature that doesn't exist | Strict "answer only from context" prompt + low temperature + offline eval set of 50 Q&A pairs |
| TTS latency makes the agent feel sluggish | Sentence-level pipelining; pre-warm TTS connection; cache audio for top FAQs |
| Help center content changes silently | Weekly re-ingest with content-hash diff; alert on >10% chunk churn |
| Multi-language users (Hindi, Gujarati) | Detect language from STT; route to Claude / GPT-4o which handle code-mixed Hindi-English well |
| Cost runaway on high traffic | Aggressive caching of embeddings (query → answer for last 24h); use `gpt-4o-mini` not full `gpt-4o` |

---

## 12. Cost Estimate (rough, 1000 conversations/day)

| Item | Volume | Cost/mo |
|---|---|---|
| Embeddings (one-time + weekly re-ingest) | ~500K tokens | $0.01 |
| Query embeddings | 30K queries × 50 tokens | $0.03 |
| LLM (GPT-4o-mini) | 30K × ~2K tokens in + 100 out | ~$15 |
| Deepgram STT | 30K × 15s avg | ~$200 |
| ElevenLabs TTS | 30K × 60 words | ~$330 |
| Pinecone (serverless) | small index | ~$20 |
| Hosting (Railway + Vercel) | basic tier | ~$25 |
| **Total** | | **~$590/mo** |

MVP with browser STT/TTS only: **~$40/mo**.

---

## 13. Open Questions to Resolve Before Coding

1. Is this customer-facing or internal (CA team only)? Affects auth, rate-limit, cost ceiling
2. Should the agent be embedded in the existing TaxOne web app, or standalone?
3. Multi-language scope — English only at launch, or Hindi/Gujarati from day 1?
4. Human handoff — pipe failed queries into the existing support workflow (Intercom? Freshdesk?) or just collect them for review?
5. Should the agent be able to *do* things (raise a ticket, schedule a callback) or only *answer*? Doing things expands scope into tool-calling / function-calling territory.

---

## 14. Quick-Start Snippet (just to prove the loop works)

```bash
# 1. Backend
cd backend
npm init -y
npm install express @langchain/openai @langchain/community @langchain/pinecone \
            @pinecone-database/pinecone langchain cheerio html-to-text dotenv

# 2. Ingest
node ingest/run.js                  # scrapes + embeds

# 3. Run server
node src/server.js                  # listens on :3001

# 4. Sanity-check from terminal
curl -N -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{"question":"How do I integrate Vyapar with Suvit?"}'

# 5. Frontend
cd ../frontend && npm create vite@latest . -- --template react
npm install zustand
npm run dev
```

Once the curl call streams a sensible answer back, you have the entire RAG loop working — voice is just I/O on top.
