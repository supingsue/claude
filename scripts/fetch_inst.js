// 從證交所 T86（三大法人買賣超日報）累積 0050 的法人買賣超歷史，
// 寫入 data/0050_inst.json。T86 一次只能查一天，因此採增量累積：
// 每次執行補抓缺少的交易日（上限 30 天），由每日排程逐步建立歷史。
const fs = require('fs');

const STOCK_NO = '0050';
const PRICE_FILE = 'data/0050.json';
const OUT = 'data/0050_inst.json';
const MAX_DAYS_PER_RUN = 30;
const BACKFILL_DAYS = 120; // 首次建檔往回補的交易日數
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (s) => Number(String(s).replace(/,/g, ''));

async function fetchDay(ymd) {
  const url = `https://www.twse.com.tw/rwd/zh/fund/T86?date=${ymd}&selectType=ALLBUT0999&response=json`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          Accept: 'application/json',
          Referer: 'https://www.twse.com.tw/zh/trading/foreign/t86.html',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.stat !== 'OK' || !Array.isArray(json.data)) return null; // 非交易日
      const row = json.data.find((r) => String(r[0]).trim() === STOCK_NO);
      if (!row) return null;
      // T86 欄位：0 代號, 4 外陸資買賣超, 7 外資自營商買賣超, 10 投信買賣超,
      //           11 自營商買賣超(合計), 18 三大法人買賣超（單位：股）
      const f = Math.round((num(row[4]) + num(row[7] ?? 0)) / 1000); // 外資（張）
      const t = Math.round(num(row[10]) / 1000);                     // 投信（張）
      const dl = Math.round(num(row[11]) / 1000);                    // 自營商（張）
      return { f, t, dl };
    } catch (e) {
      console.error(`${ymd} 第 ${attempt} 次失敗：${e}`);
      if (attempt < 2) await sleep(4000);
    }
  }
  throw new Error(`${ymd} 抓取失敗`);
}

(async () => {
  // 交易日清單以價格快照為準
  let tradingDays = [];
  try {
    const price = JSON.parse(fs.readFileSync(PRICE_FILE, 'utf8'));
    tradingDays = price.rows.map((r) => r.d);
  } catch {
    console.error('讀不到價格快照，無法決定交易日，略過法人資料更新');
    process.exit(0);
  }

  let existing = [];
  try {
    const old = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (Array.isArray(old.rows)) existing = old.rows;
  } catch { /* 首次建檔 */ }
  const have = new Set(existing.map((r) => r.d));

  // 目標範圍：最近 BACKFILL_DAYS 個交易日中缺少的（新→舊補，最新資料優先）
  const targets = tradingDays.slice(-BACKFILL_DAYS).filter((d) => !have.has(d)).reverse()
                             .slice(0, MAX_DAYS_PER_RUN);
  if (!targets.length) {
    console.log(`法人資料已是最新（${existing.length} 筆）`);
    process.exit(0);
  }

  const added = [];
  let consecFail = 0;
  for (let i = 0; i < targets.length; i++) {
    const ymd = targets[i].replace(/-/g, '');
    try {
      const r = await fetchDay(ymd);
      consecFail = 0;
      if (r) added.push({ d: targets[i], ...r });
    } catch {
      consecFail++;
      if (consecFail >= 3) { // 連續失敗多半是限流，保留額度下次再補
        console.error('連續失敗，提前結束本次補抓');
        break;
      }
    }
    if (i < targets.length - 1) await sleep(1500);
  }

  if (!added.length) {
    console.log(`本次未新增資料（既有 ${existing.length} 筆），沿用舊檔`);
    process.exit(0);
  }
  const byDate = new Map(existing.map((r) => [r.d, r]));
  for (const r of added) byDate.set(r.d, r);
  const merged = [...byDate.values()].sort((a, b) => (a.d < b.d ? -1 : 1));
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    updated: new Date().toISOString(),
    stockNo: STOCK_NO,
    note: '單位：張。f=外資(含外資自營商) t=投信 dl=自營商 買賣超',
    rows: merged,
  }));
  console.log(`完成：新增 ${added.length} 筆，共 ${merged.length} 筆（${merged[0].d} ~ ${merged[merged.length - 1].d}）`);
})();
