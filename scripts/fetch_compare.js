// 抓取跨市場比較資料，寫入 data/compare.json：
// - 美股常用標的日收盤（Stooq，免金鑰）
// - 美元兌台幣匯率 USD/TWD（Stooq）
// - 美國利率：聯邦資金利率 DFF、美債 10 年殖利率 DGS10（FRED 公開 CSV）
// 個別來源失敗時沿用舊檔中的該序列，不擋部署。
const fs = require('fs');

const OUT = 'data/compare.json';
const MONTHS = 26;
const US_TICKERS = ['SPY', 'QQQ', 'VOO', 'VT', 'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'BRK-B'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36' };

function since() {
  const t = new Date();
  t.setMonth(t.getMonth() - MONTHS);
  return t;
}
const iso = (t) => t.toISOString().slice(0, 10);
const ymd = (t) => iso(t).replace(/-/g, '');

async function fetchCSV(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return (await res.text()).trim().split('\n');
}

async function stooqDaily(symbol) {
  const lines = await fetchCSV(`https://stooq.com/q/d/l/?s=${symbol}&d1=${ymd(since())}&d2=${ymd(new Date())}&i=d`);
  // Date,Open,High,Low,Close,Volume
  const rows = [];
  for (const line of lines.slice(1)) {
    const p = line.split(',');
    const c = Number(p[4]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(p[0]) && Number.isFinite(c) && c > 0) rows.push({ d: p[0], c });
  }
  if (rows.length < 40) throw new Error(`${symbol} 資料太少（${rows.length}）`);
  return rows;
}

async function fredSeries(id) {
  const lines = await fetchCSV(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${iso(since())}`);
  const rows = [];
  for (const line of lines.slice(1)) {
    const [d, v] = line.split(',');
    const n = Number(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(n)) rows.push({ d, v: n });
  }
  if (rows.length < 40) throw new Error(`${id} 資料太少（${rows.length}）`);
  return rows;
}

(async () => {
  let old = { us: {}, fx: [], dff: [], dgs10: [] };
  try { old = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* 首次 */ }

  const out = { updated: new Date().toISOString(), us: {}, fx: old.fx || [], dff: old.dff || [], dgs10: old.dgs10 || [] };
  let ok = 0, fail = 0;

  for (const sym of US_TICKERS) {
    try {
      out.us[sym] = await stooqDaily(`${sym.toLowerCase()}.us`);
      ok++;
    } catch (e) {
      console.error(String(e));
      if (old.us && old.us[sym]) out.us[sym] = old.us[sym];
      fail++;
    }
    await sleep(600);
  }
  try { out.fx = await stooqDaily('usdtwd'); ok++; } catch (e) { console.error(String(e)); fail++; }
  await sleep(600);
  try { out.dff = await fredSeries('DFF'); ok++; } catch (e) { console.error(String(e)); fail++; }
  await sleep(600);
  try { out.dgs10 = await fredSeries('DGS10'); ok++; } catch (e) { console.error(String(e)); fail++; }

  const haveAny = Object.keys(out.us).length || out.fx.length || out.dff.length;
  if (!haveAny) {
    console.error('所有比較資料來源都失敗且無舊檔可沿用');
    process.exit(0); // 不擋部署
  }
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`完成：成功 ${ok} 個來源、失敗 ${fail} 個；美股 ${Object.keys(out.us).length} 檔、匯率 ${out.fx.length} 筆、DFF ${out.dff.length} 筆、DGS10 ${out.dgs10.length} 筆`);
})();
