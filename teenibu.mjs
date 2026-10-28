// ═══════════════════════════════════════════════════════════════════
//  TEENIBU v4.1 — GOD MODE
//  find → market score → security probe → verdict → auto-buy → manage → sell
//  + auto-drain | Base EVM + Solana scan | serverless | DRY unless armed
// ═══════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import { createWalletClient, createPublicClient, http, defineChain, parseEther, formatEther, keccak256, toHex, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ── ENV ────────────────────────────────────────────────────────────
const TG_TOKEN = process.env.TG_TOKEN, TG_CHAT = process.env.TG_CHAT_ID;
const BS_KEY = process.env.BASESCAN_KEY || '', PK = process.env.PK || '', PIN = process.env.AUTH_PIN || '';
const PRIVATE_RPC = process.env.PRIVATE_RPC || '';
const FILE = 'memory.json', ORACLE = 'oracle.json';

const CHAINS = {
  base:   { id: 8453, rpc: process.env.BASE_RPC || 'https://mainnet.base.org', scan: 'https://api.basescan.org/api', gt: 'base', type: 'evm' },
  solana: { gt: 'solana', type: 'svm' },
};
const WETH = '0x4200000000000000000000000000000000000006';
const ROUTER = process.env.ROUTER || '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24';
const ROUTER_ABI = [
  { name: 'swapExactETHForTokensSupportingFeeOnTransferTokens', type: 'function', stateMutability: 'payable', inputs: [{ type: 'uint256' }, { type: 'address[]' }, { type: 'address' }, { type: 'uint256' }], outputs: [] },
  { name: 'swapExactTokensForETHSupportingFeeOnTransferTokens', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'address[]' }, { type: 'address' }, { type: 'uint256' }], outputs: [] },
  { name: 'getAmountsOut', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }, { type: 'address[]' }], outputs: [{ type: 'uint256[]' }] },
];
const ERC20_ABI = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
];

// ── TUNING ─────────────────────────────────────────────────────────
const CFG = {
  minLiq: 8000, maxFdv: 900_000, minTx: 15, maxAgeH: 24, patience: 2, pages: 3,
  marketMin: 55, securityMin: 50, strongMarket: 70, strongSecurity: 65,
  tradeEth: 0.0004,
  slippage: 0.18,
  gasReserve: 0.00008,
  maxPositions: 1,
  tp1: 2.0, tp2: 4.0, trailArm: 3.0, trailPct: 0.30, stopLoss: 0.60, timeExitH: 4,
  drainMinLoot: 0.0002, drainGasMult: 3,
  maxAlertsPerRun: 3, maxAlertsPerDay: 10, maxUpdates: 15,
};
const LIVE = () => S.live;
const AUTO = () => S.auto;

// ── WALLET ─────────────────────────────────────────────────────────
const vBase = defineChain({ id: 8453, name: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [CHAINS.base.rpc] } } });
let acct = null, pub = null, wal = null;
if (PK) { try {
  acct = privateKeyToAccount(PK.startsWith('0x') ? PK : '0x' + PK);
  pub = createPublicClient({ chain: vBase, transport: http(CHAINS.base.rpc) });
  wal = createWalletClient({ account: acct, chain: vBase, transport: http(PRIVATE_RPC || CHAINS.base.rpc) });
} catch (e) { console.error('KEY_FAIL', e.message); } }

// ── STATE ──────────────────────────────────────────────────────────
const now = () => Date.now(), DAY = 864e5, today = () => new Date().toISOString().slice(0, 10);
const short = a => (a || '').slice(0, 10) + '…';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const randAddr = () => '0x' + [...crypto.getRandomValues(new Uint8Array(20))].map(b => b.toString(16).padStart(2, '0')).join('');
const deadline = () => Math.floor(now() / 1000) + 600;

