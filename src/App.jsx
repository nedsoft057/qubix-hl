import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { createClient } from "graphql-ws";
import {
  Search,
  X,
  Plus,
  Wifi,
  WifiOff,
  TrendingUp,
  TrendingDown,
  Activity,
  BarChart3,
  ChevronRight,
  ArrowLeft,
  Wallet,
  AlertTriangle,
} from "lucide-react";

/* ============================================================================
   CONFIG
   ----------------------------------------------------------------------------
   API key handling: per explicit instruction, this is kept client-side and
   inlined below. WARNING — any key in this file ships inside the JS bundle
   served to every browser that loads the page; it is extractable via dev
   tools / network tab by anyone who visits. Do not reuse a key here that is
   also used for server-side / billable production traffic.
   ============================================================================ */
const API_KEY =
  import.meta.env?.VITE_GOLDRUSH_API_KEY || "cqt_rQGqFvkV3QPm7qCcGHDPqqPWtRFK";

const GRAPHQL_WS_ENDPOINT = "wss://gr-staging-v2.streaming.covalenthq.com/graphql";

// Hyperliquid HyperCore chain slug as used elsewhere in GoldRush's REST/GraphQL
// surface. CONFIRM against your GoldRush dashboard / schema explorer — public
// docs at time of writing don't enumerate the exact slug for every endpoint.
const CHAIN_NAME = "hyperliquid-mainnet";

/* GraphQL subscription documents.
   Field/argument names are best-effort based on Covalent's public statement
   that Streaming API support is live on HyperCore for "OHLCV pairs, OHLCV
   tokens, wallet activity" — the precise schema (field names, args, nested
   shape) was not published. CONFIRM each of these against introspection
   (GraphiQL "Docs" panel) on your account before relying on this in prod. */
const QUERIES = {
  // CONFIRM: field name, arg names, and return shape
  walletActivity: `
    subscription WalletActivity($chainName: String!, $address: String!) {
      walletActivity(chainName: $chainName, address: $address) {
        address
        txHash
        timestamp
        activityType
        asset
        amount
        usdValue
      }
    }
  `,
  // CONFIRM: field name, arg names, and return shape
  ohlcvToken: `
    subscription OhlcvToken($chainName: String!, $symbol: String!) {
      ohlcvToken(chainName: $chainName, symbol: $symbol) {
        symbol
        timestamp
        open
        high
        low
        close
        volume
      }
    }
  `,
};

const DEFAULT_WALLETS = [
  "0x31ca8395cf837de08b24da3f660e77761dfb974",
  "0x010461c14e146ac35fe42271bdc1134ee31c703",
];

const DEFAULT_MARKETS = [
  { symbol: "BTC", marketType: "perp" },
  { symbol: "ETH", marketType: "perp" },
  { symbol: "SOL", marketType: "perp" },
  { symbol: "@PURR/USDC", marketType: "spot" },
  { symbol: "#FED-CUT-JUN", marketType: "outcome" },
  { symbol: ":XAU", marketType: "hip3" },
];

const MARKET_PREFIX = {
  spot: "@",
  outcome: "#",
  hip3: ":",
  perp: "",
};

const MAX_FEED_ITEMS = 200;

