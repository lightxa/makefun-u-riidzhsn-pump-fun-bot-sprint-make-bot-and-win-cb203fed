// Pump.fun Bot Sprint: burst-filtered fast-exit bot (v7, final).
//
// Strategy: enter 0.02 SOL only when a coin's create slot contains a
// single buy of at least 5 SOL, its real SOL reserves are at least 1 SOL,
// and it is at most 10 slots old; at most 5 open positions and one entry
// per mint. The launch burst happens inside the create slot (about 1.40x
// the create price), so the entry buys the first tradeable price after the
// burst, not the burst itself.
//
// Exits are the change from the earlier v5 build: take profit early and
// cut losers fast, because on the dev window losers bleed far more than
// runners pay. A position that never arms (+3%) is given up after 5
// slots; an armed runner takes half off at +10% and the rest rides a 6%
// trailing stop from its peak close value, with no second partial (each
// extra sell pays another 105,000-lamport tx fee). A hard stop at -5%, a
// reserve-death exit when real reserves fall 60% from their peak, a
// 300-slot stale exit and a 1000-slot max hold are safety rails only.
//
// How it runs: the harness sends hello once, then one batch per slot, and
// this bot answers each batch with its orders (buys and sells) for that
// slot. Orders decided on a batch fill two slots later. Everything is
// deterministic: no clock, no environment, no randomness.
//
// Close value versus mark-to-market: exit decisions use the net close value,
// not a raw token-times-price mark. closeValue() below is a literal port of
// the engine's own closeQuote: sell the whole position against the current
// reserves, q = floor(t * vq / (vt + t)) capped at the real quote reserves,
// minus the protocol and creator fees at the last trade's bps (95/30
// fallback), minus the 105,000-lamport tx fee, floored at zero. Cost is the
// quote actually paid for the tokens still held, curve fees included, tx
// fee excluded, exactly as the harness reports it in the position's
// cost_lamports. All comparisons are exact bigint ratios, so no float ever
// decides an exit.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type Pubkey,
  type SellInput,
} from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- parameters

const FIRST_BUY_LAMPORTS = (LAMPORTS_PER_SOL * 2n) / 100n; // 0.02 SOL
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 200n; // 0.005 SOL
const MIN_RQ_LAMPORTS = LAMPORTS_PER_SOL; // 1 SOL of real reserves
const MAX_RQ_LAMPORTS = LAMPORTS_PER_SOL * 200n; // 200 SOL
const MAX_AGE_SLOTS = 10;
const MAX_POSITIONS = 5;
const MAX_ENTRIES_PER_MINT = 1;
const COOLDOWN_SLOTS = 50;
const MAXBUY_MIN_LAMPORTS = LAMPORTS_PER_SOL * 5n; // one create-slot buy >= 5 SOL
const MAX_SLIPPAGE_BPS = 10_000;

const ARM_PCT = 103n; // runner mode arms at close value >= 103% of cost
const TP1_PCT = 110n; // sell half at >= 110% of cost
const TRAIL_KEEP_PCT = 94n; // armed runner exits below 94% of peak close value
const STOP_PCT = 95n; // hard stop: close value <= 95% of cost
const RQ_DROP_KEEP_PCT = 40n; // exit when real reserves fall below 40% of peak
const GIVEUP_SLOTS = 5;
const MAX_HOLD_SLOTS = 1000;
const STALE_SLOTS = 300;

const FALLBACK_PROTOCOL_BPS = 95n;
const FALLBACK_CREATOR_BPS = 30n;

// ---------------------------------------------------------------- helpers

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

interface FeeBps {
  protocol: bigint;
  creator: bigint;
}

const feeBpsByMint = new Map<Pubkey, FeeBps>();

/**
 * Net SOL received by selling the whole held position now: a literal port
 * of the engine's own closeQuote. Sell the tokens against the current
 * reserves, q = floor(t * vq / (vt + t)) capped at the real quote reserves,
 * minus the protocol and creator fees at the last trade's bps (95/30
 * fallback), minus the 105,000-lamport tx fee, floored at zero.
 */
