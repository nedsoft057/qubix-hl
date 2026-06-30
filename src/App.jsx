import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Search, X, Plus, Wifi, WifiOff, TrendingUp, TrendingDown,
  Activity, BarChart3, ChevronRight, ArrowLeft, Wallet,
  AlertTriangle, BarChart2, Settings2,
} from "lucide-react";

// API key — client-side per explicit instruction. Ships in the JS bundle.
// WARNING: visible to anyone who opens DevTools on your deployed URL.
const API_KEY = import.meta.env.VITE_GOLDRUSH_API_KEY;

const DEFAULT_WALLETS = [
  "0x31ca8395cf837de08b24da3f660e77761dfb974b",
  "0x010461c14e146ac35fe42271bdc1134ee31c703a",
];

const DEFAULT_MARKETS = [
  { symbol: "BTC",         marketType: "perp"    },
  { symbol: "ETH",         marketType: "perp"    },
  { symbol: "SOL",         marketType: "perp"    },
  { symbol: "HYPE",        marketType: "perp"    },
  { symbol: "PURR/USDC",   marketType: "spot"    },
  { symbol: "FED-CUT-JUN", marketType: "outcome" },
  { symbol: "XAU",         marketType: "hip3"    },
];

const MARKET_PREFIX = { spot: "@", outcome: "#", hip3: ":", perp: "" };
const MAX_FEED        = 200;
const MAX_CHART_PTS   = 500;

const TIMEFRAMES = {
  "4H":  4  * 60 * 60 * 1000,
  "1D":  24 * 60 * 60 * 1000,
  "1M":  30 * 24 * 60 * 60 * 1000,
  "1Y":  365 * 24 * 60 * 60 * 1000,
  "All": Infinity,
};

// ─── helpers ────────────────────────────────────────────────────────────────

function prefixedSymbol(market) {
  const prefix = MARKET_PREFIX[market.marketType] ?? "";
  return `${prefix}${market.symbol}`;
}

