const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ODDS_API_KEY = process.env.ODDS_API_KEY || '90462c6e64ffd14be6ce854222f5c7e9';
const AFL_SPORT = 'aussierules_afl';
const BASE = 'https://api.the-odds-api.com/v4';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => res.json({ status: 'AFL Multi Builder proxy running' }));

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'afl-multi-builder.html'));
});

app.get('/manifest.json', (req, res) => {
  res.json({
    name: 'AFL Multi Builder', short_name: 'AFL Multi',
    start_url: '/app', display: 'standalone',
    background_color: '#13151a', theme_color: '#13151a',
    icons: [{ src: '/icon.png', sizes: '192x192', type: 'image/png' }]
  });
});

app.get('/icon.png', (req, res) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192"><rect width="192" height="192" rx="32" fill="#1a3a6b"/><text x="96" y="130" font-size="100" text-anchor="middle">🏉</text></svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(svg);
});

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send('self.addEventListener("fetch", e => e.respondWith(fetch(e.request)));');
});

app.get('/debug', (req, res) => {
  res.send(`<html><body style="background:#13151a;color:#fff;padding:20px">
    <h2>Debug</h2><div id="s">Testing...</div>
    <script>
    fetch('/games').then(r=>r.json()).then(d=>{
      const afl=Array.isArray(d)?d.filter(g=>g.sport_key==='aussierules_afl'):[];
      document.getElementById('s').innerHTML='Total: '+(Array.isArray(d)?d.length:0)+' | AFL: '+afl.length+'<br>'+afl.map(g=>g.home_team+' vs '+g.away_team).join('<br>');
    }).catch(e=>document.getElementById('s').textContent='ERROR: '+e.message);
    </script></body></html>`);
});

