import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers, FetchRequest } from "ethers";
import { privateKeyToAccount } from "viem/accounts";
import axios from "axios";
import { solveChallenge, pbkdf2 } from "altcha/lib";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ACCOUNTS_FILE = "accounts.json";
const PV_FILE = "pv.txt";
const PROXY_FILE = "proxy.txt";
const GROQ_FILE = "groq.txt";
const TXHASH_FILE = "txhashes.json";
const FAUCET_COOLDOWN_FILE = "faucet_cooldowns.json";
const IP_COOLDOWN_FILE = "ip_cooldowns.json";

const API_BASE = "https://rewards.svpstars.com/api/v1";
const FAUCET_ENDPOINT = "https://www.svpchain.org/api/claim";
const ALTCHA_BASE = "https://www.svpchain.org/api/altcha/challenge";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const EXPLORER = "https://explorer.svpchain.com/tx";
const EXPLORER_API = "https://explorer.svpchain.com/api";

const CHAIN_ID = 2517;
const RPC_URLS = [
  process.env.RPC_URL || "https://svp-dataseed1-testnet.svpchain.org",
  "https://svp-dataseeds-testnet.svpchain.org",
].filter(Boolean);

const MIN_GAS_PRICE = ethers.parseUnits("2", "gwei");

const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const GROQ_FALLBACK = process.env.GROQ_FALLBACK || "openai/gpt-oss-20b";
const INVITE_CODE = process.env.INVITE_CODE || "UWTL68DI";

const LENDORA_MAX_SUPPLY = process.env.LENDORA_MAX_SUPPLY || "10";

const ROUTER_ADDRESS = "0xfe7bf2dfd5cb268c6779f1f614638a436cb701e4";
const WSVP_ADDRESS = "0x771a0a63d8198b7dbea4a16910ff68ab38006531";
const SWAP_SLIPPAGE_PCT = BigInt(process.env.SLIPPAGE_PERCENT || "20");
const SWAP_AMOUNT_PER_LEG = ethers.parseEther(process.env.SWAP_SVP_PER_LEG || "0.008");
const SWAP_MIN_RESERVE = ethers.parseEther("0.005");

const SWAP_LEGS = [
  { from: "WSVP", to: "USDC", amount: SWAP_AMOUNT_PER_LEG },
  { from: "WSVP", to: "WETH", amount: SWAP_AMOUNT_PER_LEG },
  { from: "WSVP", to: "WBTC", amount: SWAP_AMOUNT_PER_LEG },
];

const TOKENS = {
  WSVP: WSVP_ADDRESS,
  USDC: "0x732f6ea7afd5edc02e7ba052075dd0780e285489",
  USDV: "0x013a61e622e6abfcab64f52d274c3fc0aa37f951",
  WETH: "0x1c12dbda863900c680a3836c53d408feaf63f0ba",
  WBTC: "0x6c22ceb0852bd7781b57574aaa5de0f22cd44162",
  WBNB: "0x8787384b8640f6e9c30e94585d3d62b03f80a5df",
};

const CTOKENS = {
  USDC: { cToken: "0xC647A36ea112109E6B341399f665F10cEaEecEC3", underlying: "0x732F6Ea7AfD5EdC02e7ba052075dd0780e285489", decimals: 6 },
  WBTC: { cToken: "0x6653b238548927c15A5dd2046af15C88018BF1aa", underlying: "0x6C22ceB0852bd7781B57574aAA5De0F22cd44162", decimals: 8 },
  WBNB: { cToken: "0x668cC3523050cd8ef48e0fd1210F32013E630612", underlying: "0x8787384B8640f6E9c30E94585d3d62b03F80a5Df", decimals: 18 },
};

const BRIDGE_CONTRACT = "0xC2C7f43735C4bEC84eABbcce32bDA269c2c75f20";
const BRIDGE_FUNCTION_SELECTOR = "0x8d1a0e7d";
const BRIDGE_DEST_CHAIN_ID = 421614;
const BRIDGE_DST_TOKEN = "0x7a8ecfa70374c1b8702cb98aaf23de19675981d6";
const BRIDGE_AMOUNT_MIN = ethers.parseEther(process.env.BRIDGE_MIN_SVP || "0.1");
const BRIDGE_AMOUNT_MAX = ethers.parseEther(process.env.BRIDGE_MAX_SVP || "0.15");
const BRIDGE_MIN_NATIVE_RESERVE = ethers.parseEther("0.02");
const BRIDGE_VERIFY_WAIT_MS = 90_000;

const FAUCET_TOKENS = [
  { symbol: "SVP", address: "0x0000000000000000000000000000000000000000" },
  { symbol: "USDV", address: "0x013a61E622e6ABFCaB64F52D274C3Fc0aA37f951" },
  { symbol: "USDC", address: "0x732f6ea7afd5edc02e7ba052075dd0780e285489" },
  { symbol: "WBTC", address: "0x6c22ceb0852bd7781b57574aaa5de0f22cd44162" },
  { symbol: "WBNB", address: "0x8787384b8640f6e9c30e94585d3d62b03f80a5df" },
];

const INTER_TOKEN_DELAY = 10_000;
const RETRY_WAIT_SERVER_ERR = 15_000;
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
const MAX_CLAIM_ATTEMPTS = 3;
const MAX_ALTCHA_ATTEMPTS = 3;
const ALTCHA_SOLVE_TIMEOUT_MS = 45_000;
const FAUCET_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const RPC_CALL_TIMEOUT_MS = 15_000;

const args = process.argv.slice(2);
const getArg = (name, fb = null) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fb; };
const hasFlag = (name) => args.includes(name);

const DRY_RUN = hasFlag("--dry");
const DO_LEND = !hasFlag("--no-lend");
const DO_BRIDGE = !hasFlag("--no-bridge");
const DO_SWAP = !hasFlag("--no-swap");
const RUN_ONCE = hasFlag("--once");
const NO_SHUFFLE = hasFlag("--no-shuffle");
const THREADS = Math.max(1, Number.parseInt(getArg("--threads", "10"), 10));
const IP_COOLDOWN_SEC = Number.parseInt(getArg("--ip-cooldown", "3600"), 10);
const IP_COOLDOWN_MS = DRY_RUN ? 5000 : (IP_COOLDOWN_SEC * 1000);
const RESET_HOUR = Number.parseInt(getArg("--reset-hour", "0"), 10);
const ONLY_ADDR = (getArg("--only", "") || "").toLowerCase() || null;

const JITTER_MIN = 800;
const JITTER_MAX = 2500;
const COOLDOWN_BETWEEN_ACCOUNTS = 30_000;

const SKIP_ACTIONS = new Set([
  "bind_x", "x_follow", "tg_join", "discord_join", "tweet",
  "contract_deploy",
]);

const C = {
  reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m",
  yellow: "\x1b[33m", cyan: "\x1b[36m", magenta: "\x1b[35m",
  blue: "\x1b[34m", bold: "\x1b[1m", dim: "\x1b[2m",
};
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (...a) => console.log(`[${stamp()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => sleep(JITTER_MIN + Math.random() * (JITTER_MAX - JITTER_MIN));

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/139.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 OPR/116.0.0.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Vivaldi/6.9",
];

const randUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const baseHeaders = (extra = {}) => ({
  "accept": "*/*",
  "accept-language": "en-GB,en;q=0.9",
  "user-agent": randUA(),
  ...extra,
});

function readText(file) {
  const p = path.isAbsolute(file) ? file : path.join(__dirname, file);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8");
}

function loadJson(file, fallback) {
  const t = readText(file);
  if (t == null) return fallback;
  try { return JSON.parse(t); }
  catch (e) { throw new Error(`${file} is not valid JSON: ${e.message}`); }
}

function saveJson(file, data) {
  const p = path.isAbsolute(file) ? file : path.join(__dirname, file);
  const tmp = p + "." + process.pid + "." + Date.now() + "." + Math.random().toString(36).slice(2) + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, p);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { }
  }
}

function loadGroqKey() {
  const t = readText(GROQ_FILE);
  if (!t) return "";
  const key = t.trim().split(/\s+/)[0];
  return key.startsWith("gsk_") ? key : "";
}

function loadProxies() {
  const t = readText(PROXY_FILE);
  if (!t) return [];
  const lines = t.split(/\r?\n/);
  const proxies = [];
  for (const raw of lines) {
    const p = raw.trim();
    if (!p || p.startsWith("#")) continue;
    proxies.push(p);
  }
  return proxies;
}

const AGENT_CACHE = new Map();
function getProxyAgent(proxyUrl) {
  if (!proxyUrl) return null;
  if (AGENT_CACHE.has(proxyUrl)) return AGENT_CACHE.get(proxyUrl);
  let agent;
  try {
    if (proxyUrl.startsWith("socks")) {
      agent = new SocksProxyAgent(proxyUrl);
    } else {
      agent = new HttpsProxyAgent(proxyUrl);
    }
    AGENT_CACHE.set(proxyUrl, agent);
    return agent;
  } catch (e) {
    log(`${C.yellow}⚠️  Failed to create agent for proxy ${proxyUrl}: ${e.message}${C.reset}`);
    return null;
  }
}

function shuffleArray(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function loadAccounts(proxies = []) {
  const out = [];
  const seenAddrs = new Set();

  // 1. Try reading private keys from pv.txt (one per line)
  const pvText = readText(PV_FILE);
  if (pvText && pvText.trim()) {
    const lines = pvText.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i].trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith('"') && line.endsWith('"')) line = line.slice(1, -1);
      if (line.startsWith("'") && line.endsWith("'")) line = line.slice(1, -1);
      line = line.trim();
      if (!line.startsWith("0x")) line = "0x" + line;
      if (!/^0x[0-9a-fA-F]{64}$/.test(line)) {
        log(`${C.yellow}⚠️  [${PV_FILE}] Line ${i + 1}: invalid private key hex (must be 64 hex chars). Skipping.${C.reset}`);
        continue;
      }
      try {
        const account = privateKeyToAccount(line);
        const lowerAddr = account.address.toLowerCase();
        if (ONLY_ADDR && lowerAddr !== ONLY_ADDR) continue;
        if (seenAddrs.has(lowerAddr)) {
          log(`${C.yellow}⚠️  [${PV_FILE}] Line ${i + 1}: duplicate address ${account.address} already loaded. Skipping duplicate.${C.reset}`);
          continue;
        }
        seenAddrs.add(lowerAddr);
        const proxy = proxies.length > 0 ? proxies[out.length % proxies.length] : null;
        out.push({
          label: `Account #${out.length + 1}`,
          address: account.address,
          privateKey: line,
          proxy,
        });
      } catch (e) {
        log(`${C.yellow}⚠️  [${PV_FILE}] Line ${i + 1}: failed to derive account (${e.message}). Skipping.${C.reset}`);
      }
    }
  }

  // 2. Fallback to accounts.json if no keys were found in pv.txt
  if (out.length === 0) {
    const raw = loadJson(ACCOUNTS_FILE, null);
    if (Array.isArray(raw) && raw.length > 0) {
      for (let i = 0; i < raw.length; i++) {
        const a = raw[i];
        const label = a.label || `#${i + 1}`;
        let pk = a.privateKey;
        if (!pk || typeof pk !== "string") continue;
        pk = pk.trim();
        if (!pk.startsWith("0x")) pk = "0x" + pk;
        if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) continue;
        const account = privateKeyToAccount(pk);
        if (a.address && a.address.toLowerCase() !== account.address.toLowerCase()) continue;
        if (ONLY_ADDR && account.address.toLowerCase() !== ONLY_ADDR) continue;
        const proxy = proxies.length > 0 ? proxies[out.length % proxies.length] : null;
        out.push({ label, address: account.address, privateKey: pk, proxy });
      }
    }
  }

  if (out.length === 0) throw new Error(`No valid accounts found in ${PV_FILE} or ${ACCOUNTS_FILE}.`);
  return out;
}

