// pump.fun trading fees from DefiLlama (public), cached at the edge for 10 minutes.
module.exports = async (req, res) => {
  try {
    const r = await fetch('https://api.llama.fi/summary/fees/pump.fun?dataType=dailyFees');
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    if (!j.total24h) throw new Error('empty');
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
    res.json({ day: j.total24h, week: j.total7d, month: j.total30d, all: j.totalAllTime, source: 'DefiLlama' });
  } catch (e) {
    res.status(502).json({ error: 'unavailable' });
  }
};