let S = { offset: 0, seen: {}, watch: {}, targets: {}, positions: {}, paused: false, authed: false, live: false, auto: false, alertsToday: 0, day: today() };
let M = { outcomes: [], deployers: {}, stats: {}, classBump: {}, drained: [] };
const BASE_W = {
  unguarded_mint: 1.2, unguarded_pause: 0.7, unguarded_withdraw: 1.5, unguarded_initialize: 1.6,
  proxy_uninitialized: 1.4, upgradeable_proxy: 0.6, unverified: 0.5, honeypot: 1.6, unsellable: 1.7,
  high_ownership: 0.9, lp_unlocked: 1.0, dev_rugger: 1.5, txorigin_auth: 0.5,
  sol_mint_authority: 1.5, sol_freeze_authority: 1.2, sol_lp_unlocked: 1.3,
  sol_top10: 0.9, sol_transfer_fee: 0.8,
};

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    S = { ...S, ...(d.S || {}) };
    M = { ...M, ...(d.M || {}) };
  } catch {}
  S.seen = S.seen || {};
  M.stats = M.stats || {};
  M.classBump = M.classBump || {};
  if (S.day !== today()) { S.day = today(); S.alertsToday = 0; }
  S.alertsToday = S.alertsToday || 0;
  const cut = now() - 14 * DAY;
  for (const k of Object.keys(S.seen)) if ((S.seen[k] || 0) < cut) delete S.seen[k];
}
const save = () => {
  try {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ S, M }, null, 1));
    fs.renameSync(tmp, FILE);
  } catch {}
};

function weight(p) {
  const st = M.stats?.[p];
  let w = BASE_W[p] ?? 1;
  if (st && st.n >= 10) w *= Math.max(0.3, Math.min(3, ((st.wins + 1) / (st.n + 2)) * 2));
  return w * (M.classBump?.[p] || 1);
}

// ── NET ────────────────────────────────────────────────────────────
async function jget(url, opt, tries = 3) { for (let i = 0; i < tries; i++) { try {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 12000);
  const r = await fetch(url, { ...opt, signal: c.signal }); clearTimeout(t);
  if (r.status === 429) { await sleep(1500 * (i + 1)); continue; } return await r.json();
} catch { await sleep(700 * (i + 1)); } } return null; }
async function send(t) { if (!TG_TOKEN || !TG_CHAT) return console.log('[tg]', t);
  await jget(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text: t, disable_web_page_preview: true }) }, 2); }
async function rpc(method, params, tries = 3) { for (let i = 0; i < tries; i++) {
  const r = await jget(CHAINS.base.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }, 1);
  if (r === null) { await sleep(600 * (i + 1)); continue; }
  if (r.error) return { ok: false, revert: true, err: r.error.message }; return { ok: true, data: r.result };
} return { ok: false, revert: false }; }
const call = (to, data, from) => rpc('eth_call', [{ to, data, ...(from ? { from } : {}) }, 'latest']);
const getCode = async a => (await rpc('eth_getCode', [a, 'latest'])).data || null;
const getSlot = async (a, s) => (await rpc('eth_getStorageAt', [a, s, 'latest'])).data || null;
const getBal = async a => { const r = await rpc('eth_getBalance', [a, 'latest']); return r.ok ? BigInt(r.data) : 0n; };
const EIP1967 = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ZERO32 = '0x' + '0'.repeat(64), ZERO20 = '0x' + '0'.repeat(40);

// ── ANALYSIS ───────────────────────────────────────────────────────
function analyzeBytecode(code) {
  const c = (code || '').slice(2).toLowerCase();
  const out = { selectors: [], selfdestruct: false, delegatecall: false, txorigin: false };
  let i = 0, pushes = [];
  while (i < c.length) {
    const op = parseInt(c.slice(i, i + 2), 16);
    if (Number.isNaN(op)) break;
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      if (n === 4) pushes.push({ v: c.slice(i + 2, i + 10), at: i });
      i += 2 + n * 2;
      continue;
    }
    if (op === 0xff) out.selfdestruct = true;
    if (op === 0xf4) out.delegatecall = true;
    if (op === 0x32) out.txorigin = true;
    if (op === 0x14) {
      for (const p of pushes) if (i - p.at < 40) out.selectors.push('0x' + p.v);
      pushes = [];
    }
    i += 2;
  }
  out.selectors = [...new Set(out.selectors)];
  return out;
}

const abiType = (t) => t.type.startsWith('tuple') ? `(${t.components.map(abiType).join(',')})${t.type.slice(5)}` : t.type;