const TXHASHES = (() => {
  const data = loadJson(TXHASH_FILE, {}) || {};
  return {
    data,
    get: (w, k) => data[w.toLowerCase()]?.[k] ?? null,
    has: (w, k) => !!data[w.toLowerCase()]?.[k],
    set(w, k, v) {
      const key = w.toLowerCase();
      data[key] = data[key] || {};
      data[key][k] = v;
      saveJson(TXHASH_FILE, data);
    },
    clearFaucetKeys(wallet) {
      const key = wallet.toLowerCase();
      if (!data[key]) return 0;
      let removed = 0;
      for (const k of Object.keys(data[key])) {
        if (k.startsWith("faucet_")) {
          delete data[key][k];
          removed++;
        }
      }
      if (removed > 0) saveJson(TXHASH_FILE, data);
      return removed;
    },
  };
})();

const FAUCET_COOLDOWNS = (() => {
  const data = loadJson(FAUCET_COOLDOWN_FILE, {}) || {};
  return {
    data,
    get: (wallet, token) => data[wallet.toLowerCase()]?.[token.toLowerCase()] ?? 0,
    set(wallet, token, ts) {
      const w = wallet.toLowerCase();
      const t = token.toLowerCase();
      data[w] = data[w] || {};
      data[w][t] = ts;
      saveJson(FAUCET_COOLDOWN_FILE, data);
    },
    isFresh(wallet, token) {
      return Date.now() - this.get(wallet, token) < FAUCET_COOLDOWN_MS;
    },
  };
})();

const IP_COOLDOWNS = (() => {
  const data = loadJson(IP_COOLDOWN_FILE, {}) || {};
  return {
    data,
    getRemaining(ipKey) {
      const record = data[ipKey];
      if (!record || !record.lastUsed) return 0;
      const elapsed = Date.now() - record.lastUsed;
      return Math.max(0, IP_COOLDOWN_MS - elapsed);
    },
    isAvailable(ipKey) {
      return this.getRemaining(ipKey) === 0;
    },
    markUsed(ipKey, walletAddress) {
      data[ipKey] = {
        lastUsed: Date.now(),
        walletAddress: (walletAddress || "").toLowerCase(),
        availableAt: new Date(Date.now() + IP_COOLDOWN_MS).toISOString(),
      };
      saveJson(IP_COOLDOWN_FILE, data);
    },
  };
})();

class IpChannelPool {
  constructor(proxies = []) {
    if (!proxies || proxies.length === 0) {
      this.channels = [
        { id: 0, key: "direct", proxy: null, label: "Direct IP", inUse: false }
      ];
    } else {
      this.channels = proxies.map((p, i) => {
        const masked = p.replace(/:\/\/[^:]+:[^@]+@/, "://***:***@");
        return {
          id: i + 1,
          key: p,
          proxy: p,
          label: `Proxy #${i + 1} (${masked})`,
          inUse: false,
        };
      });
    }
  }

  getChannelCount() {
    return this.channels.length;
  }

  isDirect() {
    return this.channels.length === 1 && this.channels[0].proxy === null;
  }

  async acquire(workerId, accountLabel) {
    let lastLoggedSec = 0;
    while (true) {
      for (const ch of this.channels) {
        if (!ch.inUse && IP_COOLDOWNS.isAvailable(ch.key)) {
          ch.inUse = true;
          return ch;
        }
      }

      let shortestWait = Infinity;
      let nextAvailableCh = null;
      for (const ch of this.channels) {
        if (ch.inUse) continue;
        const rem = IP_COOLDOWNS.getRemaining(ch.key);
        if (rem > 0 && rem < shortestWait) {
          shortestWait = rem;
          nextAvailableCh = ch;
        }
      }

      if (shortestWait === Infinity) {
        await sleep(3000);
        continue;
      }

      const waitSec = Math.ceil(shortestWait / 1000);
      if (Math.abs(waitSec - lastLoggedSec) > 60 || lastLoggedSec === 0) {
        lastLoggedSec = waitSec;
        const targetLabel = nextAvailableCh ? nextAvailableCh.label : "IP";
        log(`⏳ [Worker #${workerId}] ${this.isDirect() ? "Direct IP in 1-hour cooldown" : "All available proxy IPs in 1-hour cooldown"}. Next available (${targetLabel}) in ${fmtDuration(shortestWait)}. Sleeping…`);
      }

      const step = Math.min(shortestWait, 10_000);
      await sleep(step);
    }
  }

  release(ch, walletAddress) {
    if (ch) {
      ch.inUse = false;
      if (ch.key) {
        IP_COOLDOWNS.markUsed(ch.key, walletAddress);
      }
    }
  }
}

