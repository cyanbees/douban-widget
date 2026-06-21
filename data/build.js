#!/usr/bin/env node
/**
 * 豆瓣豆列构建脚本
 * 抓取20个内置恐怖片豆列 → 解析 → 去重 → 输出 JSON
 *
 * 用法: node data/build.js
 * 输出: data/doulist_index.json + data/doulist_{id}.json
 */

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

// ─── 20个内置豆列 ───
const DOULISTS = {
  "1652843":   { title: "Time Out影史百大恐怖片" },
  "36980":     { title: "看电影40部最经典恐怖片" },
  "36280":     { title: "恐惧感的丧失(309部)" },
  "37140418":  { title: "难忘的经典惊悚/恐怖片(547部)" },
  "526461":    { title: "7分以上的恐怖/惊悚电影(174部)" },
  "5916567":   { title: "高分精品恐怖片(280部)" },
  "3356598":   { title: "2000后优秀恐怖电影(204部)" },
  "724565":    { title: "被忽略掉的不沉闷恐怖劲片！(77部)" },
  "152540212": { title: "Indiewire: 50位导演心中的最佳恐怖片(48部)" },
  "109801736": { title: "稀有难找 underground horror films(466部)" },
  "159889980": { title: "血浆片已阅整理 Gory Horror Film(47部)" },
  "124549602": { title: "女性导演恐怖片(383部)" },
  "162107956": { title: "Body Horror｜身体恐怖电影(155部)" },
  "161922461": { title: "瘆临其境！恐怖伪纪录片(193部)" },
  "163019144": { title: "码住！盘点欧美高分恐怖电影(585部)" },
  "163048555": { title: "怪力乱神！欧美超自然恐怖电影(206部)" },
  "159035683": { title: "审美与创意兼顾的恐怖片(96部)" },
  "148836450": { title: "我看过的恐怖片们(254部)" },
  "45782339":  { title: "我的恐怖片之旅(1534部)" },
  "163145526": { title: "码住！2026年恐怖电影大盘点(304部)" },
};

const DATA_DIR = __dirname;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const REQUEST_DELAY_MS = 1500; // 1.5s 间隔防封

// ─── 工具函数 ───

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Referer": "https://movie.douban.com/",
    },
    signal: AbortSignal.timeout(15000),
  });
  const html = await res.text();
  return cheerio.load(html);
}

/**
 * 解析一页豆列（25条），返回条目数组
 */
function parsePage($) {
  const items = [];
  const seen = new Set();

  // 策略1：标准 doulist-item（豆列页面）
  $(".doulist-item").each((i, el) => {
    const $item = $(el);
    const $link = $item.find(".title a");
    const href = $link.attr("href");
    if (!href) return;

    const match = href.match(/movie\.douban\.com\/subject\/(\d+)/);
    if (!match) return;

    const id = Number(match[1]);
    if (seen.has(id)) return;
    seen.add(id);

    const title = $link.text().trim();
    const posterPath = $item.find(".post img").attr("src") || "";
    const ratingText = $item.find(".rating_nums").text().trim();

    // 尝试从评语或描述中提取年份
    let year = 0;
    const infoText = $item.text();
    const yearMatch = infoText.match(/年份:\s*(\d{4})/);
    if (yearMatch) year = parseInt(yearMatch[1], 10);

    items.push({
      doubanId: id,
      title: title || "",
      posterPath: posterPath,
      rating: ratingText ? parseFloat(ratingText) : 0,
      year: year,
    });
  });

  // 策略2：兜底 — 兼容非标准列表页
  if (items.length === 0) {
    $("a[href*='movie.douban.com/subject/']").each((i, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      const match = href.match(/movie\.douban\.com\/subject\/(\d+)/);
      if (!match) return;
      const id = Number(match[1]);
      if (seen.has(id)) return;
      seen.add(id);
      const title = $(el).text().trim();
      items.push({
        doubanId: id,
        title: title || "",
        posterPath: "",
        rating: 0,
        year: 0,
      });
    });
  }

  return items;
}