async function abiSelectors(addr) {
  if (!BS_KEY) return null;
  const j = await jget(`${CHAINS.base.scan}?module=contract&action=getabi&address=${addr}&apikey=${BS_KEY}`);
  if (!j?.result || !String(j.result).startsWith('[')) return null;
  try {
    return JSON.parse(j.result).filter(x => x.type === 'function')
      .map(f => keccak256(toHex(`${f.name}(${(f.inputs || []).map(abiType).join(',')})`)).slice(0, 10));
  } catch { return null; }
}

async function amountsOut(amountIn, path) {
  const r = await call(ROUTER, encodeFunctionData({ abi: ROUTER_ABI, functionName: 'getAmountsOut', args: [amountIn, path] }));
  if (!r.ok) return null;
  try {
    const d = r.data.slice(2);
    const n = parseInt(d.slice(64, 128), 16);
    if (!n) return null;
    const start = 128 + (n - 1) * 64;
    return BigInt('0x' + d.slice(start, start + 64));
  } catch { return null; }
}

// ── SECURITY SCAN ──────────────────────────────────────────────────
async function securityScan(addr) {
  const f = { findings: [], selectors: [], unguarded: [], owner: null, verified: false, lpLocked: false };
  const code = await getCode(addr);
  if (code === null) { f.findings.push('rpc_error'); return f; }
  if (code === '0x') { f.findings.push('no_code'); return f; }
  const a = analyzeBytecode(code); const abi = await abiSelectors(addr);
  f.selectors = abi || a.selectors;
  if (a.txorigin) f.findings.push('txorigin_auth');
  const meta = await jget(`${CHAINS.base.scan}?module=contract&action=getsourcecode&address=${addr}&apikey=${BS_KEY}`);
  if (meta?.result?.[0] && !meta.result[0].SourceCode) f.findings.push('unverified');
  else f.verified = true;
  const slot = await getSlot(addr, EIP1967);
  if (slot && slot !== ZERO32 && BigInt(slot) !== 0n) { const impl = '0x' + slot.slice(-40); const ic = await getCode(impl); if (ic && ic !== '0x') f.findings.push('upgradeable_proxy'); }
  const gp = await jget(`https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${addr}`);
  const g = Object.values(gp?.result || {})[0];
  if (g) {
    if (g.is_honeypot === '1' || g.cannot_sell_all === '1') f.findings.push('honeypot');
    if (+(g.top_10_holder_rate || 0) > 0.5) f.findings.push('high_ownership');
    if (g.lp_holder_count === '0') f.findings.push('lp_unlocked'); else f.lpLocked = true;
    if (g.creator_address && M.deployers[g.creator_address.toLowerCase()]?.rugs) f.findings.push('dev_rugger');
  }
  const o = await call(addr, '0x8da5cb5b'); if (o.ok && o.data?.length >= 42) { const c2 = '0x' + o.data.slice(-40); if (c2 !== ZERO20) f.owner = c2; }
  const rnd = randAddr();
  for (const [nm, sel] of [['mint','0x1249c58b'],['pause','0x8456cb59'],['withdraw','0x3ccfd60b'],['initialize','0x8129fc1c']]) {
    if (!f.selectors.includes(sel)) continue;
    const r = await call(addr, sel, rnd); if (r.ok) { f.unguarded.push(nm); f.findings.push('unguarded_' + nm); }
  }
  return f;
}

function securityScore(findings, extra = {}) {
  if (findings.includes('no_code')) return { score: 0, hits: ['no_code — not a contract'] };
  if (findings.includes('rpc_error')) return { score: -1, hits: ['rpc_error — retry'] };
  let s = 70; const hits = [];
  if (extra.verified) s += 10;
  if (extra.lpLocked) s += 8;
  for (const k of [...new Set(findings)]) { s -= weight(k) * 12; hits.push(k); }
  if (findings.includes('honeypot') || findings.includes('unsellable')) s = Math.min(s, 25);
  if (findings.includes('unguarded_withdraw')) s = Math.min(s, 35);
  if (findings.includes('unguarded_mint')) s = Math.min(s, 50);
  return { score: Math.max(0, Math.min(100, Math.round(s))), hits };
}

