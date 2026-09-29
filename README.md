# SvpChain Auto-Farmer Bot 🚀

An enterprise-grade, multi-account automation bot for **SVP Chain** rewards farming on [rewards.svpstars.com](https://rewards.svpstars.com/?invite=UWTL68DI).

---

## 🌟 Features

- 💧 **Automated Faucet Claiming**: Solves ALTCHA Proof-of-Work (PBKDF2 SHA-256) CAPTCHA locally and claims all testnet drip tokens (SVP, USDV, USDC, WBTC, WBNB). Unlocks daily quest sequence.
- 🧠 **AI Quiz Automation**: Solves daily quizzes using Groq LLM API (`openai/gpt-oss-120b`).
- 📅 **Daily Check-ins**: Automated signature-based check-in rewards.
- 🔄 **DEX Swaps**: Wraps SVP to WSVP and executes 3-leg swaps with slippage and EIP-1559 gas protection.
- 🏦 **Lendora Supply**: Automatically supplies tokens to Lendora lending pools with full token approvals and indexer verification.
- 🌉 **Cross-Chain Bridge**: Bridges SVP to Arbitrum Sepolia via official bridge contracts.
- 🌐 **Isolated Proxy Routing**: Binds each wallet to a dedicated proxy IP (HTTP, HTTPS, SOCKS5).
- ⚡ **Multi-Threaded Parallel Execution**: Run multiple accounts simultaneously with `--threads <N>` for maximum speed while preserving isolated proxy channels.
- 🎲 **Anti-Sybil Randomization**: Automatically shuffles wallet execution order on every cycle.

---

## 📋 Prerequisites

1. **Node.js**: Version 18.x, 20.x, or 22+ ([Download Node.js](https://nodejs.org/)).
2. **EVM Wallets**: One or more private keys on SVP Chain.
3. **Groq API Key (Optional)**: Free API key from [console.groq.com](https://console.groq.com) for auto-solving quizzes.
4. **Proxies (Optional)**: HTTP/SOCKS5 proxies for account isolation.

---

## 🔧 Installation & Setup

### 1. Extract & Install Dependencies

Open a terminal (PowerShell, Command Prompt, or Bash) in the bot folder:

```bash
npm install
```

### 2. Configure Wallets (`pv.txt`)

Open `pv.txt` and paste your private keys (one per line, with or without `0x`):

```text
0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd
```

> ⚠️ **SECURITY WARNING**: Never share your `pv.txt` file or commit it to GitHub!

### 3. Configure Proxies (`proxy.txt` - Optional)

Open `proxy.txt` and paste your proxies (one per line):

```text
http://username:password@ip:port
http://ip:port
socks5://username:password@ip:port
```

*Each wallet will automatically be bound to a proxy IP from this pool.*

### 4. Configure Groq AI Quiz (`groq.txt` - Optional)

Open `groq.txt` and paste your Groq API key:

```text
gsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

*Without this key, daily quiz tasks will simply be skipped.*

---

## 🚀 Running the Bot

### Test Setup (Dry Run)
Test your configuration, proxy connectivity, and tasks without spending real gas:
```bash
node index.js --dry --once
```

### Run a Single Complete Cycle
Process all accounts once and exit:
```bash
node index.js --once
```

### Run with Parallel Worker Threads (High Speed with Proxies)
Run multiple isolated worker threads in parallel:
```bash
node index.js --threads 10 --once
```

### Run 24/7 Automated Daily Loop
Runs continuously and repeats daily at UTC midnight:
```bash
node index.js --threads 10
```

---

## ⚙️ Command-Line Flags

| Flag | Description | Default |
| :--- | :--- | :--- |
| `--dry` | Test run without sending blockchain transactions | `false` |
| `--once` | Run a single cycle and exit (instead of 24/7 loop) | `false` |
| `--threads <N>` | Number of concurrent isolated worker threads (auto-capped by proxy count) | `10` |
| `--ip-cooldown <sec>` | Cooldown per IP between accounts (default 1 hour) | `3600` |
| `--no-shuffle` | Disable random account shuffling | `false` (shuffling active) |
| `--no-swap` | Skip DEX swap tasks | `false` |
| `--no-lend` | Skip Lendora lending tasks | `false` |
| `--no-bridge` | Skip cross-chain bridge tasks | `false` |
| `--only <addr>` | Run only for a specific wallet address | `all` |
| `--reset-hour <H>`| UTC hour for daily reset in loop mode | `0` |

---

## 🔒 IP Cooldown & Anti-Sybil Rate Limiting (1 IP / Account / Hour)

The rewards server strictly monitors IP addresses. To prevent rate limits and Sybil flags:
1. **Rule**: Each IP (proxy or direct) has a strict **1-hour cooldown** between account claims.
2. **How It Works**:
   - `Wallet A` uses `IP 123` to claim faucet and quests.
   - `IP 123` immediately enters a **1-hour cooldown** (`ip_cooldowns.json`).
   - For the next 60 minutes, `IP 123` cannot be used by any other wallet.
   - After 1 hour has elapsed, `IP 123` becomes active again to process `Wallet B`.
3. **Throughput Scaling**:
   - **No Proxies (0 in `proxy.txt`)**: The bot runs safely on Direct IP at **1 account per hour** (threads forced to 1).
   - **10 Proxies**: The bot runs **10 accounts per hour** (10 threads in parallel).
   - **N Proxies**: The bot runs **N accounts per hour**.
4. **Persistent Cooldowns**: IP cooldown timestamps are saved to `ip_cooldowns.json`. If you stop and restart the bot, remaining cooldowns are preserved so no IP is reused prematurely.

---

## 💡 Why Points Vary (700+ vs <400 Points) & How It's Handled

You might notice some wallets earn 700+ points while others get fewer than 400 or 100 points:
1. **Backend Indexing & Sync Delays**: On-chain actions (swaps, lending, bridge) take 30–90 seconds to be indexed by the SVP backend. If a script moves on before the server indexes the transaction, the task status becomes `claimable` a minute later. The bot performs automatic **Pre-Run** and **Post-Run Sweeps** to immediately harvest all points as soon as indexing finishes.
2. **Prerequisite Quest Chain**: SVP requires daily tasks to be completed in sequence (`Faucet Claim` ➔ `Check-in` ➔ `AI Quiz` ➔ `Swap` ➔ `Lendora` ➔ `Bridge` ➔ `Region Chest`). If the faucet claim was skipped due to a stale local timestamp, downstream quests error with `previous quest not completed`. The bot now guarantees faucet claims trigger whenever the daily quest is open.
3. **Region Chests**: Once all daily quests are claimed, the 300-point Region Chest unlocks. The bot verifies and claims this chest with automatic retries.

---

## 🛡️ Troubleshooting

- **HTTP 429 (Rate Limit)**: The rewards server limits rapid requests. Use proxies in `proxy.txt` and ensure cooldowns are respected.
- **Gas Fee / Reverts**: SVP Chain requires a minimum gas price of 2 Gwei. The bot enforces this automatically. Ensure accounts have at least `0.05 SVP` for gas.
- **Task Verification Indexer Delay**: SVP rewards indexer takes ~60–90 seconds to register on-chain transactions. The bot automatically waits and retries verification up to 6 times.

---

## 🎁 Rewards Portal

Sign up & track your points: **[rewards.svpstars.com/?invite=UWTL68DI](https://rewards.svpstars.com/?invite=UWTL68DI)**