function closeValue(state: BotState, mint: Pubkey): bigint {
  const pos = state.positions.get(mint);
  if (pos === undefined) return 0n;
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0n;
  const t = pos.token_amount;
  const vq = curve.virtual_quote_reserves;
  const vt = curve.virtual_token_reserves;
  let q = (t * vq) / (vt + t);
  if (q > curve.real_quote_reserves) q = curve.real_quote_reserves;
  const bps = feeBpsByMint.get(mint) ?? {
    protocol: FALLBACK_PROTOCOL_BPS,
    creator: FALLBACK_CREATOR_BPS,
  };
  const fee = ceilDiv(q * bps.protocol, 10_000n);
  const creatorFee = ceilDiv(q * bps.creator, 10_000n);
  const net = q - fee - creatorFee - state.txFeeLamports();
  return net > 0n ? net : 0n;
}

// ---------------------------------------------------------------- per-mint state

interface Tape {
  created: number | null;
  lastTradeSlot: number;
}

interface Burst {
  /** Net buy flow of the create slot, in lamports (buys minus sells). */
  net: bigint;
  /** Largest single buy in the create slot, in lamports. */
  maxBuy: bigint;
}

interface Held {
  opened: number;
  peakValue: bigint;
  peakRq: bigint;
  armed: boolean;
  tookTp1: boolean;
}

const tapes = new Map<Pubkey, Tape>();
const bursts = new Map<Pubkey, Burst>();
const entriesByMint = new Map<Pubkey, number>();
const held = new Map<Pubkey, Held>();
const exitedAt = new Map<Pubkey, number>();

function tapeFor(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, lastTradeSlot: -1 };
    tapes.set(mint, t);
  }
  return t;
}