function marketScore(t) { let s = 0;
  s += t.liq > 30000 ? 25 : t.liq > 15000 ? 15 : 8;
  s += t.fdv < 150000 ? 25 : t.fdv < 400000 ? 15 : 6;
  s += t.tx > 300 ? 25 : t.tx > 100 ? 15 : 6;
  s += (t.ageH > 1 && t.ageH < 12) ? 25 : 12; return Math.min(100, s); }

function verdict(mk, sc) {
  if (sc < 35) return 'TRAP';
  if (mk >= CFG.strongMarket && sc >= CFG.strongSecurity) return 'STRONG';
  if (mk >= CFG.marketMin && sc >= CFG.securityMin) return 'BUY';
  return 'WATCH';
}

// ── SOLANA SCAN ────────────────────────────────────────────────────
async function scanSVM(addr) {
  const [g, r] = await Promise.all([
    jget(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${addr}`),
    jget(`https://api.rugcheck.xyz/v1/tokens/${addr}/report/summary`),
  ]);
  const t = Object.values(g?.result || {})[0] || {};
  const f = { findings: [], svm: true, rug: r?.score ?? null, locked: r?.lpLockedPct ?? null, unguarded: [], verified: true, lpLocked: false };
  if (t.mintable?.status === '1' || t.mintable?.mint_authority) f.findings.push('sol_mint_authority');
  if (t.freezable?.status === '1' || t.freezable?.freeze_authority) f.findings.push('sol_freeze_authority');
  if (t.is_honeypot === '1') f.findings.push('honeypot');
  if (+(t.top10_holders_rate || 0) > 0.5) f.findings.push('high_ownership');
  if (r?.lpLockedPct != null && r.lpLockedPct < 50) f.findings.push('sol_lp_unlocked'); else f.lpLocked = true;
  if ((r?.token?.transferFee?.pct || 0) > 5) f.findings.push('sol_transfer_fee');
  return f;
}

// ── EXECUTOR ───────────────────────────────────────────────────────
async function preflight(to, data, value = 0n) { const r = await call(to, data, acct.address); return r.ok ? true : (r.revert ? false : null); }
async function sendTx(to, data, value = 0n) {
  if (!acct) return 'NO_KEY'; if (!LIVE()) return 'DRY';
  try { return await wal.sendTransaction({ to, data, value }); } catch (e) { return 'FAIL:' + e.message.slice(0, 40); }
}

async function buyToken(addr, name, score) {
  if (!acct) return 'no key';
  if (Object.keys(S.positions).length >= CFG.maxPositions) return 'max positions';
  const bal = await getBal(acct.address);
  const size = parseEther(String(CFG.tradeEth));
  if (bal < size + parseEther(String(CFG.gasReserve))) return 'insufficient balance';
  const out = await amountsOut(size, [WETH, addr]); if (!out) return 'no route';
  const minOut = out * BigInt(Math.floor((1 - CFG.slippage) * 1000)) / 1000n;
  const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens', args: [minOut, [WETH, addr], acct.address, BigInt(deadline())] });
  if (await preflight(ROUTER, data, size) === false) return 'preflight revert';
  const h = await sendTx(ROUTER, data, size);
  S.positions[addr] = { name, entry: +out, size: CFG.tradeEth, amount: out, peak: 1, ts: now(), score, took50: false, took25: false, hash: typeof h === 'string' ? h : null };
  const ap = encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [ROUTER, (2n ** 256n) - 1n] });
  await sendTx(addr, ap);
  return h;
}

async function sellToken(addr, pct) {
  const p = S.positions[addr]; if (!p || !acct) return 'none';
  const amt = p.amount * BigInt(Math.round(pct * 100)) / 100n; if (amt <= 0n) return 'dust';
  const out = await amountsOut(amt, [addr, WETH]); if (!out) return 'no route';
  const minOut = out * BigInt(Math.floor((1 - CFG.slippage) * 1000)) / 1000n;
  const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: 'swapExactTokensForETHSupportingFeeOnTransferTokens', args: [amt, minOut, [addr, WETH], acct.address, BigInt(deadline())] });
  const h = await sendTx(ROUTER, data);
  p.amount -= amt;
  if (p.amount <= 0n) delete S.positions[addr];
  return h;
}

