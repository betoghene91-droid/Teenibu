// ═══════════════════════════════════════════════════════════════════
//  TEENIBU v3.2 — recon · risk engine · guarded executor
//  Base · Solana · Robinhood | serverless | READ-ONLY unless armed
// ═══════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import { createWalletClient, createPublicClient, http, defineChain, parseEther, formatEther, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ── ENV ────────────────────────────────────────────────────────────
const TG_TOKEN = process.env.TG_TOKEN, TG_CHAT = process.env.TG_CHAT_ID;
const BS_KEY = process.env.BASESCAN_KEY || '', PK = process.env.PK || '', PIN = process.env.AUTH_PIN || '';
const PRIVATE_RPC = process.env.PRIVATE_RPC || '';
const FILE = 'memory.json', ORACLE = 'oracle.json';

const CHAINS = {
  base:      { id: 8453, rpc: process.env.BASE_RPC || 'https://mainnet.base.org', scan: 'https://api.basescan.org/api', gt: 'base' },
  robinhood: { id: 4663, rpc: process.env.RH_RPC || 'https://rpc.robinhoodchain.io', scan: '', gt: 'robinhood' },
};
const SOL_RPC = process.env.SOL_RPC || 'https://api.mainnet-beta.solana.com';

const MAX_ALERTS_PER_RUN = 3, MAX_ALERTS_PER_DAY = 8, MAX_UPDATES = 15;
const MIN_LIQ = 8000, MIN_TX = 12, MAX_AGE_H = 36, PATIENCE = 2, PAGES = 3;
const MAX_ETH_PER_TX = 0.002, MIN_SAMPLES = 10, GAS_MULT = 3;

const WETH = '0x4200000000000000000000000000000000000006';
const ROUTER = process.env.ROUTER || '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24';
const ALLOWLIST = (process.env.ALLOWLIST || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// ── CHAIN + WALLET ─────────────────────────────────────────────────
const vBase = defineChain({ id: 8453, name: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [CHAINS.base.rpc] } } });
let acct = null, pubBase = null, walletBase = null;
if (PK) {
  try {
    acct = privateKeyToAccount(PK.startsWith('0x') ? PK : '0x' + PK);
    pubBase = createPublicClient({ chain: vBase, transport: http(CHAINS.base.rpc) });
    walletBase = createWalletClient({ account: acct, chain: vBase, transport: http(PRIVATE_RPC || CHAINS.base.rpc) });
  } catch (e) { console.error('KEY_PARSE_FAIL', e.message); }
}

// ── STATE ──────────────────────────────────────────────────────────
const now = () => Date.now(), DAY = 864e5;
const today = () => new Date().toISOString().slice(0, 10);
const short = a => (a || '').slice(0, 10) + '…';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const randAddr = () => '0x' + [...crypto.getRandomValues(new Uint8Array(20))].map(b => b.toString(16).padStart(2, '0')).join('');

let S = { offset: 0, seen: {}, watch: {}, targets: {}, paused: false, alertsToday: 0, day: today(), authed: false, exec: { enabled: false, dryRun: true } };
let M = { outcomes: [], deployers: {}, learnedAt: 0, stats: {}, classBump: {} };

const BASE_W = {
  unguarded_mint: 1.2, unguarded_pause: 0.7, unguarded_withdraw: 1.5, unguarded_initialize: 1.6,
  proxy_uninitialized: 1.4, upgradeable_proxy: 0.6, selfdestruct: 0.5, delegatecall: 0.4,
  txorigin_auth: 0.5, unverified: 0.5, honeypot: 1.6, unsellable: 1.7, high_ownership: 0.9,
  lp_unlocked: 1.0, lp_pull: 1.3, dev_rugger: 1.5,
  // solana
  sol_mint_authority: 1.5, sol_freeze_authority: 1.2, sol_lp_unlocked: 1.3, sol_top10: 0.9, sol_honeypot: 1.6, sol_transfer_fee: 0.8,
};

