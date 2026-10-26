// CRATE checker: reads a wallet's recent pump.fun (bonding curve) and PumpSwap trades from the chain
// and adds up the fees recorded in each trade's own event. Read-only, no keys needed.
const crypto = require('crypto');

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const RPCS = [process.env.RPC_URL, 'https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com', 'https://solana.drpc.org'].filter(Boolean);
const DEEP = !!process.env.RPC_URL;

const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = {}; for (let i = 0; i < ALPH.length; i++) MAP[ALPH[i]] = i;
function b58decode(s) {
  const bytes = [];
  for (const ch of s) {
    const v = MAP[ch]; if (v === undefined) throw new Error('b58');
    let carry = v;
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of s) { if (ch === '1') bytes.push(0); else break; }
  return Buffer.from(bytes.reverse());
}
function b58encode(buf) {
  const digits = [];
  for (const byte of buf) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (const byte of buf) { if (byte === 0) out += '1'; else break; }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPH[digits[i]];
  return out;
}
const disc = (n) => crypto.createHash('sha256').update('event:' + n).digest().subarray(0, 8);
const D_TRADE = disc('TradeEvent'), D_BUY = disc('BuyEvent'), D_SELL = disc('SellEvent');
const EVTAG = Buffer.from('e445a52e51cb9a1d', 'hex');
const u64 = (b, o) => Number(b.readBigUInt64LE(o));
const pk = (b, o) => b58encode(b.subarray(o, o + 32));

async function rpc(method, params) {
  let last;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (!r.ok) { last = r.status; continue; }
      const j = await r.json();
      if (j.error) { last = j.error.message; continue; }
      return j.result;
    } catch (e) { last = e.message; }
  }
  throw new Error('rpc ' + last);
}
async function batchOn(url, method, items) {
  const body = items.map((x) => ({ jsonrpc: '2.0', id: x.i, method, params: x.p }));
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) return {};
  const j = await r.json();
  const got = {};
  if (Array.isArray(j)) for (const x of j) if (x && x.result) got[x.id] = x.result;
  return got;
}
// fill every slot it can: batches on each RPC in turn, then a few single calls for whatever is still missing
async function rpcMany(method, list, size) {
  const out = new Array(list.length).fill(null);
  let missing = list.map((p, i) => ({ i, p }));
  for (const url of RPCS) {
    if (!missing.length) break;
    for (let s = 0; s < missing.length; s += size) {
      try { const got = await batchOn(url, method, missing.slice(s, s + size)); for (const k in got) out[k] = got[k]; } catch (e) { /* next */ }
    }
    missing = missing.filter((x) => !out[x.i]);
  }
  if (missing.length) {
    const left = missing.slice(0, 40); let k = 0;
    const worker = async () => { while (k < left.length) { const x = left[k++]; try { out[x.i] = await rpc(method, x.p); } catch (e) { /* skip */ } } };
    await Promise.all(Array.from({ length: 5 }, worker));
  }
  return out;
}