function shortAddr(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function timeAgo(ts) {
  if (!ts) return "";
  const diff = Date.now() - (ts > 1e12 ? ts : ts * 1000);
  const s = Math.max(0, Math.floor(diff / 1000));
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function fmtPrice(p) {
  if (p == null) return "—";
  const n = Number(p);
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1)    return n.toFixed(4);
  return n.toFixed(6);
}

function fmtDate(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString("en-US", {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// ─── WebSocket hook ──────────────────────────────────────────────────────────

function useGoldRushWS(apiKey, wallets, onMessage) {
  const [status, setStatus]  = useState("connecting");
  const wsRef                = useRef(null);
  const reconnectRef         = useRef(null);
  const walletsRef           = useRef(wallets);
  useEffect(() => { walletsRef.current = wallets; }, [wallets]);

  const sendSubs = useCallback((ws) => {
    const addrs = walletsRef.current;
    ws.send(JSON.stringify({
      method: "subscribe",
      subscription: { type: "l2Book", marketTypes: ["*"] },
    }));
    if (addrs.length) {
      ws.send(JSON.stringify({
        method: "subscribe",
        subscription: { type: "userFills", addresses: addrs },
      }));
      ws.send(JSON.stringify({
        method: "subscribe",
        subscription: { type: "orderUpdates", addresses: addrs },
      }));
      ws.send(JSON.stringify({
        method: "subscribe",
        subscription: { type: "userNonFundingLedgerUpdates", addresses: addrs },
      }));
    }
  }, []);

  const connect = useCallback(() => {
    if (!apiKey) return;
    setStatus("connecting");
    const ws = new WebSocket(`wss://hypercore.goldrushdata.com/ws?key=${apiKey}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("open");
      sendSubs(ws);
    };
    ws.onmessage = (e) => {
      try { onMessage(JSON.parse(e.data)); } catch { /* ignore parse errors */ }
    };
    ws.onclose = () => {
      setStatus("closed");
      reconnectRef.current = setTimeout(connect, 3000);
    };
    ws.onerror = () => {
      setStatus("error");
      ws.close();
    };
  }, [apiKey, onMessage, sendSubs]);

  // Re-send wallet subs if list changes while socket is open
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !wallets.length) return;
    ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "userFills",                    addresses: wallets } }));
    ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "orderUpdates",                 addresses: wallets } }));
    ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "userNonFundingLedgerUpdates",  addresses: wallets } }));
  }, [wallets]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const subCount = 1 + (wallets.length > 0 ? 3 : 0); // l2Book wildcard + 3 wallet subs
  return { status, subCount };
}

// ─── HYPE Chart ─────────────────────────────────────────────────────────────

function HypeChart({ pricePoints }) {
  const [timeframe, setTimeframe] = useState("1D");
  const [hoverIdx, setHoverIdx]   = useState(null);
  const svgRef                    = useRef(null);

  const now    = Date.now();
  const cutoff = TIMEFRAMES[timeframe] === Infinity ? 0 : now - TIMEFRAMES[timeframe];
  const pts    = useMemo(
    () => pricePoints.filter((p) => p.time >= cutoff),
    [pricePoints, cutoff],
  );

  const W = 900, H = 240, VOL_H = 38, PAD = { t: 20, r: 20, b: 10, l: 62 };
  const cW = W - PAD.l - PAD.r;
  const cH = H - PAD.t - PAD.b - VOL_H - 10;

  const prices = pts.map((p) => p.price);
  const vols   = pts.map((p) => p.volume);
  const minP   = prices.length ? Math.min(...prices) : 0;
  const maxP   = prices.length ? Math.max(...prices) : 1;
  const maxV   = vols.length   ? Math.max(...vols)   : 1;
  const pRange = maxP - minP || 1;

  const toX = (i) => PAD.l + (i / Math.max(pts.length - 1, 1)) * cW;
  const toY = (p) => PAD.t + cH - ((p - minP) / pRange) * cH;

  const linePath = pts
    .map((p, i) => `${i === 0 ? "M" : "L"}${toX(i).toFixed(1)},${toY(p.price).toFixed(1)}`)
    .join(" ");
  const areaPath = pts.length
    ? `${linePath} L${toX(pts.length - 1).toFixed(1)},${(PAD.t + cH).toFixed(1)} L${PAD.l},${(PAD.t + cH).toFixed(1)} Z`
    : "";

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    y:     PAD.t + cH - f * cH,
    label: fmtPrice(minP + f * pRange),
  }));

  const handleMouseMove = (e) => {
    if (!svgRef.current || !pts.length) return;
    const rect = svgRef.current.getBoundingClientRect();
    const mx   = ((e.clientX - rect.left) / rect.width) * W;
    const idx  = Math.round(((mx - PAD.l) / cW) * (pts.length - 1));
    setHoverIdx(Math.max(0, Math.min(idx, pts.length - 1)));
  };

  const hovered  = hoverIdx !== null ? pts[hoverIdx] : null;
  const hx       = hovered ? toX(hoverIdx) : null;
  const hy       = hovered ? toY(hovered.price) : null;

  const lastPt   = pts[pts.length - 1] || pricePoints[pricePoints.length - 1];
  const firstPt  = pts[0];
  const pctRaw   = lastPt && firstPt && firstPt.price
    ? (((lastPt.price - firstPt.price) / firstPt.price) * 100).toFixed(2)
    : null;
  const isUp = pctRaw === null || Number(pctRaw) >= 0;

  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: "#0D1117" }}>
      {/* header */}
      <div className="flex items-start justify-between px-5 pt-5 pb-2">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="w-2 h-2 rounded-full bg-cyan-400" />
            <span className="text-white font-semibold text-sm">Hyperliquid (HYPE)</span>
            <span className="text-slate-500 text-xs">· Perp</span>
          </div>
          <div className="flex items-baseline gap-3">
            <span className="text-white text-2xl font-bold tracking-tight">
              {lastPt ? `$${fmtPrice(lastPt.price)}` : "—"}
            </span>
            {pctRaw !== null && (
              <span className={`text-sm font-semibold ${isUp ? "text-emerald-400" : "text-rose-400"}`}>
                {isUp ? "+" : ""}{pctRaw}%
              </span>
            )}
          </div>
        </div>

        {/* timeframe tabs */}
        <div className="flex items-center gap-1 mt-1">
          {Object.keys(TIMEFRAMES).map((tf) => (
            <button
              key={tf}
              onClick={() => { setTimeframe(tf); setHoverIdx(null); }}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                timeframe === tf
                  ? "bg-slate-700 text-white"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              {tf}
            </button>
          ))}
          <div className="w-px h-4 bg-slate-700 mx-1" />
          <button className="p-1.5 rounded-md text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors">
            <BarChart2 size={13} />
          </button>
          <button className="p-1.5 rounded-md text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors">
            <Settings2 size={13} />
          </button>
        </div>
      </div>

      {/* chart */}
      <div className="pb-4">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          style={{ cursor: "crosshair" }}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverIdx(null)}
        >
          <defs>
            <linearGradient id="hypeAreaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="#22d3ee" stopOpacity="0.20" />
              <stop offset="100%" stopColor="#22d3ee" stopOpacity="0"    />
            </linearGradient>
            <linearGradient id="hypeVolGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="#22d3ee" stopOpacity="0.55" />
              <stop offset="100%" stopColor="#22d3ee" stopOpacity="0.08" />
            </linearGradient>
          </defs>

          {/* grid lines + y labels */}
          {yTicks.map((t, i) => (
            <g key={i}>
              <line x1={PAD.l} y1={t.y} x2={W - PAD.r} y2={t.y} stroke="#1e293b" strokeWidth="1" />
              <text x={PAD.l - 8} y={t.y + 4} textAnchor="end" fill="#475569" fontSize="10" fontFamily="ui-monospace,monospace">
                {t.label}
              </text>
            </g>
          ))}

          {/* area + line */}
          {pts.length > 1 ? (
            <>
              <path d={areaPath} fill="url(#hypeAreaGrad)" />
              <path d={linePath} fill="none" stroke="#22d3ee" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
            </>
          ) : (
            <text
              x={W / 2} y={PAD.t + cH / 2 + 6}
              textAnchor="middle" fill="#334155" fontSize="13"
              fontFamily="ui-sans-serif,sans-serif"
            >
              {pricePoints.length === 0
                ? "Waiting for HYPE l2Book data…"
                : "Accumulating data for this timeframe"}
            </text>
          )}

          {/* volume bars */}
          {pts.map((p, i) => {
            const bh  = maxV ? (p.volume / maxV) * VOL_H : 0;
            const bx  = toX(i);
            const bw  = Math.max(1, cW / Math.max(pts.length, 1) - 1);
            const by  = PAD.t + cH + 10 + VOL_H - bh;
            return (
              <rect key={i} x={bx - bw / 2} y={by} width={bw} height={bh}
                fill="url(#hypeVolGrad)" rx="1" />
            );
          })}

          {/* crosshair */}
          {hovered && (
            <>
              <line
                x1={hx} y1={PAD.t} x2={hx} y2={PAD.t + cH}
                stroke="#64748b" strokeWidth="1" strokeDasharray="4 3"
              />
              <circle cx={hx} cy={hy} r={4} fill="#22d3ee" stroke="#0D1117" strokeWidth="2.5" />

              {/* tooltip */}
              <foreignObject
                x={hx > W - 160 ? hx - 152 : hx + 14}
                y={Math.max(PAD.t, hy - 44)}
                width="142" height="70"
              >
                <div
                  xmlns="http://www.w3.org/1999/xhtml"
                  style={{
                    background: "#1e293b",
                    border: "1px solid #334155",
                    borderRadius: "8px",
                    padding: "8px 11px",
                    fontSize: "11px",
                    color: "#e2e8f0",
                    lineHeight: "1.7",
                    fontFamily: "ui-monospace, monospace",
                  }}
                >
                  <div style={{ color: "#64748b", fontSize: "10px", marginBottom: "2px" }}>
                    {fmtDate(hovered.time)}
                  </div>
                  <div>
                    <span style={{ color: "#22d3ee" }}>$</span>
                    {fmtPrice(hovered.price)}
                  </div>
                  <div style={{ color: "#475569" }}>Vol {hovered.volume.toFixed(2)}</div>
                </div>
              </foreignObject>
            </>
          )}
        </svg>
      </div>
    </div>
  );
}

// ─── KPI Card ────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, sparklinePoints, icon: Icon, pulse }) {
  const pts  = sparklinePoints || [];
  const max  = Math.max(...pts, 1);
  const W    = 200, H = 44;
  const step = pts.length > 1 ? W / (pts.length - 1) : W;

  const linePath = pts
    .map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(H - (p / max) * H).toFixed(1)}`)
    .join(" ");
  const areaPath = pts.length
    ? `${linePath} L${((pts.length - 1) * step).toFixed(1)},${H} L0,${H} Z`
    : "";

  const lastPtX = pts.length > 1 ? ((pts.length - 1) * step).toFixed(1) : null;
  const lastPtY = pts.length > 1 ? (H - (pts[pts.length - 1] / max) * H).toFixed(1) : null;

  return (
    <div className="bg-white rounded-xl p-4 border border-slate-100 shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">{label}</span>
        {Icon && <Icon size={14} className="text-slate-300" />}
      </div>
      <div className="text-[22px] font-bold text-slate-900 leading-tight">{value}</div>
      {sub && <div className="text-xs text-slate-400 mt-0.5">{sub}</div>}
      {pts.length > 1 && (
        <div className="mt-3 -mx-1">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-10 overflow-visible">
            <defs>
              <linearGradient id={`sparkGrad-${label}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stopColor="#10b981" stopOpacity="0.18" />
                <stop offset="100%" stopColor="#10b981" stopOpacity="0"    />
              </linearGradient>
            </defs>
            <path d={areaPath} fill={`url(#sparkGrad-${label})`} />
            <path d={linePath} fill="none" stroke="#10b981" strokeWidth="1.5"
              strokeLinejoin="round" strokeLinecap="round" />
            {pulse && lastPtX && lastPtY && (
              <>
                <circle cx={lastPtX} cy={lastPtY} r="3" fill="#10b981" />
                <circle cx={lastPtX} cy={lastPtY} r="3" fill="#10b981" opacity="0.7">
                  <animate attributeName="r"       from="3" to="9"  dur="1.6s" repeatCount="indefinite" />
                  <animate attributeName="opacity" from="0.7" to="0" dur="1.6s" repeatCount="indefinite" />
                </circle>
              </>
            )}
          </svg>
        </div>
      )}
    </div>
  );
}

// ─── Status Badge ────────────────────────────────────────────────────────────

function StatusBadge({ status, subCount, wallets }) {
  const publicEst = wallets.length * 3 + 1;
  const isOpen    = status === "open";
  const isConnecting = status === "connecting";
  const dot = isOpen ? "bg-emerald-400" : isConnecting ? "bg-amber-400" : "bg-rose-400";
  const label = isOpen ? "connected" : isConnecting ? "connecting…" : "disconnected";

  return (
    <div className="hidden md:flex items-center gap-2 shrink-0">
      <div className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full font-medium transition-colors ${
        isOpen ? "bg-emerald-950 text-emerald-300" : isConnecting ? "bg-amber-950 text-amber-300" : "bg-rose-950/80 text-rose-300"
      }`}>
        <span className={`w-1.5 h-1.5 rounded-full ${dot} ${isConnecting ? "animate-pulse" : ""}`} />
        {isOpen ? <Wifi size={11} /> : <WifiOff size={11} />}
        GoldRush: {label} · {subCount} subs
      </div>
      <div className="flex items-center gap-1.5 bg-slate-100 text-slate-500 text-xs px-3 py-1.5 rounded-full">
        Public HL: ~{publicEst}+ subs · 1000/IP cap
      </div>
    </div>
  );
}

// ─── Main App ────────────────────────────────────────────────────────────────

export default function App() {
  // No key → full-screen gate
  if (!API_KEY) {
    return (
      <div className="fixed inset-0 bg-slate-950 flex items-center justify-center">
        <div className="text-center px-6">
          <AlertTriangle className="mx-auto mb-4 text-amber-400" size={32} />
          <h1 className="text-white text-xl font-semibold">GoldRush API Key Required</h1>
          <p className="text-slate-400 text-sm mt-2">
            Set <code className="text-amber-400">VITE_GOLDRUSH_API_KEY</code> in your Vercel Environment Variables.
          </p>
        </div>
      </div>
    );
  }

  const [wallets,    setWallets]    = useState(DEFAULT_WALLETS);
  const [walletInput,setWalletInput]= useState("");
  const [markets]                   = useState(DEFAULT_MARKETS);

  // Feeds
  const [fillsFeed,  setFillsFeed]  = useState([]);
  const [ordersFeed, setOrdersFeed] = useState([]);
  const [ledgerFeed, setLedgerFeed] = useState([]);
  const [bookSnap,   setBookSnap]   = useState({});      // coin → { levels }
  const [hypePts,    setHypePts]    = useState([]);      // [{time,price,volume}]

  // Throughput
  const [tpBuckets, setTpBuckets]  = useState(Array(30).fill(0));
  const tpRef = useRef(0);

  const [activeTab,     setActiveTab]    = useState("fills");
  const [search,        setSearch]       = useState("");
  const [searchOpen,    setSearchOpen]   = useState(false);
  const [selectedMarket,setSelectedMarket] = useState(null);

  const handleMessage = useCallback((msg) => {
    tpRef.current += 1;

    if (msg.channel === "userFills" && msg.data?.fills) {
      setFillsFeed((p) =>
        [...msg.data.fills.map((f) => ({ ...f, _ts: Date.now() })), ...p].slice(0, MAX_FEED)
      );
    }
    if (msg.channel === "orderUpdates" && msg.data?.updates) {
      setOrdersFeed((p) =>
        [...msg.data.updates.map((u) => ({ ...u, _ts: Date.now() })), ...p].slice(0, MAX_FEED)
      );
    }
    if (msg.channel === "userNonFundingLedgerUpdates" && msg.data?.nonFundingLedgerUpdates) {
      setLedgerFeed((p) =>
        [...msg.data.nonFundingLedgerUpdates.map((l) => ({ ...l, _ts: Date.now() })), ...p].slice(0, MAX_FEED)
      );
    }
    if (msg.channel === "l2Book" && msg.data) {
      const { coin, time, levels } = msg.data;
      setBookSnap((p) => ({ ...p, [coin]: { coin, time, levels } }));

      if (coin === "HYPE" && levels) {
        const bids = levels[0] || [];
        const asks = levels[1] || [];
        const bestBid = bids[0] ? Number(bids[0].px) : null;
        const bestAsk = asks[0] ? Number(asks[0].px) : null;
        if (bestBid && bestAsk) {
          const mid = (bestBid + bestAsk) / 2;
          const vol = [...bids, ...asks].reduce((s, l) => s + Number(l.sz || 0), 0);
          setHypePts((p) => [...p, { time: time || Date.now(), price: mid, volume: vol }].slice(-MAX_CHART_PTS));
        }
      }
    }
  }, []);

  const { status, subCount } = useGoldRushWS(API_KEY, wallets, handleMessage);

  useEffect(() => {
    const id = setInterval(() => {
      setTpBuckets((p) => [...p.slice(1), tpRef.current]);
      tpRef.current = 0;
    }, 2000);
    return () => clearInterval(id);
  }, []);

  const addWallet = () => {
    const v = walletInput.trim().toLowerCase();
    if (!v || wallets.includes(v)) return;
    setWallets((p) => [...p, v]);
    setWalletInput("");
  };
  const removeWallet = (addr) => setWallets((p) => p.filter((w) => w !== addr));

  const liveMarketRows = markets.map((m) => {
    const snap    = bookSnap[m.symbol];
    const bestBid = snap?.levels?.[0]?.[0]?.px ?? null;
    const bestAsk = snap?.levels?.[1]?.[0]?.px ?? null;
    const spread  = bestBid && bestAsk
      ? (Number(bestAsk) - Number(bestBid)).toFixed(4)
      : null;
    return { ...m, bestBid, bestAsk, spread };
  });

  const filteredMarkets = useMemo(() => {
    if (!search.trim()) return markets;
    const q = search.toLowerCase();
    return markets.filter((m) => prefixedSymbol(m).toLowerCase().includes(q));
  }, [search, markets]);

  const totalMsgs = tpBuckets.reduce((a, b) => a + b, 0);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* HEADER */}
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-slate-100">
        <div className="max-w-[1400px] mx-auto px-5 h-14 flex items-center gap-4">
          {/* Logo */}
          <div className="flex items-center gap-2 shrink-0">
            <div className="w-7 h-7 rounded-lg bg-slate-900 flex items-center justify-center">
              <Activity size={14} className="text-cyan-400" />
            </div>
            <span className="font-bold text-slate-900 text-sm tracking-tight">Qubix HL</span>
          </div>

          {/* Search */}
          <div className="relative w-52">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setSearchOpen(true); }}
              onFocus={() => setSearchOpen(true)}
              onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
              placeholder="Search streaming assets…"
              className="w-full bg-slate-100 text-xs rounded-lg pl-8 pr-3 py-1.5 outline-none focus:ring-2 focus:ring-slate-200 placeholder:text-slate-400"
            />
            {searchOpen && search.trim() && (
              <div className="absolute top-full mt-1 w-full bg-white rounded-xl shadow-lg border border-slate-100 overflow-hidden z-30">
                {filteredMarkets.length === 0
                  ? <div className="px-4 py-3 text-xs text-slate-400">No matching assets</div>
                  : filteredMarkets.map((m) => (
                    <button
                      key={m.symbol}
                      onClick={() => { setSelectedMarket(m); setSearch(""); setSearchOpen(false); }}
                      className="w-full text-left px-4 py-2 text-xs hover:bg-slate-50 flex items-center justify-between"
                    >
                      <span className="font-medium text-slate-700">{prefixedSymbol(m)}</span>
                      <ChevronRight size={12} className="text-slate-300" />
                    </button>
                  ))
                }
              </div>
            )}
          </div>

          <div className="flex-1" />
          <StatusBadge status={status} subCount={subCount} wallets={wallets} />
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-5 py-5 space-y-5">
        {/* HYPE CHART */}
        <HypeChart pricePoints={hypePts} />

        {/* TWO-COLUMN */}
        <div className="grid grid-cols-1 lg:grid-cols-[400px_1fr] gap-5">

          {/* LEFT */}
          <div className="space-y-4">
            {/* KPI row */}
            <div className="grid grid-cols-2 gap-3">
              <KpiCard label="Tracked Wallets" value={wallets.length} sub="Wallet activity stream" icon={Wallet} />
              <KpiCard label="Tracked Markets" value={markets.length} sub="l2Book wildcard" icon={BarChart3} />
            </div>
            <KpiCard
              label="Stream Throughput"
              value={`${tpBuckets[tpBuckets.length - 1] ?? 0}/2s`}
              sub={`${totalMsgs} msgs · ${subCount} active subs`}
              sparklinePoints={tpBuckets}
              icon={Activity}
              pulse={status === "open"}
            />

            {/* Wallet configurator */}
            <div className="bg-white rounded-xl p-4 border border-slate-100 shadow-sm">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Watched Wallets</h3>
              <div className="flex gap-2 mb-3">
                <input
                  value={walletInput}
                  onChange={(e) => setWalletInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addWallet()}
                  placeholder="0x… paste address"
                  className="flex-1 bg-slate-50 text-xs rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-slate-200 placeholder:text-slate-400 font-mono"
                />
                <button
                  onClick={addWallet}
                  className="bg-slate-900 text-white rounded-lg px-3 py-2 hover:bg-slate-800 transition-colors shrink-0"
                >
                  <Plus size={13} />
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {wallets.map((addr) => (
                  <span key={addr} className="inline-flex items-center gap-1 bg-slate-100 text-slate-600 text-xs font-mono px-2 py-1 rounded-full">
                    {shortAddr(addr)}
                    <button onClick={() => removeWallet(addr)} className="text-slate-400 hover:text-rose-500 ml-0.5">
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            </div>

            {/* Feeds */}
            <div className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden">
              <div className="flex border-b border-slate-100">
                {[["fills","FILLS"],["orders","ORDERS"],["ledger","LEDGER"]].map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setActiveTab(key)}
                    className={`flex-1 text-xs font-semibold tracking-wide py-2.5 transition-colors ${
                      activeTab === key
                        ? "text-slate-900 border-b-2 border-slate-900"
                        : "text-slate-400 hover:text-slate-600"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="max-h-[360px] overflow-y-auto divide-y divide-slate-50">
                {/* FILLS */}
                {activeTab === "fills" && (fillsFeed.length === 0
                  ? <p className="text-center text-xs text-slate-400 py-8">Waiting for fills…</p>
                  : fillsFeed.map((f, i) => {
                    const [addr, fill] = Array.isArray(f) ? f : [f.user, f];
                    const isBuy = String(fill?.side || "").toLowerCase() === "b";
                    return (
                      <div key={i} className="flex items-center gap-2.5 px-4 py-2 text-xs">
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isBuy ? "bg-emerald-500" : "bg-rose-500"}`} />
                        <span className="font-mono text-slate-400 w-14">{shortAddr(addr)}</span>
                        <span className="font-semibold text-slate-700 w-10">{fill?.coin}</span>
                        <span className="flex-1 text-slate-500">{fill?.sz} @ {fill?.px}</span>
                        <span className="text-slate-300">{timeAgo(f._ts)}</span>
                      </div>
                    );
                  })
                )}

                {/* ORDERS */}
                {activeTab === "orders" && (ordersFeed.length === 0
                  ? <p className="text-center text-xs text-slate-400 py-8">Waiting for order updates…</p>
                  : ordersFeed.map((u, i) => {
                    const isBuy = String(u?.order?.side || u?.side || "").toLowerCase() === "b";
                    return (
                      <div key={i} className="flex items-center gap-2.5 px-4 py-2 text-xs">
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isBuy ? "bg-emerald-500" : "bg-rose-500"}`} />
                        <span className="font-mono text-slate-400 w-14">{shortAddr(u.user)}</span>
                        <span className="font-semibold text-slate-700 w-10">{u?.order?.coin}</span>
                        <span className="flex-1 text-slate-500">{u?.order?.sz} @ {u?.order?.limitPx}</span>
                        <span className={`font-medium ${u.status === "filled" ? "text-emerald-600" : "text-slate-400"}`}>
                          {u.status}
                        </span>
                      </div>
                    );
                  })
                )}

                {/* LEDGER */}
                {activeTab === "ledger" && (ledgerFeed.length === 0
                  ? <p className="text-center text-xs text-slate-400 py-8">Waiting for ledger events…</p>
                  : ledgerFeed.map((l, i) => {
                    const amt   = Number(l?.delta?.amount || 0);
                    const isPos = amt >= 0;
                    return (
                      <div key={i} className="flex items-center gap-2.5 px-4 py-2 text-xs">
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isPos ? "bg-emerald-500" : "bg-rose-500"}`} />
                        <span className="flex-1 text-slate-700">{l?.delta?.type || "ledger"}</span>
                        <span className={`font-mono font-semibold ${isPos ? "text-emerald-600" : "text-rose-500"}`}>
                          {isPos ? "+" : ""}{l?.delta?.amount}
                        </span>
                        <span className="text-slate-400">${l?.delta?.usdcValue}</span>
                        <span className="text-slate-300">{timeAgo(l._ts || l.time)}</span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {/* RIGHT — Markets grid / Depth Ladder */}
          <div className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden">
            {!selectedMarket ? (
              <>
                <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Live Markets</h3>
                  <span className="text-xs text-slate-400">{markets.length} tracked</span>
                </div>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-slate-400 uppercase tracking-wider bg-slate-50/60">
                      <th className="px-5 py-2.5 font-medium">Asset</th>
                      <th className="px-4 py-2.5 font-medium">Best Bid</th>
                      <th className="px-4 py-2.5 font-medium">Best Ask</th>
                      <th className="px-4 py-2.5 font-medium">Spread</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {liveMarketRows.map((m) => (
                      <tr
                        key={m.symbol}
                        onClick={() => setSelectedMarket(m)}
                        className="cursor-pointer hover:bg-slate-50 transition-colors"
                      >
                        <td className="px-5 py-3 font-semibold text-slate-800">{prefixedSymbol(m)}</td>
                        <td className="px-4 py-3 text-emerald-600 font-mono">{m.bestBid ? fmtPrice(m.bestBid) : "—"}</td>
                        <td className="px-4 py-3 text-rose-500   font-mono">{m.bestAsk ? fmtPrice(m.bestAsk) : "—"}</td>
                        <td className="px-4 py-3 text-slate-400  font-mono">{m.spread ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              /* DEPTH LADDER */
              <div>
                <div className="px-5 py-3.5 border-b border-slate-100 flex items-center gap-3">
                  <button onClick={() => setSelectedMarket(null)} className="text-slate-400 hover:text-slate-700">
                    <ArrowLeft size={15} />
                  </button>
                  <h3 className="text-sm font-semibold text-slate-700">
                    {prefixedSymbol(selectedMarket)} · Order Depth
                  </h3>
                  <span className="ml-auto text-xs text-slate-400">15 levels</span>
                </div>
                {(() => {
                  const snap    = bookSnap[selectedMarket.symbol];
                  const bids    = snap?.levels?.[0]?.slice(0, 15) || [];
                  const asks    = snap?.levels?.[1]?.slice(0, 15) || [];
                  const allSz   = [...bids, ...asks].map((l) => Number(l.sz || 0));
                  const maxSize = Math.max(...allSz, 1);

                  if (!snap) return (
                    <p className="text-center text-xs text-slate-400 py-12">
                      Waiting for {prefixedSymbol(selectedMarket)} book snapshot…
                    </p>
                  );

                  return (
                    <div className="grid grid-cols-2 divide-x divide-slate-100">
                      {/* BIDS */}
                      <div>
                        <div className="px-4 py-2 text-xs font-semibold text-emerald-600 uppercase tracking-wider bg-emerald-50/60">
                          Bids
                        </div>
                        {bids.map((l, i) => {
                          const pct = (Number(l.sz) / maxSize) * 100;
                          return (
                            <div key={i} className="relative flex items-center justify-between px-4 py-[5px] text-xs overflow-hidden">
                              <div
                                className="absolute inset-y-0 right-0 bg-emerald-50"
                                style={{ width: `${pct}%` }}
                              />
                              <span className="relative text-emerald-700 font-mono font-medium">{fmtPrice(l.px)}</span>
                              <span className="relative text-slate-400 font-mono">{Number(l.sz).toFixed(3)}</span>
                            </div>
                          );
                        })}
                      </div>
                      {/* ASKS */}
                      <div>
                        <div className="px-4 py-2 text-xs font-semibold text-rose-500 uppercase tracking-wider bg-rose-50/60">
                          Asks
                        </div>
                        {asks.map((l, i) => {
                          const pct = (Number(l.sz) / maxSize) * 100;
                          return (
                            <div key={i} className="relative flex items-center justify-between px-4 py-[5px] text-xs overflow-hidden">
                              <div
                                className="absolute inset-y-0 left-0 bg-rose-50"
                                style={{ width: `${pct}%` }}
                              />
                              <span className="relative text-rose-600 font-mono font-medium">{fmtPrice(l.px)}</span>
                              <span className="relative text-slate-400 font-mono">{Number(l.sz).toFixed(3)}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
                                     }