async function httpJson(method, url, { headers, body, agent } = {}) {
  const reqConfig = {
    method, url,
    headers: baseHeaders(headers),
    data: body,
    timeout: 30000,
    validateStatus: () => true,
  };
  if (agent) {
    reqConfig.httpAgent = agent;
    reqConfig.httpsAgent = agent;
  }
  const res = await axios.request(reqConfig);
  return { status: res.status, data: res.data };
}

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const CTOKEN_ABI = [
  "function mint(uint256 mintAmount) returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

const ROUTER_ABI = [
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
  "function WETH() external view returns (address)",
  "function WSVP() external view returns (address)",
];

const WSVP_ABI = [
  "function deposit() payable",
  "function withdraw(uint)",
  "function balanceOf(address) view returns (uint)",
];

function extractRevertReason(error) {
  if (error?.reason) return error.reason;
  if (error?.shortMessage) return error.shortMessage;
  if (error?.info?.error?.message) return error.info.error.message;
  return error?.message || "revert (no reason)";
}

async function safeGetBalance(provider, address) {
  try { return await provider.getBalance(address); }
  catch { return null; }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

const SVP_SYSTEM_PROMPT = `You are a precise multiple-choice quiz solver for SVP Chain — a crypto L1 focused on AI-native trading.

TOPICS:
- SVP Chain has Testnet (chainId 2517) and Mainnet (chainId 2518, rolling out).
- Public RPCs: svp-dataseed1-testnet.svpchain.org, svp-dataseeds-testnet.svpchain.org.
- Explorer: explorer.svpchain.com (Blockscout fork).
- Tooling: NovaSwap (DEX), Lendora (lending), SVP Bridge, SVP Faucet.
- Min gas: 2 Gwei.

RULES:
- Return ONLY a single integer: the 0-based index of the correct option.
- Do NOT write a letter, the option text, or any explanation.
- Do NOT add punctuation, quotes, spaces, or newlines.`;

class QuizSolver {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.enabled = !!apiKey && apiKey.startsWith("gsk_");
    this.cache = new Map();
  }
  isEnabled() { return this.enabled; }

  _buildPrompt(q) {
    const opts = (q.options || []).map((label, i) => `  [${i}] ${label}`).join("\n");
    return `Question:\n${q.question}\n\nOptions:\n${opts}\n\nReturn the 0-based index:`;
  }

  _extractIndex(text, maxIndex) {
    if (text == null) return null;
    const cleaned = String(text).trim().toLowerCase();
    const strict = cleaned.match(/^(\d+)\b/);
    if (strict) {
      const n = Number.parseInt(strict[1], 10);
      if (Number.isInteger(n) && n >= 0 && n <= maxIndex) return n;
    }
    for (const ch of cleaned) {
      if (ch >= "0" && ch <= "9") {
        const n = Number.parseInt(ch, 10);
        if (n >= 0 && n <= maxIndex) return n;
      }
    }
    return null;
  }

  async _callGroq(model, prompt) {
    const res = await axios.post(GROQ_URL, {
      model,
      messages: [
        { role: "system", content: SVP_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      max_tokens: 512,
      temperature: 0,
      stream: false,
    }, {
      timeout: 20000,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": randUA(),
      },
      validateStatus: () => true,
    });
    if (res.status >= 400) throw new Error(`Groq HTTP ${res.status}`);
    const msg = res.data?.choices?.[0]?.message || {};
    return msg.content || msg.reasoning || "";
  }

  async solve(q) {
    if (!this.enabled) return null;
    if (!q?.question || !Array.isArray(q.options) || q.options.length === 0) return null;
    const maxIndex = q.options.length - 1;
    const key = `${q.id}::${q.question}`;
    if (this.cache.has(key)) return this.cache.get(key);

    const prompt = this._buildPrompt(q);
    for (const model of [GROQ_MODEL, GROQ_FALLBACK]) {
      if (!model) continue;
      try {
        const raw = await this._callGroq(model, prompt);
        const idx = this._extractIndex(raw, maxIndex);
        if (idx !== null) {
          this.cache.set(key, idx);
          log(`   ${C.cyan}🤖 Groq [${model}] → idx=${idx}${C.reset}`);
          return idx;
        }
      } catch (e) {
        log(`   ${C.yellow}🤖 Groq [${model}] failed: ${e.message}${C.reset}`);
      }
    }
    return null;
  }

  async solveAll(questions) {
    const answers = [];
    for (const q of questions) {
      const idx = await this.solve(q);
      if (idx === null) return null;
      answers.push({ id: q.id, choice: idx });
    }
    return answers;
  }
}

class ApiError extends Error {
  constructor(code, message, httpStatus) {
    super(message); this.name = "ApiError";
    this.code = code; this.httpStatus = httpStatus;
  }
}

class SvpClient {
  constructor(token, agent = null) {
    this.token = token || null;
    this.agent = agent || null;
  }

  async request(pathname, { method = "GET", body, auth = false } = {}) {
    const headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth) {
      if (!this.token) throw new ApiError(-1, "no token", 401);
      headers["authorization"] = `Bearer ${this.token}`;
    }
    headers["origin"] = "https://rewards.svpstars.com";
    headers["referer"] = "https://rewards.svpstars.com/";

    const { status, data } = await httpJson(
      method,
      `${API_BASE}${pathname}`,
      { headers, body: body !== undefined ? JSON.stringify(body) : undefined, agent: this.agent }
    );

    if (!data || typeof data !== "object") throw new ApiError(-1, `HTTP ${status}`, status);
    if (status >= 400 || data.code !== 0) {
      throw new ApiError(data.code ?? -1, data.message || `HTTP ${status}`, status);
    }
    return data.data;
  }

  getNonce(address) { return this.request(`/auth/nonce?address=${encodeURIComponent(address)}`); }
  login({ address, signature, inviteCode }) {
    const body = { address, signature };
    if (inviteCode) body.inviteCode = inviteCode;
    return this.request("/auth/login", { method: "POST", body });
  }
  me() { return this.request("/me", { auth: true }); }
  tasks() { return this.request("/tasks", { auth: true }); }
  startTask(id) { return this.request(`/tasks/${id}/start`, { method: "POST", auth: true }); }
  verifyTask(id) { return this.request(`/tasks/${id}/verify`, { method: "POST", auth: true, body: {} }); }
  claimTask(id, body) { return this.request(`/tasks/${id}/claim`, { method: "POST", auth: true, body: body ?? {} }); }
  quizToday() { return this.request("/quiz/today", { auth: true }); }
  claimRegionReward(cat) { return this.request(`/region-rewards/${cat}/claim`, { method: "POST", auth: true, body: {} }); }
}

async function fetchAltchaEnvelope(address, tokenAddress, agent = null) {
  const url = `${ALTCHA_BASE}?chain=svp-testnet` +
    `&token=${encodeURIComponent(tokenAddress)}` +
    `&address=${encodeURIComponent(address)}`;
  const { status, data } = await httpJson("GET", url, {
    headers: {
      "accept": "*/*",
      "referer": "https://www.svpchain.org/faucet",
      "origin": "https://www.svpchain.org",
    },
    agent,
  });
  if (status !== 200 || !data?.parameters) throw new Error(`challenge HTTP ${status}`);
  return data;
}

async function solveAltcha(envelope) {
  const start = Date.now();
  const solution = await solveChallenge({
    challenge: envelope,
    deriveKey: pbkdf2.deriveKey,
    timeout: ALTCHA_SOLVE_TIMEOUT_MS,
  });
  if (!solution || typeof solution.counter !== "number") {
    throw new Error(`altcha gave up after ${Date.now() - start}ms`);
  }
  return solution;
}

function buildAltchaToken(envelope, solution) {
  return Buffer.from(JSON.stringify({
    challenge: envelope,
    solution: {
      counter: solution.counter,
      derivedKey: solution.derivedKey,
      time: solution.time,
    },
  })).toString("base64");
}

async function faucetClaimOne(address, tokenAddress, symbol, agent = null) {
  let altchaToken;
  for (let attempt = 1; attempt <= MAX_ALTCHA_ATTEMPTS; attempt++) {
    try {
      const envelope = await fetchAltchaEnvelope(address, tokenAddress, agent);
      const solution = await solveAltcha(envelope);
      log(`   ${C.cyan}🔐 ALTCHA solved (counter=${solution.counter}, ${Math.round(solution.time)}ms)${C.reset}`);
      altchaToken = buildAltchaToken(envelope, solution);
      break;
    } catch (e) {
      log(`   ${C.yellow}🔐 ALTCHA attempt ${attempt}/${MAX_ALTCHA_ATTEMPTS} failed: ${e.message}${C.reset}`);
      if (attempt === MAX_ALTCHA_ATTEMPTS) {
        return { ok: false, symbol, errMsg: `altcha: ${e.message}` };
      }
      await sleep(3000);
    }
  }

  let status = 0, data = {};
  try {
    const r = await httpJson("POST", FAUCET_ENDPOINT, {
      headers: {
        "content-type": "application/json",
        "origin": "https://www.svpchain.org",
        "referer": "https://www.svpchain.org/faucet",
      },
      body: JSON.stringify({
        chain: "svp-testnet",
        token: tokenAddress,
        address,
        altcha: altchaToken,
      }),
      agent,
    });
    status = r.status; data = r.data;
  } catch (e) {
    return { ok: false, symbol, status: 0, errMsg: e.message };
  }

  const json = data || {};
  const txHash = json.tx_hash || json.txHash || json.hash || json.data?.txHash || json.data?.tx_hash || null;
  const errMsg = json.error || json.message || json.reason || json.data?.error || json.data?.message || null;
  return { ok: status < 400 && !!txHash, txHash, status, errMsg, symbol };
}

async function faucetClaimWithRetry(address, token, attempts = MAX_CLAIM_ATTEMPTS, agent = null) {
  for (let i = 1; i <= attempts; i++) {
    const r = await faucetClaimOne(address, token.address, token.symbol, agent);
    if (r.ok) return r;

    if (r.status === 400 && /not enabled/i.test(r.errMsg || "")) return r;
    if (r.status === 400 && /already|too soon|cooldown|recently/i.test(r.errMsg || "")) return r;
    if (r.status === 429) return r;

    if (RETRYABLE_STATUS.has(r.status) && i < attempts) {
      log(`   ${C.yellow}⚠️  ${token.symbol}: HTTP ${r.status} — retry ${i}/${attempts} in ${RETRY_WAIT_SERVER_ERR / 1000}s${C.reset}`);
      await sleep(RETRY_WAIT_SERVER_ERR);
      continue;
    }
    return r;
  }
  return { ok: false, symbol: token.symbol, errMsg: "max retries exceeded" };
}

/**
 * Recover a real faucet drip tx from the explorer.
 * Faucet wallet is 0x8b52753dcbad46925821f02b7b7d90bad8804bfe — every drip
 * comes from it. ERC-20 drips (USDC/USDV/WBTC/WBNB) appear in tokentx.
 */
async function findRecentFaucetTx(address, agent = null) {
  const FAUCET_WALLET = "0x8b52753dcbad46925821f02b7b7d90bad8804bfe";
  try {
    for (const action of ["tokentx", "txlist"]) {
      const url = `${EXPLORER_API}?module=account&action=${action}` +
        `&address=${encodeURIComponent(address)}` +
        `&sort=desc&page=1&offset=50`;
      const { status, data } = await httpJson("GET", url, {
        headers: { accept: "application/json" },
        agent,
      });
      if (status !== 200) continue;
      const items = data?.result;
      if (!Array.isArray(items) || items.length === 0) continue;

      for (const tx of items) {
        if (!tx?.hash) continue;
        if ((tx.to || "").toLowerCase() !== address.toLowerCase()) continue;
        if ((tx.from || "").toLowerCase() !== FAUCET_WALLET) continue;
        return tx.hash;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function faucetClaimAll(address, task = null, agent = null) {
  const results = [];
  const txHashes = [];
  const taskDone = task && task.userStatus === "done";

  for (let i = 0; i < FAUCET_TOKENS.length; i++) {
    const t = FAUCET_TOKENS[i];
    if (taskDone) break;

    // If rewards quest is already done, skip drip.
    // If quest is NOT done (reset at UTC 00:00), only skip if already tried in last 10m of current run.
    const lastClaim = FAUCET_COOLDOWNS.get(address, t.address);
    const claimedRecently = lastClaim != null && (Date.now() - lastClaim) < 10 * 60 * 1000;
    if (taskDone || claimedRecently) {
      const ago = Math.round((Date.now() - (lastClaim || 0)) / 60000);
      log(`   ${C.dim}⏭️  skip faucet ${t.symbol}: ${taskDone ? "task already done" : `tried ${ago}m ago`}${C.reset}`);

      let cached = TXHASHES.get(address, `faucet_${t.symbol}`);
      if (!cached) cached = TXHASHES.get(address, "faucet_last");
      if (!cached) {
        cached = await findRecentFaucetTx(address, agent);
        if (cached) {
          log(`   ${C.cyan}💧 recovered ${t.symbol} tx from explorer: ${cached}${C.reset}`);
          TXHASHES.set(address, `faucet_${t.symbol}`, cached);
        }
      }
      if (cached) txHashes.push({ symbol: t.symbol, hash: cached });
      continue;
    }

    try {
      const r = await faucetClaimWithRetry(address, t, MAX_CLAIM_ATTEMPTS, agent);
      results.push(r);
      if (r.ok) {
        log(`   ${C.green}💧 faucet ${t.symbol}: ${EXPLORER}/${r.txHash}${C.reset}`);
        FAUCET_COOLDOWNS.set(address, t.address, Date.now());
        TXHASHES.set(address, `faucet_${t.symbol}`, r.txHash);
        TXHASHES.set(address, "faucet_last", r.txHash);
        txHashes.push({ symbol: t.symbol, hash: r.txHash });
      } else if (r.status === 400 && /not enabled/i.test(r.errMsg || "")) {
        log(`   ${C.yellow}🚫 faucet ${t.symbol}: disabled${C.reset}`);
      } else if (r.status === 429) {
        log(`   ${C.dim}⏭️  faucet ${t.symbol}: rate-limited (already claimed recently)${C.reset}`);
        FAUCET_COOLDOWNS.set(address, t.address, Date.now());
        const cached = TXHASHES.get(address, `faucet_${t.symbol}`) || TXHASHES.get(address, "faucet_last");
        if (cached) txHashes.push({ symbol: t.symbol, hash: cached });
      } else if (r.status === 400 && /already|too soon|cooldown|recently/i.test(r.errMsg || "")) {
        log(`   ${C.dim}⏭️  faucet ${t.symbol}: cooldown — ${r.errMsg}${C.reset}`);
        FAUCET_COOLDOWNS.set(address, t.address, Date.now());
        const cached = TXHASHES.get(address, `faucet_${t.symbol}`) || TXHASHES.get(address, "faucet_last");
        if (cached) txHashes.push({ symbol: t.symbol, hash: cached });
      } else {
        log(`   ${C.yellow}❌ faucet ${t.symbol}: HTTP ${r.status}${r.errMsg ? ` — ${r.errMsg}` : ""}${C.reset}`);
      }
    } catch (e) {
      results.push({ ok: false, symbol: t.symbol, errMsg: e.message });
      log(`   ${C.red}❌ faucet ${t.symbol}: ${e.message}${C.reset}`);
    }

    if (i < FAUCET_TOKENS.length - 1) {
      await sleep(INTER_TOKEN_DELAY);
    }
  }
  return { results, txHashes, anySuccess: txHashes.length > 0 };
}

const swapLog = (...a) => log(`   ${C.cyan}🔄 [swap]${C.reset}`, ...a);

async function getTxFeeOptions(provider, gasLimit = 250_000n) {
  let fee = {};
  if (provider?.getFeeData) {
    try { fee = await provider.getFeeData(); } catch { }
  }
  let maxFeePerGas = fee.maxFeePerGas ?? MIN_GAS_PRICE;
  let maxPriorityFeePerGas = fee.maxPriorityFeePerGas ?? ethers.parseUnits("0.125", "gwei");
  if (maxFeePerGas < MIN_GAS_PRICE) maxFeePerGas = MIN_GAS_PRICE;
  return {
    gasLimit,
    type: 2,
    maxFeePerGas,
    maxPriorityFeePerGas,
  };
}

async function wrapNativeToWSVP(wallet, amountWei) {
  const wsvp = new ethers.Contract(WSVP_ADDRESS, WSVP_ABI, wallet);
  swapLog(`wrapping ${ethers.formatEther(amountWei)} SVP → WSVP…`);
  const feeOpts = await getTxFeeOptions(wallet.provider, 200_000n);
  const tx = await wsvp.deposit({ value: amountWei, ...feeOpts });
  const rcpt = await tx.wait();
  if (rcpt.status !== 1) throw new Error("WSVP.deposit reverted");
  swapLog(`${C.green}✅ wrapped${C.reset} ${EXPLORER}/${tx.hash}`);
  return tx.hash;
}

async function approveToken(wallet, tokenAddress, spender) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  const allowance = await token.allowance(wallet.address, spender);
  if (allowance > 0n) return null;
  swapLog(`approving ${tokenAddress.slice(0, 10)}…`);
  const feeOpts = await getTxFeeOptions(wallet.provider, 200_000n);
  const tx = await token.approve(spender, ethers.MaxUint256, feeOpts);
  await tx.wait();
  swapLog(`${C.green}✅ approved${C.reset} ${EXPLORER}/${tx.hash}`);
  return tx.hash;
}

async function executeSwapLeg(wallet, provider, fromSymbol, toSymbol, amountIn) {
  const fromToken = TOKENS[fromSymbol];
  const toToken = TOKENS[toSymbol];
  if (!fromToken || !toToken) {
    swapLog(`${C.red}unknown token in leg ${fromSymbol}→${toSymbol}${C.reset}`);
    return null;
  }

  const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);
  const deadline = Math.floor(Date.now() / 1000) + 900;
  const path = [fromToken, toToken];

  let amountOutMin;
  try {
    const amounts = await router.getAmountsOut(amountIn, path);
    const out = amounts[amounts.length - 1];
    amountOutMin = (out * (100n - SWAP_SLIPPAGE_PCT)) / 100n;
    swapLog(`quote ${fromSymbol}→${toSymbol}: ${ethers.formatEther(amountIn)} in → ${out.toString()} out`);
  } catch (e) {
    swapLog(`${C.yellow}no liquidity ${fromSymbol}→${toSymbol}: ${extractRevertReason(e)}${C.reset}`);
    return null;
  }

  try { await approveToken(wallet, fromToken, ROUTER_ADDRESS); }
  catch (e) {
    swapLog(`${C.yellow}approve failed: ${extractRevertReason(e)}${C.reset}`);
    return null;
  }

  let gasLimit;
  try {
    const est = await router.swapExactTokensForTokens.estimateGas(
      amountIn, amountOutMin, path, wallet.address, deadline
    );
    gasLimit = (est * 130n) / 100n;
  } catch (e) {
    swapLog(`${C.yellow}gas est. failed (${extractRevertReason(e)}) — using 500k${C.reset}`);
    gasLimit = 500_000n;
  }

  let fee = {};
  try { fee = await provider.getFeeData(); } catch { }
  let maxFeePerGas = fee.maxFeePerGas ?? MIN_GAS_PRICE;
  let maxPriorityFeePerGas = fee.maxPriorityFeePerGas ?? ethers.parseUnits("0.125", "gwei");
  if (maxFeePerGas < MIN_GAS_PRICE) maxFeePerGas = MIN_GAS_PRICE;

  try {
    const tx = await router.swapExactTokensForTokens(
      amountIn, amountOutMin, path, wallet.address, deadline,
      { gasLimit, type: 2, maxFeePerGas, maxPriorityFeePerGas }
    );
    const rcpt = await tx.wait();
    if (rcpt.status !== 1) throw new Error("swap reverted");
    swapLog(`${C.green}✅ ${fromSymbol}→${toSymbol}${C.reset} ${EXPLORER}/${tx.hash}`);
    return tx.hash;
  } catch (e) {
    swapLog(`${C.red}❌ ${fromSymbol}→${toSymbol} failed: ${extractRevertReason(e)}${C.reset}`);
    return null;
  }
}

async function performDistinctSwaps(privateKey, provider) {
  const wallet = new ethers.Wallet(privateKey, provider);
  const hashes = [];

  const bal = await safeGetBalance(provider, wallet.address);
  if (bal == null) {
    swapLog(`${C.yellow}balance check failed — aborting swaps${C.reset}`);
    return hashes;
  }
  const needWSVP = SWAP_LEGS.reduce((a, l) => a + l.amount, 0n);
  const needTotal = needWSVP + SWAP_MIN_RESERVE;
  if (bal < needTotal) {
    swapLog(`${C.yellow}insufficient SVP: have ${ethers.formatEther(bal)}, need ${ethers.formatEther(needTotal)}${C.reset}`);
    return hashes;
  }

  try { hashes.push(await wrapNativeToWSVP(wallet, needWSVP)); }
  catch (e) {
    swapLog(`${C.red}wrap failed: ${extractRevertReason(e)}${C.reset}`);
    return hashes;
  }

  try { await approveToken(wallet, WSVP_ADDRESS, ROUTER_ADDRESS); }
  catch (e) {
    swapLog(`${C.red}WSVP approve failed: ${extractRevertReason(e)}${C.reset}`);
  }

  for (const leg of SWAP_LEGS) {
    const h = await executeSwapLeg(wallet, provider, leg.from, leg.to, leg.amount);
    if (h) hashes.push(h);
    await sleep(3000);
  }

  swapLog(`${C.green}${hashes.length} swap tx(s) landed${C.reset}`);
  return hashes;
}

async function loginAccount(privateKey, agent = null) {
  const account = privateKeyToAccount(privateKey);
  const client = new SvpClient(null, agent);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { message } = await client.getNonce(account.address);
      const signature = await account.signMessage({ message });
      const { token } = await client.login({
        address: account.address,
        signature,
        inviteCode: INVITE_CODE || undefined,
      });
      return { client: new SvpClient(token, agent), address: account.address };
    } catch (e) {
      if (attempt < 3 && /nonce|expired|network|timeout|500|502|503/i.test(e.message)) {
        await sleep(2000 * attempt);
        continue;
      }
      throw e;
    }
  }
}

function flattenTasks(bundle) {
  const out = [];
  for (const cat of ["newbie", "daily", "weekly", "special"]) {
    for (const t of bundle?.[cat] ?? []) out.push({ ...t, category: cat });
  }
  return out;
}

const lendLog = (...a) => log(`   ${C.magenta}🏦 [lendora]${C.reset}`, ...a);

async function performLendoraSupply(privateKey, provider) {
  const wallet = new ethers.Wallet(privateKey, provider);

  for (const sym of ["USDC", "WBTC", "WBNB"]) {
    const cfg = CTOKENS[sym];
    if (!cfg) continue;

    const erc20 = new ethers.Contract(cfg.underlying, ERC20_ABI, wallet);
    const bal = await erc20.balanceOf(wallet.address).catch(() => 0n);
    if (bal === 0n) {
      lendLog(`${C.yellow}⏭️  skip ${sym}: zero balance${C.reset}`);
      continue;
    }

    const capRaw = ethers.parseUnits(LENDORA_MAX_SUPPLY, cfg.decimals);
    const ninetyPct = (bal * 90n) / 100n;
    const amount = ninetyPct > capRaw ? capRaw : ninetyPct;
    if (amount === 0n) continue;

    const cToken = new ethers.Contract(cfg.cToken, CTOKEN_ABI, wallet);

    try {
      const allowance = await erc20.allowance(wallet.address, cfg.cToken);
      if (allowance < amount) {
        lendLog(`approving ${sym}…`);
        const feeOpts = await getTxFeeOptions(provider, 200_000n);
        const atx = await erc20.approve(cfg.cToken, ethers.MaxUint256, feeOpts);
        await atx.wait();
      }
    } catch (e) {
      lendLog(`${C.yellow}${sym} approve failed — ${extractRevertReason(e)}${C.reset}`);
      continue;
    }

    const mintErc20 = cToken.getFunction("mint(uint256)");

    try {
      await mintErc20.staticCall(amount);
    } catch (e) {
      lendLog(`${C.yellow}${sym} sim failed — ${extractRevertReason(e)}${C.reset}`);
      continue;
    }

    const gasLimit = await mintErc20.estimateGas(amount)
      .then(g => (g * 130n) / 100n)
      .catch(() => 400_000n);

    lendLog(`supplying ${ethers.formatUnits(amount, cfg.decimals)} ${sym}…`);
    try {
      const feeOpts = await getTxFeeOptions(provider, gasLimit);
      const tx = await mintErc20(amount, feeOpts);
      lendLog(`${C.cyan}📜 ${EXPLORER}/${tx.hash}${C.reset}`);
      const rcpt = await tx.wait();
      if (rcpt.status === 1) {
        lendLog(`${C.green}✅ lendora supply (${sym})${C.reset} ${EXPLORER}/${tx.hash}`);
        return tx.hash;
      }
    } catch (e) {
      lendLog(`${C.yellow}${sym} mint failed — ${extractRevertReason(e)}${C.reset}`);
    }
  }

  lendLog(`${C.yellow}😕 no Lendora market accepted supply${C.reset}`);
  return null;
}

const bridgeLog = (...a) => log(`   ${C.blue}🌉 [bridge]${C.reset}`, ...a);

function encodeBridgeCalldata(dstChainId, dstToken, recipient) {
  const selector = BRIDGE_FUNCTION_SELECTOR.replace(/^0x/, "");
  const chainIdParam = ethers.zeroPadValue(ethers.toBeHex(BigInt(dstChainId)), 32).slice(2);
  const dstTokenParam = ethers.zeroPadValue(dstToken, 32).slice(2);
  const recipientParam = ethers.zeroPadValue(recipient, 32).slice(2);
  const reservedParam = "0".repeat(64);
  return `0x${selector}${chainIdParam}${dstTokenParam}${recipientParam}${reservedParam}`;
}

async function performBridge(privateKey, provider) {
  const wallet = new ethers.Wallet(privateKey, provider);
  const recipient = wallet.address;

  const min = BRIDGE_AMOUNT_MIN;
  const max = BRIDGE_AMOUNT_MAX > min ? BRIDGE_AMOUNT_MAX : min;
  const span = max - min;
  const rand = span > 0n ? BigInt(Math.floor(Math.random() * Number(span))) : 0n;
  const amount = min + rand;

  const bal = await safeGetBalance(provider, wallet.address);
  if (bal == null) {
    bridgeLog(`${C.yellow}balance check failed — skipping bridge${C.reset}`);
    return null;
  }
  if (bal < amount + BRIDGE_MIN_NATIVE_RESERVE) {
    bridgeLog(`${C.yellow}⏭️  skip: balance too low (have ${ethers.formatEther(bal)}, need ${ethers.formatEther(amount + BRIDGE_MIN_NATIVE_RESERVE)})${C.reset}`);
    return null;
  }

  const data = encodeBridgeCalldata(BRIDGE_DEST_CHAIN_ID, BRIDGE_DST_TOKEN, recipient);

  bridgeLog(`bridging ${ethers.formatEther(amount)} SVP → chain ${BRIDGE_DEST_CHAIN_ID}`);
  bridgeLog(`data      : ${data.slice(0, 10)}…${data.slice(-16)}`);

  let fee = {};
  try { fee = await provider.getFeeData(); } catch { }
  let maxFeePerGas = fee.maxFeePerGas ?? MIN_GAS_PRICE;
  let maxPriorityFeePerGas = fee.maxPriorityFeePerGas ?? ethers.parseUnits("0.125", "gwei");
  if (maxFeePerGas < MIN_GAS_PRICE) maxFeePerGas = MIN_GAS_PRICE;

  let gasLimit;
  try {
    const est = await provider.estimateGas({ from: wallet.address, to: BRIDGE_CONTRACT, value: amount, data });
    gasLimit = (est * 130n) / 100n;
  } catch {
    bridgeLog(`${C.yellow}⛽ gas est. failed — using 300k${C.reset}`);
    gasLimit = 300_000n;
  }

  let tx;
  try {
    tx = await wallet.sendTransaction({
      to: BRIDGE_CONTRACT, value: amount, data, gasLimit,
      type: 2, maxFeePerGas, maxPriorityFeePerGas,
    });
  } catch (e) {
    bridgeLog(`${C.red}❌ send failed — ${extractRevertReason(e)}${C.reset}`);
    return null;
  }

  bridgeLog(`${C.cyan}📜 tx: ${tx.hash}${C.reset}`);
  bridgeLog(`${C.cyan}🔗 ${EXPLORER}/${tx.hash}${C.reset}`);

  const rcpt = await tx.wait(1);
  if (!rcpt || rcpt.status !== 1) {
    bridgeLog(`${C.red}❌ reverted on-chain${C.reset}`);
    return null;
  }

  bridgeLog(`${C.green}✅ confirmed block ${rcpt.blockNumber}${C.reset}`);
  return tx.hash;
}

async function handleCheckin(client, task) {
  if (task.userStatus === "done") return;
  await client.startTask(task.id).catch(() => { });
  const r = await client.claimTask(task.id, {});
  log(`   ${C.green}📅 check-in +${r.pointsAwarded} pts${C.reset}`);
}

async function handleQuiz(client, task, solver) {
  if (task.userStatus === "done") return;

  await client.startTask(task.id).catch(() => { });
  const payload = await client.quizToday().catch(() => null);
  const questions = payload?.questions ?? [];
  if (!questions.length) { log(`   🧠 quiz: no questions`); return; }
  if (!solver.isEnabled()) { log(`   🧠 quiz: Groq disabled`); return; }

  const answers = await solver.solveAll(questions);
  if (!answers) { log(`   🧠 quiz: solver failed`); return; }

  const res = await client.claimTask(task.id, { answers });
  log(`   ${C.green}🧠 quiz +${res.pointsAwarded} pts${C.reset}`);
}

async function handleFaucet(client, task, address) {
  if (task.userStatus === "done") {
    log(`   💧 faucet task already done — skipping drips`);
    return true;
  }

  log(`   💧 faucet: requesting all token drips…`);
  const { txHashes } = await faucetClaimAll(address, task, client.agent);

  await client.startTask(task.id).catch(() => { });

  if (txHashes.length === 0) {
    log(`   ${C.red}😕 no faucet tx available (fresh or recovered) — cannot claim${C.reset}`);
    return false;
  }

  const ordered = [
    ...txHashes.filter(h => h.symbol === "SVP"),
    ...txHashes.filter(h => h.symbol !== "SVP"),
  ];
  const tried = new Set();

  for (const h of ordered) {
    if (tried.has(h.hash)) continue;
    tried.add(h.hash);
    log(`   ${C.cyan}💧 trying proof tx ${h.hash} (${h.symbol})${C.reset}`);
    try {
      const r = await client.claimTask(task.id, { txHash: h.hash });
      log(`   ${C.green}💧 faucet verified +${r.pointsAwarded} pts${C.reset}`);
      return true;
    } catch (e) {
      const msg = e.message || "";
      if (/not sent to the official faucet contract/i.test(msg)) {
        log(`   ${C.yellow}💧 ${h.symbol} hash rejected (not a faucet tx) — trying next${C.reset}`);
        continue;
      }
      if (/invalid transaction hash/i.test(msg)) {
        log(`   ${C.yellow}💧 ${h.symbol} hash rejected (invalid) — trying next${C.reset}`);
        continue;
      }
      log(`   ${C.yellow}💧 claim with ${h.symbol} hash failed: ${msg}${C.reset}`);
      break;
    }
  }

  log(`   ${C.red}💧 no recovered hash was accepted by the backend${C.reset}`);
  log(`   ${C.yellow}💡 A fresh faucet drip is needed. Try again in ~10 minutes when cooldown expires, or delete faucet_cooldowns.json to force a new drip.${C.reset}`);
  return false;
}

async function handleVerifyThenClaim(client, task) {
  if (task.userStatus === "done") return;

  // If already claimable, claim immediately — don't risk re-verifying
  if (task.userStatus === "claimable") {
    try {
      const r = await client.claimTask(task.id, {});
      log(`   ${C.green}✅ claim ${task.title} +${r.pointsAwarded}${C.reset}`);
      return;
    } catch (e) {
      log(`   ${C.yellow}claim error: ${e.message} — trying verify${C.reset}`);
    }
  }

  if (task.userStatus === "todo") {
    try { await client.startTask(task.id); } catch { }
  }

  const MAX_VERIFY = 6;
  const VERIFY_INTERVAL = 15_000;

  for (let i = 1; i <= MAX_VERIFY; i++) {
    let upd;
    try { upd = await client.verifyTask(task.id); }
    catch (e) {
      log(`   ${C.yellow}🔍 verify ${i}/${MAX_VERIFY}: ${e.message}${C.reset}`);
      if (i < MAX_VERIFY) { await sleep(VERIFY_INTERVAL); continue; }
      return;
    }

    const ps = upd?.productState;
    log(`   🔍 verify ${task.title} [${i}/${MAX_VERIFY}] → ${upd.userStatus}` +
      (ps ? ` (${ps.progress ?? "?"}/${ps.target ?? "?"}` +
        (ps.uniqueDirectionCount != null ? `, dirs=${ps.uniqueDirectionCount}` : "") +
        (ps.reasonCode ? `, reason=${ps.reasonCode}` : "") +
        (ps.bridgeSummary
          ? `, bridge processing=${ps.bridgeSummary.processingCount ?? 0}`
          : "") +
        `)` : ""));

    if (upd.userStatus === "claimable") {
      const r = await client.claimTask(task.id, {});
      log(`   ${C.green}✅ claim ${task.title} +${r.pointsAwarded}${C.reset}`);
      return;
    }
    if (upd.userStatus === "done") return;

    // If progress is at or above target but not claimable yet — indexer lag
    const progress = ps?.progress ?? 0;
    const target = ps?.target ?? 1;
    if (progress >= target && i < MAX_VERIFY) {
      log(`   ${C.yellow}⏳ progress ${progress}/${target} but not claimable — waiting ${VERIFY_INTERVAL / 1000}s for indexer…${C.reset}`);
      await sleep(VERIFY_INTERVAL);
      continue;
    }

    // No progress yet — don't keep retrying, on-chain action likely didn't happen
    if (progress < target) {
      if (i === 1) log(`   ${C.dim}progress ${progress}/${target} — on-chain action needed${C.reset}`);
      return;
    }

    if (i < MAX_VERIFY) await sleep(VERIFY_INTERVAL);
  }

  log(`   ${C.yellow}😕 ${task.title} still not claimable after ${MAX_VERIFY} verify attempts${C.reset}`);
}

async function handleGeneric(client, task) {
  if (task.userStatus === "done") return;
  if (task.userStatus === "todo") {
    await client.startTask(task.id).catch(() => { });
  } else if (task.userStatus === "claimable") {
    const r = await client.claimTask(task.id, {});
    log(`   ${C.green}✅ claim ${task.title} +${r.pointsAwarded}${C.reset}`);
  }
}

async function sweepClaimableTasks(client, tasks) {
  let claimedCount = 0;
  for (const t of tasks) {
    if (SKIP_ACTIONS.has(t.actionType)) continue;
    if (t.userStatus === "claimable" && t.actionType !== "contract_deploy") {
      try {
        const r = await client.claimTask(t.id, {});
        log(`   ${C.green}🎁 [sweep] claimed ${t.title} +${r.pointsAwarded} pts${C.reset}`);
        claimedCount++;
      } catch { }
    }
  }
  return claimedCount;
}

async function claimAllRegionChests(client) {
  for (const cat of ["daily", "special", "newbie", "weekly"]) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await jitter();
      try {
        const r = await client.claimRegionReward(cat);
        log(`   ${C.green}🎁 region [${cat}] +${r.pointsAwarded} pts${C.reset}`);
        break;
      } catch (e) {
        const msg = e.message || "";
        if (/already|completed/i.test(msg)) break;
        if (/not ready|locked|remaining/i.test(msg)) {
          if (attempt < 3 && (cat === "daily" || cat === "special")) {
            await sleep(5_000);
            continue;
          }
          break;
        }
        log(`   ${C.yellow}🎁 region [${cat}] skip: ${msg}${C.reset}`);
        break;
      }
    }
  }
}

