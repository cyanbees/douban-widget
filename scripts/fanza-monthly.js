// FANZA 月度榜单爬取脚本 (Playwright 版)
// 用 Playwright 浏览器访问 DMM，绕过封锁
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

const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'fanza-monthly.json');

// JavDB API
const JAVDB_BASE = 'https://jdforrepam.com/api';
const JAVDB_SIGN_KEY = '71cf27bb3c0bcdf207b64abecddc970098c7421ee7203b9cdae54478478a199e7d5a6e1a57691123c1a931c057842fb73ba3b3c83bcd69c17ccf174081e3d8aa';
const JAVDB_USER = process.env.JAVDB_USER || '';
const JAVDB_PASS = process.env.JAVDB_PASS || '';

function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }

function javdbSig() {
  const ts = Math.floor(Date.now() / 1000);
  return ts + '.lpw6vgqzsp.' + md5(String(ts) + JAVDB_SIGN_KEY);
}

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers, timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
  });
}

function httpsPost(url, body, headers = {}) {
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
  if (!JAVDB_USER || !JAVDB_PASS) throw new Error('需要 JAVDB_USER/JAVDB_PASS 环境变量');
  const sig = javdbSig();
  const res = await httpsPost(`${JAVDB_BASE}/v1/sessions`, JSON.stringify({
    username: JAVDB_USER, password: JAVDB_PASS,
    device_uuid: '04b9534d-5118-53de-9f87-2ddded77111e',
    device_name: 'FanzaBot', device_model: 'Server', platform: 'ios',
    system_version: '17.4', app_version: 'official', app_version_number: '1.9.29', app_channel: 'official',
  }), { 'jdSignature': sig, 'User-Agent': 'Dart/3.5 (dart:io)' });
  const data = JSON.parse(res.body);
  if (!data || !data.data || !data.data.token) throw new Error('JavDB 登录失败: ' + (data.message || ''));
  console.log('  JavDB 登录成功');
  return data.data.token;
}

async function javdbSearch(token, keyword) {
  const sig = javdbSig();
  const res = await httpsGet(
    `${JAVDB_BASE}/v2/search?q=${encodeURIComponent(keyword)}&type=video&page=1&limit=3`,
    { 'jdSignature': sig, 'User-Agent': 'Dart/3.5 (dart:io)', 'Authorization': `Bearer ${token}` }
  );
  if (res.status !== 200) return null;
  try {
    const data = JSON.parse(res.body);
    if (!data || data.success !== 1) return null;
    const movies = data.data && data.data.movies || [];
    const target = keyword.toUpperCase().replace(/[\s_-]/g, '');
    for (const m of movies) {
      const num = (m.number || '').toUpperCase().replace(/[\s_-]/g, '');
      if (num === target) return m.id;
    }
    return movies.length > 0 ? movies[0].id : null;
  } catch { return null; }
}

function guessProductCode(cid) {
  let s = cid.toLowerCase();
  // h_1133yako00073 → YAKO-073
  let m = s.match(/^h_\d+([a-z]+)(\d+)$/);
  if (m) return m[1].toUpperCase() + '-' + String(parseInt(m[2], 10)).padStart(3, '0');
  // 去掉纯数字前缀: 1start00498v → start00498v
  s = s.replace(/^\d+/, '');
  // start00498v → start, 00498, v
  m = s.match(/^([a-z]+?)(\d+)([a-z]?)$/);
  if (m) {
    let prefix = m[1].toUpperCase();
    let num = String(parseInt(m[2], 10)).padStart(3, '0');
    let suffix = m[3] ? m[3].toUpperCase() : '';
    return prefix + '-' + num + suffix;
  }
  return cid.toUpperCase();
}

async function main() {
  console.log('=== FANZA 月度榜单爬取 (Playwright 版) ===');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'ja-JP',
  });
  const page = await context.newPage();

  // 拦截 GraphQL 响应获取排名数据
  let graphqlData = null;
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('api.video.dmm.co.jp/graphql')) {
      try {
        const text = await response.text();
        if (text && text.includes('ppvContentRanking') && text.length > 50000) {
          graphqlData = text;
          console.log('  截获 GraphQL 排名数据, 大小:', text.length);
        }
      } catch {}
    }
  });

  console.log('1. 访问 DMM 月榜页面...');
  await page.goto('https://video.dmm.co.jp/av/ranking/?term=monthly', {
    waitUntil: 'domcontentloaded', timeout: 60000
  });

  // 处理年龄验证
  try {
    const ageBtn = await page.waitForSelector('a[href*="declared=yes"]', { timeout: 5000 });
    if (ageBtn) {
      await ageBtn.click();
      console.log('  年龄验证通过');
      await page.waitForTimeout(3000);
    }
  } catch {
    console.log('  无需年龄验证');
  }

  // 滚动加载全部 100 条
  console.log('2. 滚动加载数据...');
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
  }
  await page.waitForTimeout(2000);

  // 从 GraphQL 或页面提取 CID
  let cids = [];
  if (graphqlData) {
    const regex = /\{"id":"([^"]+)","rank":(\d+),/g;
    const map = new Map();
    let m;
    while ((m = regex.exec(graphqlData)) !== null) {
      const rank = parseInt(m[2]);
      if (!map.has(rank)) map.set(rank, m[1]);
    }
    cids = [...map.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
    console.log(`  GraphQL 提取到 ${cids.length} 个 CID`);
  }

  if (cids.length === 0) {
    // 从页面 HTML/图片提取
    cids = await page.evaluate(() => {
      const ids = new Set();
      document.querySelectorAll('a[href*="?id="]').forEach(a => {
        const m = a.href.match(/[?&]id=([a-z0-9_]+)/);
        if (m) ids.add(m[1].toLowerCase());
      });
      document.querySelectorAll('img[src*="video/"]').forEach(img => {
        const m = img.src.match(/\/video\/([a-z0-9_]+)\/\1/);
        if (m) ids.add(m[1].toLowerCase());
      });
      return [...ids];
    });
    console.log(`  页面提取到 ${cids.length} 个 CID`);
  }

  await browser.close();

  if (cids.length < 50) {
    console.log('  ❌ 提取的 CID 太少:', cids.length);
    process.exit(1);
  }

  // 转换 CID → 番号
  console.log('3. 转换 CID → 番号...');
  const seen = new Set();
  const results = [];
  cids.forEach((cid, idx) => {
    const code = guessProductCode(cid);
    if (!seen.has(code)) {
      seen.add(code);
      results.push({ rank: results.length + 1, cid: code });
    }
  });
  console.log(`  生成 ${results.length} 个番号 (去重后)`);

  // JavDB 查询
  console.log('4. 查询 JavDB ID...');
  let token = null;
  try { token = await javdbLogin(); } catch (e) { console.log('  JavDB 登录失败:', e.message); }

  const finalData = [];
  for (const item of results.slice(0, 100)) {
    const entry = { rank: item.rank, cid: item.cid };
    if (token && /^[A-Z0-9]+-\d+$/.test(item.cid)) {
      try {
        const javdbId = await javdbSearch(token, item.cid);
        if (javdbId) entry.javdbId = javdbId;
      } catch {}
    }
    finalData.push(entry);
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(finalData, null, 2));
  console.log(`\n✅ 完成! 共 ${finalData.length} 条，写入 ${OUTPUT_PATH}`);
  console.log('  前 5:', JSON.stringify(finalData.slice(0, 5)));
}

main().catch(e => { console.error('❌ 失败:', e.message); process.exit(1); });
