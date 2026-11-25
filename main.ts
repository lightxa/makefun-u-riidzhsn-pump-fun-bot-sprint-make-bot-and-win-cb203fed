// Pump.fun bot: masuk saat lonjakan buy besar di slot create, keluar cepat.
//
// Ide dasarnya: koin yang baru dibuat kadang langsung diserbu satu buy
// besar di slot yang sama. Bot ini hanya ikut saat serbuan itu terbukti:
// ada satu buy tunggal minimal 5 SOL di slot create, cadangan SOL riil
// koinnya minimal 1 SOL, dan koinnya masih berumur at most 10 slot.
// Masuknya kecil, 0.02 SOL, maksimal lima posisi terbuka, dan tiap mint
// hanya dimasuki sekali.
//
// Begitu masuk, bot tidak menunggu lama. Posisi yang tidak kunjung naik
// 3% dilepas setelah 5 slot. Posisi yang naik 3% dianggap "armed": di
// +10% separuh posisi dijual, sisanya dibiarkan naik dengan trailing stop
// 6% dari nilai close tertinggi. Stop keras di -5% memotong kerugian
// sebelum makin dalam. Ada juga pengaman cadangan: bila cadangan riil
// jatuh di bawah 40% puncaknya, posisi ditutup. Posisi yang tidak ada
// perdagangan selama 300 slot ditutup, dan tidak ada posisi yang
// dipertahankan lebih dari 1000 slot.
//
// Semua keputusan keluar memakai nilai close bersih: berapa SOL yang
// benar-benar diterima bila seluruh token dijual sekarang melawan
// cadangan saat ini, setelah dipotong fee protokol dan fee creator
// (dari bps perdagangan terakhir, fallback 95/30) serta fee transaksi
// 105.000 lamport, dibulatkan ke bawah di nol. Biaya posisi yang
// dipakai sebagai pembanding adalah cost_lamports dari harness, yaitu
// quote yang benar-benar dibayar termasuk fee kurva, tanpa fee tx.
// Semua perbandingan memakai rasio bigint eksak, jadi tidak ada float
// yang ikut memutuskan keluar atau masuk.
//
// Harness memanggil onBatch sekali per slot dengan seluruh event slot
// itu; order yang diputuskan di satu batch terisi dua slot kemudian.
// Tidak ada jam, tidak ada environment, tidak ada angka acak: bot ini
// sepenuhnya deterministik.

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

// ---- angka-angka strategi (semua dalam lamport / slot / bps) ----

const ENTRY_LAMPORTS = LAMPORTS_PER_SOL / 50n; // 0.02 SOL per posisi
const SMALLEST_BUY = LAMPORTS_PER_SOL / 200n; // 0.005 SOL, buy di bawah ini tidak jalan
const RQ_FLOOR = LAMPORTS_PER_SOL; // cadangan riil minimal 1 SOL
const RQ_CEILING = LAMPORTS_PER_SOL * 200n; // cadangan riil maksimal 200 SOL
const AGE_LIMIT = 10; // umur koin maksimal 10 slot saat masuk
const OPEN_LIMIT = 5; // maksimal 5 posisi terbuka
const ENTRIES_PER_MINT = 1; // satu entry per mint
const REENTRY_WAIT = 50; // jeda 50 slot sebelum boleh masuk lagi ke mint yang sama
const BURST_BUY_MIN = LAMPORTS_PER_SOL * 5n; // satu buy create-slot minimal 5 SOL
const SLIPPAGE_LIMIT_BPS = 10_000;

const ARM_AT_PCT = 103n; // armed saat nilai close >= 103% dari cost
const FIRST_TP_AT_PCT = 110n; // jual separuh saat nilai close >= 110% dari cost
const TRAIL_FLOOR_PCT = 94n; // armed keluar saat nilai close <= 94% dari puncak
const STOP_AT_PCT = 95n; // stop keras saat nilai close <= 95% dari cost
const RQ_FLOOR_PCT = 40n; // keluar saat cadangan riil < 40% dari puncak cadangan
const UNARMED_GIVEUP = 5; // lepas posisi belum armed setelah 5 slot
const HOLD_LIMIT = 1000; // hold maksimal 1000 slot
const QUIET_LIMIT = 300; // keluar bila tidak ada trade selama 300 slot

const DEFAULT_PROTOCOL_BPS = 95n;
const DEFAULT_CREATOR_BPS = 30n;

// ---- catatan per mint yang dipertahankan antar batch ----

interface FeePair {
  protocol: bigint;
  creator: bigint;
}

interface MintTape {
  createdAt: number | null;
  lastSeenTrade: number;
}

