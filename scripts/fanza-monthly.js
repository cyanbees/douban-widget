// FANZA 月度榜单爬取脚本
// 用 Playwright 获取 DMM 月间排名，提取番号，调用 JavDB API 查询 javdbId
//
// 用法:
//   JAVDB_USER=xxx JAVDB_PASS=xxx node scripts/fanza-monthly.js
//
// 输出: data/fanza-monthly.json

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// ==================== 配置 ====================
const DMM_RANKING_URL = 'https://video.dmm.co.jp/av/ranking/?term=monthly';
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'fanza-monthly.json');

// JavDB API 配置
const JAVDB_BASE = 'https://jdforrepam.com/api';
const JAVDB_SIGN_KEY = '71cf27bb3c0bcdf207b64abecddc970098c7421ee7203b9cdae54478478a199e7d5a6e1a57691123c1a931c057842fb73ba3b3c83bcd69c17ccf174081e3d8aa';
const JAVDB_USER = process.env.JAVDB_USER || '';
const JAVDB_PASS = process.env.JAVDB_PASS || '';

// ==================== JavDB API 工具 ====================
function md5(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

function javdbSig() {
  const ts = Math.floor(Date.now() / 1000);
  return ts + '.lpw6vgqzsp.' + md5(String(ts) + JAVDB_SIGN_KEY);
}

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers, timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
  });
}

