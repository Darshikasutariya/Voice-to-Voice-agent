import axios from "axios";
import * as cheerio from "cheerio";
import pLimit from "p-limit";
import fs from "fs-extra";
import https from "node:https";
import { config } from "./config.js";

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

// Helper to delay execution
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function crawl() {
  const { baseUrl, maxDepth, delayMs, concurrency, userAgent } = config.crawl;
  const visited = new Set();
  const pages = [];
  const queue = [{ url: baseUrl, depth: 1 }];

  console.log(`[crawler] starting crawl from ${baseUrl}...`);

  while (queue.length > 0) {
    // Process in batches matching concurrency limit
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

          // Remove script, style, nav, footer, iframe, header, and specific site layout elements to avoid noise pollution
          $(
            "script, style, nav, footer, iframe, header, noscript, " +
            ".s_header, .s_footer, .s_breadcrumbs, .s_overlay, " +
            ".s_articles-inner-left, .s_header-dropdown"
          ).remove();

          // Extract title
          const title =
            $("title").text().trim() ||
            $("h1").first().text().trim() ||
            "Untitled Article";

          // Extract body text: focus on article content containers if possible, or fallback to body text
          let bodyElement = $(
            ".s_articles-inner-content, .s_collection-list, .s_main-collection, " +
            "article, .article, .content, main"
          );
          if (bodyElement.length === 0) {
            bodyElement = $("body");
          }

          // Clean text content
          const text = bodyElement.text().replace(/\s+/g, " ").trim();

          if (text.length > 50) {
            pages.push({
              url: item.url,
              title,
              text,
              charCount: text.length,
              crawledAt: new Date().toISOString(),
            });
          }

          // Discover links if we haven't reached max depth
          if (item.depth < maxDepth) {
            $("a[href]").each((_, elem) => {
              let href = $(elem).attr("href");
              if (!href) return;

              // Convert relative to absolute url
              try {
                const absoluteUrl = new URL(href, baseUrl)
                  .toString()
                  .split("#")[0]; // remove hash
                const parsedUrl = new URL(absoluteUrl);

                // Only crawl links within taxone.vyapar.com/help
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