function load() {
  try { const d = JSON.parse(fs.readFileSync(FILE, 'utf8')); S = { ...S, ...(d.S || {}) }; M = { ...M, ...(d.M || {}) }; } catch {}
  S.day = today(); S.alertsToday = 0;
  const cut = now() - 14 * DAY;
  for (const k of Object.keys(S.seen)) if ((S.seen[k] || 0) < cut) delete S.seen[k];
  for (const k of Object.keys(S.targets)) if ((S.targets[k].t || 0) < cut) delete S.targets[k];
  M.outcomes = (M.outcomes || []).slice(-500);
}
const save = () => { try { fs.writeFileSync(FILE, JSON.stringify({ S, M }, null, 1)); } catch (e) { console.error('SAVE_FAIL', e.message); } };

function weight(p) {
  const st = M.stats[p]; let w = BASE_W[p] ?? 1;
  if (st && st.n >= MIN_SAMPLES) w *= Math.max(0.3, Math.min(3, ((st.wins + 1) / (st.n + 2)) * 2));
  w *= (M.classBump[p] || 1);
  return w;
}
function decay() {
  const cut = now() - 14 * DAY;
  for (const [p, st] of Object.entries(M.stats)) {
    const old = M.outcomes.filter(o => o.tags?.includes(p) && o.ts < cut).length;
    if (!old || st.n <= MIN_SAMPLES) continue;
    const ratio = st.n ? st.wins / st.n : 0;          // FIX: ratio before mutation
    st.n = Math.max(MIN_SAMPLES, st.n - old * 0.5);
    st.wins = Math.max(0, st.wins - Math.round(old * 0.5 * ratio));
  }
}

// ── NET ────────────────────────────────────────────────────────────
async function jget(url, opt, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const c = new AbortController(); const to = setTimeout(() => c.abort(), 12000);
      const r = await fetch(url, { ...opt, signal: c.signal }); clearTimeout(to);
      if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
      return await r.json();
    } catch { await sleep(700 * (i + 1)); }
  }
  return null;
}
async function send(t) {
  if (!TG_TOKEN || !TG_CHAT) return console.log('[tg]', t);
  await jget(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text: t, disable_web_page_preview: true }) }, 2);
}
async function rpc(chain, method, params, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await jget(CHAINS[chain].rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }, 1);
    if (r === null) { await sleep(600 * (i + 1)); continue; }
    if (r.error) return { ok: false, revert: true, err: r.error.message };
    return { ok: true, data: r.result };
  }
  return { ok: false, revert: false, err: 'rpc_down' };
}
const call = (chain, to, data, from) => rpc(chain, 'eth_call', [{ to, data, ...(from ? { from } : {}) }, 'latest']);
const getCode = async (c, a) => (await rpc(c, 'eth_getCode', [a, 'latest'])).data || null;
const getSlot = async (c, a, s) => (await rpc(c, 'eth_getStorageAt', [a, s, 'latest'])).data || null;
const getBal = async (c, a) => { const r = await rpc(c, 'eth_getBalance', [a, 'latest']); return r.ok ? BigInt(r.data) : 0n; };
const EIP1967 = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ZERO32 = '0x' + '0'.repeat(64), ZERO20 = '0x' + '0'.repeat(40);
const selOf = (sig) => keccak256(toHex(sig)).slice(0, 10);