// ---------------------------------------------------------------- decision loop

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const now = batch.slot;
  const txFee = state.txFeeLamports();
  const orders: OrderInput[] = [];
  const traded: Pubkey[] = [];
  const tradedSeen = new Set<Pubkey>();

  // Fold this batch's events in: tapes, per-mint fee bps, create-slot burst
  // flow, and the list of mints traded this batch (first-seen order).
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      tapeFor(e.mint).created = e.slot;
    } else if (e.event === 'TradeEvent') {
      const t = tapeFor(e.mint);
      t.lastTradeSlot = e.slot;
      const feeBps = BigInt(e.fee_basis_points);
      feeBpsByMint.set(
        e.mint,
        feeBps > 0n
          ? { protocol: feeBps, creator: BigInt(e.creator_fee_basis_points) }
          : { protocol: FALLBACK_PROTOCOL_BPS, creator: FALLBACK_CREATOR_BPS },
      );
      if (t.created !== null && e.slot === t.created) {
        const sol = BigInt(e.sol_amount);
        let b = bursts.get(e.mint);
        if (b === undefined) {
          b = { net: 0n, maxBuy: 0n };
          bursts.set(e.mint, b);
        }
        b.net += e.is_buy ? sol : -sol;
        if (e.is_buy && sol > b.maxBuy) b.maxBuy = sol;
      }
      if (!tradedSeen.has(e.mint)) {
        tradedSeen.add(e.mint);
        traded.push(e.mint);
      }
    }
  }

  // Burst filter: a mint whose create slot carried trades but no single buy
  // of at least 5 SOL never becomes an entry. (A mint with no create-slot
  // trades at all records no burst and is not blocked by this filter; it
  // still has to pass the reserve and age gates below.)
  for (const [mint, b] of bursts) {
    if (b.net < 0n || b.maxBuy < MAXBUY_MIN_LAMPORTS) {
      entriesByMint.set(mint, 99);
    }
  }

  // Pending orders by mint, for the sell-duplicate and cash accounting.
  const pendingByMint = new Map<Pubkey, { buy: boolean; sell: boolean }>();
  for (const p of state.pending.values()) {
    let flags = pendingByMint.get(p.order.mint);
    if (flags === undefined) {
      flags = { buy: false, sell: false };
      pendingByMint.set(p.order.mint, flags);
    }
    if (p.order.side === 'buy') flags.buy = true;
    else flags.sell = true;
  }

  // Exits first: every held position is re-valued at its net close value.
  for (const [mint, h] of held) {
    const pos = state.positions.get(mint);
    if (pos === undefined) {
      if (!pendingByMint.has(mint)) {
        held.delete(mint);
        exitedAt.set(mint, now);
      }
      continue;
    }
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const value = closeValue(state, mint);
    const cost = pos.cost_lamports;
    if (value > h.peakValue) h.peakValue = value;
    const rq = curve.real_quote_reserves;
    if (rq > h.peakRq) h.peakRq = rq;
    if (value * 100n >= cost * ARM_PCT) h.armed = true;

    let reason: string | null = null;
    let partial: bigint | null = null;
    if (value * 100n <= cost * STOP_PCT) {
      reason = 'stop';
    } else if (h.armed && !h.tookTp1 && value * 100n >= cost * TP1_PCT) {
      reason = 'tp1';
      partial = pos.token_amount / 2n;
    } else if (h.armed && value * 100n <= h.peakValue * TRAIL_KEEP_PCT) {
      reason = 'trail';
    } else if (h.peakRq > 0n && rq * 100n < h.peakRq * RQ_DROP_KEEP_PCT) {
      reason = 'rqdrop';
    } else if (now - tapeFor(mint).lastTradeSlot > STALE_SLOTS) {
      reason = 'stale';
    } else if (!h.armed && now - h.opened > GIVEUP_SLOTS) {
      reason = 'giveup';
    } else if (now - h.opened > MAX_HOLD_SLOTS) {
      reason = 'hold';
    }
    if (reason === null) continue;
    if (pendingByMint.get(mint)?.sell) continue;
    if (orders.length >= state.hello.caps.max_orders_per_batch) break;
    if (partial !== null && partial > 0n) {
      const sell: SellInput = {
        side: 'sell',
        mint,
        token_amount: partial,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
      orders.push(sell);
      if (reason === 'tp1') h.tookTp1 = true;
      continue;
    }
    const sell: SellInput = {
      side: 'sell',
      mint,
      token_amount: pos.token_amount,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    };
    orders.push(sell);
  }

  // Entries: mints traded on this batch, youngest first by event order.
  let free = state.freeCashLamports();
  let openCount = state.committedPositionCount();
  for (const mint of traded) {
    if (orders.length >= state.hello.caps.max_orders_per_batch) break;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const t = tapeFor(mint);
    if (t.created === null) continue;
    if (held.has(mint)) continue;
    if (openCount >= MAX_POSITIONS) continue;
    if ((entriesByMint.get(mint) ?? 0) >= MAX_ENTRIES_PER_MINT) continue;
    if (now - (exitedAt.get(mint) ?? -1_000_000_000) < COOLDOWN_SLOTS) continue;
    if (now - t.created > MAX_AGE_SLOTS) continue;
    const rq = curve.real_quote_reserves;
    if (rq < MIN_RQ_LAMPORTS || rq > MAX_RQ_LAMPORTS) continue;
    const cap = state.maxBuyLamports(mint);
    let amt = cap < FIRST_BUY_LAMPORTS ? cap : FIRST_BUY_LAMPORTS;
    if (amt > free - txFee) amt = free - txFee;
    if (amt < MIN_BUY_LAMPORTS) continue;
    const buy: BuyInput = {
      side: 'buy',
      mint,
      quote_lamports: amt,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    };
    orders.push(buy);
    free -= amt + txFee;
    openCount += 1;
    entriesByMint.set(mint, (entriesByMint.get(mint) ?? 0) + 1);
    held.set(mint, {
      opened: now,
      peakValue: 0n,
      peakRq: rq,
      armed: false,
      tookTp1: false,
    });
  }

  return orders;
}

await runBot({ onBatch });