function keysOf(tx) {
  const m = tx.transaction.message;
  let keys = (m.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey));
  const la = tx.meta && tx.meta.loadedAddresses;
  if (la) keys = keys.concat(la.writable || [], la.readonly || []);
  return keys;
}
function events(tx) {
  const seen = new Set(), evs = [];
  const add = (b) => { const h = b.toString('hex'); if (!seen.has(h)) { seen.add(h); evs.push(b); } };
  if (!tx || !tx.meta) return evs;
  for (const l of tx.meta.logMessages || []) if (l.startsWith('Program data: ')) { try { add(Buffer.from(l.slice(14), 'base64')); } catch (e) {} }
  const keys = keysOf(tx);
  for (const inner of tx.meta.innerInstructions || []) for (const ix of inner.instructions || []) {
    const pid = keys[ix.programIdIndex];
    if (pid !== PUMP && pid !== AMM) continue;
    let d; try { d = b58decode(ix.data); } catch (e) { continue; }
    if (d.length > 16 && d.subarray(0, 8).equals(EVTAG)) add(d.subarray(8));
  }
  return evs;
}
// returns {user, kind, sol, fee, cfee, exact, coin} or null
function parse(b) {
  const d = b.subarray(0, 8);
  if (d.equals(D_TRADE) && b.length >= 129) {
    const sol = u64(b, 40), user = pk(b, 57), coin = pk(b, 8);
    if (b.length >= 225) {
      const bps = u64(b, 161), f = u64(b, 169), cbps = u64(b, 209), cf = u64(b, 217);
      const want = sol * bps / 1e4;
      if (bps <= 1000 && Math.abs(f - want) <= Math.max(3, want * 0.03)) return { user, kind: 'curve', sol, fee: f, cfee: cbps <= 1000 ? cf : 0, exact: true, coin };
    }
    return { user, kind: 'curve', sol, fee: Math.round(sol * 0.01), cfee: 0, exact: false, coin };
  }
  if ((d.equals(D_BUY) || d.equals(D_SELL)) && b.length >= 184) {
    const q = u64(b, 64), pbps = u64(b, 88), pf = u64(b, 96), user = pk(b, 152), coin = pk(b, 120);
    let cf = 0;
    if (b.length >= 360) { const cbps = u64(b, 344); if (cbps <= 1000) cf = u64(b, 352); }
    const want = q * pbps / 1e4;
    const ok = pbps <= 1000 && Math.abs(pf - want) <= Math.max(3, want * 0.05);
    return { user, kind: 'amm', sol: q, fee: ok ? pf : 0, cfee: cf, exact: ok, coin };
  }
  return null;
}
const txOpts = { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' };

async function selftest(res) {
  const out = {};
  for (const [name, prog] of [['curve', PUMP], ['amm', AMM]]) {
    const sigs = await rpc('getSignaturesForAddress', [prog, { limit: 30 }]);
    const txs = await rpcMany('getTransaction', sigs.filter((s) => !s.err).slice(0, 20).map((s) => [s.signature, txOpts]), 20);
    let n = 0, exact = 0, samples = [];
    for (const tx of txs) for (const b of events(tx)) { const e = parse(b); if (!e) continue; n++; if (e.exact) exact++; if (samples.length < 3) samples.push({ user: e.user, sol: e.sol / 1e9, fee: e.fee / 1e9, cfee: e.cfee / 1e9, exact: e.exact }); }
    out[name] = { txs: txs.filter(Boolean).length, events: n, exact, samples };
  }
  res.json(out);
}

module.exports = async (req, res) => {
  const q = req.query || {};
  try {
    if (q.selftest) return await selftest(res);
    const w = String(q.wallet || '').trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w)) return res.status(400).json({ error: 'That is not a Solana address.' });
    const sigs = await rpc('getSignaturesForAddress', [w, { limit: 1000 }]);
    const ok = sigs.filter((s) => !s.err);
    const scan = ok.slice(0, DEEP ? 600 : 120);
    const txs = await rpcMany('getTransaction', scan.map((s) => [s.signature, txOpts]), DEEP ? 100 : 20);
    let trades = 0, vol = 0, fee = 0, cfee = 0, est = 0, first = null, last = null;
    const coins = new Set();
    txs.forEach((tx, i) => {
      if (!tx) return;
      let hit = false;
      for (const b of events(tx)) {
        const e = parse(b); if (!e || e.user !== w) continue;
        hit = true; trades++; vol += e.sol; fee += e.fee; cfee += e.cfee; if (!e.exact) est++; coins.add(e.coin);
      }
      if (hit) { const t = tx.blockTime || scan[i].blockTime; if (t) { first = first === null ? t : Math.min(first, t); last = last === null ? t : Math.max(last, t); } }
    });
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.json({ wallet: w, scanned: txs.filter(Boolean).length, trades, coins: coins.size, solVolume: vol / 1e9, feesPaid: fee / 1e9, creatorFees: cfee / 1e9, estimated: est, firstTrade: first, lastTrade: last });
  } catch (e) {
    res.status(502).json({ error: 'Solana is busy right now. Try again in a minute.' });
  }
};