// ── POSITION MANAGER ───────────────────────────────────────────────
async function manage() {
  for (const [addr, p] of Object.entries(S.positions)) {
    const j = await jget(`https://api.dexscreener.com/latest/dex/tokens/${addr}`);
    const price = +(j?.pairs?.[0]?.priceUsd || 0); if (!price) continue;
    const m = price * 1e18 / Number(p.entry);
    p.peak = Math.max(p.peak, m);
    let act = null;
    if (m <= CFG.stopLoss) act = ['STOP-LOSS', 1.0];
    else if (p.peak >= CFG.trailArm && m <= p.peak * (1 - CFG.trailPct)) act = ['TRAIL', 1.0];
    else if (m >= CFG.tp2 && !p.took25) { act = ['TP2', 0.25]; p.took25 = true; }
    else if (m >= CFG.tp1 && !p.took50) { act = ['TP1', 0.50]; p.took50 = true; }
    else if (now() - p.ts > CFG.timeExitH * 3600e3 && p.peak < 1.3) act = ['TIME-EXIT', 1.0];
    if (act) {
      const h = await sellToken(addr, act[1]);
      await send(`${act[1] === 1 ? '🔴' : '🟢'} ${act[0]} ${p.name} @ ${m.toFixed(2)}x\n${typeof h === 'string' ? h : ''}`);
      if (act[1] === 1) { M.outcomes.push({ addr, mult: +m.toFixed(2), peak: p.peak, ts: now() }); delete S.positions[addr]; }
    }
  }
}

// ── DRAIN HUNTER ───────────────────────────────────────────────────
async function drainHunt() {
  if (!acct || !LIVE()) return;
  for (const [addr, t] of Object.entries(S.targets)) {
    if (t.drained || t.chain !== 'base') continue;
    const f = await securityScan(addr);
    if (!f.unguarded.includes('withdraw')) continue;
    const sel = '0x3ccfd60b';
    const sim = await call(addr, sel, acct.address); if (!sim.ok) continue;
    const loot = await getBal(addr);
    const gas = await rpc('eth_estimateGas', [{ to: addr, data: sel, from: acct.address }, 'latest']);
    const gp = await rpc('eth_gasPrice', []);
    if (!gas.ok || !gp.ok) continue;
    const cost = BigInt(gas.data) * BigInt(gp.data);
    if (loot > cost * BigInt(CFG.drainGasMult) && loot > parseEther(String(CFG.drainMinLoot))) {
      const h = await sendTx(addr, sel);
      t.drained = true;
      M.drained.push({ addr, loot: formatEther(loot), hash: typeof h === 'string' ? h : null, ts: now() });
      await send(`🩸 AUTO-DRAIN ${short(addr)}\n${formatEther(loot)} ETH taken\n${typeof h === 'string' ? h : ''}`);
    }
  }
}