/**
 * 抓取单个豆列的所有页面
 */
async function fetchDoulist(doulistId, doulistTitle) {
  console.log(`[${doulistTitle}] 开始抓取...`);

  const allItems = [];
  const seenGlobal = new Set();
  let page = 0;
  let emptyPages = 0;

  while (true) {
    const start = page * 25;
    const url = `https://www.douban.com/doulist/${doulistId}/?start=${start}`;

    console.log(`  → 第 ${page + 1} 页 (start=${start})`);

    try {
      const $ = await fetchPage(url);
      const items = parsePage($);

      if (items.length === 0) {
        emptyPages++;
        if (emptyPages >= 2) break; // 连续2页空则停止
      } else {
        emptyPages = 0;
      }

      // 去重（跨页）
      for (const item of items) {
        if (!seenGlobal.has(item.doubanId)) {
          seenGlobal.add(item.doubanId);
          allItems.push(item);
        }
      }

      // 检查是否有下一页
      const hasNext = $('link[rel="next"]').length > 0 || $(".next a").length > 0;
      if (!hasNext && items.length < 25) break;

    } catch (err) {
      console.error(`  ✗ 第 ${page + 1} 页失败:`, err.message || err);
      emptyPages++;
      if (emptyPages >= 3) break;
    }

    page++;
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`  ✓ 完成，共 ${allItems.length} 条`);
  return allItems;
}

// ─── 即将上映抓取 ───

/**
 * 将豆瓣中文日期转为 ISO 日期字符串
 * "06月25日" → "2026-06-25"
 * "2027年02月06日" → "2027-02-06"
 */
function parseComingSoonDate(dateText, currentYear) {
  var fullMatch = dateText.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (fullMatch) {
    return fullMatch[1] + "-" + fullMatch[2].padStart(2, "0") + "-" + fullMatch[3].padStart(2, "0");
  }
  var shortMatch = dateText.match(/(\d{1,2})月(\d{1,2})日/);
  if (shortMatch) {
    return currentYear + "-" + shortMatch[1].padStart(2, "0") + "-" + shortMatch[2].padStart(2, "0");
  }
  var monthOnly = dateText.match(/(\d{1,2})月/);
  if (monthOnly) {
    return currentYear + "-" + monthOnly[1].padStart(2, "0") + "-01";
  }
  return "";
}

/**
 * 抓取豆瓣即将上映页面
 */
async function fetchComingSoon() {
  console.log("[即将上映] 开始抓取...");
  var $ = await fetchPage("https://movie.douban.com/coming");
  var currentYear = new Date().getFullYear();
  var items = [];

  $("table tr").each(function (i, el) {
    var cells = $(el).find("td");
    if (cells.length < 5) return;

    var dateText = $(cells[0]).text().trim();
    if (!dateText) return;

    var $link = $(cells[1]).find("a");
    var href = $link.attr("href") || "";
    var title = $link.text().trim() || $(cells[1]).text().trim();

    var match = href.match(/movie\.douban\.com\/subject\/(\d+)/);
    if (!match) return;

    var doubanId = Number(match[1]);
    var genres = $(cells[2]).text().trim();
    var region = $(cells[3]).text().trim();

    var wishText = $(cells[4]).text().trim();
    var wishMatch = wishText.match(/(\d+)/);
    var wishCount = wishMatch ? parseInt(wishMatch[1], 10) : 0;

    items.push({
      doubanId: doubanId,
      tmdbId: null,
      title: title,
      releaseDate: parseComingSoonDate(dateText, currentYear),
      genres: genres,
      region: region,
      wishCount: wishCount,
    });
  });

  console.log(`[即将上映] 抓取完成，共 ${items.length} 部`);
  return items;
}

// ─── TMDB 匹配 ───

