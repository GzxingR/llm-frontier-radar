// 候选池：只放「广义上好用的模型」基础名。
//
// 规则（硬约束）：
//   1. 不带任何参数后缀 —— 不加 -1017、@256k、-fast、-cc-format、-preview、-flash-0828 这类修饰
//   2. 只写模型的正式基础名，同名跨版本靠家族归类区分
//   3. 想加的模型直接往对应家族里加一行即可，不用改代码逻辑
//
// 为什么固定：雷达的意义是「拿一份干净的候选去撞站」。
// 如果池子跟着站点名单长大，就永远只能发现站点已经公布的东西，失去意义。

const FAMILIES = [
  {
    name: 'OpenAI',
    models: [
      'gpt-6.1-sol',
      'gpt-6-astra',
      'gpt-6-luna',
      'gpt-6.1-terra',
      'gpt-5.6-sol',
    ],
  },
  {
    name: 'Anthropic',
    models: [
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-fable-5-2',
      'claude-haiku-5-5',
    ],
  },
  {
    name: 'Google',
    models: [
      'gemini-4-argon',
      'gemini-4-carbon',
      'gemini-3-8-flash',
    ],
  },
  {
    name: 'xAI',
    models: [
      'grok-4.7',
      'grok-4.6',
      'grok-4.5',
    ],
  },
  {
    name: 'DeepSeek',
    models: [
      'deepseek-v4.1-flash',
      'deepseek-v4.1',
      'deepseek-v4-pro',
    ],
  },
  {
    name: '国产',
    models: [
      'kimi-k3',
      'kimi-k3-1-pro',
      'glm-5.3',
      'glm-5.3-flash',
      'minimax-m3',
    ],
  },
];

// 展平成一维候选列表，同时保留每个模型属于哪个家族
function candidates() {
  const out = [];
  for (const f of FAMILIES) {
    for (const m of f.models) out.push({ id: m, family: f.name });
  }
  return out;
}

// 参数后缀检测：用来在启动时提醒「池子里混进了带参数的写法」
const PARAM_HINT = /@\d|-\d{3,}$|-(fast|preview|cc-format|free|lite|mini-v\d)$/i;

function checkPool() {
  const bad = [];
  for (const c of candidates()) {
    if (PARAM_HINT.test(c.id)) bad.push(c.id);
  }
  return bad;
}

module.exports = { FAMILIES, candidates, checkPool, PARAM_HINT };
