// 從證交所抓取 0050 日成交資料，寫入 data/0050.json。
// 在 GitHub Actions 執行器上執行（Node 20+，使用內建 fetch）。
//
// 增量策略：已有快照時只補抓最近兩個月（避免對證交所大量請求觸發限流）；
// 沒有快照才全量抓 26 個月。抓取失敗但已有快照時，沿用舊資料並以成功結束，
// 讓網站部署不被資料來源的暫時性限流卡住。
const fs = require('fs');

const STOCK_NO = '0050';
const FULL_MONTHS = 26;
const OUT = 'data/0050.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (s) => Number(String(s).replace(/,/g, ''));

function monthKey(offset) {
  const now = new Date();
  const t = new Date(now.getFullYear(), now.getMonth() - offset, 1);
  return `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}01`;
}

async function fetchMonth(ym) {
  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${ym}&stockNo=${STOCK_NO}&response=json`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          Accept: 'application/json',
          Referer: 'https://www.twse.com.tw/zh/trading/historical/stock-day.html',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const rows = [];
      if (json.stat === 'OK' && Array.isArray(json.data)) {
        // 欄位：日期(民國), 成交股數, 成交金額, 開盤, 最高, 最低, 收盤, 漲跌價差, 成交筆數
        for (const r of json.data) {
          const [y, m, d] = r[0].split('/');
          const row = {
            d: `${Number(y) + 1911}-${m}-${d}`,
            o: num(r[3]), h: num(r[4]), l: num(r[5]), c: num(r[6]),
            v: Math.round(num(r[1]) / 1000), // 股 -> 張
          };
          if (Number.isFinite(row.c) && row.v > 0) rows.push(row);
        }
      }
      return rows; // stat 非 OK（例如未來月份）視為空月
    } catch (e) {
      console.error(`${ym} 第 ${attempt} 次失敗：${e}`);
      if (attempt < 3) await sleep(3000 * attempt);
    }
  }
  throw new Error(`${ym} 三次都失敗`);
}

(async () => {
  let existing = [];
  try {
    const old = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (Array.isArray(old.rows) && old.rows.length >= 100) existing = old.rows;
  } catch { /* 沒有既有快照 */ }

  // 已有快照 → 只補最近兩個月；否則全量
  const months = existing.length
    ? [monthKey(1), monthKey(0)]
    : Array.from({ length: FULL_MONTHS }, (_, i) => monthKey(FULL_MONTHS - 1 - i));

  const fetched = [];
  let failed = 0;
  for (let i = 0; i < months.length; i++) {
    try {
      fetched.push(...await fetchMonth(months[i]));
    } catch (e) {
      failed++;
      console.error(String(e));
    }
    if (i < months.length - 1) await sleep(1200); // 禮貌性節流
  }

  const byDate = new Map(existing.map((r) => [r.d, r]));
  for (const r of fetched) byDate.set(r.d, r);
  const merged = [...byDate.values()].sort((a, b) => (a.d < b.d ? -1 : 1));

  if (merged.length < 100) {
    console.error(`資料不足（${merged.length} 筆）且無既有快照可沿用，失敗`);
    process.exit(1);
  }
  if (fetched.length === 0 && existing.length) {
    console.log(`證交所暫時抓不到（${failed} 個月失敗），沿用既有快照：${existing.length} 筆，最後交易日 ${existing[existing.length - 1].d}`);
    process.exit(0); // 不改寫檔案，部署沿用舊資料
  }

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    updated: new Date().toISOString(),
    stockNo: STOCK_NO,
    rows: merged,
  }));
  console.log(`完成：${merged.length} 個交易日，${merged[0].d} ~ ${merged[merged.length - 1].d}，最新收盤 ${merged[merged.length - 1].c}（本次新抓 ${fetched.length} 筆，失敗 ${failed} 個月）`);
})();