function prefixedSymbol(market) {
  const raw = market.symbol.replace(/^[@#:]/, "");
  const prefix = MARKET_PREFIX[market.marketType] ?? "";
  return market.symbol.startsWith(prefix) && prefix
    ? market.symbol
    : `${prefix}${raw}`;
}

function shortAddr(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function timeAgo(ts) {
  if (!ts) return "";
  const diff = Date.now() - (ts > 1e12 ? ts : ts * 1000);
  const s = Math.max(0, Math.floor(diff / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

/* ============================================================================
   GraphQL-WS connection hook
   One client (one underlying WebSocket) multiplexes every subscription —
   wallet activity per tracked wallet, OHLCV per tracked market.
   ============================================================================ */
function useGoldRushStream(apiKey, wallets, markets, onActivity, onOhlcv) {
  const [status, setStatus] = useState("connecting"); // connecting | open | closed | error
  const clientRef = useRef(null);
  const unsubsRef = useRef([]);

  useEffect(() => {
    if (!apiKey) return;

    const client = createClient({
      url: GRAPHQL_WS_ENDPOINT,
      connectionParams: { apiKey },
      retryAttempts: Infinity,
      shouldRetry: () => true,
      on: {
        connected: () => setStatus("open"),
        closed: () => setStatus("closed"),
        error: () => setStatus("error"),
      },
    });
    clientRef.current = client;
    setStatus("connecting");

    return () => {
      unsubsRef.current.forEach((u) => u());
      unsubsRef.current = [];
      client.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  // (Re-)subscribe to wallet activity whenever the tracked wallet list changes.
  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;
    const localUnsubs = [];

    wallets.forEach((address) => {
      const unsubscribe = client.subscribe(
        {
          query: QUERIES.walletActivity,
          variables: { chainName: CHAIN_NAME, address },
        },
        {
          next: (msg) => {
            const payload = msg?.data?.walletActivity;
            if (payload) onActivity({ ...payload, address });
          },
          error: () => {
            /* surfaced via connection-level status badge */
          },
          complete: () => {},
        }
      );
      localUnsubs.push(unsubscribe);
    });

    unsubsRef.current.push(...localUnsubs);
    return () => localUnsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallets.join("|"), status === "open"]);

  // (Re-)subscribe to OHLCV whenever the tracked market list changes.
  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;
    const localUnsubs = [];

    markets.forEach((m) => {
      const unsubscribe = client.subscribe(
        {
          query: QUERIES.ohlcvToken,
          variables: { chainName: CHAIN_NAME, symbol: m.symbol.replace(/^[@#:]/, "") },
        },
        {
          next: (msg) => {
            const payload = msg?.data?.ohlcvToken;
            if (payload) onOhlcv({ ...payload, marketType: m.marketType, rawSymbol: m.symbol });
          },
          error: () => {},
          complete: () => {},
        }
      );
      localUnsubs.push(unsubscribe);
    });

    unsubsRef.current.push(...localUnsubs);
    return () => localUnsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markets.map((m) => m.symbol).join("|"), status === "open"]);

  return status;
}

/* ============================================================================
   Small UI atoms
   ============================================================================ */
function Sparkline({ points, width = 220, height = 56, positive = true }) {
  if (!points || points.length < 2) {
    return <div style={{ width, height }} className="opacity-30 text-xs flex items-end">no data yet</div>;
  }
  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;
  const stepX = width / (points.length - 1);
  const path = points
    .map((p, i) => {
      const x = i * stepX;
      const y = height - ((p - min) / range) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const areaPath = `${path} L${width},${height} L0,${height} Z`;
  const stroke = positive ? "#16a34a" : "#dc2626";

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="overflow-visible">
      <path d={areaPath} fill={stroke} opacity="0.08" />
      <path d={path} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function KpiCard({ label, value, sub, sparklinePoints, positive = true, icon: Icon }) {
  return (
    <div className="bg-white rounded-2xl p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.08)] border border-slate-100">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-slate-400 tracking-wide uppercase">{label}</p>
          <p className="text-2xl font-semibold text-slate-900 mt-1">{value}</p>
          {sub && <p className="text-xs text-slate-400 mt-1">{sub}</p>}
        </div>
        {Icon && (
          <div className="w-9 h-9 rounded-xl bg-slate-50 flex items-center justify-center text-slate-400">
            <Icon size={16} />
          </div>
        )}
      </div>
      {sparklinePoints && (
        <div className="mt-3 -ml-1">
          <Sparkline points={sparklinePoints} positive={positive} width={200} height={48} />
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status, wallets, markets }) {
  const subCount = wallets.length + markets.length;
  const connLabel =
    status === "open" ? "1 conn" : status === "connecting" ? "connecting…" : "disconnected";
  const Icon = status === "open" ? Wifi : WifiOff;
  const dot =
    status === "open" ? "bg-emerald-400" : status === "connecting" ? "bg-amber-400" : "bg-rose-400";

  const publicHlEstimate = wallets.length * 2 + markets.length; // userFills+orderUpdates per wallet, l2Book per market

  return (
    <div className="hidden md:flex items-center gap-2">
      <div className="flex items-center gap-1.5 bg-slate-900 text-slate-200 text-xs px-3 py-1.5 rounded-full">
        <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
        <Icon size={12} />
        <span>GoldRush: {connLabel} · {subCount} subs</span>
      </div>
      <div className="flex items-center gap-1.5 bg-slate-100 text-slate-500 text-xs px-3 py-1.5 rounded-full">
        <span>Public HL: ~{publicHlEstimate}+ subs across separate sockets, 1000/IP cap</span>
      </div>
    </div>
  );
}

/* ============================================================================
   Main App
   ============================================================================ */
export default function App() {
  const [wallets, setWallets] = useState(DEFAULT_WALLETS);
  const [walletInput, setWalletInput] = useState("");
  const [markets] = useState(DEFAULT_MARKETS);

  const [activityFeed, setActivityFeed] = useState([]);
  const [ohlcvFeed, setOhlcvFeed] = useState([]);
  const [ticker, setTicker] = useState({}); // symbol -> latest ohlcv row
  const [candleHistory, setCandleHistory] = useState({}); // symbol -> array of rows

  const [throughputBuckets, setThroughputBuckets] = useState(Array(30).fill(0));
  const throughputRef = useRef(0);

  const [activeTab, setActiveTab] = useState("activity"); // activity | ohlcv
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedMarket, setSelectedMarket] = useState(null);

  const handleActivity = useCallback((row) => {
    throughputRef.current += 1;
    setActivityFeed((prev) => [row, ...prev].slice(0, MAX_FEED_ITEMS));
  }, []);

  const handleOhlcv = useCallback((row) => {
    throughputRef.current += 1;
    setOhlcvFeed((prev) => [row, ...prev].slice(0, MAX_FEED_ITEMS));
    setTicker((prev) => ({ ...prev, [row.symbol]: row }));
    setCandleHistory((prev) => {
      const existing = prev[row.symbol] || [];
      return { ...prev, [row.symbol]: [row, ...existing].slice(0, 60) };
    });
  }, []);

  const status = useGoldRushStream(API_KEY, wallets, markets, handleActivity, handleOhlcv);

  // Roll a throughput bucket every 2s for the sparkline.
  useEffect(() => {
    const id = setInterval(() => {
      setThroughputBuckets((prev) => {
        const next = [...prev.slice(1), throughputRef.current];
        throughputRef.current = 0;
        return next;
      });
    }, 2000);
    return () => clearInterval(id);
  }, []);

  const addWallet = () => {
    const cleaned = walletInput.trim().toLowerCase();
    if (!cleaned) return;
    if (!/^0x[a-f0-9]{40}$/.test(cleaned)) return;
    if (wallets.includes(cleaned)) return;
    setWallets((prev) => [...prev, cleaned]);
    setWalletInput("");
  };

  const removeWallet = (addr) => setWallets((prev) => prev.filter((w) => w !== addr));

  const filteredMarkets = useMemo(() => {
    if (!search.trim()) return markets;
    const q = search.trim().toLowerCase();
    return markets.filter((m) => m.symbol.toLowerCase().includes(q));
  }, [search, markets]);

  const liveMarketRows = markets.map((m) => {
    const last = ticker[m.symbol];
    const history = candleHistory[m.symbol] || [];
    const prevClose = history[1]?.close;
    const changePct =
      last && prevClose ? (((last.close - prevClose) / prevClose) * 100).toFixed(2) : null;
    return { ...m, last, changePct };
  });

  if (!API_KEY) {
    return (
      <div className="fixed inset-0 bg-slate-950 flex items-center justify-center">
        <div className="text-center px-6">
          <AlertTriangle className="mx-auto mb-4 text-amber-400" size={32} />
          <h1 className="text-white text-xl font-semibold">GoldRush API Key Required</h1>
          <p className="text-slate-400 text-sm mt-2">
            Set VITE_GOLDRUSH_API_KEY in your environment to start streaming.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* TOP NAV */}
      <header className="sticky top-0 z-20 bg-white/90 backdrop-blur border-b border-slate-100">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center gap-6">
          <div className="flex items-center gap-2 shrink-0">
            <div className="w-8 h-8 rounded-lg bg-slate-900 flex items-center justify-center">
              <Activity size={16} className="text-white" />
            </div>
            <span className="font-semibold text-slate-900 tracking-tight">Qubix HL</span>
          </div>

          <div className="relative flex-1 max-w-md">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setSearchOpen(true);
              }}
              onFocus={() => setSearchOpen(true)}
              onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
              placeholder="Search streaming assets…"
              className="w-full bg-slate-100 text-sm rounded-lg pl-9 pr-3 py-2 outline-none focus:ring-2 focus:ring-slate-300 placeholder:text-slate-400"
            />
            {searchOpen && search.trim() && (
              <div className="absolute top-full mt-1 w-full bg-white rounded-xl shadow-lg border border-slate-100 overflow-hidden z-30">
                {filteredMarkets.length === 0 && (
                  <div className="px-4 py-3 text-sm text-slate-400">No matching assets</div>
                )}
                {filteredMarkets.map((m) => (
                  <button
                    key={m.symbol}
                    onClick={() => {
                      setSelectedMarket(m);
                      setSearch("");
                      setSearchOpen(false);
                    }}
                    className="w-full text-left px-4 py-2.5 text-sm hover:bg-slate-50 flex items-center justify-between"
                  >
                    <span className="font-medium text-slate-700">{prefixedSymbol(m)}</span>
                    <ChevronRight size={14} className="text-slate-300" />
                  </button>
                ))}
              </div>
            )}
          </div>

          <StatusBadge status={status} wallets={wallets} markets={markets} />
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-[420px_1fr] gap-6">
        {/* LEFT COLUMN */}
        <div className="space-y-6">
          {/* KPI CARDS */}
          <div className="grid grid-cols-2 gap-4">
            <KpiCard
              label="Tracked Wallets"
              value={wallets.length}
              sub="Wallet activity stream"
              icon={Wallet}
            />
            <KpiCard
              label="Tracked Markets"
              value={markets.length}
              sub="OHLCV stream"
              icon={BarChart3}
            />
            <div className="col-span-2">
              <KpiCard
                label="Stream Throughput"
                value={`${throughputBuckets[throughputBuckets.length - 1] ?? 0}/2s`}
                sub="Messages received across all subscriptions"
                sparklinePoints={throughputBuckets}
                positive={true}
                icon={Activity}
              />
            </div>
          </div>

          {/* WALLET CONFIGURATOR */}
          <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <h3 className="text-sm font-semibold text-slate-700 mb-3">Watched Wallets</h3>
            <div className="flex gap-2 mb-3">
              <input
                value={walletInput}
                onChange={(e) => setWalletInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addWallet()}
                placeholder="0x… add address"
                className="flex-1 bg-slate-50 text-sm rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-slate-200 placeholder:text-slate-400"
              />
              <button
                onClick={addWallet}
                className="bg-slate-900 text-white rounded-lg px-3 py-2 hover:bg-slate-800 transition-colors"
              >
                <Plus size={15} />
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {wallets.map((addr) => (
                <span
                  key={addr}
                  className="inline-flex items-center gap-1.5 bg-slate-100 text-slate-600 text-xs font-mono px-2.5 py-1.5 rounded-full"
                >
                  {shortAddr(addr)}
                  <button onClick={() => removeWallet(addr)} className="text-slate-400 hover:text-rose-500">
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          </div>

          {/* FEEDS */}
          <div className="bg-white rounded-2xl border border-slate-100 shadow-[0_1px_2px_rgba(0,0,0,0.04)] overflow-hidden">
            <div className="flex border-b border-slate-100">
              {[
                { key: "activity", label: "ACTIVITY" },
                { key: "ohlcv", label: "OHLCV" },
              ].map((t) => (
                <button
                  key={t.key}
                  onClick={() => setActiveTab(t.key)}
                  className={`flex-1 text-xs font-semibold tracking-wide py-3 transition-colors ${
                    activeTab === t.key
                      ? "text-slate-900 border-b-2 border-slate-900"
                      : "text-slate-400 hover:text-slate-600"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="max-h-[420px] overflow-y-auto divide-y divide-slate-50">
              {activeTab === "activity" &&
                (activityFeed.length === 0 ? (
                  <p className="text-center text-xs text-slate-400 py-8">Waiting for wallet activity…</p>
                ) : (
                  activityFeed.map((row, i) => {
                    const isBuyLike = /buy|deposit|receive/i.test(row.activityType || "");
                    return (
                      <div key={i} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            isBuyLike ? "bg-emerald-500" : "bg-rose-500"
                          }`}
                        />
                        <span className="font-mono text-xs text-slate-400 w-16">{shortAddr(row.address)}</span>
                        <span className="flex-1 text-slate-700 truncate">{row.activityType || "activity"}</span>
                        <span className="text-slate-900 font-medium">{row.asset}</span>
                        <span className="text-slate-400 text-xs w-10 text-right">{timeAgo(row.timestamp)}</span>
                      </div>
                    );
                  })
                ))}

              {activeTab === "ohlcv" &&
                (ohlcvFeed.length === 0 ? (
                  <p className="text-center text-xs text-slate-400 py-8">Waiting for OHLCV updates…</p>
                ) : (
                  ohlcvFeed.map((row, i) => {
                    const up = row.close >= row.open;
                    return (
                      <div key={i} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${up ? "bg-emerald-500" : "bg-rose-500"}`} />
                        <span className="font-medium text-slate-700 w-20">{row.symbol}</span>
                        <span className="flex-1 text-slate-400 text-xs">O {row.open} · H {row.high} · L {row.low}</span>
                        <span className="text-slate-900 font-medium">{row.close}</span>
                        <span className="text-slate-400 text-xs w-10 text-right">{timeAgo(row.timestamp)}</span>
                      </div>
                    );
                  })
                ))}
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN */}
        <div className="bg-white rounded-2xl border border-slate-100 shadow-[0_1px_2px_rgba(0,0,0,0.04)] overflow-hidden">
          {!selectedMarket ? (
            <>
              <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-700">Live Markets</h3>
                <span className="text-xs text-slate-400">{markets.length} tracked</span>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-400 uppercase tracking-wide">
                    <th className="px-5 py-3">Asset</th>
                    <th className="px-5 py-3">Last</th>
                    <th className="px-5 py-3">Chg %</th>
                    <th className="px-5 py-3">Volume</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {liveMarketRows.map((m) => {
                    const positive = m.changePct === null ? true : Number(m.changePct) >= 0;
                    return (
                      <tr
                        key={m.symbol}
                        onClick={() => setSelectedMarket(m)}
                        className="cursor-pointer hover:bg-slate-50 transition-colors"
                      >
                        <td className="px-5 py-3 font-medium text-slate-800">{prefixedSymbol(m)}</td>
                        <td className="px-5 py-3 text-slate-700">{m.last ? m.last.close : "—"}</td>
                        <td className="px-5 py-3">
                          {m.changePct === null ? (
                            <span className="text-slate-400">—</span>
                          ) : (
                            <span
                              className={`inline-flex items-center gap-1 ${
                                positive ? "text-emerald-600" : "text-rose-600"
                              }`}
                            >
                              {positive ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                              {m.changePct}%
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-3 text-slate-500">{m.last ? m.last.volume : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          ) : (
            <div>
              <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3">
                <button
                  onClick={() => setSelectedMarket(null)}
                  className="text-slate-400 hover:text-slate-700"
                >
                  <ArrowLeft size={16} />
                </button>
                <h3 className="text-sm font-semibold text-slate-700">
                  {prefixedSymbol(selectedMarket)} · recent candles
                </h3>
              </div>
              <div className="px-5 py-3 grid grid-cols-5 text-xs text-slate-400 uppercase tracking-wide">
                <span>Time</span>
                <span>Open</span>
                <span>High</span>
                <span>Low</span>
                <span>Close</span>
              </div>
              <div className="divide-y divide-slate-50 max-h-[480px] overflow-y-auto">
                {(candleHistory[selectedMarket.symbol] || []).length === 0 ? (
                  <p className="text-center text-xs text-slate-400 py-10">
                    No candles received yet for this symbol.
                  </p>
                ) : (
                  (candleHistory[selectedMarket.symbol] || []).map((c, i) => (
                    <div key={i} className="px-5 py-2.5 grid grid-cols-5 text-sm font-mono">
                      <span className="text-slate-400 text-xs">{timeAgo(c.timestamp)}</span>
                      <span className="text-slate-600">{c.open}</span>
                      <span className="text-emerald-600">{c.high}</span>
                      <span className="text-rose-600">{c.low}</span>
                      <span className="text-slate-900 font-semibold">{c.close}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