async function handleSwapTask(client, task, address, privateKey, provider) {
  if (task.userStatus === "done") {
    log(`\n${C.cyan}🔄 ─── swap_check already done ───${C.reset}`);
    return;
  }

  if (task.userStatus === "claimable") {
    log(`\n${C.cyan}🔄 ─── swap_check already claimable — claiming now ───${C.reset}`);
    try {
      const r = await client.claimTask(task.id, {});
      log(`   ${C.green}✅ claim ${task.title} +${r.pointsAwarded}${C.reset}`);
      return;
    } catch (e) {
      log(`   ${C.yellow}claim error: ${e.message} — verifying${C.reset}`);
    }
  }

  const progress = task.productState?.progress ?? 0;
  const target = task.productState?.target ?? 3;

  if (progress >= target) {
    log(`\n${C.cyan}🔄 ─── swap_check at ${progress}/${target} — verifying ───${C.reset}`);
    await handleVerifyThenClaim(client, task);
    return;
  }

  if (!DO_SWAP) {
    log(`\n${C.cyan}🔄 ─── swap disabled (--no-swap) — verifying only ───${C.reset}`);
    await handleVerifyThenClaim(client, task);
    return;
  }

  log(`\n${C.bold}${C.cyan}🔄 ─── swap_check: executing 3 swap legs ───${C.reset}`);
  let hashes = [];
  try { hashes = await performDistinctSwaps(privateKey, provider); }
  catch (e) { log(`   ${C.red}🔄 swap error: ${e.message}${C.reset}`); }

  if (hashes.length === 0) {
    log(`   ${C.yellow}😕 no swaps landed — verifying anyway${C.reset}`);
    await handleVerifyThenClaim(client, task);
    return;
  }

  TXHASHES.set(address, "swap_last", hashes.join(","));

  log(`   ${C.green}⏳ swaps landed — waiting 90s for indexer…${C.reset}`);
  await sleep(90_000);

  const MAX_ATTEMPTS = 6;
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    let upd;
    try { upd = await client.verifyTask(task.id); }
    catch (e) { log(`   ${C.yellow}🔍 verify ${i}/${MAX_ATTEMPTS}: ${e.message}${C.reset}`); }

    if (upd) {
      const ps = upd.productState;
      log(`   🔍 verify swap_check → ${upd.userStatus}` +
        (ps ? ` (${ps.progress ?? "?"}/${ps.target ?? "?"}` +
          (ps.uniqueDirectionCount != null ? `, dirs=${ps.uniqueDirectionCount}` : "") +
          (ps.reasonCode ? `, reason=${ps.reasonCode}` : "") + `)` : ""));

      if (upd.userStatus === "claimable") {
        const r = await client.claimTask(task.id, {});
        log(`   ${C.green}✅ claim ${task.title} +${r.pointsAwarded}${C.reset}`);
        return;
      }
      if (upd.userStatus === "done") return;
    }
    if (i < MAX_ATTEMPTS) await sleep(20_000);
  }

  log(`   ${C.yellow}😕 swap_check still not claimable after retries${C.reset}`);
}