// ── ANALYSIS ───────────────────────────────────────────────────────
function analyzeBytecode(code) {
  const c = (code || '').slice(2).toLowerCase();
  const out = { selectors: [], selfdestruct: false, delegatecall: false, txorigin: false, create2: false };
  let i = 0, pushes = [];
  while (i < c.length) {
    const op = parseInt(c.slice(i, i + 2), 16); if (Number.isNaN(op)) break;
    if (op >= 0x60 && op <= 0x7f) { const n = op - 0x5f; const v = c.slice(i + 2, i + 2 + n * 2); if (n === 4) pushes.push({ v, at: i }); i += 2 + n * 2; continue; }
    if (op === 0xff) out.selfdestruct = true;
    if (op === 0xf4) out.delegatecall = true;
    if (op === 0x32) out.txorigin = true;
    if (op === 0xf5) out.create2 = true;
    if (op === 0x14) { for (const p of pushes) if (i - p.at < 40) out.selectors.push('0x' + p.v); pushes = []; }
    i += 2;
  }
  out.selectors = [...new Set(out.selectors)];
  return out;
}
async function abiSelectors(chain, addr) {
  if (!BS_KEY || !CHAINS[chain].scan) return null;
  const j = await jget(`${CHAINS[chain].scan}?module=contract&action=getabi&address=${addr}&apikey=${BS_KEY}`);
  if (!j?.result || typeof j.result !== 'string' || !j.result.startsWith('[')) return null;
  try {
    return JSON.parse(j.result).filter(x => x.type === 'function')
      .map(f => ({ sel: selOf(`${f.name}(${(f.inputs || []).map(i => i.type).join(',')})`), name: f.name }));
  } catch { return null; }
}
async function sellCheck(chain, token) {
  if (!ROUTER) return null;
  const amt = (10n ** 18n).toString(16).padStart(64, '0');
  const data = '0xd06ca61f' + amt + '40'.padStart(64, '0') + '2'.padStart(64, '0') + token.slice(2).padStart(64, '0') + WETH.slice(2).padStart(64, '0');
  const r = await call(chain, ROUTER, data);
  if (r.ok) return true; if (r.revert) return false; return null;
}

async function scanEVM(chain, addr, tr) {
  const f = { chain, addr, findings: [], selectors: [], unguarded: [], log: [] };
  const push = t => { f.log.push(t); if (tr) tr.push(t); };
  const code = await getCode(chain, addr);
  if (!code || code === '0x') { f.findings.push('no_code'); return f; }

  const a = analyzeBytecode(code);
  const abi = await abiSelectors(chain, addr);
  f.selectors = abi ? abi.map(x => x.sel) : a.selectors;
  push(`size ${(code.length - 2) / 2}B · selectors ${f.selectors.length}${abi ? ' (from ABI)' : ' (from bytecode)'}`);
  if (a.selfdestruct) f.findings.push('selfdestruct');
  if (a.txorigin) f.findings.push('txorigin_auth');
  if (a.create2) f.findings.push('create2_factory');

  const c = CHAINS[chain];
  if (c.scan && BS_KEY) {
    const m = await jget(`${c.scan}?module=contract&action=getsourcecode&address=${addr}&apikey=${BS_KEY}`);
    if (m?.result?.[0] && !m.result[0].SourceCode) { f.findings.push('unverified'); push('UNVERIFIED'); }
  }
  const slot = await getSlot(chain, addr, EIP1967);
  let isProxy = false;
  if (slot && slot !== ZERO32 && BigInt(slot) !== 0n) {
    const impl = '0x' + slot.slice(-40); const ic = await getCode(chain, impl);
    if (ic && ic !== '0x') { f.impl = impl; f.findings.push('upgradeable_proxy'); isProxy = true; push('proxy → ' + short(impl)); }
  }
  if (a.delegatecall && !isProxy) {                     // FIX: dedupe
    if (f.selectors.includes('0x8129fc1c')) { f.findings.push('proxy_uninitialized'); push('uninitialized proxy'); }
    else f.findings.push('delegatecall');
  }
  const gp = await jget(`https://api.gopluslabs.io/api/v1/token_security/${c.id}?contract_addresses=${addr}`);
  const g = Object.values(gp?.result || {})[0];
  if (g) {
    if (g.is_honeypot === '1' || g.cannot_sell_all === '1') f.findings.push('honeypot');
    if (+(g.top_10_holder_rate || 0) > 0.5) f.findings.push('high_ownership');
    if (g.lp_holder_count === '0') f.findings.push('lp_unlocked');
    if (g.creator_address && M.deployers[g.creator_address.toLowerCase()]?.rugs) f.findings.push('dev_rugger');
  }
  if (await sellCheck(chain, addr) === false) { f.findings.push('unsellable'); push('router SELL REVERT'); }

  let owner = null;
  const o = await call(chain, addr, '0x8da5cb5b');
  if (o.ok && o.data?.length >= 42) { const cd = '0x' + o.data.slice(-40); if (cd !== ZERO20) owner = cd; }

  const PROBES = [['mint','0x1249c58b'],['pause','0x8456cb59'],['withdraw','0x3ccfd60b'],['withdraw','0x853828b6'],['initialize','0x8129fc1c']];
  const rnd = randAddr();                               // FIX: randomized fingerprint
  for (const [name, sel] of PROBES) {
    if (!f.selectors.includes(sel)) continue;
    const asR = await call(chain, addr, sel, rnd);
    if (!asR.ok && !asR.revert) continue;
    if (asR.ok) { f.unguarded.push(name); f.findings.push('unguarded_' + name); push(`${name}: ✅ UNGUARDED`); continue; }
    const asO = owner ? await call(chain, addr, sel, owner) : null;
    push(`${name}: ${asO?.ok ? '🔒 guarded' : 'reverts'}`);
  }
  return f;
}

