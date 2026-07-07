// 西瓜短剧模块 — 结构 & 数据处理测试
// 运行: node test-xgshort-structure.js
// 不依赖真实API（用 web_fetch 获取的数据作为 mock）

const fs = require('fs');
const assert = require('assert/strict');

// 用之前 web_fetch 获取的真实数据做 mock
const MOCK_HOME_RESPONSE = {
  code: 200, msg: "success",
  data: {
    list: [{
      type: 0, name: "轮播图", banners: [
        { shortId: "test1", title: "测试短剧1", coverUrl: "https://static.656932.com/banners/test1.png" }
      ]
    }, {
      type: 1001, name: "搜索过滤器", filters: []
    }, {
      type: 1002, name: "视频列表", list: [
        { shortId: "YjAvsSaAXC9", title: "测试剧集", coverUrl: "https://static.656932.com/test.jpg", type: "短剧", score: "8.5", playCount: 12345678, upStatus: "已完结", tags: ["穿越","甜宠"], description: "测试描述" }
      ]
    }]
  }
};

// Mock Widget 环境
let storageData = {};
global.Widget = {
  http: {
    get: async (url, opts) => {
      // 返回 mock 数据
      if (url.includes('/auth/guest-login')) {
        return {
          data: { access_token: 'test_token_123', token_type: 'Bearer', expires_in: 604800 },
          status: 200
        };
      }
      if (url.includes('/home/gethomemodules')) {
        return { data: MOCK_HOME_RESPONSE, status: 200 };
      }
      if (url.includes('/video/episodes')) {
        return {
          data: {
            code: 200, data: {
              seriesInfo: { title: "测试短剧", description: "测试描述", coverUrl: "https://static.656932.com/test.jpg", score: "8.5", actor: "张三,李四" },
              tags: ["穿越","甜宠"],
              list: [
                { shortId: "ep1", episodeNumber: 1, title: "第1集", duration: 600, episodeAccessKey: "key1", urls: [{ cdnUrl: "https://cdn.test.com/video1.mp4", quality: "1080p" }] },
                { shortId: "ep2", episodeNumber: 2, title: "第2集", duration: 600, episodeAccessKey: "key2", urls: [{ cdnUrl: "https://cdn.test.com/video2.mp4", quality: "720p" }] }
              ],
              hasMore: false
            }
          },
          status: 200
        };
      }
      if (url.includes('/video/recommend')) {
        return {
          data: {
            code: 200, data: {
              list: [
                { seriesShortId: "rec1", shortId: "rec_ep1", seriesTitle: "推荐剧1", seriesCoverUrl: "https://static.656932.com/rec1.jpg", episodeNumber: 1, duration: 300, playCount: 1000, tags: ["甜宠"] }
              ],
              hasMore: true
            }
          },
          status: 200
        };
      }
      if (url.includes('/list/getfiltersdata') || url.includes('/list/getfilterstags')) {
        return {
          data: {
            code: 200, data: {
              list: [
                { shortId: "filter1", title: "筛选结果1", coverUrl: "https://static.656932.com/f1.jpg", type: "短剧", score: "7.5", playCount: 5000 }
              ],
              hasMore: false
            }
          },
          status: 200
        };
      }
      if (url.includes('/list/fuzzysearch')) {
        return {
          data: {
            code: 200, data: {
              list: [
                { shortId: "search1", title: "搜索结果1", coverUrl: "https://static.656932.com/s1.jpg", type: "短剧", score: "8.0", playCount: 10000 }
              ],
              hasMore: false
            }
          },
          status: 200
        };
      }
      return { data: { code: 200, data: { list: [] } }, status: 200 };
    },
    post: async (url, body, opts) => {
      if (url.includes('/auth/guest-login')) {
        return {
          data: { access_token: 'test_token_123', token_type: 'Bearer', expires_in: 604800 },
          status: 200
        };
      }
      if (url.includes('/video/url/query')) {
        return {
          data: {
            code: 200, data: {
              urls: [
                { cdnUrl: "https://cdn.test.com/playback.mp4", quality: "1080p" },
                { cdnUrl: "https://cdn.test.com/playback_720.mp4", quality: "720p" }
              ]
            }
          },
          status: 200
        };
      }
      return { data: { code: 200 }, status: 200 };
    }
  },
  storage: {
    get: function (k) { return storageData[k]; },
    set: function (k, v) { storageData[k] = v; }
  }
};

