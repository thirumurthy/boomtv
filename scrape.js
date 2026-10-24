import fs from "node:fs/promises";
import * as cheerio from "cheerio";

const BASE = "https://bhoomtv.org";
//const LIST_PATH = "/channel/tamil-local-tv/page";
const LIST_PATHS = ["/channel/tamil-local-tv/page", "/channel/tamil/page"];
const MAX_PAGES = 50; // safety cap
const DELAY_MS = 800; // polite delay between requests
const OUTPUT_FILE = "bhoomtv_results.json";
const DEBUG_FILE = "bhoomtv_failed.json";

// ---------- Headers you asked for ----------
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Sec-Ch-Ua": '"Google Chrome";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  Referer: "https://bhoomtv.org/",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  Connection: "keep-alive",
};

const API_HEADERS = {
  ...HEADERS,
  Accept: "application/json, text/plain, */*",
  Referer: "https://bhoomtv.org/",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- HTTP helper with browser-ish headers ----------
async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS, redirect: "follow" });
  if (!res.ok) {
    console.error(`DEBUG: Failed URL: ${url}`);
    console.error(`DEBUG: Response Status: ${res.status}`);
    const body = await res.text();
    console.error(`DEBUG: Response Body (first 500 chars): ${body.substring(0, 500)}`);
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.text();
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: API_HEADERS, redirect: "follow" });
  if (!res.ok) {
    console.error(`DEBUG: Failed JSON URL: ${url}`);
    console.error(`DEBUG: Response Status: ${res.status}`);
    const body = await res.text();
    console.error(`DEBUG: Response Body (first 500 chars): ${body.substring(0, 500)}`);
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.json();
}

// ---------- Parse a listing page ----------
function parseListPage(html) {
  const $ = cheerio.load(html);
  const items = [];

  $("article.item.movies").each((_, el) => {
    const idAttr = $(el).attr("id") || ""; // "post-27534"
    const idMatch = idAttr.match(/post-(\d+)/);
    const id = idMatch ? idMatch[1] : null;

    const img = $(el).find(".poster img").first();
    const img_url = img.attr("src") || null;

    const a = $(el).find("h3 a").first();
    const name = a.text().trim();
    const url = a.attr("href") || null;

    if (id) items.push({ id, img_url, name, url });
  });

  return items;
}