function scoreFindings(findings) {
  let score = 0; const hits = [];
  for (const k of [...new Set(findings)]) { const w = weight(k); score += w * 10; hits.push(`${k} (${w.toFixed(2)})`); }
  return { score: Math.min(100, Math.round(score)), hits };
}

// ── SOLANA ─────────────────────────────────────────────────────────
async function scanSVM(addr, tr) {
  const [g, r] = await Promise.all([
    jget(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${addr}`),
    jget(`https://api.rugcheck.xyz/v1/tokens/${addr}/report/summary`),
  ]);
  const t = Object.values(g?.result || {})[0] || {};
  const findings = [];
  if (t.mintable?.mint_authority) findings.push('sol_mint_authority');
  if (t.freezable?.freeze_authority) findings.push('sol_freeze_authority');
  if (t.is_honeypot === '1') findings.push('sol_honeypot');
  if (+(t.top10_holders_rate || 0) > 0.5) findings.push('sol_top10');
  if (r?.lpLockedPct != null && r.lpLockedPct < 50) findings.push('sol_lp_unlocked');
  if (r?.token?.transferFee?.pct > 5) findings.push('sol_transfer_fee');
  return { findings, rug: r?.score ?? null, locked: r?.lpLockedPct ?? null, top10: +(t.top10_holders_rate || 0) * 100 };
}

// ── EXECUTOR ───────────────────────────────────────────────────────
async function gasCost(chain, to, data, value = 0n) {
  const e = await rpc(chain, 'eth_estimateGas', [{ to, data, value: '0x' + value.toString(16) }, 'latest']);
  const p = await rpc(chain, 'eth_gasPrice', []);
  if (!e.ok || !p.ok) return null;
  return BigInt(e.data) * BigInt(p.data);
}
async function exSend(to, data, value = 0n, bypass = false) {
  if (!acct) return 'NO_KEY';
  if (!S.exec.enabled) return 'DISARMED';
  if (!bypass && value > parseEther(String(MAX_ETH_PER_TX))) return 'OVER_CAP';
  if (ALLOWLIST.length && !ALLOWLIST.includes(to.toLowerCase())) return 'NOT_ALLOWED';
  const sim = await call('base', to, data, acct.address);
  if (!sim.ok && sim.revert) return 'REVERT:' + (sim.err || '').slice(0, 50);
  if (!sim.ok) return 'PREFLIGHT_FAIL';
  if (S.exec.dryRun) return 'DRY';
  try { return await walletBase.sendTransaction({ to, data, value }); }
  catch (e) { return 'FAIL:' + e.message.slice(0, 50); }
}

// ── PIPELINE ───────────────────────────────────────────────────────
async function sourcer() {
  if (S.paused) return 0;
  if (S.day !== today()) { S.day = today(); S.alertsToday = 0; }
  let fired = 0;
  for (const chain of ['base', 'solana']) {
    for (let page = 1; page <= PAGES; page++) {
      const j = await jget(`https://api.geckoterminal.com/api/v2/networks/${chain}/new_pools?page=${page}`);
      for (const p of j?.data || []) {
        if (fired >= MAX_ALERTS_PER_RUN || S.alertsToday >= MAX_ALERTS_PER_DAY) break;
        const addr = (p.relationships?.base_token?.data?.id || '').split('_').slice(1).join('_');
        if (!addr || S.seen[addr]) continue;
        const liq = +p.attributes.reserve_in_usd || 0, fdv = +(p.attributes.fdv_usd || p.attributes.market_cap_usd) || 0;
        const tx = (p.attributes.transactions?.h24?.buys || 0) + (p.attributes.transactions?.h24?.sells || 0);
        const ageH = (now() - new Date(p.attributes.pool_created_at).getTime()) / 3600e3;
        if (liq < MIN_LIQ || !fdv || fdv > 900_000 || tx < MIN_TX || ageH > MAX_AGE_H) continue;
        const w = S.watch[addr];
        if (!w) { S.watch[addr] = { runs: 1 }; continue; }
        w.runs++; if (w.runs < PATIENCE) continue;

        let score = 0, tags = [];
        if (chain === 'base') { const f = await scanEVM('base', addr); const r = scoreFindings(f.findings); score = r.score; tags = f.findings; }
        else { const s = await scanSVM(addr); const r = scoreFindings(s.findings); score = r.score; tags = s.findings; }
        S.seen[addr] = now(); delete S.watch[addr];
        if (score < 40) continue;

        fired++; S.alertsToday++;
        S.targets[addr] = { chain, t: now(), score, tags, liq, entry: +p.attributes.base_token_price_usd || 0, pair: p.attributes.address, maxUp: 1, maxDown: 1 };
        await send(`🧬 TEENIBU ${score}/100 ${p.attributes.name}\nLiq $${Math.round(liq).toLocaleString()} · MCap $${Math.round(fdv).toLocaleString()}\n${tags.length ? '⚠ ' + [...new Set(tags)].join(', ') : '✅ clean'}\nhttps://dexscreener.com/${chain}/${addr}`);
      }
    }
  }
  return fired;
}

async function monitor() {
  for (const [addr, t] of Object.entries(S.targets)) {
    if (t.done) continue;
    const j = await jget(`https://api.dexscreener.com/latest/dex/pairs/${t.chain}/${t.pair}`);
    const pair = j?.pairs?.[0]; if (!pair) continue;
    const price = +pair.priceUsd || 0, liqNow = +pair.liquidity?.usd || 0;
    if (price && t.entry) { const m = price / t.entry; t.maxUp = Math.max(t.maxUp || 1, m); t.maxDown = Math.min(t.maxDown || 1, m); }
    if (t.liq && liqNow && liqNow < t.liq * 0.5 && !t.lpPulled) {
      t.lpPulled = true;
      await send(`🚨 LP PULL ${short(addr)}\n$${Math.round(t.liq).toLocaleString()} → $${Math.round(liqNow).toLocaleString()}`);
    }
  }
}

async function resolve() {
  for (const [addr, t] of Object.entries(S.targets)) {
    if (t.done || now() - t.t < 24 * 3600e3) continue;
    const j = await jget(`https://api.dexscreener.com/latest/dex/pairs/${t.chain}/${t.pair}`);
    const price = +(j?.pairs?.[0]?.priceUsd || 0); if (!price || !t.entry) continue;
    const mult = price / t.entry;
    const survived = mult >= 0.5 && !t.lpPulled;              // FIX: survival, not peak
    t.result = +mult.toFixed(2); t.done = true;
    for (const tag of [...new Set(t.tags)]) {
      M.stats[tag] ??= { n: 0, wins: 0 }; M.stats[tag].n++;
      if (survived && t.maxUp >= 1.5) M.stats[tag].wins++;
    }
    if (t.lpPulled) { M.stats.lp_pull ??= { n: 0, wins: 0 }; M.stats.lp_pull.n++; }
    M.outcomes.push({ addr, tags: t.tags, mult: t.result, maxUp: t.maxUp, maxDown: t.maxDown, survived, ts: now() });
  }
  decay();
}

async function learn() {
  const txt = await jget('https://raw.githubusercontent.com/SunWeb3Sec/DeFiHackLabs/main/README.md');
  if (!txt) return '🧠 learn failed';
  const s = JSON.stringify(txt).toLowerCase();
  const MAP = { oracle: ['high_ownership'], reentrancy: ['unsellable'], 'access control': ['unguarded_mint','unguarded_withdraw','unguarded_initialize'], uninitialized: ['proxy_uninitialized'], flashloan: ['unsellable'], signature: ['txorigin_auth'], 'storage collision': ['proxy_uninitialized'], governance: ['unguarded_pause'] };
  const active = [];
  for (const [cls, tags] of Object.entries(MAP)) {
    if (!s.includes(cls)) continue;
    active.push(cls);
    for (const t of tags) M.classBump[t] = Math.min(1.5, (M.classBump[t] || 1) + 0.05);   // FIX: real effect
  }
  M.learnedAt = now();
  return `🧠 ${active.length} attack classes trending\n${active.join(' · ')}\nBoosted: ${Object.entries(M.classBump).filter(([,v])=>v>1).map(([k,v])=>k+':'+v.toFixed(2)).join(', ') || 'none'}`;
}

function writeOracle() {
  const o = { v: '3.2', ts: now(), signals: Object.entries(S.targets).map(([a, t]) => ({ addr: a, chain: t.chain, score: t.score, tags: t.tags })), patterns: Object.fromEntries(Object.keys(BASE_W).map(k => [k, +weight(k).toFixed(2)])) };
  try { fs.writeFileSync(ORACLE, JSON.stringify(o, null, 1)); } catch {}
  return o;
}

// ── REPORTS ────────────────────────────────────────────────────────
async function scanText(chain, addr) {
  if (chain === 'solana') {
    const s = await scanSVM(addr);
    const { score, hits } = scoreFindings(s.findings);
    return `🧬 TEENIBU — solana ${short(addr)}\nDANGER ${score}/100 · rugcheck ${s.rug ?? 'n/a'}\n${hits.length ? '⚠ ' + hits.join('\n⚠ ') : '✅ no flags'}\nhttps://solscan.io/token/${addr}`;
  }
  const f = await scanEVM(chain, addr);
  if (f.findings.includes('no_code')) return `❌ no contract at ${short(addr)}`;
  const { score, hits } = scoreFindings(f.findings);
  const un = [...new Set(f.unguarded)];
  return `🧬 TEENIBU — ${chain} ${short(addr)}\nDANGER ${score}/100\n\n${un.length ? '🔓 UNGUARDED:\n' + un.map(x => '• ' + x + ' ⚠').join('\n') : '🔒 none'}\n\n${hits.length ? '🧪 ' + hits.join('\n• ') : '• none'}`;
}

// ── COMMANDS ───────────────────────────────────────────────────────
async function handle() {
  const r = await jget(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${S.offset}&timeout=0&allowed_updates=%5B%22message%22%5D`);
  let n = 0;
  for (const u of r?.result || []) {
    if (n++ > MAX_UPDATES) break;                            // FIX: backlog guard
    S.offset = u.update_id + 1;
    if (String(u.message?.chat?.id) !== String(TG_CHAT)) continue;
    const [cmd, a, b, c] = (u.message.text || '').trim().split(/\s+/);
    const ok = () => !PIN || S.authed;

    if (cmd === '/ping') await send(`🧬 Teenibu v3.2 · exec=${S.exec.enabled ? 'ARMED' : 'off'} · ${S.exec.dryRun ? 'DRY' : 'LIVE'}`);
    else if (cmd === '/auth' && a) { S.authed = a === PIN; await send(S.authed ? '🔓 authed' : '❌ wrong pin'); }
    else if (cmd === '/scan' && a) await send(await scanText(a === 'sol' ? 'solana' : 'base', b || a));
    else if (cmd === '/explain' && a) { const t = []; await scanEVM('base', a, t); await send('🔬 TRANSCRIPT\n' + t.join('\n')); }
    else if (cmd === '/learn') await send(await learn());
    else if (cmd === '/oracle') { const o = writeOracle(); await send(`📡 ${o.signals.length} signals exported`); }
    else if (cmd === '/stats') { const d = M.outcomes, w = d.filter(o => o.survived && o.maxUp >= 1.5).length; await send(`📊 ${d.length} resolved · ${w} winners · ${d.length ? Math.round(w / d.length * 100) : 0}%\nMatured: ${Object.values(M.stats).filter(s => s.n >= MIN_SAMPLES).length}`); }
    else if (cmd === '/watch' && a) { S.watch[a] = { runs: 0 }; await send('👁 ' + short(a)); }
    else if (cmd === '/pause') { S.paused = true; await send('⏸'); }
    else if (cmd === '/resume') { S.paused = false; await send('▶️'); }
    else if (cmd === '/exec') { if (!ok()) return await send('🔒 /auth first'); if (a === 'on') { S.exec.enabled = true; await send('⚔️ ARMED ' + (S.exec.dryRun ? 'DRY' : 'LIVE')); } else { S.exec.enabled = false; await send('⚔️ disarmed'); } }
    else if (cmd === '/live') { if (a === 'on' && !b) await send('⚠️ LIVE — sends real txs. /live on yes'); else { S.exec.dryRun = a !== 'on'; await send('mode ' + (S.exec.dryRun ? 'DRY' : 'LIVE')); } }
    else if (cmd === '/bal') await send(acct ? `💰 ${acct.address}\n${formatEther(await pubBase.getBalance({ address: acct.address }))} ETH` : 'no PK');
    else if (cmd === '/sweep' && a) {
      if (!ok() || !acct) return await send('🔒 auth/key');
      const bal = await pubBase.getBalance({ address: acct.address }), buf = parseEther('0.00005');
      if (bal <= buf) return await send('nothing to sweep');
      if (b !== 'confirm') return await send(`🧹 will send ${formatEther(bal - buf)} ETH → ${a}\nreply: /sweep ${a} confirm`);
      await send('🧹 ' + await exSend(a, '0x', bal - buf, true));
    }
    else if (cmd === '/call' && a && b) { if (!ok() || !acct) return await send('🔒 auth/key'); await send('⚔️ ' + await exSend(a, b, 0n)); }
    else if (cmd === '/drain' && a) {
      const f = await scanEVM('base', a);
      const un = [...new Set(f.unguarded)];
      if (!un.length) return await send('🔒 no unguarded functions');
      const map = { mint: '0x1249c58b', pause: '0x8456cb59', withdraw: '0x3ccfd60b', initialize: '0x8129fc1c' };
      const out = [];
      for (const nm of un) {
        const s = map[nm]; if (!s) continue;
        const sim = await call('base', a, s, acct?.address || randAddr());
        const gas = await gasCost('base', a, s);
        const loot = await getBal('base', a);
        const worth = gas && loot > gas * BigInt(GAS_MULT);
        out.push(`${nm}: ${sim.ok ? '✅ callable' : '❌ reverts'}${sim.ok ? worth ? ` · 💰 ${formatEther(loot)} ETH > gas×${GAS_MULT}` : ` · ⚠ ${formatEther(loot)} ETH (gas×${GAS_MULT} = ${formatEther(gas * BigInt(GAS_MULT))})` : ''}`);
      }
      const sellable = await sellCheck('base', a);
      await send(`🩸 DRAIN ${short(a)}\n${out.join('\n')}\n${sellable === false ? '⚠ token UNSELLABLE — draining gets you nothing' : ''}\n${acct ? 'wallet ' + short(acct.address) : 'no PK'}`);
    }
    else if (cmd === '/drainall') {
      const t = Object.entries(S.targets).filter(([, x]) => !x.done);
      const out = [];
      for (const [addr] of t.slice(0, 8)) { const f = await scanEVM('base', addr); if (f.unguarded.length) out.push(`${short(addr)} → ${[...new Set(f.unguarded)].join(',')}`); }
      await send(out.length ? '🩸 TARGETS WITH UNGUARDED FNs\n' + out.join('\n') : 'none');
    }
    else if (cmd === '/help') await send(`🧬 TEENIBU\n/auth <pin> · /scan <addr> · /scan sol <mint>\n/explain <addr> · /learn · /oracle · /stats · /watch\n⚔️ /exec on|off · /live on|off · /bal · /sweep <to> confirm\n/call <a> <data> · /drain <a> · /drainall`);
  }
}

// ── MAIN ───────────────────────────────────────────────────────────
(async () => {
  load();
  await handle();
  const n = await sourcer();
  await monitor();
  await resolve();
  writeOracle();
  save();
  console.log('teenibu v3.2 — alerts:', n);
})().catch(e => { console.error(e); save(); });