async function handleLendTask(client, task, address, privateKey, provider) {
  if (task.userStatus === "done") {
    log(`\n${C.cyan}🏦 ─── lending_check already done ───${C.reset}`);
    return;
  }

  if (task.userStatus === "claimable") {
    log(`\n${C.cyan}🏦 ─── lending_check already claimable — claiming now ───${C.reset}`);
    try {
      const r = await client.claimTask(task.id, {});
      log(`   ${C.green}✅ claim ${task.title} +${r.pointsAwarded}${C.reset}`);
      return;
    } catch (e) {
      log(`   ${C.yellow}claim error: ${e.message} — verifying${C.reset}`);
    }
  }

  const progress = task.productState?.progress ?? 0;
  const target = task.productState?.target ?? 1;

  if (progress >= target) {
    log(`\n${C.cyan}🏦 ─── lending progress ${progress}/${target} — verifying ───${C.reset}`);
    await handleVerifyThenClaim(client, task);
    return;
  }

  if (!DO_LEND) {
    log(`\n${C.cyan}🏦 ─── lending disabled (--no-lend) — verifying only ───${C.reset}`);
    await handleVerifyThenClaim(client, task);
    return;
  }

  log(`\n${C.bold}${C.cyan}🏦 ─── lending_check: supplying to Lendora ───${C.reset}`);
  let hash = null;
  try { hash = await performLendoraSupply(privateKey, provider); }
  catch (e) { log(`   ${C.red}🏦 lendora error: ${e.message}${C.reset}`); }

  if (!hash) {
    log(`   ${C.yellow}😕 no lendora supply landed — verifying anyway${C.reset}`);
    await handleVerifyThenClaim(client, task);
    return;
  }

  TXHASHES.set(address, "lend_last", hash);

  log(`   ${C.green}⏳ supply landed — waiting 60s for indexer…${C.reset}`);
  await sleep(60_000);

  const MAX_ATTEMPTS = 6;
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    let upd;
    try { upd = await client.verifyTask(task.id); }
    catch (e) { log(`   ${C.yellow}🔍 verify lending ${i}/${MAX_ATTEMPTS}: ${e.message}${C.reset}`); }

    if (upd) {
      const ps = upd.productState;
      log(`   🔍 verify lending_check → ${upd.userStatus}` +
        (ps ? ` (${ps.progress ?? "?"}/${ps.target ?? "?"})` : ""));

      if (upd.userStatus === "claimable") {
        const r = await client.claimTask(task.id, {});
        log(`   ${C.green}✅ claim ${task.title} +${r.pointsAwarded}${C.reset}`);
        return;
      }
      if (upd.userStatus === "done") return;
    }
    if (i < MAX_ATTEMPTS) await sleep(15_000);
  }

  log(`   ${C.yellow}😕 lending_check still not claimable after retries${C.reset}`);
}

