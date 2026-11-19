// 雷达核心：拿候选池去撞站点，判断「站点了没说自己有这个模型」。
//
// 三级探测（成本递增）：
//   L1 存在性   空 messages 打 chat/completions，让参数校验拦下 —— 0 token
//   L2 协议自适应 L1 若说「本接口已停用」，自动换 /v1/responses 再试 —— 0 token
//   L3 真实性   max_tokens=1 的真实小请求 —— 会花 token，默认关闭
//
// 判定原则：只有拿到明确的 model_not_found 才算「不存在」。
// 429 / 超时 / 别的 400 一律记「待确认」，不冤枉可用的模型。

const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const zlib = require('zlib');

/* ---------------------------------------------------------------- 请求 */

function nodeJson(urlStr, { method = 'GET', headers = {}, body = null, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch { return resolve({ status: 0, body: 'bad url', latencyMs: 0 }); }
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = { 'Accept-Encoding': 'gzip, deflate, br', ...headers };
    if (data) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    const t0 = Date.now();
    const req = lib.request({
      host: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: h,
      timeout: timeoutMs,
      rejectUnauthorized: true,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size < 2 * 1024 * 1024) chunks.push(c); });
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        const done = (buf) => resolve({ status: res.statusCode, body: buf.toString('utf8'), latencyMs: Date.now() - t0 });
        try {
          if (enc === 'gzip') return zlib.gunzip(raw, (e, out) => done(e ? raw : out));
          if (enc === 'deflate') return zlib.inflate(raw, (e, out) => done(e ? raw : out));
          if (enc === 'br') return zlib.brotliDecompress(raw, (e, out) => done(e ? raw : out));
        } catch {}
        done(raw);
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout', latencyMs: Date.now() - t0 }); });
    req.on('error', (e) => resolve({ status: 0, body: e.message, latencyMs: Date.now() - t0 }));
    if (data) req.write(data);
    req.end();
  });
}

// 站点要走代理时用 curl，它处理 CONNECT 隧道和证书怪癖稳得多
function curlJson(urlStr, { method = 'GET', headers = {}, body = null, timeoutMs = 30000, proxy } = {}) {
  return new Promise((resolve) => {
    const sec = Math.max(1, Math.round(timeoutMs / 1000));
    const args = ['-sS', '--ssl-no-revoke', '--compressed', '-m', String(sec), '-w', '\n%{http_code}'];
    if (proxy) args.unshift('-x', proxy); else args.unshift('--noproxy', '*');
    if (method !== 'GET') args.push('-X', method);
    for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    if (data != null) args.push('--data-binary', data);
    args.push(urlStr);

    const t0 = Date.now();
    execFile('curl.exe', args, { timeout: timeoutMs + 5000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        const s = String(stdout || '');
        const i = s.lastIndexOf('\n');
        const status = i >= 0 ? Number(s.slice(i + 1).trim()) || 0 : 0;
        resolve({ status, body: i >= 0 ? s.slice(0, i) : s, latencyMs: Date.now() - t0 });
      });
  });
}

function isWindowsCurl() {
  return process.platform === 'win32';
}

function request(urlStr, opts = {}) {
  if (opts.proxy && isWindowsCurl()) return curlJson(urlStr, opts);
  return nodeJson(urlStr, opts);
}

/* ---------------------------------------------------------------- 判定 */