async function resolveTMDB(items, apiKey) {
  if (!apiKey) {
    console.log("[TMDB] 无 API Key，跳过匹配");
    return items;
  }
  console.log("[TMDB] 开始匹配 " + items.length + " 部电影...");

  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var year = item.releaseDate ? item.releaseDate.substring(0, 4) : "";

    try {
      var url = "https://api.themoviedb.org/3/search/movie?api_key=" + apiKey +
        "&query=" + encodeURIComponent(item.title) +
        "&language=zh-CN&page=1";
      if (year) url += "&year=" + year;

      var res = await fetch(url, {
        headers: {
          "Accept": "application/json",
        },
      });
      var data = await res.json();

      if (data.results && data.results.length > 0) {
        var best = data.results[0];
        var resultYear = best.release_date ? best.release_date.substring(0, 4) : "";
        if (!year || !resultYear || year === resultYear) {
          item.tmdbId = best.id;
          if (best.poster_path) {
            item.posterPath = "https://image.tmdb.org/t/p/w500" + best.poster_path;
          }
        }
      }
    } catch (e) {
      console.warn("  ✗ TMDB 搜索失败:", item.title, e.message);
    }

    // 控制请求频率
    if (i < items.length - 1) await sleep(300);
  }

  var matched = items.filter(function (i) { return i.tmdbId; }).length;
  console.log("[TMDB] 匹配完成: " + matched + "/" + items.length + " 部");
  return items;
}

// ─── 豆瓣海报抓取（弥补 TMDB 海报不可用的问题） ───

async function fetchDoubanPosters(items) {
  console.log("[豆瓣海报] 开始抓取 " + items.length + " 部电影的海报...");

  for (var i = 0; i < items.length; i++) {
    var item = items[i];

    try {
      // 用搜索页面绕过反爬，搜索页加 bid cookie 可正常返回
      var searchUrl = "https://movie.douban.com/subject_search?search_text=" +
        encodeURIComponent(item.title) + "&cat=1002";
      var res = await fetch(searchUrl, {
        headers: {
          "User-Agent": UA,
          "Referer": "https://movie.douban.com/",
          "Cookie": "bid=reasonix_build_script",
        },
        signal: AbortSignal.timeout(15000),
      });
      var html = await res.text();
      var $ = cheerio.load(html);

      // 在搜索结果中找到匹配 doubanId 的条目，提取海报
      var found = false;
      $("a[href*='/subject/" + item.doubanId + "/']").each(function () {
        if (found) return;
        var posterImg = $(this).find("img").first();
        var src = posterImg.attr("src");
        // 豆瓣海报 CDN URL 包含 "doubanio.com/view/photo/"
        if (src && src.indexOf("doubanio.com/view/photo/") >= 0) {
          item.posterPath = src;
          found = true;
          console.log("  ✓ " + item.title + ": " + src.substring(0, 60) + "...");
        }
      });

      if (!found) {
        // 兜底：取搜索页第一张海报
        var firstPoster = $(".item-root .cover img, .detail img, img[src*='doubanio.com/view/photo/']").first().attr("src");
        if (firstPoster) {
          item.posterPath = firstPoster;
          console.log("  ⚠ " + item.title + " (模糊匹配): " + firstPoster.substring(0, 60) + "...");
        } else {
          console.warn("  ✗ " + item.title + ": 未找到海报");
        }
      }
    } catch (e) {
      console.warn("  ✗ " + item.title + ": " + (e.message || e));
    }

    if (i < items.length - 1) await sleep(1000);
  }

  var got = items.filter(function (i) { return i.posterPath; }).length;
  console.log("[豆瓣海报] 完成: " + got + "/" + items.length + " 部有海报");
  return items;
}

// ─── 主流程 ───