global.WidgetMetadata = {};
storageData = {};

// 加载模块
const code = fs.readFileSync('./widgets/xgshort.js', 'utf8');
eval(code);

let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('  ✅', name);
    passed++;
  } catch (e) {
    console.log('  ❌', name, '-', e.message);
    console.log('     栈:', e.stack.split('\n').slice(1, 3).join(' ').trim());
    failed++;
  }
}

async function run() {
  console.log('\n🧪 西瓜短剧模块 — 结构 & 数据处理测试\n');

  // === WidgetMetadata 结构检查 ===
  await test('WidgetMetadata 存在', () => {
    assert.ok(global.WidgetMetadata);
    assert.equal(global.WidgetMetadata.id, 'forward.xgshort');
  });

  await test('WidgetMetadata 有 modules 数组', () => {
    assert.ok(Array.isArray(global.WidgetMetadata.modules));
    assert.equal(global.WidgetMetadata.modules.length, 5);
  });

  await test('WidgetMetadata 有 search 块', () => {
    assert.ok(global.WidgetMetadata.search);
    assert.equal(global.WidgetMetadata.search.functionName, 'searchShort');
  });

  // 检查每个模块定义
  const moduleIds = ['xgshort-home', 'xgshort-category', 'xgshort-feed', 'xgshort-topic', 'loadResource'];
  moduleIds.forEach(id => {
    const mod = global.WidgetMetadata.modules.find(m => m.id === id);
    assert.ok(mod, `模块 ${id} 已定义`);
    assert.ok(mod.functionName, `模块 ${id} 有 functionName`);
  });

  // === loadHomeList ===
  await test('loadHomeList 返回正确格式', async () => {
    storageData = {};
    const result = await loadHomeList({ page: 1 });
    assert.equal(result.pageType, 'category');
    assert.equal(result.style, 'media.posterGrid');
    assert.ok(Array.isArray(result.items));
    assert.ok(result.items.length > 0);
    const item = result.items[0];
    assert.ok(item.title);
    assert.equal(item.type, 'url');
    assert.ok(item.link);
    assert.ok(item.link.startsWith('xg-series:'));
  });

  await test('loadHomeList items 有完整字段', async () => {
    storageData = {};
    const result = await loadHomeList({ page: 1 });
    const item = result.items[0];
    assert.ok(item.id, '缺少 id');
    assert.ok(item.title, '缺少 title');
    assert.ok(item.type, '缺少 type');
    assert.ok(item.mediaType, '缺少 mediaType');
    assert.ok(item.link, '缺少 link');
    assert.ok(item.poster, '缺少 poster');
    assert.ok(item.backdrop, '缺少 backdrop');
    assert.ok(item.imageHeaders, '缺少 imageHeaders');
    assert.ok(item.posterHeaders, '缺少 posterHeaders');
    assert.ok(item.backdropHeaders, '缺少 backdropHeaders');
  });

  // === loadCategoryList ===
  await test('loadCategoryList 短剧频道', async () => {
    storageData = {};
    const result = await loadCategoryList({ channelId: '1', page: 1 });
    assert.equal(result.pageType, 'category');
    assert.ok(Array.isArray(result.items));
    assert.ok(result.items.length > 0);
  });

  await test('loadCategoryList 电影频道', async () => {
    storageData = {};
    const result = await loadCategoryList({ channelId: '2', page: 1 });
    assert.ok(Array.isArray(result.items));
    assert.ok(result.items[0].title);
  });

  await test('loadCategoryList 人气排序', async () => {
    storageData = {};
    const result = await loadCategoryList({ channelId: '1', sort: '1', page: 1 });
    assert.ok(Array.isArray(result.items));
  });

  // === loadShortFeed ===
  await test('loadShortFeed 返回竖屏格式', async () => {
    storageData = {};
    const result = await loadShortFeed({ page: 1 });
    assert.equal(result.pageType, 'shortFeed');
    assert.ok(Array.isArray(result.items));
    if (result.items.length > 0) {
      assert.equal(result.items[0].aspectRatio, '9:16');
    }
  });

  // === loadTopicList ===
  await test('loadTopicList 题材筛选', async () => {
    storageData = {};
    const result = await loadTopicList({ topicId: '1', page: 1 });
    assert.ok(Array.isArray(result.items));
    assert.ok(result.items.length > 0);
  });

  // === searchShort ===
  await test('searchShort 搜索', async () => {
    storageData = {};
    const result = await searchShort({ keyword: '测试', page: 1 });
    assert.ok(Array.isArray(result.items));
    assert.ok(result.items.length > 0);
    assert.ok(result.items[0].link);
  });

  await test('searchShort 空关键词返回空数组', async () => {
    storageData = {};
    const result = await searchShort({ keyword: '', page: 1 });
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 0);
  });

  // === loadDetail ===
  await test('loadDetail 返回完整详情', async () => {
    storageData = {};
    const detail = await loadDetail('xg-series:test-series');
    assert.ok(detail, '详情不应为 null');
    assert.equal(detail.type, 'url');
    assert.equal(detail.mediaType, 'series');
    assert.ok(detail.title);
    assert.ok(detail.overview !== undefined);
    assert.ok(detail.seasons, '应有 seasons');
    assert.ok(detail.seasons.length > 0, '应有至少一季');
    const season = detail.seasons[0];
    assert.ok(season.episodes, '应有剧集列表');
    assert.ok(season.episodes.length > 0);
    const ep = season.episodes[0];
    assert.ok(ep.id);
    assert.ok(ep.title);
    assert.ok(ep.action, '剧集应有 action');
    assert.ok(ep.action.type === 'play', 'action 类型应为 play');
    assert.ok(ep.action.versionId, '应有 versionId');
    assert.ok(detail.genres, '应有类型标签');
    assert.ok(detail.cast, '应有演员列表');
    assert.ok(detail.relatedItems, '应有相关推荐');
  });

  await test('loadDetail 无效 link 返回 null', async () => {
    storageData = {};
    const result = await loadDetail('');
    assert.equal(result, null);
  });

  // === loadResource ===
  await test('loadResource 直链直接返回', async () => {
    storageData = {};
    const resources = await loadResource({
      url: 'https://cdn.test.com/direct.mp4',
      versionId: 'test'
    });
    assert.ok(Array.isArray(resources));
    assert.ok(resources.length > 0);
    assert.equal(resources[0].url, 'https://cdn.test.com/direct.mp4');
    assert.ok(resources[0].customHeaders);
    assert.equal(resources[0].playerType, 'app');
  });

  await test('loadResource 通过 versionId 解析', async () => {
    storageData = {};
    // 先加载详情让缓存有数据
    await loadDetail('xg-series:test-series');
    const resources = await loadResource({
      itemId: 'xg-series:test-series',
      episodeId: 'ep1',
      versionId: 'xgplay:key1'
    });
    assert.ok(Array.isArray(resources));
    assert.ok(resources.length > 0);
    assert.ok(resources[0].url);
  });

  // === 工具函数测试 ===
  await test('stringValue 处理各种输入', () => {
    assert.equal(stringValue(null), '');
    assert.equal(stringValue(undefined), '');
    assert.equal(stringValue(' hello '), 'hello');
    assert.equal(stringValue(123), '123');
  });

  await test('yearFrom 提取年份', () => {
    assert.equal(yearFrom('2024-01-01'), 2024);
    assert.equal(yearFrom('发布于2023年'), 2023);
    assert.equal(yearFrom('abc'), undefined);
  });

  await test('imageURL 处理各种格式', () => {
    assert.equal(imageURL('https://example.com/a.jpg'), 'https://example.com/a.jpg');
    assert.equal(imageURL('//example.com/a.jpg'), 'https://example.com/a.jpg');
    assert.equal(imageURL('/api/path.jpg'), 'https://www.xgshort.com/api/path.jpg');
    assert.equal(imageURL(''), undefined);
  });

  await test('positiveInt 数字处理', () => {
    assert.equal(positiveInt('5', 1), 5);
    assert.equal(positiveInt('abc', 10), 10);
    assert.equal(positiveInt(-1, 0), 0);
  });

  await test('formatCount 格式化', () => {
    assert.equal(formatCount(10000), '1万');
    assert.equal(formatCount(12345678), '1234.6万');
    assert.equal(formatCount(500), '500');
    assert.equal(formatCount(0), '');
  });

  // 汇总
  console.log('\n📊 测试结果');
  console.log('  通过:', passed);
  console.log('  失败:', failed);
  console.log('  总计:', passed + failed);

  if (failed > 0) {
    console.error('\n❌ 部分测试失败');
    process.exit(1);
  } else {
    console.log('\n✅ 全部通过');
  }
}

run().catch(e => {
  console.error('❌ 测试异常:', e);
  process.exit(1);
});
