import fs from "node:fs/promises";

// ---------- Config ----------
const INPUT_FILE = "bhoomtv_results.json";
const OUTPUT_FILE = "bhoomtv_results.m3u";
const PLAYLIST_NAME = "BhoomTV – Tamil Local TV";
const INCLUDE_MP4 = true; // mp4 sources are playable in VLC/Kodi
const INCLUDE_DASH = false; // .mpd won't play in most M3U consumers

// group-title to write into the M3U; you can derive it from page_url if you want
const GROUP_TITLE = "Tamil Local TV";

// ---------- Helpers ----------
// M3U attribute values must escape double-quotes and commas-per-attribute rules:
// we wrap values in double quotes and escape embedded quotes.
const esc = (s = "") =>
  String(s).replace(/"/g, '\\"').replace(/\r?\n/g, " ").trim();

const isHls = (u) => /\.m3u8(\?|#|$)/i.test(u);
const isDash = (u) => /\.mpd(\?|#|$)/i.test(u);
const isMp4 = (u) => /\.mp4(\?|#|$)/i.test(u);

// ---------- Main ----------
async function main() {
  const raw = await fs.readFile(INPUT_FILE, "utf8");
  const items = JSON.parse(raw);

  if (!Array.isArray(items)) {
    throw new Error(`${INPUT_FILE} must contain a JSON array`);
  }

  const lines = [`#EXTM3U x-tvg-url=""`];
  const stats = {
    added: 0,
    skippedNoSource: 0,
    skippedB4u: 0,
    skippedDash: 0,
    skippedOther: 0,
    dedup: 0,
  };

  const seen = new Set();

  // Sort alphabetically by name for a tidy playlist
  const sorted = [...items].sort((a, b) =>
    (a.name || "").localeCompare(b.name || "", undefined, {
      sensitivity: "base",
    }),
  );

  for (const it of sorted) {
    const name = (it.name || "").trim();
    const source = (it.source || "").trim();
    const logo = (it.img_url || "").trim();
    const kind = (it.kind || "").toLowerCase();
    const skipped = !!it.skipped_b4uplay;

    if (!name || !source) {
      stats.skippedNoSource++;
      continue;
    }
    if (skipped) {
      stats.skippedB4u++;
      continue;
    }

    // Decide playability
    let playable = false;
    if (kind === "hls" || isHls(source)) playable = true;
    else if (kind === "mp4" || isMp4(source)) playable = INCLUDE_MP4;
    else if (kind === "dash" || isDash(source)) playable = INCLUDE_DASH;
    else playable = false;

    if (!playable) {
      if (kind === "dash" || isDash(source)) stats.skippedDash++;
      else stats.skippedOther++;
      continue;
    }

    // De-dup by source URL (some channels repeat across pages)
    if (seen.has(source)) {
      stats.dedup++;
      continue;
    }
    seen.add(source);

    // #EXTINF:<duration> key="value" ...,Display Name
    const attrs = [
      `tvg-id="${esc(name)}"`,
      `tvg-name="${esc(name)}"`,
      `tvg-logo="${esc(logo)}"`,
      `group-title="${esc(GROUP_TITLE)}"`,
    ].join(" ");

    lines.push(`#EXTINF:-1 ${attrs},${name}`);
    lines.push(source);
    stats.added++;
  }

  // M3U files can end with or without a trailing newline; add one for POSIX-friendliness
  await fs.writeFile(OUTPUT_FILE, lines.join("\n") + "\n", "utf8");

  console.log(`✅ Wrote ${OUTPUT_FILE}`);
  console.log(`   total input    : ${items.length}`);
  console.log(`   added to m3u   : ${stats.added}`);
  console.log(`   skipped (no src): ${stats.skippedNoSource}`);
  console.log(`   skipped (b4u)  : ${stats.skippedB4u}`);
  console.log(`   skipped (dash) : ${stats.skippedDash}`);
  console.log(`   skipped (other): ${stats.skippedOther}`);
  console.log(`   deduped        : ${stats.dedup}`);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