async function handleBridgeTask(client, task, address, privateKey, provider) {
  if (task.userStatus === "done") {
    log(`\n${C.cyan}🌉 ─── bridge_check already done ───${C.reset}`);
    return;
  }

  if (task.userStatus === "claimable") {
    log(`\n${C.cyan}🌉 ─── bridge_check already claimable — claiming now ───${C.reset}`);
    try {
      const r = await client.claimTask(task.id, {});
      log(`   ${C.green}✅ claim ${task.title} +${r.pointsAwarded}${C.reset}`);
      return;
    } catch (e) {
      log(`   ${C.yellow}claim error: ${e.message} — verifying${C.reset}`);
    }
  }

  const progress = task.productState?.progress ?? 0;
  const target = task.productState?.target ?? 1;
  const processing = task.productState?.bridgeSummary?.processingCount ?? 0;

  if (progress >= target) {
    log(`\n${C.cyan}🌉 ─── bridge progress ${progress}/${target} — verifying ───${C.reset}`);
    await handleVerifyThenClaim(client, task);
    return;
  }

  if (processing > 0) {
    log(`\n${C.cyan}🌉 ─── bridge already processing (${processing}) — verifying ───${C.reset}`);
    await handleVerifyThenClaim(client, task);
    return;
  }

  if (!DO_BRIDGE) {
    log(`\n${C.cyan}🌉 ─── bridge disabled (--no-bridge) ───${C.reset}`);
    return;
  }

  log(`\n${C.bold}${C.blue}🌉 ─── Executing bridge SVP → Arbitrum Sepolia ───${C.reset}`);
  let hash;
  try { hash = await performBridge(privateKey, provider); }
  catch (e) { log(`   ${C.red}🌉 bridge error: ${e.message}${C.reset}`); return; }

  if (!hash) {
    log(`   ${C.yellow}😕 no bridge tx sent — trying verify anyway${C.reset}`);
    await handleVerifyThenClaim(client, task);
    return;
  }

  TXHASHES.set(address, "bridge_last", hash);
  log(`   ${C.green}⏳ waiting ${BRIDGE_VERIFY_WAIT_MS / 1000}s for indexer…${C.reset}`);
  await sleep(BRIDGE_VERIFY_WAIT_MS);

  const MAX_ATTEMPTS = 6;
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    let upd;
    try { upd = await client.verifyTask(task.id); }
    catch (e) { log(`   ${C.yellow}🔍 verify ${i}/${MAX_ATTEMPTS}: ${e.message}${C.reset}`); }

    if (upd) {
      const ps = upd.productState;
      log(`   🔍 verify bridge_check → ${upd.userStatus}` +
        (ps ? ` (${ps.progress ?? "?"}/${ps.target ?? "?"}` +
          (ps.reasonCode ? `, reason=${ps.reasonCode}` : "") +
          (ps.bridgeSummary
            ? `, bridge processing=${ps.bridgeSummary.processingCount ?? 0}`
            : "") +
          `)` : ""));

      if (upd.userStatus === "claimable") {
        const r = await client.claimTask(task.id, {});
        log(`   ${C.green}✅ claim ${task.title} +${r.pointsAwarded}${C.reset}`);
        return;
      }
      if (upd.userStatus === "done") return;
    }
    if (i < MAX_ATTEMPTS) await sleep(20_000);
  }

  log(`   ${C.yellow}😕 bridge_check still not claimable after retries${C.reset}`);
}

