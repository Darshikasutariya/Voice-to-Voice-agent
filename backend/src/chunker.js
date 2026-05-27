import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { createHash } from "node:crypto";
import { config } from "./config.js";

/**
 * Stable, deterministic ID per chunk so re-ingest overwrites the same vector
 * instead of duplicating it. Uses sha1(url) + chunk index.
 */
function chunkId(url, index) {
  const urlHash = createHash("sha1").update(url).digest("hex").slice(0, 12);
  return `${urlHash}_${index}`;
}

/**
 * Voice-friendly text cleaner.
 * Strips visual references, emojis, and normalizes branding.
 */
/**
 * Voice-friendly text cleaner.
 * Strips visual references, emojis, and normalizes branding.
 */
function cleanForVoice(text) {
  if (!text || typeof text !== "string") return "";

  let cleaned = text;

  // 0. Strip broken/invalid Unicode surrogate pairs FIRST.
  // These can survive scraping and emoji-stripping and break JSON serialization
  // (Chroma rejects requests with "lone leading surrogate" errors).
  cleaned = cleaned
    // Unpaired high surrogate (high without matching low after it)
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
    // Unpaired low surrogate (low without matching high before it)
    .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "$1")
    // Any remaining lone surrogate (catch-all)
    .replace(/[\uD800-\uDFFF]/g, "")
    // Null bytes and other control chars that break JSON
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  // 1. Normalize branding
  cleaned = cleaned.replace(/\bSuvit\b/g, "Vyapar TaxOne");

  // 2. Remove visual reference phrases
  const visualPhrases = [
    /\bclick here\b/gi,
    /\bsee (?:the )?image (?:above|below)\b/gi,
    /\brefer (?:to )?(?:the )?image (?:above|below)\b/gi,
    /\bas (?:shown|seen) (?:in )?(?:the )?image (?:above|below)\b/gi,
    /\bas per (?:the )?(?:above|below) image\b/gi,
    /\brefer (?:the )?below image\b/gi,
    /\bshown in (?:the )?(?:above|below) image\b/gi,
    /\bsee below\b/gi,
    /\bsee above\b/gi,
    /\b(?:please )?refer (?:to )?below\b/gi,
    /\bclick on (?:the )?(?:link|button) (?:below|above)\b/gi,
    /\bLearn More\b/g,
  ];
  for (const re of visualPhrases) {
    cleaned = cleaned.replace(re, " ");
  }

  // 3. Strip emojis and decorative symbols
  cleaned = cleaned
    .replace(/[→←↑↓➜⇒⇨]/g, " ")
    .replace(/[✅⚠️📌🚀✍️ℹ️🔧🪜📤📥📋✨💡🎯📊📚📝📘📓🟢🔴🟡🟠❌✔️☑️❓❗⭐]/g, "")
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, "")
    .replace(/[\u{2600}-\u{27BF}]/gu, "")
    .replace(/[\u{1F000}-\u{1F02F}]/gu, "");

  // 4. Remove markdown leftovers
  cleaned = cleaned
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // 5. Collapse repeated whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  return cleaned;
}

/**
 * Strip leading punctuation/whitespace artifacts left by the splitter.
 * Example: ". This collection offers..." -> "This collection offers..."
 */
function trimLeadingArtifacts(text) {
  return text.replace(/^[\s.,;:!?]+/, "").trim();
}

/**
 * Derive module from URL pattern.
 *
 * IMPORTANT: Order matters. Check more specific patterns first.
 * Uses substring matching (lower.includes) since article slugs embed
 * the module name anywhere in the slug, not just as a path segment.
 */