function httpsPost(url, body, headers = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

async function javdbLogin() {
  if (!JAVDB_USER || !JAVDB_PASS) throw new Error('需要设置 JAVDB_USER 和 JAVDB_PASS 环境变量');
  const sig = javdbSig();
  const body = JSON.stringify({
    username: JAVDB_USER,
    password: JAVDB_PASS,
    device_uuid: '04b9534d-5118-53de-9f87-2ddded77111e',
    device_name: 'FanzaBot',
    device_model: 'Server',
    platform: 'ios',
    system_version: '17.4',
    app_version: 'official',
    app_version_number: '1.9.29',
    app_channel: 'official',
  });
  const res = await httpsPost(`${JAVDB_BASE}/v1/sessions`, body, {
    'jdSignature': sig,
    'User-Agent': 'Dart/3.5 (dart:io)',
  });
  const data = JSON.parse(res.body);
  if (!data || !data.data || !data.data.token) {
    throw new Error('JavDB 登录失败: ' + (data.message || JSON.stringify(data)));
  }
  console.log('  JavDB 登录成功, token:', data.data.token.substring(0, 20) + '...');
  return data.data.token;
}

async function javdbSearch(token, keyword) {
  const sig = javdbSig();
  const res = await httpsGet(
    `${JAVDB_BASE}/v2/search?q=${encodeURIComponent(keyword)}&type=video&page=1&limit=3`,
    {
      'jdSignature': sig,
      'User-Agent': 'Dart/3.5 (dart:io)',
      'Authorization': `Bearer ${token}`,
    }
  );
  if (res.status !== 200) return null;
  try {
    const data = JSON.parse(res.body);
    if (!data || data.success !== 1) return null;
    const movies = data.data && data.data.movies || [];
    for (const m of movies) {
      const num = (m.number || '').toUpperCase().replace(/[\s_-]/g, '');
      const target = keyword.toUpperCase().replace(/[\s_-]/g, '');
      if (num === target) return m.id;
    }
    if (movies.length > 0) return movies[0].id;
    return null;
  } catch { return null; }
}

// ==================== 主逻辑 ====================
async function main() {
  console.log('=== FANZA 月度榜单爬取 ===');
  console.log('启动 Playwright...');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // 拦截 GraphQL 响应
  let graphqlBody = '';
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('api.video.dmm.co.jp/graphql')) {
      try {
        const text = await response.text();
        if (text.length > 100000) graphqlBody = text;
      } catch {}
    }
  });

  console.log('1. 访问 DMM 月榜页面...');
  await page.goto(DMM_RANKING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // 处理年龄验证
  try {
    await page.waitForSelector('a[href*="declared=yes"]', { timeout: 5000 });
    await page.click('a[href*="declared=yes"]');
    await page.waitForTimeout(3000);
    console.log('  年龄验证通过');
  } catch {
    console.log('  无需年龄验证');
  }

  // 滚动加载全部 100 条
  console.log('2. 滚动加载数据...');
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
  }

  // 等待 GraphQL 响应
  await page.waitForTimeout(2000);

  // 从 GraphQL 提取 CIDs
  const itemRegex = /\{"id":"([^"]+)","rank":(\d+),/g;
  const cidRankMap = new Map();
  let match;
  while ((match = itemRegex.exec(graphqlBody)) !== null) {
    const cid = match[1];
    const rank = parseInt(match[2]);
    if (!cidRankMap.has(rank)) cidRankMap.set(rank, cid);
  }

  const cidEntries = [...cidRankMap.entries()].sort((a, b) => a[0] - b[0]);
  console.log(`  提取到 ${cidEntries.length} 个 CID`);

  if (cidEntries.length === 0) {
    console.log('  未提取到 CID，尝试从图片 URL 提取...');
    const cids = await page.evaluate(() => {
      const ids = new Set();
      document.querySelectorAll('img[src*="awsimgsrc.dmm.co.jp/pics_dig/digital/video/"]').forEach(img => {
        const m = img.src.match(/\/video\/([a-z0-9]+)\/\1ps\.jpg/);
        if (m) ids.add(m[1]);
      });
      return [...ids];
    });
    cids.forEach((cid, idx) => cidRankMap.set(idx + 1, cid));
    console.log(`  图片提取到 ${cids.length} 个 CID`);
  }

  // 逐个访问详情页提取番号
  console.log('3. 提取番号（メーカー品番）...');
  const results = [];
  for (const [rank, cid] of cidEntries) {
    try {
      const detailUrl = `https://video.dmm.co.jp/av/content/?id=${cid}`;
      await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1000);

      const text = await page.evaluate(() => document.body.innerText);
      const lines = text.split('\n');
      let productCode = '';

      for (let j = 0; j < lines.length; j++) {
        if (lines[j].includes('メーカー品番')) {
          const m = lines[j].match(/メーカー品番[：:]\s*(\S+)/);
          if (m) productCode = m[1];
          else {
            const next = lines[j + 1]?.trim();
            if (next && !next.includes('：') && !next.includes(':')) productCode = next;
          }
          break;
        }
      }

      if (!productCode) {
        // 从 CID 猜测番号
        productCode = guessProductCode(cid);
      }

      results.push({ rank, cid, productCode });
      if (rank % 10 === 0) console.log(`  #${rank}: ${productCode || cid}`);
    } catch (e) {
      console.log(`  #${rank} 失败: ${e.message.substring(0, 60)}`);
    }
  }

  await browser.close();
  console.log(`  共提取 ${results.length} 个番号`);

  // JavDB 查询 javdbId
  console.log('4. 查询 JavDB ID...');
  let token = null;
  try { token = await javdbLogin(); } catch (e) { console.log('  JavDB 登录失败:', e.message); }

  const finalData = [];
  for (const item of results) {
    const entry = { rank: item.rank, cid: item.productCode || item.cid };
    if (token && entry.cid) {
      try {
        const javdbId = await javdbSearch(token, entry.cid);
        if (javdbId) entry.javdbId = javdbId;
      } catch {}
    }
    finalData.push(entry);
  }

  // 写入文件
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(finalData, null, 2));
  console.log(`\n✅ 完成! 写入 ${OUTPUT_PATH}, 共 ${finalData.length} 条`);
  if (finalData.length > 0) {
    console.log('  前 5 条:', JSON.stringify(finalData.slice(0, 5)));
  }
}

function guessProductCode(cid) {
  // 部分 DMM CID 可以直接推导出番号
  // sqte00633 → SQTE-633
  const m = cid.match(/^([a-z]+)(\d+)$/);
  if (m) {
    const prefix = m[1].toUpperCase();
    const num = parseInt(m[2], 10);
    return prefix + '-' + num;
  }
  return cid.toUpperCase();
}

main().catch(e => {
  console.error('❌ 失败:', e.message);
  process.exit(1);
});
