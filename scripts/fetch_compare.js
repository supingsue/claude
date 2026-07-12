// 抓取跨市場比較資料，寫入 data/compare.json：
// - 美股常用標的日收盤、USD/TWD 匯率、美債 10 年殖利率：Yahoo Finance chart API（主）/ Stooq（備援）
// - 聯邦資金有效利率 EFFR：紐約聯儲公開 API
// 個別來源失敗時沿用舊檔中的該序列，不擋部署。
const fs = require('fs');

const OUT = 'data/compare.json';
const MONTHS = 26;
const US_TICKERS = ['SPY', 'QQQ', 'VOO', 'VT', 'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'BRK-B'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'application/json,text/csv,*/*',
};

function since() {
  const t = new Date();
  t.setMonth(t.getMonth() - MONTHS);
  return t;
}
const ymd = (t) => t.toISOString().slice(0, 10).replace(/-/g, '');

async function getJSON(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.slice(0, 80)}`);
  return res.json();
}

/* Yahoo v8 chart：回傳 [{d, c}] */
async function yahooDaily(symbol, scale = 1) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d&events=div%7Csplit`;
  const json = await getJSON(url);
  const r = json.chart && json.chart.result && json.chart.result[0];
  if (!r || !Array.isArray(r.timestamp)) throw new Error(`${symbol} 無資料`);
  const closes = r.indicators.quote[0].close;
  const rows = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const c = closes[i];
    if (c === null || !Number.isFinite(c) || c <= 0) continue;
    rows.push({ d: new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10), c: +(c * scale).toFixed(4) });
  }
  if (rows.length < 40) throw new Error(`${symbol} 資料太少（${rows.length}）`);
  return rows;
}

/* Stooq CSV 備援 */
async function stooqDaily(symbol) {
  const res = await fetch(`https://stooq.com/q/d/l/?s=${symbol}&d1=${ymd(since())}&d2=${ymd(new Date())}&i=d`, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status} stooq ${symbol}`);
  const lines = (await res.text()).trim().split('\n');
  const rows = [];
  for (const line of lines.slice(1)) {
    const p = line.split(',');
    const c = Number(p[4]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(p[0]) && Number.isFinite(c) && c > 0) rows.push({ d: p[0], c });
  }
  if (rows.length < 40) throw new Error(`stooq ${symbol} 資料太少（${rows.length}）`);
  return rows;
}

async function marketDaily(yahooSym, stooqSym, scale = 1) {
  try { return await yahooDaily(yahooSym, scale); }
  catch (e) {
    console.error(`Yahoo 失敗改用 Stooq：${e}`);
    return stooqDaily(stooqSym);
  }
}

/* 紐約聯儲：聯邦資金有效利率 EFFR */
async function fetchEFFR() {
  const start = since().toISOString().slice(0, 10);
  const url = `https://markets.newyorkfed.org/api/rates/unsecured/effr/search.json?startDate=${start}`;
  const json = await getJSON(url);
  const rows = (json.refRates || [])
    .filter((r) => Number.isFinite(Number(r.percentRate)))
    .map((r) => ({ d: r.effectiveDate, v: Number(r.percentRate) }))
    .sort((a, b) => (a.d < b.d ? -1 : 1));
  if (rows.length < 40) throw new Error(`EFFR 資料太少（${rows.length}）`);
  return rows;
}

(async () => {
  let old = { us: {}, fx: [], dff: [], dgs10: [] };
  try { old = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* 首次 */ }

  const out = { updated: new Date().toISOString(), us: {}, fx: old.fx || [], dff: old.dff || [], dgs10: old.dgs10 || [] };
  let ok = 0, fail = 0;

  for (const sym of US_TICKERS) {
    try {
      out.us[sym] = await marketDaily(sym, `${sym.toLowerCase()}.us`);
      ok++;
    } catch (e) {
      console.error(String(e));
      if (old.us && old.us[sym]) out.us[sym] = old.us[sym];
      fail++;
    }
    await sleep(800);
  }
  try { out.fx = await marketDaily('TWD=X', 'usdtwd'); ok++; } catch (e) { console.error(String(e)); fail++; }
  await sleep(800);
  // Yahoo 的 ^TNX 即為殖利率百分比（例 4.57）
  try { out.dgs10 = (await yahooDaily('^TNX')).map((r) => ({ d: r.d, v: +r.c.toFixed(3) })); ok++; }
  catch (e) { console.error(String(e)); fail++; }
  await sleep(800);
  try { out.dff = await fetchEFFR(); ok++; } catch (e) { console.error(String(e)); fail++; }

  const haveAny = Object.keys(out.us).length || out.fx.length || out.dff.length;
  if (!haveAny) {
    console.error('所有比較資料來源都失敗且無舊檔可沿用');
    process.exit(0); // 不擋部署
  }
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`完成：成功 ${ok}、失敗 ${fail}；美股 ${Object.keys(out.us).length} 檔、匯率 ${out.fx.length} 筆、EFFR ${out.dff.length} 筆、美債10Y ${out.dgs10.length} 筆`);
})();