// ── SOURCER ────────────────────────────────────────────────────────
async function sourcer() {
  if (S.paused) return 0;
  if (S.day !== today()) { S.day = today(); S.alertsToday = 0; }
  let fired = 0; const tEnd = Date.now() + 90_000;
  outer:
  for (const chain of ['base', 'solana']) {
    for (let page = 1; page <= CFG.pages; page++) {
      if (Date.now() > tEnd) break outer;
      const j = await jget(`https://api.geckoterminal.com/api/v2/networks/${chain}/new_pools?page=${page}`);
      for (const p of j?.data || []) {
        if (Date.now() > tEnd) break outer;
        if (fired >= CFG.maxAlertsPerRun || S.alertsToday >= CFG.maxAlertsPerDay) break outer;
        const addr = (p.relationships?.base_token?.data?.id || '').split('_').slice(1).join('_');
        if (!addr || S.seen[addr]) continue;
        const liq = +p.attributes.reserve_in_usd || 0, fdv = +(p.attributes.fdv_usd || p.attributes.market_cap_usd) || 0;
        const tx = (p.attributes.transactions?.h24?.buys || 0) + (p.attributes.transactions?.h24?.sells || 0);
        const ageH = (now() - new Date(p.attributes.pool_created_at).getTime()) / 3600e3;
        if (liq < CFG.minLiq || !fdv || fdv > CFG.maxFdv || tx < CFG.minTx || ageH > CFG.maxAgeH) continue;
        const w = S.watch[addr]; if (!w) { S.watch[addr] = { runs: 1 }; continue; }
        w.runs++; if (w.runs < CFG.patience) continue;

        const sec = chain === 'base' ? await securityScan(addr) : await scanSVM(addr);
        const sc = securityScore(sec.findings, { verified: sec.verified, lpLocked: sec.lpLocked });
        const mk = marketScore({ liq, fdv, tx, ageH });
        const v = verdict(mk, sc);
        S.seen[addr] = now(); delete S.watch[addr];
        if (v === 'WATCH') continue;

        S.targets[addr] = { t: now(), chain, mk, sc: sc.score, verdict: v, liq, entry: +p.attributes.base_token_price_usd || 0, pair: p.attributes.address, maxUp: 1 };
        fired++; S.alertsToday++;
        const tag = v === 'TRAP' ? '🪤' : v === 'STRONG' ? '🔥' : '✅';
        await send(`${tag} ${v} [${chain}] — ${p.attributes.name}\nMarket ${mk}/100 · Security ${sc.score}/100\nLiq $${Math.round(liq).toLocaleString()} · MCap $${Math.round(fdv).toLocaleString()}\n${sc.hits.length ? '⚠ ' + [...new Set(sc.hits)].join(', ') : 'clean'}\nhttps://dexscreener.com/${chain}/${addr}`);

        if (AUTO() && v === 'STRONG' && chain === 'base') {
          const h = await buyToken(addr, p.attributes.name, mk + sc.score);
          await send(`⚔️ AUTO-BUY ${p.attributes.name}\n${h}`);
        }
      }
    }
  }
  return fired;
}

function writeOracle() {
  const o = { v: '4.1', ts: now(), signals: Object.entries(S.targets).map(([a, t]) => ({ addr: a, verdict: t.verdict, mk: t.mk, sc: t.sc })) };
  try { fs.writeFileSync(ORACLE, JSON.stringify(o, null, 1)); } catch {}
  return o;
}

