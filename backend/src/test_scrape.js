import axios from "axios";
import * as cheerio from "cheerio";
import https from "node:https";

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

async function main() {
  const url = "https://taxone.vyapar.com/help/articles/import-the-bank-statement";
  console.log("Fetching url:", url);

  const response = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    timeout: 10000,
    httpsAgent,
  });

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

  console.log("\n--- SCRAPE RESULTS ---");
  console.log("Title :", title);
  console.log("Length:", text.length, "chars");
  console.log("Text (First 600 chars):");
  console.log(text.slice(0, 600));
  console.log("----------------------");
}

main().catch(err => {
  console.error("Failed:", err);
});