async function runAccount(account, idx, total, ctx, workerId = 1, ipLabel = null) {
  const { solver } = ctx;
  const agent = getProxyAgent(account.proxy);

  const tag = `[ ${idx + 1}/${total} ]`;
  const workerTag = `[Worker #${workerId}] `;
  log(`\n${C.bold}🏦 ═════ ${tag} ${account.label} ${workerTag}═════${C.reset}`);
  if (ipLabel) {
    log(`🌐 IP Channel : ${ipLabel}`);
  } else if (account.proxy) {
    const maskedProxy = account.proxy.replace(/:\/\/[^:]+:[^@]+@/, "://***:***@");
    log(`🌐 Proxy      : ${maskedProxy}`);
  }

  let conn;
  try { conn = await loginAccount(account.privateKey, agent); }
  catch (e) { log(`${C.red}🔐 LOGIN FAIL: ${e.message}${C.reset}`); return; }

  const { client, address } = conn;
  log(`📍 Address    : ${address}`);

  let provider = null;
  if (DO_LEND || DO_BRIDGE || DO_SWAP) {
    try {
      provider = buildProvider(agent);
    } catch (e) {
      log(`${C.yellow}⚠️  Failed to create provider for account: ${e.message}${C.reset}`);
      provider = null;
    }
  }

  // ─── Start-of-cycle safety net: if all local faucet cooldowns have
  // expired, the previous run's faucet hashes have been consumed by the
  // backend and are no longer valid proof. Clear them so the next drip
  // writes fresh ones.
  const anyFresh = FAUCET_TOKENS.some(t => FAUCET_COOLDOWNS.isFresh(address, t.address));
  if (!anyFresh) {
    const n = TXHASHES.clearFaucetKeys(address);
    if (n) log(`   ${C.dim}🧹 faucet cooldowns expired — cleared ${n} stale faucet key(s)${C.reset}`);
  }

  try {
    const me = await client.me();
    log(`📊 Profile: points=${me.totalPoints} invites=${me.validInviteCount} rank=#${me.rank}`);
  } catch (e) { log(`📊 me(): ${e.message}`); }

  let tasks = [];
  try { tasks = flattenTasks(await client.tasks()); }
  catch (e) { log(`📋 tasks(): ${e.message}`); return; }
  log(`📋 Fetched ${tasks.length} tasks`);

  // ─── Step 0.5: Sweep already-claimable tasks from delayed indexers ──
  const preSwept = await sweepClaimableTasks(client, tasks);
  if (preSwept > 0) {
    try { tasks = flattenTasks(await client.tasks()); } catch { }
  }

  if (DRY_RUN) {
    for (const t of tasks) {
      const mark = t.locked ? "🔒" : t.userStatus === "done" ? "✅" : "•";
      log(`  ${mark} [${t.category}] ${t.title} — ${t.userStatus} (${t.actionType})`);
    }
    return;
  }

  // ─── Step 1: Faucet ──────────────────────────────────────────────
  const faucetTask = tasks.find(t => t.actionType === "faucet_claim");
  let faucetOk = faucetTask ? faucetTask.userStatus === "done" : true;

  if (faucetTask && faucetTask.userStatus !== "done") {
    log(`\n${C.bold}${C.green}💧 ─── Step 1: Faucet ───${C.reset}`);
    try { faucetOk = await handleFaucet(client, faucetTask, address); }
    catch (e) { log(`   ${C.red}💧 faucet error: ${e.message}${C.reset}`); }

    if (provider) {
      const bal = await safeGetBalance(provider, address);
      if (bal != null) log(`   ${C.cyan}💰 Balance after faucet: ${ethers.formatEther(bal)} SVP${C.reset}`);
      else log(`   ${C.yellow}💰 balance check failed (RPC) — continuing${C.reset}`);
    }

    try { tasks = flattenTasks(await client.tasks()); } catch { }
  } else if (faucetTask) {
    log(`\n${C.cyan}💧 ─── Step 1: Faucet skipped (done) ───${C.reset}`);
  }

  // The daily quest chain (check-in, quiz, swaps, lend, bridge) requires faucet completion.
  const dailyChainUnlocked = !faucetTask || faucetTask.userStatus === "done" || faucetOk;
  if (!dailyChainUnlocked) {
    log(`\n${C.yellow}⚠️  Faucet claim not completed.${C.reset}`);
    log(`${C.yellow}⚠️  SVP backend chains daily tasks: check-in, quiz, swaps, lend, and bridge require faucet completion first.${C.reset}`);
    log(`${C.yellow}⚠️  Skipping daily chain for this account. Will retry on next cycle.${C.reset}`);
  } else {
    // ─── Step 2: Check-in ─────────────────────────────────────────────
    const checkinTask = tasks.find(t => t.actionType === "checkin");
    if (checkinTask && checkinTask.userStatus !== "done") {
      log(`\n${C.bold}${C.green}📅 ─── Step 2: Check-in ───${C.reset}`);
      try { await handleCheckin(client, checkinTask); }
      catch (e) { log(`   ${C.red}📅 checkin error: ${e.message}${C.reset}`); }
      try { tasks = flattenTasks(await client.tasks()); } catch { }
    } else if (checkinTask) {
      log(`\n${C.cyan}📅 ─── Step 2: Check-in skipped (done) ───${C.reset}`);
    }

    // ─── Step 3: Quiz ─────────────────────────────────────────────────
    const quizTask = tasks.find(t => t.actionType === "quiz");
    if (quizTask && quizTask.userStatus !== "done") {
      log(`\n${C.bold}${C.green}🧠 ─── Step 3: Quiz ───${C.reset}`);
      try { await handleQuiz(client, quizTask, solver); }
      catch (e) { log(`   ${C.red}🧠 quiz error: ${e.message}${C.reset}`); }
      try { tasks = flattenTasks(await client.tasks()); } catch { }
    } else if (quizTask) {
      log(`\n${C.cyan}🧠 ─── Step 3: Quiz skipped (done) ───${C.reset}`);
    }

    // ─── Step 4: Swap ─────────────────────────────────────────────────
    const swapTask = tasks.find(t => t.actionType === "swap_check");
    if (swapTask && swapTask.userStatus !== "done") {
      log(`\n${C.bold}${C.green}🔄 ─── Step 4: Auto-Swap ───${C.reset}`);
      log(`→ [${swapTask.category}] ${swapTask.title} (${swapTask.actionType}, ${swapTask.userStatus})`);
      try { await handleSwapTask(client, swapTask, address, account.privateKey, provider); }
      catch (e) { log(`   ${C.red}🔄 swap error: ${e.message}${C.reset}`); }
      try { tasks = flattenTasks(await client.tasks()); } catch { }
    } else if (swapTask) {
      log(`\n${C.cyan}🔄 ─── Step 4: Auto-Swap skipped (done) ───${C.reset}`);
    }

    // ─── Step 5: Lendora ──────────────────────────────────────────────
    const lendTask = tasks.find(t => t.actionType === "lending_check");
    if (lendTask && lendTask.userStatus !== "done") {
      log(`\n${C.bold}${C.green}🏦 ─── Step 5: Lendora ───${C.reset}`);
      await handleLendTask(client, lendTask, address, account.privateKey, provider);
      try { tasks = flattenTasks(await client.tasks()); } catch { }
    } else if (lendTask) {
      log(`\n${C.cyan}🏦 ─── Step 5: Lendora skipped (done) ───${C.reset}`);
    }

    // ─── Step 6: Bridge ───────────────────────────────────────────────
    const bridgeTask = tasks.find(t => t.actionType === "bridge_check");
    if (bridgeTask && bridgeTask.userStatus !== "done") {
      log(`\n${C.bold}${C.green}🌉 ─── Step 6: Bridge ───${C.reset}`);
      await handleBridgeTask(client, bridgeTask, address, account.privateKey, provider);
      try { tasks = flattenTasks(await client.tasks()); } catch { }
    } else if (bridgeTask) {
      log(`\n${C.cyan}🌉 ─── Step 6: Bridge skipped (done) ───${C.reset}`);
    }
  }

  // ─── Step 7: Remaining tasks ──────────────────────────────────────
  log(`\n${C.bold}${C.green}📋 ─── Step 7: Remaining tasks ───${C.reset}`);
  let didAnything = false;
  for (const t of tasks) {
    if (SKIP_ACTIONS.has(t.actionType)) continue;
    if (t.userStatus === "done") continue;

    await jitter();
    log(`→ [${t.category}] ${t.title} (${t.actionType}, ${t.userStatus})`);
    didAnything = true;

    try {
      switch (t.actionType) {
        case "swap_check":
        case "lending_check":
        case "bridge_check":
        case "onchain_tx_count":
          await handleVerifyThenClaim(client, t);
          break;
        default:
          await handleGeneric(client, t);
      }
    } catch (e) {
      log(`   ${C.red}❌ ${t.title}: ${e.message}${C.reset}`);
    }
  }
  if (!didAnything) log(`   ${C.dim}(nothing left)${C.reset}`);

  // Final sweep for any tasks that turned claimable during on-chain execution
  try {
    tasks = flattenTasks(await client.tasks());
    await sweepClaimableTasks(client, tasks);
  } catch { }

  // ─── Step 8: Region chests ────────────────────────────────────────
  log(`\n${C.bold}${C.green}🎁 ─── Step 8: Region chests ───${C.reset}`);
  await claimAllRegionChests(client);
}