// ---------- Get max page number from pagination ----------
function getLastPage(html) {
  const $ = cheerio.load(html);
  let max = 1;
  $(".pagination a, .page-numbers a, a.page-numbers").each((_, el) => {
    const n = parseInt($(el).text().trim(), 10);
    if (!Number.isNaN(n) && n > max) max = n;
  });
  // also inspect href for /page/N/
  $("a[href*='/page/']").each((_, el) => {
    const href = $(el).attr("href") || "";
    const m = href.match(/\/page\/(\d+)\//);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  });
  return max;
}

// ---------- Dooplayer API ----------
async function getPlayer(id) {
  const url = `${BASE}/wp-json/dooplayer/v2/${id}/movie/1`;
  try {
    const json = await fetchJson(url);
    const embed = json.embed_url || "";
    const type = json.type || "";

    // ---- Extract source ----
    let source = null;
    let kind = null; // "hls" | "dash" | "mp4" | "iframe"

    // Case A: jwplayer with ?source=...&id=...&type=mp4
    if (embed.includes("/jwplayer/")) {
      const m = embed.match(/[?&]source=([^&]+)/);
      if (m) {
        source = decodeURIComponent(m[1]);
        if (source.endsWith(".m3u8")) kind = "hls";
        else if (source.endsWith(".mpd")) kind = "dash";
        else if (source.includes(".mp4")) kind = "mp4";
        else kind = "other";
      }
    }

    // Case B: b4uplay player.php?mpd=...  → SKIP as requested
    if (embed.includes("b4uplay.com/player.php")) {
      return {
        ok: true,
        skipped: true,
        reason: "b4uplay iframe variant skipped (per spec)",
        embed_url: embed,
        type,
        source: null,
        kind: null,
      };
    }

    // Case C: direct mpd / m3u8 in embed_url
    if (!source) {
      const m = embed.match(/https?:\/\/[^\s"'&]+\.(m3u8|mpd|mp4)/i);
      if (m) {
        source = m[0];
        kind =
          m[1].toLowerCase() === "m3u8"
            ? "hls"
            : m[1].toLowerCase() === "mpd"
              ? "dash"
              : "mp4";
      }
    }

    return {
      ok: true,
      skipped: false,
      type,
      embed_url: embed,
      source, // <-- this is the m3u8 / mpd url you want
      kind, // "hls" | "dash" | "mp4" | null
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------- Main ----------
async function main() {
  const results = [];
  const failed = [];

  for (const listPath of LIST_PATHS) {
    console.log(`\n=== Processing: ${listPath} ===`);

    // Page 1 (also to discover last page)
    console.log(`▶ Fetching page 1 ...`);
    let firstHtml;
    try {
      firstHtml = await fetchHtml(`${BASE}${listPath}/1/`);
    } catch (e) {
      console.error(`✖ Could not load page 1 for ${listPath}: ${e.message}`);
      continue;
    }

    const lastPage = Math.min(getLastPage(firstHtml), MAX_PAGES);
    console.log(`✔ Detected last page: ${lastPage}`);

    let pageHtml = firstHtml;
    for (let p = 1; p <= lastPage; p++) {
      if (p > 1) {
        await sleep(DELAY_MS);
        const url = `${BASE}${listPath}/${p}/`;
        console.log(`▶ Fetching page ${p} ...`);
        try {
          pageHtml = await fetchHtml(url);
        } catch (e) {
          console.error(`  ✖ Page ${p} failed: ${e.message}`);
          continue;
        }
      }

      const items = parseListPage(pageHtml);
      console.log(`  • page ${p}: ${items.length} articles`);

      for (const it of items) {
        // Skip if we already have this ID in results to avoid duplicates across categories
        if (results.some((r) => r.id === it.id)) {
          console.log(`    → id=${it.id} "${it.name}" (already scraped, skipping)`);
          continue;
        }

        process.stdout.write(`    → id=${it.id} "${it.name}" ... `);
        const player = await getPlayer(it.id);
        await sleep(300); // polite gap for the API

        const record = {
          id: it.id,
          name: it.name,
          img_url: it.img_url,
          page_url: it.url,
          category: listPath.includes("local-tv") ? "Tamil Local TV" : "Tamil TV",
          player_type: player.type ?? null,
          embed_url: player.embed_url ?? null,
          source: player.source ?? null,
          kind: player.kind ?? null,
          skipped_b4uplay: player.skipped ?? false,
        };

        if (player.ok) {
          console.log(
            player.skipped
              ? "skipped (b4uplay)"
              : `ok [${player.kind}] ${player.source ? player.source.slice(0, 60) + "…" : "no-source"}`,
          );
          results.push(record);
        } else {
          console.log(`FAIL (${player.error})`);
          failed.push({ ...record, error: player.error });
        }
      }
    }
  }

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(results, null, 2), "utf8");
  if (failed.length) {
    await fs.writeFile(DEBUG_FILE, JSON.stringify(failed, null, 2), "utf8");
  }

  console.log(`\n✅ Done`);
  console.log(`   saved   : ${results.length} → ${OUTPUT_FILE}`);
  console.log(`   failed  : ${failed.length} → ${DEBUG_FILE}`);
  console.log(`   hls     : ${results.filter((r) => r.kind === "hls").length}`);
  console.log(
    `   dash    : ${results.filter((r) => r.kind === "dash").length}`,
  );
  console.log(
    `   skipped : ${results.filter((r) => r.skipped_b4uplay).length} (b4uplay)`,
  );
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
