import axios from "axios";
import * as cheerio from "cheerio";
import pLimit from "p-limit";
import fs from "fs-extra";
import https from "node:https";
import { config } from "./config.js";

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Block-level tags that should be separated by whitespace when flattening to text.
 * Without this, cheerio's .text() glues adjacent block contents together.
 */
const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "header", "footer", "main", "aside",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "li", "ul", "ol", "dl", "dt", "dd",
  "tr", "td", "th", "table", "thead", "tbody", "tfoot",
  "br", "hr",
  "blockquote", "pre",
  "form", "fieldset",
]);

const PARAGRAPH_TAGS = new Set([
  "p", "div", "section", "article",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "li", "tr", "blockquote", "pre",
]);

/**
 * Walk the DOM and build text with proper spacing between block elements.
 * Heading and paragraph elements get a "\n\n" break so the chunker's
 * separator hierarchy works as intended.
 */
function extractTextWithSpacing($, root) {
  const parts = [];

  function walk(node) {
    if (!node) return;

    // Text node
    if (node.type === "text") {
      const text = node.data;
      if (text && text.trim()) {
        parts.push(text);
      }
      return;
    }

    if (node.type !== "tag") return;

    const tag = node.name?.toLowerCase();
    const isBlock = BLOCK_TAGS.has(tag);
    const isParagraph = PARAGRAPH_TAGS.has(tag);

    // Insert a separator BEFORE block elements (except the very first thing)
    if (isBlock && parts.length > 0) {
      parts.push(isParagraph ? "\n\n" : " ");
    }

    // <br> just adds a newline
    if (tag === "br") {
      parts.push("\n");
      return;
    }

    // Recurse into children
    const children = node.children || [];
    for (const child of children) {
      walk(child);
    }

    // Trailing separator after paragraph-like blocks
    if (isParagraph) {
      parts.push("\n\n");
    } else if (isBlock) {
      parts.push(" ");
    }
  }

  // root can be a cheerio collection — iterate its underlying nodes
  root.each((_, el) => walk(el));

  return parts.join("");
}

/**
 * Decode HTML entities, normalize whitespace, drop common noise lines.
 */
function cleanExtractedText(raw) {
  if (!raw) return "";

  let text = raw;

  // Decode common HTML entities that survive cheerio's .text() in odd cases
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'");

  // Normalize windows line endings
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Collapse 3+ newlines to a single paragraph break
  text = text.replace(/\n{3,}/g, "\n\n");

  // Collapse multiple spaces/tabs on a line (but keep newlines intact)
  text = text.replace(/[ \t]+/g, " ");

  // Trim each line
  text = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return true; // keep empty lines (they become paragraph breaks)
      // Drop tiny boilerplate lines we don't want
      if (/^\d+ Articles?$/i.test(line)) return false;
      if (/^Learn More$/i.test(line)) return false;
      return true;
    })
    .join("\n");

  // Collapse runs of blank lines again after filtering
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  return text;
}

export async function crawl() {
  const { baseUrl, maxDepth, delayMs, concurrency, userAgent } = config.crawl;
  const visited = new Set();
  const pages = [];
  const queue = [{ url: baseUrl, depth: 1 }];

  console.log(`[crawler] starting crawl from ${baseUrl}...`);

  while (queue.length > 0) {
    const batch = [];
    const limit = pLimit(concurrency);

    while (queue.length > 0 && batch.length < concurrency) {
      const next = queue.shift();
      if (!visited.has(next.url)) {
        visited.add(next.url);
        batch.push(next);
      }
    }

    if (batch.length === 0) continue;

    const tasks = batch.map((item) =>
      limit(async () => {
        try {
          console.log(`[crawler] fetching (depth=${item.depth}): ${item.url}`);
          const response = await axios.get(item.url, {
            headers: { "User-Agent": userAgent },
            timeout: 10000,
            httpsAgent,
          });

          if (delayMs > 0) {
            await delay(delayMs);
          }

          const html = response.data;
          const $ = cheerio.load(html);

          // Remove noise (added: buttons, svg, sidebar/nav widgets, images)
          $(
            "script, style, nav, footer, iframe, header, noscript, " +
            "button, svg, img, picture, source, video, audio, " +
            ".s_header, .s_footer, .s_breadcrumbs, .s_overlay, " +
            ".s_articles-inner-left, .s_header-dropdown, " +
            ".s_button, .s_action-buttons, .s_share-buttons, " +
            "[role='navigation'], [role='banner'], [role='contentinfo']"
          ).remove();

          // Extract title from the first reliable source
          const title =
            $("h1").first().text().trim() ||
            $("title").text().trim() ||
            "Untitled Article";

          // Find the main content container
          let bodyElement = $(
            ".s_articles-inner-content, .s_collection-list, .s_main-collection, " +
            "article, .article, .content, main, [role='main']"
          );
          if (bodyElement.length === 0) {
            bodyElement = $("body");
          }

          // Extract text WITH proper block-level spacing
          const rawText = extractTextWithSpacing($, bodyElement);
          const text = cleanExtractedText(rawText);

          if (text.length > 50) {
            pages.push({
              url: item.url,
              title,
              text,
              charCount: text.length,
              crawledAt: new Date().toISOString(),
            });
          } else {
            console.log(`[crawler] skip (too short after cleaning): ${item.url}`);
          }

          // Discover links if we haven't reached max depth
          if (item.depth < maxDepth) {
            $("a[href]").each((_, elem) => {
              let href = $(elem).attr("href");
              if (!href) return;

              try {
                const absoluteUrl = new URL(href, baseUrl)
                  .toString()
                  .split("#")[0];
                const parsedUrl = new URL(absoluteUrl);

                if (
                  parsedUrl.origin === new URL(baseUrl).origin &&
                  parsedUrl.pathname.startsWith("/help") &&
                  !parsedUrl.pathname.startsWith("/help/search") &&
                  !visited.has(absoluteUrl) &&
                  !queue.some((q) => q.url === absoluteUrl)
                ) {
                  queue.push({ url: absoluteUrl, depth: item.depth + 1 });
                }
              } catch (e) {
                // Ignore invalid URLs
              }
            });
          }
        } catch (error) {
          console.error(
            `[crawler] failed to crawl ${item.url}: ${error.message}`,
          );
        }
      }),
    );

    await Promise.all(tasks);
  }

  console.log(
    `[crawler] crawling finished. Total pages crawled: ${pages.length}`,
  );

  // Quick sanity log: average text length
  if (pages.length > 0) {
    const avgLen = Math.round(
      pages.reduce((a, p) => a + p.charCount, 0) / pages.length,
    );
    console.log(`[crawler] average page length: ${avgLen} chars`);
  }

  return pages;
}

export async function saveScrape(pages, outputPath) {
  try {
    await fs.ensureFile(outputPath);
    await fs.outputJson(outputPath, pages, { spaces: 2 });
    console.log(`[crawler] saved ${pages.length} pages to ${outputPath}`);
  } catch (error) {
    console.error(`[crawler] failed to save scraped data: ${error.message}`);
  }
}