app.get('/games', async (req, res) => {
  try {
    const r = await fetch(`${BASE}/sports/${AFL_SPORT}/events?apiKey=${ODDS_API_KEY}&dateFormat=iso`);
    const data = await r.json();
    res.set('x-requests-remaining', r.headers.get('x-requests-remaining'));
    const filtered = Array.isArray(data) ? data.filter(g => g.sport_key === 'aussierules_afl') : data;
    res.json(filtered);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/markets/:eventId', async (req, res) => {
  const markets = ['player_disposals','player_goals','player_tackles'].join(',');
  try {
    const r = await fetch(`${BASE}/sports/${AFL_SPORT}/events/${req.params.eventId}/odds?apiKey=${ODDS_API_KEY}&regions=au&markets=${markets}&oddsFormat=decimal&dateFormat=iso`);
    const data = await r.json();
    res.set('x-requests-remaining', r.headers.get('x-requests-remaining'));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/stats', async (req, res) => {
  const { players } = req.body;
  if (!players || !Array.isArray(players) || players.length === 0)
    return res.status(400).json({ error: 'players array required' });
  try {
    const indexRes = await fetch('https://aflml.com/players', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const indexHtml = await indexRes.text();
    const playerIndex = {};
    const linkRegex = /href="\/players\/(\d+)"[^>]*>([A-Z][a-z]+(?:\s[A-Z][a-zA-Z'-]+)+)/g;
    let m;
    while ((m = linkRegex.exec(indexHtml)) !== null) {
      const id = m[1], name = m[2].trim();
      playerIndex[name.toLowerCase()] = id;
      const surname = name.split(' ').pop().toLowerCase();
      if (!playerIndex[surname]) playerIndex[surname] = id;
    }
    const findId = (name) => {
      const lower = name.toLowerCase();
      if (playerIndex[lower]) return playerIndex[lower];
      const surname = lower.split(' ').pop();
      if (playerIndex[surname]) return playerIndex[surname];
      for (const [key, id] of Object.entries(playerIndex))
        if (key.includes(surname)) return id;
      return null;
    };
    const toFetch = players.slice(0, 25).map(name => ({ name, id: findId(name) })).filter(p => p.id);
    const results = await Promise.all(toFetch.map(async ({ name, id }) => {
      try {
        const r = await fetch(`https://aflml.com/players/${id}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const html = await r.text();
        const extract = (pattern) => { const m = html.match(pattern); return m ? parseFloat(m[1]) : null; };
        const avgDisposals = extract(/Games[\s\S]{0,300}?Disposals[\s\S]{0,50}?(\d+\.?\d*)/);
        const avgGoals = extract(/Goals[\s\S]{0,50}?(\d+\.?\d{0,2})(?!\d)/);
        const avgTackles = extract(/Tackles[\s\S]{0,50}?(\d+\.?\d{0,2})(?!\d)/);
        const last5Avg = extract(/Last 5 avg:\s*([\d.]+)/);
        const hitRates = {};
        const hrMatches = [...html.matchAll(/(\d+)\+[^%]{0,100}?(\d+)%\s*\|\s*(\d+)%\s*\|\s*(\d+)%/g)];
        for (const hr of hrMatches) hitRates[`${hr[1]}plus`] = { season: parseInt(hr[2]), last5: parseInt(hr[4]) };
        const dispMatches = [...html.matchAll(/<td[^>]*>\s*(\d{1,2})\s*<\/td>/g)].map(m => parseInt(m[1])).filter(n => n > 0 && n < 60).slice(0, 5);
        return { name, id, season2026: { avgDisposals, avgGoals, avgTackles, last5Avg, recentDisposals: dispMatches.length > 0 ? dispMatches : null, hitRates: Object.keys(hitRates).length > 0 ? hitRates : null } };
      } catch (e) { return { name, id, error: e.message }; }
    }));
    res.json({ players: results, found: results.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/analyse', async (req, res) => {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(req.body),
    });
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/insights', async (req, res) => {
  const { trackerData } = req.body;
  if (!trackerData || !Array.isArray(trackerData) || trackerData.length === 0)
    return res.json({ insights: null, message: 'Not enough data yet' });
  const allLegs = [];
  for (const multi of trackerData)
    for (const leg of multi.legs)
      if (leg.result !== 'pending')
        allLegs.push({ ...leg, venue: multi.venue || '', combinedRating: multi.combinedRating || '' });
  if (allLegs.length < 5) return res.json({ insights: null, message: 'Need at least 5 settled legs' });
  const hits = allLegs.filter(l => l.result === 'hit').length;
  const statMap = {};
  for (const leg of allLegs) {
    if (!statMap[leg.stat]) statMap[leg.stat] = { hit: 0, total: 0 };
    statMap[leg.stat].total++; if (leg.result === 'hit') statMap[leg.stat].hit++;
  }
  const statRates = Object.entries(statMap).map(([stat, d]) => ({ stat, hitRate: Math.round(d.hit/d.total*100), total: d.total })).sort((a,b) => b.hitRate - a.hitRate);
  const playerMap = {};
  for (const leg of allLegs) {
    if (!playerMap[leg.player]) playerMap[leg.player] = { hit: 0, total: 0, lines: [] };
    playerMap[leg.player].total++; playerMap[leg.player].lines.push(leg.line);
    if (leg.result === 'hit') playerMap[leg.player].hit++;
  }
  const playerRates = Object.entries(playerMap).filter(([,d]) => d.total >= 2).map(([player, d]) => ({ player, hitRate: Math.round(d.hit/d.total*100), total: d.total, avgLine: Math.round(d.lines.reduce((a,b)=>a+b,0)/d.lines.length) })).sort((a,b) => b.hitRate - a.hitRate);
  const dispLegs = allLegs.filter(l => l.stat === 'disposals');
  const lineAnalysis = {
    low: { range: '≤22', hitRate: dispLegs.filter(l=>l.line<=22).length ? Math.round(dispLegs.filter(l=>l.line<=22&&l.result==='hit').length/dispLegs.filter(l=>l.line<=22).length*100) : null, total: dispLegs.filter(l=>l.line<=22).length },
    mid: { range: '23-27', hitRate: dispLegs.filter(l=>l.line>22&&l.line<=27).length ? Math.round(dispLegs.filter(l=>l.line>22&&l.line<=27&&l.result==='hit').length/dispLegs.filter(l=>l.line>22&&l.line<=27).length*100) : null, total: dispLegs.filter(l=>l.line>22&&l.line<=27).length },
    high: { range: '28+', hitRate: dispLegs.filter(l=>l.line>27).length ? Math.round(dispLegs.filter(l=>l.line>27&&l.result==='hit').length/dispLegs.filter(l=>l.line>27).length*100) : null, total: dispLegs.filter(l=>l.line>27).length },
  };
  const venueMap = {};
  for (const leg of allLegs) {
    if (!leg.venue) continue;
    if (!venueMap[leg.venue]) venueMap[leg.venue] = { hit: 0, total: 0 };
    venueMap[leg.venue].total++; if (leg.result === 'hit') venueMap[leg.venue].hit++;
  }
  const venueRates = Object.entries(venueMap).filter(([,d]) => d.total >= 3).map(([venue, d]) => ({ venue, hitRate: Math.round(d.hit/d.total*100), total: d.total })).sort((a,b) => b.hitRate - a.hitRate);
  const rules = [];
  const best = statRates[0], worst = statRates[statRates.length-1];
  if (best?.total >= 3) rules.push(`LEARNT: ${best.stat} legs hit ${best.hitRate}% — prioritise these`);
  if (worst?.total >= 3 && worst.hitRate < 40) rules.push(`LEARNT: ${worst.stat} legs only hit ${worst.hitRate}% — use sparingly`);
  if (lineAnalysis.high.total >= 3 && lineAnalysis.high.hitRate < 40) rules.push(`LEARNT: Disposal lines 28+ only hit ${lineAnalysis.high.hitRate}% — be conservative`);
  if (lineAnalysis.low.total >= 3 && lineAnalysis.low.hitRate > 60) rules.push(`LEARNT: Disposal lines ≤22 hit ${lineAnalysis.low.hitRate}% — reliable`);
  playerRates.filter(p => p.hitRate >= 75).slice(0,3).forEach(p => rules.push(`LEARNT: ${p.player} hits ${p.hitRate}% — reliable pick`));
  playerRates.filter(p => p.hitRate <= 33).slice(0,3).forEach(p => rules.push(`LEARNT: ${p.player} only hits ${p.hitRate}% — avoid`));
  res.json({ summary: { totalLegs: allLegs.length, overallHitRate: Math.round(hits/allLegs.length*100), settledMultis: trackerData.filter(t => t.legs.every(l => l.result !== 'pending')).length }, statRates, playerRates: playerRates.slice(0,10), lineAnalysis, venueRates, rules });
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