function nextRunTime() {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    RESET_HOUR, 0, 0, 0
  ));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m ${s % 60}s`;
}

const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

async function runSweepPass(ctx) {
  log(`\n${C.bold}${C.magenta}🧹 ═══════════ RECLAIM SWEEP PASS — ${new Date().toISOString()} ═══════════${C.reset}`);
  let totalClaimed = 0;
  let totalPoints = 0;
  let nextIdx = 0;
  const accounts = ctx.accounts;
  const sweepWorkers = Math.min(5, accounts.length);

  const workers = Array.from({ length: sweepWorkers }, async () => {
    while (nextIdx < accounts.length) {
      const acc = accounts[nextIdx++];
      const agent = getProxyAgent(acc.proxy);

      let client, address;
      try {
        const conn = await loginAccount(acc.privateKey, agent);
        client = conn.client;
        address = conn.address;
      } catch (e) {
        continue;
      }

      let tasks = [];
      try {
        tasks = flattenTasks(await client.tasks());
      } catch (e) {
        continue;
      }

      const claimable = tasks.filter(t => t.userStatus === "claimable");
      const processing = tasks.filter(t => t.userStatus === "processing");
      const dailyTasks = tasks.filter(t => t.category === "daily");
      const dailyDone = dailyTasks.filter(t => t.userStatus === "done").length;

      let claimedAny = false;

      // 1. Claim any tasks that are claimable
      for (const t of claimable) {
        try {
          const r = await client.claimTask(t.id, {});
          log(`   ${C.green}✅ [Sweep] ${acc.label} (${address.slice(0, 10)}…): ${t.title} claimed +${r.pointsAwarded} pts!${C.reset}`);
          totalClaimed++;
          totalPoints += (r.pointsAwarded || 0);
          claimedAny = true;
        } catch {}
      }

      // 2. Re-verify processing tasks (e.g. bridge_check waiting for relayer)
      for (const t of processing) {
        try {
          const upd = await client.verifyTask(t.id);
          if (upd && upd.userStatus === "claimable") {
            const r = await client.claimTask(t.id, {});
            log(`   ${C.green}✅ [Sweep] ${acc.label} (${address.slice(0, 10)}…): ${t.title} relayer finished! Claimed +${r.pointsAwarded} pts!${C.reset}`);
            totalClaimed++;
            totalPoints += (r.pointsAwarded || 0);
            claimedAny = true;
          } else if (upd && upd.userStatus !== "done") {
            const reason = upd?.productState?.reasonCode || "PROCESSING";
            log(`   ${C.yellow}⏳ [Sweep] ${acc.label}: ${t.title} still processing (${reason})…${C.reset}`);
          }
        } catch {}
      }

      // 3. Claim region rewards
      for (const reg of ["daily", "special", "newbie"]) {
        try {
          const r = await client.claimRegionReward(reg);
          if (r && r.pointsAwarded > 0) {
            log(`   ${C.green}🎁 [Sweep] ${acc.label} (${address.slice(0, 10)}…): ${reg} region chest claimed +${r.pointsAwarded} pts!${C.reset}`);
            totalClaimed++;
            totalPoints += (r.pointsAwarded || 0);
            claimedAny = true;
          }
        } catch {}
      }

      if (!claimedAny) {
        if (dailyTasks.length > 0 && dailyDone === dailyTasks.length) {
          log(`   ${C.dim}✨ [Sweep] ${acc.label} (${address.slice(0, 10)}…): all daily quests & chests done today.${C.reset}`);
        } else {
          log(`   ${C.dim}ℹ️  [Sweep] ${acc.label} (${address.slice(0, 10)}…): daily quests ${dailyDone}/${dailyTasks.length} done today.${C.reset}`);
        }
      }

      await sleep(1000);
    }
  });

  await Promise.all(workers);
  log(`\n${C.bold}${C.magenta}🏁 [Sweep Result] Claimed ${totalClaimed} pending item(s) (+${totalPoints} pts total).${C.reset}\n`);
  return { totalClaimed, totalPoints };
}

async function sleepUntilNextRun(ctx) {
  const next = nextRunTime();
  log(`\n${C.bold}${C.cyan}⏰ Next full cycle: ${next.toISOString()}${C.reset}`);
  log(`${C.cyan}🔄 Periodic Sweep Active: Re-checking error/delayed quests every 15 minutes…${C.reset}`);

  while (true) {
    const remaining = next.getTime() - Date.now();
    if (remaining <= 0) return;

    const sleepDuration = Math.min(remaining, SWEEP_INTERVAL_MS);
    log(`\n${C.dim}😴 Sleeping for ${fmtDuration(sleepDuration)} (Next 15m sweep in ${Math.round(sleepDuration / 60000)}m | ${fmtDuration(remaining)} until daily reset)…${C.reset}`);
    await sleep(sleepDuration);

    if (Date.now() >= next.getTime()) return;

    try {
      log(`\n${C.bold}${C.cyan}⏰ 15-Minute Reclaim Sweep Triggered (${new Date().toISOString()})${C.reset}`);
      await runSweepPass(ctx);
    } catch (e) {
      log(`${C.yellow}⚠️  15m Sweep error: ${e.message}${C.reset}`);
    }
  }
}

async function runCycle(ctx, cycleNum) {
  log(`\n${C.bold}${C.cyan}🔄 ═══════════ CYCLE #${cycleNum} — ${new Date().toISOString()} ═══════════${C.reset}`);
  let accountsToRun = [...ctx.accounts];
  if (!NO_SHUFFLE) {
    accountsToRun = shuffleArray(accountsToRun);
    log(`${C.magenta}🎲 Randomized account execution order (${accountsToRun.length} accounts)${C.reset}`);
  }

  const ipPool = new IpChannelPool(ctx.proxies);
  const maxWorkers = ipPool.isDirect() ? 1 : Math.min(THREADS, ipPool.getChannelCount());

  log(`${C.cyan}🌐 IP Pool    : ${ipPool.getChannelCount()} IP channel(s) | Concurrency: ${maxWorkers} worker(s)${C.reset}`);
  log(`${C.cyan}⏱️  IP Policy  : 1 account per IP every 1 hour (3,600s cooldown)${C.reset}`);

  let nextIndex = 0;
  const total = accountsToRun.length;

  const workers = Array.from({ length: maxWorkers }, async (_, workerIndex) => {
    const workerId = workerIndex + 1;
    while (nextIndex < total) {
      const idx = nextIndex++;
      const acc = accountsToRun[idx];

      // Acquire an available IP channel whose 1-hour cooldown is complete
      const channel = await ipPool.acquire(workerId, acc.label);
      const accWithProxy = { ...acc, proxy: channel.proxy };

      try {
        await runAccount(accWithProxy, idx, total, ctx, workerId, channel.label);
      } catch (e) {
        log(`${C.red}💥 [Worker #${workerId}] Account ${acc.label} crashed: ${e.message}${C.reset}`);
      } finally {
        ipPool.release(channel, acc.address);
        log(`🔒 [Worker #${workerId}] ${channel.label} entered 1-hour cooldown (claimed for ${acc.address.slice(0, 10)}…)`);
      }

      await sleep(2000);
    }
  });

  await Promise.all(workers);

  // ─── Post-cycle Sweep: Reclaim any delayed tasks (e.g. bridge) ────
  log(`\n${C.bold}${C.cyan}🧹 ─── End-of-Cycle Sweep: Reclaiming delayed bridge & chest points ───${C.reset}`);
  try {
    await runSweepPass(ctx);
  } catch (e) {
    log(`${C.yellow}⚠️  End-of-cycle sweep error: ${e.message}${C.reset}`);
  }

  // ─── End-of-cycle cleanup ─────────────────────────────────────────
  log(`\n${C.dim}🧹 End-of-cycle cleanup — clearing faucet hashes for next run…${C.reset}`);
  for (const acc of ctx.accounts) {
    const n = TXHASHES.clearFaucetKeys(acc.address);
    if (n) log(`   ${C.dim}cleared ${n} faucet key(s) for ${acc.address.slice(0, 10)}…${C.reset}`);
  }

  log(`\n${C.green}${C.bold}✅ Cycle #${cycleNum} complete.${C.reset}`);
}

function buildProvider(agent = null) {
  const createReq = (url) => {
    const req = new FetchRequest(url);
    if (agent) {
      req.getUrlFunc = FetchRequest.createGetUrlFunc({ agent });
    }
    return req;
  };

  if (RPC_URLS.length === 1) {
    return new ethers.JsonRpcProvider(createReq(RPC_URLS[0]), CHAIN_ID, {
      staticNetwork: true,
      timeout: RPC_CALL_TIMEOUT_MS,
    });
  }
  const configs = RPC_URLS.map((url, i) => ({
    provider: new ethers.JsonRpcProvider(createReq(url), CHAIN_ID, {
      staticNetwork: true,
      timeout: RPC_CALL_TIMEOUT_MS,
    }),
    priority: i + 1,
    stallTimeout: 4000,
    weight: 1,
  }));
  return new ethers.FallbackProvider(configs, CHAIN_ID, { quorum: 1 });
}

async function main() {
  log(`${C.cyan}${C.bold}🌟 SVP Rewards — daily auto-farmer (v4.7)${C.reset}`);
  log(`⛓️  Chain ID  : ${CHAIN_ID}`);
  log(`🌐 RPCs      : ${RPC_URLS.join(", ")}`);
  log(`🔀 Router    : ${ROUTER_ADDRESS}`);
  log(`🌉 Bridge    : ${BRIDGE_CONTRACT}`);
  log(`🧪 Dry run   : ${DRY_RUN ? "YES" : "no"}`);
  log(`🔄 Run mode  : ${RUN_ONCE ? "ONCE" : "LOOP (daily)"}`);
  log(`🎲 Shuffling : ${NO_SHUFFLE ? "DISABLED" : "ENABLED"}`);
  log(`⚡ Threads   : ${THREADS} worker(s) requested`);
  log(`⏰ Reset UTC : ${RESET_HOUR}:00`);
  log(`💱 Do swap   : ${DO_SWAP ? "YES" : "no"}`);
  log(`🏦 Do lend   : ${DO_LEND ? "YES" : "no"}`);
  log(`🌉 Do bridge : ${DO_BRIDGE ? "YES" : "no"}`);
  log(`🎟️  Invite    : ${INVITE_CODE || "(none)"}`);
  if (ONLY_ADDR) log(`🎯 Only addr : ${ONLY_ADDR}`);
  log("");

  const groqKey = loadGroqKey();
  const solver = new QuizSolver(groqKey);
  log(solver.isEnabled() ? `${C.green}🧠 Quiz solver: enabled (${GROQ_MODEL})${C.reset}` : `${C.yellow}🧠 Quiz solver: disabled${C.reset}`);

  const proxies = loadProxies();
  log(`🌐 Loaded ${proxies.length} proxy/proxies from ${PROXY_FILE}`);

  const hasProxies = proxies.length > 0;
  const effectiveThreads = hasProxies ? Math.min(THREADS, proxies.length) : 1;
  const hourlyThroughput = hasProxies ? proxies.length : 1;

  log(`⚡ Concurrency : ${effectiveThreads} worker thread(s)`);
  log(`⏱️  Throughput  : max ${hourlyThroughput} account(s)/hour (1h cooldown per IP)`);
  if (!hasProxies) {
    log(`${C.yellow}⚠️  No proxies detected in ${PROXY_FILE}! Only running 1 account per hour on Direct IP to prevent rate limits & Sybil bans.${C.reset}`);
    log(`${C.dim}💡 Add proxies to ${PROXY_FILE} to run up to ${THREADS} accounts simultaneously (1 account per proxy per hour).${C.reset}`);
  }

  const accounts = loadAccounts(proxies);
  log(`👥 Loaded ${accounts.length} account(s) from ${readText(PV_FILE)?.trim() ? PV_FILE : ACCOUNTS_FILE}`);
  if (accounts.length === 0) throw new Error("No valid accounts.");

  let provider = null;
  if (DO_LEND || DO_BRIDGE || DO_SWAP) {
    const testAgent = proxies.length > 0 ? getProxyAgent(proxies[0]) : null;
    provider = buildProvider(testAgent);
    try {
      const net = await withTimeout(provider.getNetwork(), RPC_CALL_TIMEOUT_MS, "RPC init");
      if (Number(net.chainId) !== CHAIN_ID) throw new Error(`chainId ${net.chainId}`);
      log(`${C.green}🌐 RPC OK: chainId ${net.chainId}${testAgent ? " (verified through proxy)" : ""}${C.reset}`);
    } catch (e) {
      log(`${C.red}🌐 RPC fail: ${e.message}${C.reset}`);
      log(`${C.yellow}⚠️  Continuing without provider check — accounts will test their individual providers.${C.reset}`);
      provider = null;
    }
  }

  const ctx = { solver, provider, accounts, proxies };

  if (RUN_ONCE) {
    await runCycle(ctx, 1);
    log(`\n${C.green}${C.bold}✅ --once given, exiting.${C.reset}`);
    return;
  }

  log(`\n${C.bold}${C.cyan}🚀 Starting daily loop. Ctrl+C to stop.${C.reset}`);
  let cycle = 1;
  while (true) {
    try { await runCycle(ctx, cycle); cycle++; }
    catch (e) { log(`${C.red}💥 Cycle crashed: ${e.message}${C.reset}`); }
    await sleepUntilNextRun(ctx);
  }
}

main().catch((e) => {
  console.error(`${C.red}💀 Fatal: ${e.message}${C.reset}`);
  process.exit(1);
});