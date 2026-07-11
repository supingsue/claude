// 從證交所抓取 0050 近 26 個月的日成交資料，寫入 data/0050.json。
// 在 GitHub Actions 執行器上執行（Node 20+，使用內建 fetch）。
const fs = require('fs');

const STOCK_NO = '0050';
const MONTHS = 26;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (s) => Number(String(s).replace(/,/g, ''));

(async () => {
  const now = new Date();
  const rows = [];
  for (let i = MONTHS - 1; i >= 0; i--) {
    const t = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}01`;
    const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${ym}&stockNo=${STOCK_NO}&response=json`;
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; 0050-volume-dashboard)', Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
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
        ok = true; // stat 非 OK（例如未來月份）視為空月，不重試
      } catch (e) {
        console.error(`${ym} 第 ${attempt} 次失敗：${e}`);
        await sleep(1500 * attempt);
      }
    }
    await sleep(400); // 禮貌性節流
  }

  const seen = new Set();
  const uniq = rows.filter((r) => !seen.has(r.d) && seen.add(r.d))
                   .sort((a, b) => (a.d < b.d ? -1 : 1));
  if (uniq.length < 100) {
    console.error(`抓到的資料太少（${uniq.length} 筆），放棄寫入以免覆蓋既有快照`);
    process.exit(1);
  }
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/0050.json', JSON.stringify({
    updated: new Date().toISOString(),
    stockNo: STOCK_NO,
    rows: uniq,
  }));
  console.log(`完成：${uniq.length} 個交易日，${uniq[0].d} ~ ${uniq[uniq.length - 1].d}，最新收盤 ${uniq[uniq.length - 1].c}`);
})();
