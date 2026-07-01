// FANZA 月度榜单爬取脚本 v2 — 使用 DMM GraphQL API 直接请求
// 不需要 Playwright，直接调用 API 获取排名数据
//
// 用法:
//   JAVDB_USER=xxx JAVDB_PASS=xxx node scripts/fanza-monthly.js
//
// 输出: data/fanza-monthly.json

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// ==================== 配置 ====================
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'fanza-monthly.json');

// JavDB API 配置
const JAVDB_BASE = 'https://jdforrepam.com/api';
const JAVDB_SIGN_KEY = '71cf27bb3c0bcdf207b64abecddc970098c7421ee7203b9cdae54478478a199e7d5a6e1a57691123c1a931c057842fb73ba3b3c83bcd69c17ccf174081e3d8aa';
const JAVDB_USER = process.env.JAVDB_USER || '';
const JAVDB_PASS = process.env.JAVDB_PASS || '';

// ==================== HTTP 工具 ====================
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

// ==================== JavDB API ====================
function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }
function javdbSig() {
  const ts = Math.floor(Date.now() / 1000);
  return ts + '.lpw6vgqzsp.' + md5(String(ts) + JAVDB_SIGN_KEY);
}

async function javdbLogin() {
  if (!JAVDB_USER || !JAVDB_PASS) throw new Error('需要设置 JAVDB_USER 和 JAVDB_PASS');
  const sig = javdbSig();
  const body = JSON.stringify({
    username: JAVDB_USER, password: JAVDB_PASS,
    device_uuid: '04b9534d-5118-53de-9f87-2ddded77111e',
    device_name: 'FanzaBot', device_model: 'Server',
    platform: 'ios', system_version: '17.4',
    app_version: 'official', app_version_number: '1.9.29', app_channel: 'official',
  });
  const res = await httpsPost(`${JAVDB_BASE}/v1/sessions`, body, {
    'jdSignature': sig, 'User-Agent': 'Dart/3.5 (dart:io)',
  });
  const data = JSON.parse(res.body);
  if (!data || !data.data || !data.data.token) throw new Error('JavDB 登录失败');
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
    for (const m of movies) {
      const num = (m.number || '').toUpperCase().replace(/[\s_-]/g, '');
      const target = keyword.toUpperCase().replace(/[\s_-]/g, '');
      if (num === target) return m.id;
    }
    if (movies.length > 0) return movies[0].id;
    return null;
  } catch { return null; }
}

// ==================== DMM CID → 番号 转换 ====================
function guessProductCode(cid) {
  let s = cid.toLowerCase();
  // h_1133yako00073 → YAKO-073
  let m = s.match(/^h_\d+([a-z]+)(\d+)$/);
  if (m) return m[1].toUpperCase() + '-' + parseInt(m[2], 10);
  // 去掉纯数字前缀: 1start00373 → start00373
  s = s.replace(/^\d+/, '');
  m = s.match(/^([a-z]+?)(\d+)$/);
  if (m) return m[1].toUpperCase() + '-' + parseInt(m[2], 10);
  return cid.toUpperCase();
}

// ==================== 主逻辑 ====================
async function main() {
  console.log('=== FANZA 月度榜单爬取 (API直连版) ===');

  // 1. 先访问 DMM 首页获取 cookie
  console.log('1. 获取 DMM cookie...');
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const cookieReq = await new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'www.dmm.co.jp', path: '/',
      headers: { 'User-Agent': ua, 'Accept': 'text/html,*/*' },
      timeout: 10000,
    }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ headers: res.headers, body: b }));
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('timeout')); });
  });

  // 提取 cookie 中的 age_check token
  const setCookies = cookieReq.headers['set-cookie'] || [];
  const cookies = setCookies.map(c => c.split(';')[0]).join('; ') + '; age_check_done=1';

  console.log('2. 请求 DMM GraphQL API...');

  // 2. 直接调用 DMM 的排名页面（SSR 版本，无需 JS）
  // DMM 提供服务端渲染的排名页面，可以直接从 HTML 中提取
  const rankHtml = await httpsGet('https://www.dmm.co.jp/av/ranking/=/term=monthly/', {
    'User-Agent': ua,
    'Cookie': cookies,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ja,en;q=0.9',
  });

  const html = rankHtml.body;

  // 从 HTML 中提取 CID（所有详情页链接中的 id 参数）
  const cidSet = new Set();
  const linkRegex = /\/av\/content\/\?id=([a-z0-9_]+)/gi;
  let m;
  while ((m = linkRegex.exec(html)) !== null) {
    cidSet.add(m[1].toLowerCase());
  }
  // 也提取图片中的 CID
  const imgRegex = /\/video\/([a-z0-9_]+)\/\1ps\.jpg/gi;
  while ((m = imgRegex.exec(html)) !== null) {
    cidSet.add(m[1].toLowerCase());
  }

  const cids = [...cidSet];
  console.log(`  提取到 ${cids.length} 个 CID`);

  if (cids.length === 0) {
    console.log('  HTML 前 500 字符:', html.substring(0, 500));
    console.log('  ❌ 未提取到任何 CID');
    process.exit(1);
  }

  // 3. 用番号规则转换 CID → 番号
  console.log('3. 转换 CID → 番号...');
  const results = cids.map((cid, idx) => ({
    rank: idx + 1,
    cid,
    productCode: guessProductCode(cid),
  }));
  // 去重（按番号）
  const seen = new Set();
  const uniqueResults = [];
  for (const r of results) {
    if (!seen.has(r.productCode)) {
      seen.add(r.productCode);
      uniqueResults.push(r);
    }
  }

  console.log(`  生成 ${uniqueResults.length} 个番号`);

  // 4. JavDB 查询 javdbId
  console.log('4. 查询 JavDB ID...');
  let token = null;
  try { token = await javdbLogin(); } catch (e) { console.log('  JavDB 登录失败:', e.message); }

  const finalData = [];
  for (const item of uniqueResults.slice(0, 100)) {
    const entry = { rank: item.rank, cid: item.productCode };
    if (token && entry.cid && entry.cid.match(/^[A-Z0-9]+-[A-Z0-9]+$/)) {
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

main().catch(e => {
  console.error('❌ 失败:', e.message);
  process.exit(1);
});
