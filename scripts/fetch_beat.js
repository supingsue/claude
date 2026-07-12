// 十年報酬對決：以 Yahoo 還原收盤價（adjclose，含股息與分割調整）計算
// 約 40 檔台灣中大型股與 0050 的近十年總報酬，寫入 data/beat0050.json。
// 樣本 = 台灣50 主要成分股 + 市場知名的長期強勢股（含上櫃），非全市場掃描。
const fs = require('fs');

const OUT = 'data/beat0050.json';
const CANDIDATES = [
  ['0050', '元大台灣50'],
  ['2330', '台積電'], ['2454', '聯發科'], ['2317', '鴻海'], ['2308', '台達電'],
  ['2382', '廣達'], ['2303', '聯電'], ['2412', '中華電'], ['2881', '富邦金'],
  ['2882', '國泰金'], ['2886', '兆豐金'], ['2891', '中信金'], ['2884', '玉山金'],
  ['1216', '統一'], ['1301', '台塑'], ['1303', '南亞'], ['2002', '中鋼'],
  ['2603', '長榮'], ['2609', '陽明'], ['2615', '萬海'], ['3008', '大立光'],
  ['2345', '智邦'], ['3231', '緯創'], ['2357', '華碩'], ['2383', '台光電'],
  ['2368', '金像電'], ['3017', '奇鋐'], ['3324', '雙鴻'], ['2059', '川湖'],
  ['1590', '亞德客-KY'], ['5274', '信驊'], ['3661', '世芯-KY'], ['3529', '力旺'],
  ['4966', '譜瑞-KY'], ['5269', '祥碩'], ['3533', '嘉澤'], ['3653', '健策'],
  ['8454', '富邦媒'], ['2912', '統一超'], ['2395', '研華'], ['3443', '創意'],
  ['3034', '聯詠'], ['2379', '瑞昱'], ['6415', '矽力-KY'], ['2359', '所羅門'],
  ['6669', '緯穎'],
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'application/json',
};

async function yahoo10y(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=10y&interval=1mo&events=div%7Csplit`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${symbol}`);
  const json = await res.json();
  const r = json.chart && json.chart.result && json.chart.result[0];
  if (!r || !Array.isArray(r.timestamp)) throw new Error(`${symbol} 無資料`);
  const adj = (r.indicators.adjclose && r.indicators.adjclose[0].adjclose) || r.indicators.quote[0].close;
  const rows = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const c = adj[i];
    if (c === null || !Number.isFinite(c) || c <= 0) continue;
    rows.push({ d: new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10), c });
  }
  if (rows.length < 24) throw new Error(`${symbol} 資料太少（${rows.length}）`);
  return rows;
}

/* 上市/上櫃自動嘗試 */
async function twStock10y(no) {
  try { return await yahoo10y(`${no}.TW`); }
  catch { return yahoo10y(`${no}.TWO`); }
}

(async () => {
  const results = [];
  const skipped = [];
  const windowEnd = new Date().toISOString().slice(0, 10);
  const windowStart = new Date(Date.now() - 3652 * 86400000).toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() - (3652 - 183) * 86400000).toISOString().slice(0, 10); // 需在視窗起點半年內就有資料

  for (const [no, name] of CANDIDATES) {
    try {
      const rows = await twStock10y(no);
      const first = rows[0], last = rows[rows.length - 1];
      if (first.d > cutoff) {
        skipped.push({ no, name, reason: `上市未滿十年（自 ${first.d.slice(0, 7)}）` });
      } else {
        const years = (new Date(last.d) - new Date(first.d)) / 86400000 / 365.25;
        const mult = last.c / first.c;
        results.push({
          no, name,
          mult: +mult.toFixed(2),
          cagr: +((Math.pow(mult, 1 / years) - 1) * 100).toFixed(1),
          from: first.d, to: last.d,
        });
      }
    } catch (e) {
      console.error(`${no} ${name}：${e}`);
      skipped.push({ no, name, reason: '抓取失敗' });
    }
    await sleep(700);
  }

  const base = results.find((r) => r.no === '0050');
  if (!base) {
    console.error('0050 基準抓取失敗，不寫檔');
    process.exit(0);
  }
  results.sort((a, b) => b.mult - a.mult);
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    updated: new Date().toISOString(),
    window: { start: windowStart, end: windowEnd },
    method: 'Yahoo Finance 還原收盤價（含股息、分割調整），月資料，近10年總報酬',
    base, rows: results, skipped,
  }));
  const beat = results.filter((r) => r.no !== '0050' && r.mult > base.mult).length;
  console.log(`完成：${results.length} 檔（0050 十年 ${base.mult} 倍、年化 ${base.cagr}%），其中 ${beat} 檔打敗 0050；略過 ${skipped.length} 檔`);
  console.log('前五名：' + results.slice(0, 5).map((r) => `${r.name} ${r.mult}x`).join('、'));
})();
