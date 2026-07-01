// FANZA 榜单爬取脚本 (Playwright 版)
// 用 Playwright 浏览器访问 DMM，绕过封锁
//
// 用法:
//   TERM=daily   JAVDB_USER=xxx JAVDB_PASS=xxx node scripts/fanza-monthly.js
//   TERM=weekly  JAVDB_USER=xxx JAVDB_PASS=xxx node scripts/fanza-monthly.js
//   TERM=monthly JAVDB_USER=xxx JAVDB_PASS=xxx node scripts/fanza-monthly.js
//
// TERM 取值: daily / weekly / monthly (默认 monthly)
// 输出: data/fanza-{term}.json

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const TERM = process.env.TERM || 'monthly';
const OUTPUT_FILE = process.env.OUTPUT_FILE || `data/fanza-${TERM}.json`;
const OUTPUT_PATH = path.join(__dirname, '..', OUTPUT_FILE);
const DMM_RANKING_URL = `https://video.dmm.co.jp/av/ranking/?term=${TERM}`;

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
  console.log(`=== FANZA ${TERM}榜单爬取 (Playwright 版) ===`);

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

  console.log(`1. 访问 DMM ${TERM}榜单页面...`);
  await page.goto(DMM_RANKING_URL, {
    waitUntil: 'domcontentloaded', timeout: 60000
  });

  // 处理年龄验证 + 自动登录 (日榜/周榜需要 DMM 账号)
  try {
    await page.waitForTimeout(2000);
    console.log('  初始URL:', page.url().substring(0, 80));

    // 处理年龄验证
    if (page.url().includes('age_check')) {
      try {
        var ageBtn = await page.waitForSelector('a[href*="declared=yes"]', { timeout: 5000 });
        if (ageBtn) {
          console.log('  年龄验证 - 点击...');
          await ageBtn.click();
          await page.waitForTimeout(3000);
        }
      } catch (e2) { console.log('  年龄验证按钮未找到'); }
    }

    // 如果跳转到登录页，自动登录
    if (page.url().includes('login') || page.url().includes('accounts.dmm')) {
      console.log('  检测到登录页面，自动登录...');
      var dmmUser = process.env.DMM_USER || '';
      var dmmPass = process.env.DMM_PASS || '';
      if (dmmUser && dmmPass) {
        await page.waitForTimeout(2000);
        // 填邮箱
        var emailSel = 'input[name="login_id"], input[type="email"], input[id*="login"], input[id*="mail"]';
        var emailEl = await page.$(emailSel);
        if (emailEl) {
          await emailEl.click();
          await emailEl.fill(dmmUser);
          console.log('  已填邮箱');
        }
        await page.waitForTimeout(500);
        // 填密码
        var passEl = await page.$('input[type="password"]');
        if (passEl) {
          await passEl.click();
          await passEl.fill(dmmPass);
          console.log('  已填密码');
        }
        await page.waitForTimeout(500);
        // 点登录
        var btn = await page.$('button[type="submit"], input[type="submit"]');
        if (btn) {
          await btn.click();
          await page.waitForTimeout(5000);
          console.log('  登录后URL:', page.url().substring(0, 80));
        }
      }
    }

    // 直接跳转到排名页 (用新页面避免 mylibrary 重定向)
    // 直接跳转到排名页 (拦截 mylibrary 重定向)
    await page.goto(DMM_RANKING_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(function(){});
    await page.waitForTimeout(1000);
    // 如果被重定向到 mylibrary，用 route 拦截
    if (page.url().includes('mylibrary')) {
      console.log('  mylibrary 重定向, 使用拦截...');
      // 阻止所有 mylibrary 导航
      await page.route('**/mylibrary/**', function(route) { route.abort(); });
      await page.goto(DMM_RANKING_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(function(){});
      await page.waitForTimeout(3000);
      // 取消路由拦截
      await page.unroute('**/mylibrary/**').catch(function(){});
    }
  } catch (e) {
    console.log('  页面处理异常:', e && e.message ? e.message.substring(0, 80) : e);
  }
  console.log('  最终URL:', page.url().substring(0, 80));

  await page.waitForTimeout(3000);
  console.log('  当前URL:', page.url().substring(0, 80));

  // 滚动加载全部 100 条
  console.log('2. 滚动加载数据...');
  try {
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(function(){});
      await page.waitForTimeout(2500);
    }
    await page.waitForTimeout(3000);
  } catch (e) {
    console.log('  滚动异常:', e && e.message ? e.message.substring(0, 60) : e);
    // 滚动失败后再等一等
    await page.waitForTimeout(5000);
  }

  // 从页面提取 CID
  let cids = [];

  // 优先使用 GraphQL 数据
  if (graphqlData) {
    var regex = /\{"id":"([^"]+)","rank":(\d+),/g;
    var map = {};
    var gRank;
    var gCid;
    while ((gCid = regex.exec(graphqlData)) !== null) {
      var rankVal = parseInt(gCid[2]);
      if (!map[rankVal]) map[rankVal] = gCid[1];
    }
    var gcids = Object.keys(map).sort(function(a,b){return a-b}).map(function(k){return map[k];});
    if (gcids.length >= 30) {
      cids = gcids;
      console.log('  GraphQL 提取到', cids.length, '个 CID');
    }
  }

  if (cids.length === 0) {
    // 调试: 直接获取页面 HTML 查找 CID
    try {
      var html = await page.content();
      var htmlCids = html.match(/[?&]id=([a-z0-9_]+)/gi);
      if (htmlCids) {
        var uniqueCids = {};
        htmlCids.forEach(function(h) {
          var m = h.match(/id=([a-z0-9_]+)/i);
          if (m) uniqueCids[m[1].toLowerCase()] = 1;
        });
        cids = Object.keys(uniqueCids);
        console.log('  HTML 匹配到', cids.length, '个 CID');
      }
    } catch(e2) {
      console.log('  HTML 提取失败:', e2.message.substring(0,60));
    }
  }

  if (cids.length === 0) {
    try {
    cids = await page.evaluate(() => {
    const ids = new Set();
    // DMM 排名页内容块
    document.querySelectorAll('a[href*="?id="]').forEach(a => {
      const m = a.href.match(/[?&]id=([a-z0-9_]+)/);
      if (m) ids.add(m[1].toLowerCase());
    });
    // 图片路径
    document.querySelectorAll('img[src*="/video/"]').forEach(img => {
      const m = img.src.match(/\/video\/([a-z0-9_]+)\/\1/);
      if (m) ids.add(m[1].toLowerCase());
    });
    // 页面文本中的 CID 模式
    const body = document.body.innerText;
    const textMatches = body.matchAll(/([a-z0-9_]{8,20})/gi);
    for (const tm of textMatches) {
      const t = tm[1].toLowerCase();
      if (/^[a-z]/.test(t) && /\d{3,}/.test(t)) ids.add(t);
    }
    return [...ids];
  });
  console.log(`  页面提取到 ${cids.length} 个 CID`);

  if (cids.length === 0) {
    // 调试: 检查页面内容
    const debug = await page.evaluate(() => {
      const links = [...document.querySelectorAll('a[href]')].map(a => a.href).filter(h => h.includes('id=') || h.includes('ranking')).slice(0, 5);
      const imgs = [...document.querySelectorAll('img[src]')].map(i => i.src).filter(s => s.includes('dmm')).slice(0, 3);
      return { url: location.href, title: document.title, links, imgs, bodyLen: document.body.innerText.length };
    });
    console.log('  调试:', JSON.stringify(debug, null, 2));
  }

  } catch (e) {
    console.log("  CID 提取异常:", e && e.message ? e.message.substring(0,60) : e);
  }
  }
  // 调试: cids 为 0 时输出页面内容
  if (cids.length < 5) {
    try {
      var pageContent = await page.content();
      console.log('  页面HTML前500:', pageContent.substring(0, 500).replace(/\\s+/g, ' '));
      var pageTitle = await page.title();
      console.log('  标题:', pageTitle);
      var pageUrl2 = page.url();
      console.log('  URL:', pageUrl2.substring(0, 100));
    } catch(e3) {}
  }
  // 3. 逐个访问详情页提取メーカー品番
  if (graphqlData) {
    const regex = /\{"id":"([^"]+)","rank":(\d+),/g;
    const map = new Map();
    let m;
    while ((m = regex.exec(graphqlData)) !== null) {
      const rank = parseInt(m[2]);
      if (!map.has(rank)) map.set(rank, m[1]);
    }
    const graphqlCids = [...map.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
    if (graphqlCids.length >= 50) {
      cids = graphqlCids;
      console.log(`  GraphQL 覆盖, 共 ${cids.length} 个 CID`);
    }
  }

  // 3. 逐个访问详情页提取メーカー品番
  console.log('3. 提取メーカー品番...');
  const results = [];
  let rank = 0;
  const seen = new Set();

  for (const cid of cids.slice(0, 100)) {
    let productCode = null;
    try {
      await page.goto(`https://video.dmm.co.jp/av/content/?id=${cid}`, {
        waitUntil: 'domcontentloaded', timeout: 30000
      });
      await page.waitForTimeout(800);
      // 从页面提取メーカー品番
      productCode = await page.evaluate(() => {
        const text = document.body.innerText;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes('メーカー品番')) {
            const m = lines[i].match(/メーカー品番[：:]\s*(\S+)/);
            if (m) return m[1];
            const next = lines[i + 1]?.trim();
            if (next && !next.includes('：') && !next.includes(':')) return next;
          }
        }
        return null;
      });
    } catch (e) {
      console.log(`  #${rank + 1} ${cid} 详情页失败:`, e.message.substring(0, 50));
    }

    // 详情页提取失败时用猜测
    const code = productCode || guessProductCode(cid);
    if (!seen.has(code)) {
      seen.add(code);
      rank++;
      results.push({ rank, cid: code });
      if (rank % 20 === 0) console.log(`  ${rank}/${cids.length}: ${code}`);
    }
  }

  await browser.close();
  console.log(`  提取到 ${results.length} 个番号`);

  // 4. JavDB 查询
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
  console.log(`\n✅ 完成! 共 ${finalData.length} 条，写入 ${OUTPUT_FILE}`);
  console.log('  前 5:', JSON.stringify(finalData.slice(0, 5)));
}

main().catch(e => { console.error('❌ 失败:', e.message); process.exit(1); });