interface CreateBurst {
  /** Arus buy bersih slot create (buy dikurangi sell), dalam lamport. */
  netFlow: bigint;
  /** Buy tunggal terbesar di slot create, dalam lamport. */
  biggestBuy: bigint;
}

interface OpenPosition {
  openedAt: number;
  bestClose: bigint;
  bestReserves: bigint;
  armed: boolean;
  halfTaken: boolean;
}

const feeByMint = new Map<Pubkey, FeePair>();
const tapeByMint = new Map<Pubkey, MintTape>();
const burstByMint = new Map<Pubkey, CreateBurst>();
const entryCount = new Map<Pubkey, number>();
const openByMint = new Map<Pubkey, OpenPosition>();
const lastExitByMint = new Map<Pubkey, number>();

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

function tapeOf(mint: Pubkey): MintTape {
  const existing = tapeByMint.get(mint);
  if (existing !== undefined) return existing;
  const fresh: MintTape = { createdAt: null, lastSeenTrade: -1 };
  tapeByMint.set(mint, fresh);
  return fresh;
}

/**
 * Nilai close bersih posisi yang masih dipegang untuk satu mint: jual
 * semua token melawan cadangan sekarang, q = floor(t * vq / (vt + t))
 * yang dibatasi cadangan quote riil, lalu kurangi fee protokol dan fee
 * creator dari bps trade terakhir (fallback 95/30) dan fee transaksi,
 * dengan batas bawah nol. Ini port harfiah dari closeQuote engine.
 */
function netCloseValue(state: BotState, mint: Pubkey): bigint {
  const pos = state.positions.get(mint);
  if (pos === undefined) return 0n;
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0n;
  const tokens = pos.token_amount;
  let quoteOut =
    (tokens * curve.virtual_quote_reserves) /
    (curve.virtual_token_reserves + tokens);
  if (quoteOut > curve.real_quote_reserves) {
    quoteOut = curve.real_quote_reserves;
  }
  const bps = feeByMint.get(mint) ?? {
    protocol: DEFAULT_PROTOCOL_BPS,
    creator: DEFAULT_CREATOR_BPS,
  };
  const protocolFee = ceilDiv(quoteOut * bps.protocol, 10_000n);
  const creatorFee = ceilDiv(quoteOut * bps.creator, 10_000n);
  const net = quoteOut - protocolFee - creatorFee - state.txFeeLamports();
  return net > 0n ? net : 0n;
}