async function main() {
  var args = process.argv.slice(2);
  var onlyComingSoon = args.indexOf("--coming-soon") >= 0;

  if (onlyComingSoon) {
    // ── 仅更新即将上映 ──
    console.log("═══════════════════════════════");
    console.log("  即将上映更新工具");
    console.log("═══════════════════════════════\n");

    var items = await fetchComingSoon();
    var apiKey = process.env.TMDB_API_KEY || "";
    items = await resolveTMDB(items, apiKey);

    items.sort(function (a, b) {
      return (a.releaseDate || "").localeCompare(b.releaseDate || "");
    });

    var outFile = path.join(DATA_DIR, "coming_soon.json");
    fs.writeFileSync(outFile, JSON.stringify({
      doulistId: "coming_soon",
      title: "即将上映",
      updatedAt: new Date().toISOString(),
      count: items.length,
      items: items,
    }, null, 2), "utf8");
    console.log("\n→ 已写入: coming_soon.json (共 " + items.length + " 部)");
    return;
  }

  // ── 完整构建：豆列 + 即将上映 ──
  console.log("═══════════════════════════════");
  console.log("  豆瓣豆列构建工具 v1.0");
  console.log("  共 " + Object.keys(DOULISTS).length + " 个豆列");
  console.log("═══════════════════════════════\n");

  const allMoviesMap = new Map(); // doubanId → item（全局去重）
  const perDoulistResults = {};

  for (const [id, meta] of Object.entries(DOULISTS)) {
    const items = await fetchDoulist(id, meta.title);
    perDoulistResults[id] = items;

    for (const item of items) {
      if (!allMoviesMap.has(item.doubanId)) {
        allMoviesMap.set(item.doubanId, item);
      }
    }

    // 写入单个豆列文件
    const outFile = path.join(DATA_DIR, `doulist_${id}.json`);
    fs.writeFileSync(outFile, JSON.stringify({
      doulistId: id,
      title: meta.title,
      count: items.length,
      items: items,
    }, null, 2), "utf8");
    console.log(`  → 已写入: doulist_${id}.json\n`);
  }

  // ─── 写入索引文件 ───
  const indexData = {
    version: "1.0",
    updatedAt: new Date().toISOString(),
    totalUnique: allMoviesMap.size,
    doulists: Object.entries(DOULISTS).map(([id, meta]) => ({
      id: id,
      title: meta.title,
      count: perDoulistResults[id] ? perDoulistResults[id].length : 0,
      file: `doulist_${id}.json`,
    })),
  };

  const indexFile = path.join(DATA_DIR, "doulist_index.json");
  fs.writeFileSync(indexFile, JSON.stringify(indexData, null, 2), "utf8");
  console.log(`→ 已写入: doulist_index.json`);

  // ─── 写入全量去重表（方便后续增量更新） ───
  const allMovies = Array.from(allMoviesMap.values());
  const moviesFile = path.join(DATA_DIR, "movies.json");
  fs.writeFileSync(moviesFile, JSON.stringify({
    version: "1.0",
    updatedAt: new Date().toISOString(),
    count: allMovies.length,
    movies: allMovies,
  }, null, 2), "utf8");
  console.log(`→ 已写入: movies.json (去重后共 ${allMovies.length} 部)`);

  // ─── 即将上映 ───
  console.log("\n── 即将上映 ──");
  var comingItems = await fetchComingSoon();
  var apiKey = process.env.TMDB_API_KEY || "";
  comingItems = await resolveTMDB(comingItems, apiKey);
  comingItems.sort(function (a, b) {
    return (a.releaseDate || "").localeCompare(b.releaseDate || "");
  });
  var comingFile = path.join(DATA_DIR, "coming_soon.json");
  fs.writeFileSync(comingFile, JSON.stringify({
    doulistId: "coming_soon",
    title: "即将上映",
    updatedAt: new Date().toISOString(),
    count: comingItems.length,
    items: comingItems,
  }, null, 2), "utf8");
  console.log(`→ 已写入: coming_soon.json (共 ${comingItems.length} 部)`);

  console.log("\n═══════════════════════════════");
  console.log("  构建完成!");
  console.log(`  豆列文件: ${Object.keys(DOULISTS).length} 个`);
  console.log(`  去重影片: ${allMovies.length} 部`);
  console.log("═══════════════════════════════");
}

main().catch(err => {
  console.error("\n构建失败:", err);
  process.exit(1);
});
