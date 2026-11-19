// Frontier Radar · 前沿模型雷达
//
// 拿一份干净的候选模型池，去撞各个中转站，回答两个问题：
//   哪些模型能用但站点没公布？  → hidden
//   哪些模型公布了但其实不能用？ → broken
//
// 零运行时依赖，只用 Node 内置模块。

const http = require('http');
const fs = require('fs');
const path = require('path');
const pool = require('./pool');
const radar = require('./radar');

const CONFIG_FILE = path.join(__dirname, 'config.local.json');
const EXAMPLE_FILE = path.join(__dirname, 'config.example.json');
const STATE_FILE = path.join(__dirname, 'state.json');

/* ---------------------------------------------------------------- 配置 */

function readConfig() {
  for (const f of [CONFIG_FILE, EXAMPLE_FILE]) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  }
  return { server: {}, scan: {}, sites: [] };
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

// 对外只给脱敏视图
function maskKey(k) {
  if (!k) return '';
  const s = String(k);
  return s.length <= 12 ? '••••' : `${s.slice(0, 5)}…${s.slice(-4)}`;
}

function publicConfig(cfg) {
  return {
    server: cfg.server || {},
    scan: cfg.scan || {},
    sites: (cfg.sites || []).map((s) => ({
      id: s.id,
      name: s.name || s.id,
      baseUrl: s.baseUrl,
      proxy: s.proxy || '',
      kind: s.kind || '',
      hasKey: Boolean(s.apiKey),
      keyHint: maskKey(s.apiKey),
      apiKey: s.apiKey ? '••••••••' : '',
      headers: s.headers || {},
    })),
  };
}

/* ---------------------------------------------------------------- 状态 */

const state = {
  running: false,
  progress: null,
  lastScanAt: null,
  nextScanAt: null,
  results: null,   // 最近一次完整扫描
  error: '',
  startedAt: null,
};

// 上一次结果落盘，重启后不用立刻重扫
function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state.results = j.results || null;
    state.lastScanAt = j.lastScanAt || null;
  } catch {}
}
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      lastScanAt: state.lastScanAt,
      results: state.results,
    }, null, 2), 'utf8');
  } catch {}
}

/* ---------------------------------------------------------------- 矩阵 */

const TAGS = ['hidden', 'listed', 'broken', 'absent', 'nogroup', 'blocked', 'auth', 'limited', 'unknown'];

function buildMatrix(scan) {
  if (!scan) {
    // 还没扫过：仍然把候选池和站点列出来，界面不至于是一片 0
    const cfg = readConfig();
    return {
      models: pool.candidates().map((c) => ({ id: c.id, family: c.family })),
      sites: (cfg.sites || []).filter((s) => s.enabled !== false && s.baseUrl)
        .map((s) => ({ id: s.id, name: s.name || s.id, declaredOk: false, declaredCount: 0 })),
      cells: {},
      counts: {},
      lastScanAt: null,
      nextScanAt: state.nextScanAt,
      running: state.running,
    };
  }

  const models = [];
  const seen = new Set();
  const cells = {};
  const counts = Object.fromEntries(TAGS.map((t) => [t, 0]));

  for (const siteRes of scan.sites) {
    for (const r of siteRes.results) {
      if (!seen.has(r.model)) {
        seen.add(r.model);
        models.push({ id: r.model, family: r.family || '' });
        cells[r.model] = {};
      }
      cells[r.model][siteRes.site] = {
        tag: r.tag,
        text: r.text,
        verdict: r.verdict,
        status: r.status,
        proto: r.proto,
        latencyMs: r.latencyMs,
        declared: r.declared,
        detail: r.detail,
        real: Boolean(r.real),
        tokens: r.tokens ?? null,
      };
      counts[r.tag] = (counts[r.tag] || 0) + 1;
    }
  }

  return {
    models,
    sites: scan.sites.map((s) => ({
      id: s.site,
      name: s.siteName,
      declaredOk: s.declaredOk,
      declaredCount: s.declaredCount,
      declaredStatus: s.declaredStatus,
      declaredError: s.declaredError,
    })),
    cells,
    counts,
    lastScanAt: state.lastScanAt,
    nextScanAt: state.nextScanAt,
    running: state.running,
  };
}

/* ---------------------------------------------------------------- 扫描 */

async function runScan({ deep = null } = {}) {
  if (state.running) return { ok: false, error: '扫描进行中' };
  const cfg = readConfig();
  const sites = (cfg.sites || []).filter((s) => s.enabled !== false && s.baseUrl);
  if (!sites.length) return { ok: false, error: '没有配置站点' };

  const scanCfg = cfg.scan || {};
  const useDeep = deep == null ? Boolean(scanCfg.deep) : Boolean(deep);
  const candidates = pool.candidates();

  state.running = true;
  state.error = '';
  state.startedAt = new Date().toISOString();
  state.progress = { site: null, done: 0, total: sites.length * candidates.length, model: '', tag: '' };

  const siteResults = [];
  let done = 0;
  try {
    for (const site of sites) {
      state.progress.site = site.id;
      const r = await radar.scanSite(site, candidates, {
        timeoutMs: scanCfg.timeoutMs,
        delayMs: scanCfg.delayMs,
        deep: useDeep,
        onProgress: (p) => {
          state.progress.model = p.model;
          state.progress.tag = p.tag;
          state.progress.done = done + p.done;
        },
      });
      siteResults.push(r);
      done += candidates.length;
      state.progress.done = done;
      // 站点之间也留间隔，别让多家同时看到密集流量
      await radar.sleep(radar.jitter(Number(scanCfg.siteGapMs) || 3000));
    }
    state.results = { sites: siteResults, deep: useDeep, at: new Date().toISOString() };
    state.lastScanAt = state.results.at;
    saveState();
    return { ok: true, at: state.lastScanAt };
  } catch (e) {
    state.error = String(e && e.message || e);
    return { ok: false, error: state.error };
  } finally {
    state.running = false;
    state.progress = null;
    scheduleNext();
  }
}