const RX = {
  // 本接口被站点停用，要换 Responses
  chatDisabled: /chat_completions_disabled|已停用\s*\/v1\/chat\/completions|has no URL for|请改用\s*\/v1\/responses/i,
  // 本 key 的分组里没有这个模型（不等于站没有）
  noGroup: /not supported by any configured account|not supported in this group|分组|分组不|无权访问/i,
  // 明确的「模型不存在」
  notFound: /model_not_found|model not found|invalid model|does not exist|unsupported model|模型不存在|不存在的模型/i,
  // 参数校验拦下 —— 注意：这只能说明请求体形状被拒，不证明模型存在
  paramRejected: /messages.*(required|non-empty|empty|must)|messages can not be empty|field messages is required|input.*(required|empty|must)/i,
  // 站点用 200 回一句「客户端不支持」的假成功，必须单独识别
  softBlock: /本站仅限|当前客户端不支持|client_not_allowed|仅支持.{0,8}客户端|仅支持编程客户端|freeblock|client_not_support/i,
  // 路径不存在（base URL 配错了），不是模型问题
  badPath: /Invalid URL \(POST|Invalid URL \(GET|not found \(POST/i,
  // 阿里云 ESA 之类的前置 WAF 会回 HTML+JS 挑战，HTTP 却是 200
  waf: /^\s*<(!doctype|html)|var arg1=|acw_sc__v2|__jsl_clearance/i,
};

// 只有 exists===true 且 strong===true 才叫「确实可用」。
// 200 但内容是拒绝话术 → 客户端被拦；400 但只校验消息体 → 证据不足，标疑似。
function judge(status, text, model) {
  const t = String(text || '');
  const mentionsModel = model ? t.toLowerCase().includes(String(model).toLowerCase()) : false;

  if (status === 0) return { exists: null, strong: false, state: 'unknown', verdict: '待确认', detail: '超时或网络错误，无结论' };

  // WAF 挑战页不是模型响应，任何状态码下都要先排除
  if (RX.waf.test(t)) return { exists: null, strong: false, state: 'waf', verdict: '被 WAF 拦', detail: '返回的是 HTML/JS 挑战页，需要换出口 IP 或走代理' };

  if (status === 200) {
    if (RX.softBlock.test(t)) {
      return { exists: null, strong: false, state: 'clientblock', verdict: '客户端被拦', detail: '200 但返回的是拒绝话术，不是模型输出' };
    }
    let content = '';
    try {
      const j = JSON.parse(t);
      content = j.choices?.[0]?.message?.content || j.output_text || '';
    } catch {}
    if (String(content).trim()) {
      return { exists: true, strong: true, state: 'ok', verdict: '可用', detail: '真实返回内容' };
    }
    return { exists: null, strong: false, state: 'unknown', verdict: '待确认', detail: '200 但无内容' };
  }

  if (status === 401) return { exists: null, strong: false, state: 'auth', verdict: '密钥失效', detail: '鉴权失败' };
  if (status === 402) return { exists: true, strong: true, state: 'paid', verdict: '需付费', detail: '模型存在但不在当前额度/免费档内' };
  if (status === 403) return { exists: null, strong: false, state: 'blocked', verdict: '无权限', detail: t.slice(0, 200) };
  if (status === 429) return { exists: null, strong: false, state: 'limited', verdict: '限流', detail: '触达速率或额度限制' };
  if (status === 413) return { exists: null, strong: false, state: 'unknown', verdict: '待确认', detail: '请求体过大，与模型无关' };
  if (status >= 500) return { exists: null, strong: false, state: 'unknown', verdict: '待确认', detail: `上游 ${status}` };

  if (/not part of the free tier|not in the free tier|insufficient|quota exceeded|余额不足|需付费|订阅/i.test(t) && status !== 200) {
    return { exists: true, strong: true, state: 'paid', verdict: '需付费', detail: '模型存在但当前额度不足' };
  }

  if (status === 400 || status === 404 || status === 422) {
    if (RX.chatDisabled.test(t)) return { exists: null, strong: false, state: 'needResponses', verdict: '需 Responses', detail: '本站停用了 chat 接口' };
    if (RX.softBlock.test(t)) return { exists: null, strong: false, state: 'clientblock', verdict: '客户端被拦', detail: t.slice(0, 200) };
    if (RX.badPath.test(t)) return { exists: null, strong: false, state: 'badpath', verdict: '路径不存在', detail: 'base URL 可能填错' };
    if (RX.noGroup.test(t)) return { exists: null, strong: false, state: 'nogroup', verdict: '分组没有', detail: t.slice(0, 200) };
    if (RX.notFound.test(t)) return { exists: false, strong: true, state: 'absent', verdict: '不存在', detail: t.slice(0, 200) };
    if (RX.paramRejected.test(t)) {
      // 报错提到模型名才算强证据；只报 messages 形状问题的，不能证明模型存在
      return mentionsModel
        ? { exists: true, strong: true, state: 'exists', verdict: '存在', detail: '模型级参数校验拦下' }
        : { exists: true, strong: false, state: 'weak', verdict: '疑似可用', detail: '仅请求体校验被拒，需 L3 确认' };
    }
    if (/bad response status code|upstream|origin/i.test(t)) {
      return { exists: true, strong: false, state: 'weak', verdict: '疑似可用', detail: '上游已响应（嵌套错误）' };
    }
    return { exists: null, strong: false, state: 'unknown', verdict: '待确认', detail: t.slice(0, 200) };
  }
  return { exists: null, strong: false, state: 'unknown', verdict: `HTTP ${status}`, detail: t.slice(0, 200) };
}

/* ---------------------------------------------------------------- 单站 */

function baseOf(site) {
  return String(site.baseUrl || '').replace(/\/+$/, '');
}

// 站点级请求头。很多中转站会校验客户端 UA（只允许 Codex / Claude Code 等），
// 不带上就一律 403 client_not_allowed，这跟模型是否存在无关。
function headersOf(site) {
  const h = { ...(site.headers || {}) };
  if (site.apiKey) h.Authorization = `Bearer ${site.apiKey}`;
  if (!h['User-Agent'] && !h['user-agent']) {
    h['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
  }
  return h;
}

async function fetchDeclared(site, timeoutMs) {
  const base = baseOf(site);
  const out = { ok: false, models: [], status: 0, error: '' };
  for (const suffix of ['/models', '/v1/models']) {
    const url = /\/v1$/.test(base) && suffix === '/v1/models' ? null : base + suffix;
    if (!url) continue;
    const r = await request(url, {
      headers: headersOf(site),
      timeoutMs,
      proxy: site.proxy,
    });
    if (r.status === 200) {
      try {
        const j = JSON.parse(r.body);
        const rows = j.data || j.models || (Array.isArray(j) ? j : []);
        out.models = rows.map((m) => String(m.id || m.name || m).replace(/^models\//, '')).filter(Boolean);
        out.ok = true;
        out.status = 200;
        return out;
      } catch { out.error = '模型列表不是 JSON'; }
    } else {
      out.status = r.status;
      out.error = String(r.body || '').slice(0, 160);
    }
  }
  return out;
}

// L1 + L2
async function probePresence(site, model, timeoutMs) {
  const base = baseOf(site);
  const headers = headersOf(site);

  const l1 = await request(base + '/chat/completions', {
    method: 'POST', headers, timeoutMs, proxy: site.proxy,
    body: { model, messages: [], max_tokens: 1 },
  });
  let j = judge(l1.status, l1.body, model);
  if (j.state !== 'needResponses') {
    return { ...j, proto: 'chat', status: l1.status, latencyMs: l1.latencyMs };
  }

  // L2：站点停用了 chat，换 Responses
  const l2 = await request(base + '/responses', {
    method: 'POST', headers, timeoutMs, proxy: site.proxy,
    body: { model, input: [], max_output_tokens: 1 },
  });
  const j2 = judge(l2.status, l2.body, model);
  return {
    ...j2,
    proto: 'responses',
    status: l2.status,
    latencyMs: l2.latencyMs,
    detail: j2.state === 'unknown' ? `chat 已停用；responses: ${j2.detail}` : j2.detail,
  };
}

// L3：真实小请求，会花 token
async function probeReal(site, model, timeoutMs) {
  const base = baseOf(site);
  const headers = headersOf(site);
  const r = await request(base + '/chat/completions', {
    method: 'POST', headers, timeoutMs, proxy: site.proxy,
    body: { model, messages: [{ role: 'user', content: '.' }], max_tokens: 1 },
  });
  let usage = null;
  let content = '';
  if (r.status === 200) {
    try {
      const j = JSON.parse(r.body);
      usage = j.usage || null;
      content = j.choices?.[0]?.message?.content || j.output_text || '';
    } catch {}
  }
  const j = judge(r.status, r.body, model);
  return {
    ...j,
    proto: 'chat',
    real: true,
    status: r.status,
    latencyMs: r.latencyMs,
    tokens: usage ? (usage.prompt_tokens || 0) + (usage.completion_tokens || 0) : null,
    content: String(content).slice(0, 60),
  };
}

/* ---------------------------------------------------------------- 差异 */

// 把「站点的宣称」和「探针看到的」做差集，得到最终标签
function labelOf(declared, probe) {
  if (probe.state === 'paid') return { tag: 'paid', text: '需付费' };
  if (probe.exists === true) {
    if (probe.strong === false) return { tag: 'weak', text: '疑似可用' };
    return declared
      ? { tag: 'listed', text: '已公布可用' }
      : { tag: 'hidden', text: '隐藏可用' };
  }
  if (probe.exists === false) {
    return declared
      ? { tag: 'broken', text: '公布但坏' }
      : { tag: 'absent', text: '不存在' };
  }
  if (probe.state === 'waf') return { tag: 'waf', text: '被 WAF 拦' };
  if (probe.state === 'clientblock') return { tag: 'clientblock', text: '客户端被拦' };
  if (probe.state === 'badpath') return { tag: 'badpath', text: '路径不存在' };
  if (probe.state === 'nogroup') return { tag: 'nogroup', text: '分组没有' };
  if (probe.state === 'blocked') return { tag: 'blocked', text: '无权限' };
  if (probe.state === 'auth') return { tag: 'auth', text: '密钥失效' };
  if (probe.state === 'limited') return { tag: 'limited', text: '限流' };
  return { tag: 'unknown', text: '待确认' };
}

/* ---------------------------------------------------------------- 扫描 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jitter(baseMs, ratio = 0.4) {
  const d = baseMs * ratio;
  return Math.max(0, Math.round(baseMs - d + Math.random() * d * 2));
}

// 单站扫描：串行 + 间隔抖动，避免被 WAF 当成扫描器
async function scanSite(site, poolModels, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || 30000;
  const delayMs = Number(opts.delayMs) || 1200;
  const deep = Boolean(opts.deep);
  const onProgress = opts.onProgress || (() => {});

  const declaredRes = await fetchDeclared(site, timeoutMs);
  const declared = new Set(declaredRes.models.map((m) => m.toLowerCase()));

  const results = [];
  let i = 0;
  for (const c of poolModels) {
    i++;
    let probe;
    try {
      probe = await probePresence(site, c.id, timeoutMs);
    } catch (e) {
      probe = { exists: null, state: 'unknown', verdict: '待确认', detail: String(e), proto: 'chat', status: 0, latencyMs: 0 };
    }

    // L3 只补测「疑似可用」的那些（L1 只拿到请求体校验错误），已经强证据的不再花钱
    if (deep && probe.exists === true && probe.strong === false && !probe.real) {
      const real = await probeReal(site, c.id, timeoutMs);
      probe = { ...probe, ...real, detail: real.detail || probe.detail };
      await sleep(jitter(delayMs));
    }

    const isDeclared = declared.has(c.id.toLowerCase());
    const label = labelOf(isDeclared, probe);

    results.push({
      model: c.id,
      family: c.family,
      declared: isDeclared,
      ...probe,
      ...label,
      at: new Date().toISOString(),
    });

    onProgress({ site: site.id, done: i, total: poolModels.length, model: c.id, tag: label.tag });

    if (i < poolModels.length) await sleep(jitter(delayMs));
  }

  return {
    site: site.id,
    siteName: site.name || site.id,
    declaredOk: declaredRes.ok,
    declaredCount: declaredRes.models.length,
    declaredStatus: declaredRes.status,
    declaredError: declaredRes.error,
    results,
    at: new Date().toISOString(),
  };
}

module.exports = {
  request, judge, labelOf, headersOf,
  fetchDeclared, probePresence, probeReal,
  scanSite, jitter, sleep, baseOf, RX,
};