// ---- loop keputusan: satu jawaban per batch ----

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const now = batch.slot;
  const txFee = state.txFeeLamports();
  const orders: OrderInput[] = [];
  const tradedNow: Pubkey[] = [];
  const alreadyTraded = new Set<Pubkey>();

  // Serap semua event batch ini: catat slot create, slot trade terakhir,
  // bps fee dari tiap trade, arus buy slot create, dan daftar mint yang
  // diperdagangkan batch ini (urutan kemunculan pertama).
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      tapeOf(e.mint).createdAt = e.slot;
    } else if (e.event === 'TradeEvent') {
      const tape = tapeOf(e.mint);
      tape.lastSeenTrade = e.slot;
      const protocolBps = BigInt(e.fee_basis_points);
      feeByMint.set(
        e.mint,
        protocolBps > 0n
          ? {
              protocol: protocolBps,
              creator: BigInt(e.creator_fee_basis_points),
            }
          : {
              protocol: DEFAULT_PROTOCOL_BPS,
              creator: DEFAULT_CREATOR_BPS,
            },
      );
      if (tape.createdAt !== null && e.slot === tape.createdAt) {
        const sol = BigInt(e.sol_amount);
        let burst = burstByMint.get(e.mint);
        if (burst === undefined) {
          burst = { netFlow: 0n, biggestBuy: 0n };
          burstByMint.set(e.mint, burst);
        }
        burst.netFlow += e.is_buy ? sol : -sol;
        if (e.is_buy && sol > burst.biggestBuy) burst.biggestBuy = sol;
      }
      if (!alreadyTraded.has(e.mint)) {
        alreadyTraded.add(e.mint);
        tradedNow.push(e.mint);
      }
    }
  }

  // Gerbang burst: mint yang slot create-nya ramai tapi tidak punya satu
  // buy pun sebesar 5 SOL tidak akan pernah dimasuki. Mint tanpa trade
  // sama sekali di slot create tidak tercatat di sini, jadi tidak kena
  // gerbang ini; ia tetap harus lolos gerbang cadangan dan umur di bawah.
  for (const [mint, burst] of burstByMint) {
    if (burst.netFlow < 0n || burst.biggestBuy < BURST_BUY_MIN) {
      entryCount.set(mint, 99);
    }
  }

  // Order yang masih pending, per mint, untuk cegah sell ganda dan
  // untuk akuntansi kas.
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

  // Keluar dulu: tiap posisi terbuka dinilai ulang pada nilai close bersih.
  for (const [mint, open] of openByMint) {
    const pos = state.positions.get(mint);
    if (pos === undefined) {
      // Posisi sudah tidak ada: bila tidak ada order pending untuk mint
      // ini, tutup pembukuannya dan catat waktu keluar untuk cooldown.
      if (!pendingByMint.has(mint)) {
        openByMint.delete(mint);
        lastExitByMint.set(mint, now);
      }
      continue;
    }
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const value = netCloseValue(state, mint);
    const cost = pos.cost_lamports;
    if (value > open.bestClose) open.bestClose = value;
    const reserves = curve.real_quote_reserves;
    if (reserves > open.bestReserves) open.bestReserves = reserves;
    if (value * 100n >= cost * ARM_AT_PCT) open.armed = true;

    // Alasan keluar, dicek berurutan: stop keras menang atas segalanya,
    // lalu ambil profit separuh, lalu trailing stop, lalu cadangan mati,
    // lalu sepi, lalu giveup, lalu batas hold.
    let reason: string | null = null;
    let half: bigint | null = null;
    if (value * 100n <= cost * STOP_AT_PCT) {
      reason = 'stop';
    } else if (
      open.armed &&
      !open.halfTaken &&
      value * 100n >= cost * FIRST_TP_AT_PCT
    ) {
      reason = 'tp1';
      half = pos.token_amount / 2n;
    } else if (
      open.armed &&
      value * 100n <= open.bestClose * TRAIL_FLOOR_PCT
    ) {
      reason = 'trail';
    } else if (
      open.bestReserves > 0n &&
      reserves * 100n < open.bestReserves * RQ_FLOOR_PCT
    ) {
      reason = 'rqdrop';
    } else if (now - tapeOf(mint).lastSeenTrade > QUIET_LIMIT) {
      reason = 'stale';
    } else if (!open.armed && now - open.openedAt > UNARMED_GIVEUP) {
      reason = 'giveup';
    } else if (now - open.openedAt > HOLD_LIMIT) {
      reason = 'hold';
    }
    if (reason === null) continue;
    if (pendingByMint.get(mint)?.sell) continue;
    if (orders.length >= state.hello.caps.max_orders_per_batch) break;
    if (half !== null && half > 0n) {
      const sell: SellInput = {
        side: 'sell',
        mint,
        token_amount: half,
        max_slippage_bps: SLIPPAGE_LIMIT_BPS,
      };
      orders.push(sell);
      if (reason === 'tp1') open.halfTaken = true;
      continue;
    }
    const sell: SellInput = {
      side: 'sell',
      mint,
      token_amount: pos.token_amount,
      max_slippage_bps: SLIPPAGE_LIMIT_BPS,
    };
    orders.push(sell);
  }

  // Masuk: mint yang diperdagangkan batch ini, termuda dulu menurut
  // urutan event. Semua gerbang harus lolos sebelum satu buy dikirim.
  let cash = state.freeCashLamports();
  let openCount = state.committedPositionCount();
  for (const mint of tradedNow) {
    if (orders.length >= state.hello.caps.max_orders_per_batch) break;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const tape = tapeOf(mint);
    if (tape.createdAt === null) continue;
    if (openByMint.has(mint)) continue;
    if (openCount >= OPEN_LIMIT) continue;
    if ((entryCount.get(mint) ?? 0) >= ENTRIES_PER_MINT) continue;
    if (now - (lastExitByMint.get(mint) ?? -1_000_000_000) < REENTRY_WAIT) {
      continue;
    }
    if (now - tape.createdAt > AGE_LIMIT) continue;
    const reserves = curve.real_quote_reserves;
    if (reserves < RQ_FLOOR || reserves > RQ_CEILING) continue;
    const buyCap = state.maxBuyLamports(mint);
    let amount = buyCap < ENTRY_LAMPORTS ? buyCap : ENTRY_LAMPORTS;
    if (amount > cash - txFee) amount = cash - txFee;
    if (amount < SMALLEST_BUY) continue;
    const buy: BuyInput = {
      side: 'buy',
      mint,
      quote_lamports: amount,
      max_slippage_bps: SLIPPAGE_LIMIT_BPS,
    };
    orders.push(buy);
    cash -= amount + txFee;
    openCount += 1;
    entryCount.set(mint, (entryCount.get(mint) ?? 0) + 1);
    openByMint.set(mint, {
      openedAt: now,
      bestClose: 0n,
      bestReserves: reserves,
      armed: false,
      halfTaken: false,
    });
  }

  return orders;
}

await runBot({ onBatch });