function scheduleNext() {
  const cfg = readConfig();
  const hours = Number((cfg.scan || {}).intervalHours) || 0;
  if (hours <= 0) { state.nextScanAt = null; return; }
  state.nextScanAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

// 每 15 秒看一次该不该自动扫
let ticker = null;
function startTicker() {
  if (ticker) clearInterval(ticker);
  ticker = setInterval(() => {
    if (state.running) return;
    if (!state.nextScanAt) return;
    if (Date.now() >= new Date(state.nextScanAt).getTime()) {
      runScan().catch(() => {});
    }
  }, 15000);
}

/* ---------------------------------------------------------------- 服务 */

const UI = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8');

function json(res, o, code = 200) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(o));
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { if (b.length < limit) b += c; });
    req.on('end', () => resolve(b));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const p = url.pathname;

  if (p === '/' || p === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(UI);
    return;
  }

  if (p === '/api/pool') {
    return json(res, {
      families: pool.FAMILIES,
      count: pool.candidates().length,
      warnings: pool.checkPool(),
    });
  }

  if (p === '/api/config' && req.method === 'GET') {
    return json(res, publicConfig(readConfig()));
  }

  if (p === '/api/config' && req.method === 'POST') {
    const raw = await readBody(req);
    let incoming;
    try { incoming = JSON.parse(raw || '{}'); } catch { return json(res, { ok: false, error: 'JSON 解析失败' }, 400); }

    const cur = readConfig();
    const oldById = Object.fromEntries((cur.sites || []).map((s) => [s.id, s]));

    const sites = (Array.isArray(incoming.sites) ? incoming.sites : cur.sites || [])
      .filter((s) => s && s.id && s.baseUrl)
      .map((s) => {
        const prev = oldById[s.id] || {};
        // 前端提交脱敏占位就沿用旧密钥
        const key = (!s.apiKey || s.apiKey === '••••••••') ? (prev.apiKey || '') : s.apiKey;
        // 额外请求头：很多中转站校验客户端 UA，不带上会一律 403
        let headers = prev.headers || {};
        if (typeof s.headers === 'string') {
          try { headers = JSON.parse(s.headers || '{}'); } catch { headers = prev.headers || {}; }
        } else if (s.headers && typeof s.headers === 'object') {
          headers = s.headers;
        }
        return {
          id: String(s.id).trim(),
          name: s.name || prev.name || s.id,
          baseUrl: String(s.baseUrl).trim(),
          apiKey: key,
          headers,
          proxy: s.proxy || '',
          kind: s.kind || prev.kind || '公益站',
          enabled: s.enabled !== false,
        };
      });

    const cfg = {
      server: { ...(cur.server || {}), ...(incoming.server || {}) },
      scan: { ...(cur.scan || {}), ...(incoming.scan || {}) },
      sites,
    };
    writeConfig(cfg);
    if (!state.running) scheduleNext();
    return json(res, { ok: true, config: publicConfig(cfg) });
  }

  if (p === '/api/scan' && req.method === 'POST') {
    if (state.running) return json(res, { ok: false, error: '扫描进行中' }, 409);
    const deepParam = url.searchParams.get('deep');
    const deep = deepParam == null ? null : deepParam === '1';
    // 立刻返回，前端轮询 /api/status
    runScan({ deep }).catch(() => {});
    return json(res, { ok: true, started: true });
  }

  if (p === '/api/status') {
    const cfg = readConfig();
    return json(res, {
      running: state.running,
      progress: state.progress,
      lastScanAt: state.lastScanAt,
      nextScanAt: state.nextScanAt,
      intervalHours: Number((cfg.scan || {}).intervalHours) || 0,
      deep: Boolean((cfg.scan || {}).deep),
      delayMs: Number((cfg.scan || {}).delayMs) || 1200,
      error: state.error,
      remainingMs: state.nextScanAt ? Math.max(0, new Date(state.nextScanAt).getTime() - Date.now()) : null,
    });
  }

  if (p === '/api/results') {
    return json(res, buildMatrix(state.results));
  }

  if (p === '/api/export') {
    const m = buildMatrix(state.results);
    const lines = ['model,family,' + m.sites.map((s) => s.id).join(',')];
    for (const mo of m.models) {
      const row = [mo.id, mo.family];
      for (const s of m.sites) {
        const c = m.cells[mo.id]?.[s.id];
        row.push(c ? `${c.tag}${c.status ? '/' + c.status : ''}` : '');
      }
      lines.push(row.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(','));
    }
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="frontier-radar-${Date.now()}.csv"`,
    });
    res.end('\ufeff' + lines.join('\n'));
    return;
  }

  json(res, { error: 'not found' }, 404);
});

/* ---------------------------------------------------------------- 启动 */

loadState();
const cfg = readConfig();
const PORT = Number(process.env.RADAR_PORT || (cfg.server || {}).port || 5199);
const HOST = process.env.RADAR_HOST || (cfg.server || {}).host || '127.0.0.1';

if (state.lastScanAt) scheduleNext();

server.listen(PORT, HOST, () => {
  const c = pool.candidates().length;
  const sites = (readConfig().sites || []).length;
  const warn = pool.checkPool();
  console.log(`FrontierRadar on http://${HOST}:${PORT}  (候选 ${c} 个 / 站点 ${sites} 个)`);
  if (warn.length) console.log(`⚠ 候选池里疑似带参数后缀：${warn.join(', ')}`);
  startTicker();
});