function deriveModule(url) {
  if (!url) return "general";
  const lower = url.toLowerCase();

  // Most specific / multi-word patterns first

  // GST family — check before generic terms
  if (
    lower.includes("gstr") ||
    lower.includes("/ims") ||
    lower.includes("gst-reco") ||
    lower.includes("gst-data") ||
    lower.includes("gst-dashboard") ||
    lower.includes("gst-notice") ||
    lower.includes("gst-automation") ||
    lower.includes("gstin") ||
    lower.includes("/gst") ||
    lower.includes("reset-gstin")
  ) return "gst";

  // Vyapar integration (must come before generic "vyapar" matches)
  if (
    lower.includes("integrate-vyapar") ||
    lower.includes("vyapar-mapping") ||
    lower.includes("review-sync-vyapar") ||
    lower.includes("/vyapar")
  ) return "vyapar_integration";

  // Banking (very specific — many bank-related slugs)
  if (
    lower.includes("bank-statement") ||
    lower.includes("/banking") ||
    lower.includes("bank-allocation") ||
    lower.includes("import-the-bank") ||
    lower.includes("delete-entries-from-bank") ||
    lower.includes("auto-fill-ledger-in-banking") ||
    lower.includes("cheque-number") ||
    lower.includes("supplier-reference-number-banking") ||
    lower.includes("voucher-number-cannot-be-left-blank-banking") ||
    lower.includes("enable-cost-centre-banking") ||
    lower.includes("change-date-edit-narration-banking") ||
    lower.includes("managing-duplicate-entries-suvit-banking") ||
    lower.includes("cash-entries") ||
    lower.includes("unsupported-bank")
  ) return "banking";

  // Sales
  if (
    lower.includes("sales") ||
    lower.includes("sale-") ||
    lower.includes("create-invoice-for-sales") ||
    lower.includes("ajio") ||
    lower.includes("meesho") ||
    lower.includes("zerodha-sales")
  ) return "sales";

  // Purchase
  if (
    lower.includes("purchase") ||
    lower.includes("groww-purchase") ||
    lower.includes("zerodha-purchase") ||
    lower.includes("nj-india-invest-purchase") ||
    lower.includes("choice-broker-purchase") ||
    lower.includes("gstr-2b") ||
    lower.includes("gstr-2-b")
  ) return "purchase";

  // Journal
  if (lower.includes("journal")) return "journal";

  // OCR
  if (lower.includes("/ocr") || lower.includes("ocr-")) return "ocr";

  // Bulk master
  if (
    lower.includes("bulk-master") ||
    lower.includes("create-bulk") ||
    lower.includes("bulk-stock") ||
    lower.includes("bulk-ledger") ||
    lower.includes("bulk-party-creation") ||
    lower.includes("bulk-upload")
  ) return "bulk_master";

  // User / client management
  if (
    lower.includes("user-account") ||
    lower.includes("user-report") ||
    lower.includes("client-account") ||
    lower.includes("user-activity-log") ||
    lower.includes("personalized-roles") ||
    lower.includes("how-to-edit-the-user-role") ||
    lower.includes("how-to-delete-a-client") ||
    lower.includes("how-to-activate-secondary-user") ||
    lower.includes("how-to-add-company-to-user") ||
    lower.includes("how-to-remove-company-from-user") ||
    lower.includes("/client") ||
    lower.includes("/user")
  ) return "user_management";

  // Getting started / setup
  if (
    lower.includes("/getting-started") ||
    lower.includes("registration") ||
    lower.includes("account-verification") ||
    lower.includes("install-suvit-desktop") ||
    lower.includes("install-vyapar-taxone") ||
    lower.includes("subscribe-company") ||
    lower.includes("subscribe-split") ||
    lower.includes("create-your-suvit-account") ||
    lower.includes("purchase-a-suvit-subscription")
  ) return "getting_started";

  // Data collection / Suvit Drive / Vyapar TaxOne Chat
  if (
    lower.includes("data-collection") ||
    lower.includes("automatic-data-collection") ||
    lower.includes("suvit-drive")
  ) return "data_collection";

  // FAQ
  if (lower.includes("/faqs")) return "faq";

  return "general";
}

/**
 * Priority signal for retrieval boosting.
 */