// ── COMMANDS ───────────────────────────────────────────────────────
async function handle() {
  const r = await jget(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${S.offset}&timeout=0&allowed_updates=%5B%22message%22%5D`);
  let n = 0;
  const ok = () => !PIN || S.authed;
  for (const u of r?.result || []) {
    if (n++ >= CFG.maxUpdates) break;
    S.offset = u.update_id + 1;
    if (String(u.message?.chat?.id) !== String(TG_CHAT)) continue;
    const [cmd, a, b] = (u.message.text || '').trim().split(/\s+/);
    try {
      if (cmd === '/ping') await send(`🧬 Teenibu v4.1 · live=${LIVE() ? 'ON' : 'off'} · auto=${AUTO() ? 'ON' : 'off'}`);
      else if (cmd === '/auth' && a) { S.authed = a === PIN; await send(S.authed ? '🔓 authed' : '❌ wrong pin'); }
      else if (cmd === '/scan' && a) {
        if (a === 'sol') {
          if (!b) { await send('usage: /scan sol <mint>'); continue; }
          const f = await scanSVM(b); const s = securityScore(f.findings, { verified: true, lpLocked: f.lpLocked });
          await send(`🧬 SOL ${short(b)}\nSecurity ${s.score}/100 · rugcheck ${f.rug ?? 'n/a'}\n${s.hits.length ? '⚠ ' + s.hits.join(', ') : 'clean'}`);
        } else {
          const f = await securityScan(a); const s = securityScore(f.findings, { verified: f.verified, lpLocked: f.lpLocked });
          await send(`🧬 ${short(a)}\nSecurity ${s.score}/100\n${f.unguarded.length ? '🔓 UNGUARDED: ' + f.unguarded.join(', ') + '\n' : ''}${s.hits.length ? '⚠ ' + s.hits.join(', ') : 'clean'}`);
        }
      }
      else if (cmd === '/drain' && a) {
        if (a === 'sol') {
          if (!b) { await send('usage: /drain sol <mint>'); continue; }
          const f = await scanSVM(b);
          await send(`🩸 SOL ${short(b)}\n${f.findings.length ? '⚠ ' + f.findings.join(', ') : 'clean'}\nSolana is alert-only (no auto-exec yet)`);
        } else {
          const f = await securityScan(a);
          const un = [...new Set(f.unguarded)];
          if (!un.length) { await send('🔒 no unguarded functions'); continue; }
          const map = { mint: '0x1249c58b', pause: '0x8456cb59', withdraw: '0x3ccfd60b', initialize: '0x8129fc1c' };
          const out = [];
          for (const nm of un) {
            const s = map[nm]; if (!s) continue;
            const sim = await call(a, s, acct?.address || randAddr());
            out.push(`${nm}: ${sim.ok ? '✅ callable' : '❌ reverts'} · holds ${formatEther(await getBal(a))} ETH`);
          }
          await send(`🩸 DRAIN ${short(a)}\n${out.join('\n')}`);
        }
      }
      else if (cmd === '/drainall') {
        const t = Object.entries(S.targets).filter(([, x]) => !x.done && x.chain === 'base');
        const out = [];
        for (const [addr] of t.slice(0, 8)) { const f = await securityScan(addr); if (f.unguarded.length) out.push(`${short(addr)} → ${[...new Set(f.unguarded)].join(',')}`); }
        await send(out.length ? '🩸 TARGETS WITH UNGUARDED\n' + out.join('\n') : 'none');
      }
      else if (cmd === '/stats') await send(`📊 positions ${Object.keys(S.positions).length} · resolved ${M.outcomes.length} · drained ${M.drained.length}`);
      else if (cmd === '/positions') await send(Object.entries(S.positions).map(([, p]) => `${p.name} peak ${p.peak.toFixed(2)}x`).join('\n') || 'none');
      else if (cmd === '/bal') await send(acct ? `💰 ${formatEther(await getBal(acct.address))} ETH\n${acct.address}` : 'no key');
      else if (cmd === '/live') {
        if (a === 'on' && b === 'yes') { S.live = true; await send('⚠️ LIVE'); } else { S.live = false; await send('DRY'); }
      }
      else if (cmd === '/auto') { S.auto = a === 'on'; await send('auto-buy ' + (S.auto ? 'ON' : 'off')); }
      else if (cmd === '/buy' && a) { if (!ok()) { await send('🔒 auth'); continue; } await send('⚔️ ' + await buyToken(a, short(a), 0)); }
      else if (cmd === '/sell' && a) {
        if (!ok()) { await send('🔒 auth'); continue; }
        const pct = +(b || 100);
        if (!(pct > 0 && pct <= 100)) { await send('pct must be 1-100'); continue; }
        await send('🔴 ' + await sellToken(a, pct / 100));
      }
      else if (cmd === '/sweep' && a) {
        if (!ok() || !acct) { await send('🔒'); continue; }
        const bal = await getBal(acct.address); const buf = parseEther('0.00005');
        if (bal <= buf) { await send('nothing'); continue; }
        if (b !== 'confirm') { await send(`🧹 ${formatEther(bal - buf)} ETH → ${a}\n/sweep ${a} confirm`); continue; }
        await send('🧹 ' + await sendTx(a, '0x', bal - buf));
      }
      else if (cmd === '/pause') { S.paused = true; await send('⏸'); }
      else if (cmd === '/resume') { S.paused = false; await send('▶️'); }
      else if (cmd === '/help') await send(`🧬 TEENIBU v4.1\n/auth <pin>\n/scan <addr> · /scan sol <mint> · /drain <addr> · /drainall\n/stats · /positions · /bal\n/live on yes · /auto on|off\n/buy <addr> · /sell <addr> [pct] · /sweep <to> confirm\n/pause /resume /ping`);
    } catch (e) { try { await send('⚠️ ' + String(e?.message || e).slice(0, 200)); } catch {} }
  }
}

// ── MAIN ───────────────────────────────────────────────────────────
(async () => {
  load();
  await handle();
  save();
  await sourcer(); await manage(); await drainHunt(); writeOracle(); save();
  const end = Date.now() + 260_000;              // stay awake ~4m20s
  while (Date.now() < end) {
    const before = S.offset;
    await handle();
    if (S.offset !== before) save();
    await sleep(3000);
  }
  save();
  console.log('listening window closed');
})().catch(e => { console.error(e); save(); });