function derivePriority(url) {
  if (!url) return "medium";
  const lower = url.toLowerCase();

  // Critical: core daily-use flows
  if (
    lower.includes("import-the-bank-statement") ||
    lower.includes("uploading-sales-sales-return") ||
    lower.includes("uploading-purchase-purchase-return") ||
    lower.includes("how-do-we-process-or-push") ||
    lower.includes("ledger-selection") ||
    lower.includes("save-entries-and-send") ||
    lower.includes("complete-status-after-processing") ||
    lower.includes("failed-status-after-processing")
  ) return "critical";

  // High: core feature overviews + common errors + setup
  if (
    lower.includes("/collections/") ||
    lower === "https://taxone.vyapar.com/help" ||
    lower.endsWith("/help") ||
    lower.includes("auto-mapping") ||
    lower.includes("registration") ||
    lower.includes("subscribe-company") ||
    lower.includes("install-suvit-desktop") ||
    lower.includes("install-vyapar-taxone") ||
    lower.includes("not-able-to-connect") ||
    lower.includes("transaction-s-failed") ||
    lower.includes("date-out-of-range") ||
    lower.includes("voucher-number-is-missing") ||
    lower.includes("voucher-number-cannot-be-left-blank") ||
    lower.includes("please-sync-ledger") ||
    lower.includes("how-to-configure-tally-port") ||
    lower.includes("how-to-create-a-user-account") ||
    lower.includes("how-to-create-a-client-account") ||
    lower.includes("gst-reco")
  ) return "high";

  // Low: niche broker integrations, rare tools
  if (
    lower.includes("zerodha") ||
    lower.includes("groww") ||
    lower.includes("choice-broker") ||
    lower.includes("nj-india") ||
    lower.includes("meesho") ||
    lower.includes("ajio") ||
    lower.includes("anydesk") ||
    lower.includes("default_browser") ||
    lower.includes("request-feature")
  ) return "low";

  return "medium";
}

/**
 * Type of chunk for retrieval routing.
 */
function deriveType(url) {
  if (!url) return "article";
  const lower = url.toLowerCase();
  if (lower.includes("/collections/")) return "overview";
  // Root help page is also an overview/landing page
  if (lower === "https://taxone.vyapar.com/help" || lower.endsWith("/help")) return "overview";
  if (lower.includes("/faqs")) return "faq";
  return "article";
}

/**
 * Extract a readable intent from URL slug.
 */
function extractIntent(url) {
  if (!url) return "";
  const slug = url.split("/").filter(Boolean).pop() || "";
  return slug
    .replace(/-/g, " ")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export async function chunkDocuments(pages) {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: config.chunk.chunkSize,
    chunkOverlap: config.chunk.chunkOverlap,
    separators: ["\n\n", "\n", "। ", ". ", "? ", "! ", "; ", ", ", " ", ""],
  });

  const chunks = [];
  let totalCharsBefore = 0;
  let totalCharsAfter = 0;

  for (const page of pages) {
    const originalText = page.text || "";
    const cleanedText = cleanForVoice(originalText);

    totalCharsBefore += originalText.length;
    totalCharsAfter += cleanedText.length;

    if (cleanedText.length < 50) continue;

    const module = deriveModule(page.url);
    const priority = derivePriority(page.url);
    const type = deriveType(page.url);
    const intent = extractIntent(page.url);

    const pieces = await splitter.splitText(cleanedText);

    pieces.forEach((piece, i) => {
      // Re-strip surrogates after splitter (defensive — splitters can cut mid-codepoint)
      const safePiece = piece
        .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
        .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "$1")
        .replace(/[\uD800-\uDFFF]/g, "");
    
      const finalText = trimLeadingArtifacts(safePiece);
      if (finalText.length < 20) return;
    
      chunks.push({
        id: chunkId(page.url, i),
        text: finalText,
        metadata: {
          url: page.url,
          title: page.title,
          chunkIndex: i,
          totalChunks: pieces.length,
          crawledAt: page.crawledAt,
          module,
          priority,
          type,
          intent,
          cleanedLength: finalText.length,
        },
      });
    });
  }

  const reduction = totalCharsBefore > 0
    ? Math.round((1 - totalCharsAfter / totalCharsBefore) * 100)
    : 0;

  console.log(`[chunk] ${pages.length} pages → ${chunks.length} chunks`);
  console.log(`[chunk] cleaning removed ${reduction}% of noise (${totalCharsBefore} → ${totalCharsAfter} chars)`);

  const moduleStats = {};
  for (const c of chunks) {
    moduleStats[c.metadata.module] = (moduleStats[c.metadata.module] || 0) + 1;
  }
  console.log(`[chunk] distribution by module:`, moduleStats);

  // Warn if too many chunks landed as "general" — usually means tagging needs tuning
  const generalRatio = (moduleStats.general || 0) / chunks.length;
  if (generalRatio > 0.3) {
    console.warn(`[chunk] WARNING: ${Math.round(generalRatio * 100)}% of chunks are tagged "general".`);
    console.warn(`[chunk] Consider tuning deriveModule() in chunker.js. Sample "general" URLs:`);
    const generalSample = chunks
      .filter(c => c.metadata.module === "general")
      .slice(0, 5)
      .map(c => `  - ${c.metadata.url}`);
    console.warn(generalSample.join("\n"));
  }

  return chunks;
}