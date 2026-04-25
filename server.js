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

app.get('/games', async (req, res) => {
  try {
    const r = await fetch(`${BASE}/sports/${AFL_SPORT}/events?apiKey=${ODDS_API_KEY}&dateFormat=iso`);
    const data = await r.json();
    res.set('x-requests-remaining', r.headers.get('x-requests-remaining'));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/markets/:eventId', async (req, res) => {
  const markets = ['player_disposals','player_goals','player_marks','player_tackles','player_assists','player_score_involvements'].join(',');
  try {
    const r = await fetch(
      `${BASE}/sports/${AFL_SPORT}/events/${req.params.eventId}/odds?apiKey=${ODDS_API_KEY}&regions=au&markets=${markets}&oddsFormat=decimal&dateFormat=iso`
    );
    const data = await r.json();
    res.set('x-requests-remaining', r.headers.get('x-requests-remaining'));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// Check all available markets for a game - helps discover what's actually available
app.get('/markets/check/:eventId', async (req, res) => {
  const allMarkets = [
    'player_disposals','player_goals','player_marks','player_tackles',
    'player_assists','player_score_involvements','player_fantasy_points',
    'player_kicks','player_handballs','player_clearances','player_hitouts',
    'player_shots_at_goal','player_goal_involvements','player_first_goal_scorer',
    'player_anytime_goal_scorer','player_last_goal_scorer',
  ].join(',');
  try {
    const r = await fetch(
      `${BASE}/sports/${AFL_SPORT}/events/${req.params.eventId}/odds?apiKey=${ODDS_API_KEY}&regions=au&markets=${allMarkets}&oddsFormat=decimal&dateFormat=iso`
    );
    const data = await r.json();
    res.set('x-requests-remaining', r.headers.get('x-requests-remaining'));
    // Return just which markets have data
    const available = [];
    if (data.bookmakers) {
      for (const bm of data.bookmakers) {
        for (const mkt of bm.markets) {
          if (!available.find(m => m.key === mkt.key)) {
            available.push({ key: mkt.key, bookmaker: bm.title, playerCount: mkt.outcomes.filter(o => o.name === 'Over').length });
          }
        }
      }
    }
    res.json({ available, error: data.message || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/stats', async (req, res) => {
  const { players } = req.body;
  if (!players || !Array.isArray(players) || players.length === 0) {
    return res.status(400).json({ error: 'players array required in body' });
  }
  try {
    const indexRes = await fetch('https://aflml.com/players', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AFL-Multi-Builder/1.0)' }
    });
    const indexHtml = await indexRes.text();
    const playerIndex = {};
    const linkRegex = /href="\/players\/(\d+)"[^>]*>([A-Z][a-z]+(?:\s[A-Z][a-zA-Z'-]+)+)/g;
    let m;
    while ((m = linkRegex.exec(indexHtml)) !== null) {
      const id = m[1], name = m[2].trim();
      playerIndex[name.toLowerCase()] = id;
      const parts = name.split(' ');
      if (parts.length >= 2) {
        const surname = parts[parts.length - 1].toLowerCase();
        if (!playerIndex[surname]) playerIndex[surname] = id;
      }
    }
    const findId = (name) => {
      const lower = name.toLowerCase();
      if (playerIndex[lower]) return playerIndex[lower];
      const surname = lower.split(' ').pop();
      if (playerIndex[surname]) return playerIndex[surname];
      for (const [key, id] of Object.entries(playerIndex)) {
        if (key.includes(surname) || surname.includes(key.split(' ').pop())) return id;
      }
      return null;
    };
    const toFetch = players.slice(0, 25).map(name => ({ name, id: findId(name) })).filter(p => p.id);
    const results = await Promise.all(toFetch.map(async ({ name, id }) => {
      try {
        const r = await fetch(`https://aflml.com/players/${id}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AFL-Multi-Builder/1.0)' }
        });
        const html = await r.text();
        const extract = (pattern) => { const m = html.match(pattern); return m ? parseFloat(m[1]) : null; };
        const avgDisposals = extract(/Games[\s\S]{0,300}?Disposals[\s\S]{0,50}?(\d+\.?\d*)/);
        const avgGoals     = extract(/Goals[\s\S]{0,50}?(\d+\.?\d{0,2})(?!\d)/);
        const avgMarks     = extract(/Marks[\s\S]{0,50}?(\d+\.?\d{0,2})(?!\d)/);
        const avgTackles   = extract(/Tackles[\s\S]{0,50}?(\d+\.?\d{0,2})(?!\d)/);
        const games        = extract(/Games[\s\S]{0,50}?(\d+)(?!\d)/);
        const last5Avg     = extract(/Last 5 avg:\s*([\d.]+)/);
        const hitRates = {};
        const hrMatches = [...html.matchAll(/(\d+)\+[^%]{0,100}?(\d+)%\s*\|\s*(\d+)%\s*\|\s*(\d+)%\s*\|\s*(\d+)%/g)];
        for (const hr of hrMatches) {
          hitRates[`${hr[1]}plus`] = { season: parseInt(hr[2]), last10: parseInt(hr[3]), last5: parseInt(hr[4]) };
        }
        const dispMatches = [...html.matchAll(/<td[^>]*>\s*(\d{1,2})\s*<\/td>/g)]
          .map(m => parseInt(m[1])).filter(n => n > 0 && n < 60).slice(0, 5);
        return { name, id, season2026: { avgDisposals, avgGoals, avgMarks, avgTackles, games, last5Avg,
          recentDisposals: dispMatches.length > 0 ? dispMatches : null,
          hitRates: Object.keys(hitRates).length > 0 ? hitRates : null } };
      } catch (e) { return { name, id, error: e.message }; }
    }));
    res.json({ players: results, source: 'aflml.com', season: 2026, found: results.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// Learning engine — analyse tracker data and generate betting insights
app.post('/insights', async (req, res) => {
  const { trackerData } = req.body;
  if (!trackerData || !Array.isArray(trackerData) || trackerData.length === 0) {
    return res.json({ insights: null, message: 'Not enough data yet' });
  }

  // Flatten all legs from all tracked multis
  const allLegs = [];
  for (const multi of trackerData) {
    for (const leg of multi.legs) {
      if (leg.result !== 'pending') {
        allLegs.push({
          player: leg.player,
          stat: leg.stat,
          line: leg.line,
          odds: leg.odds,
          result: leg.result, // 'hit' or 'miss'
          venue: multi.venue || '',
          combinedRating: multi.combinedRating || '',
          date: multi.date,
        });
      }
    }
  }

  if (allLegs.length < 5) {
    return res.json({ insights: null, message: 'Need at least 5 settled legs to generate insights' });
  }

  // ── ANALYSIS ──────────────────────────────────────────

  // 1. Overall hit rate
  const hits = allLegs.filter(l => l.result === 'hit').length;
  const overallHitRate = Math.round((hits / allLegs.length) * 100);

  // 2. Hit rate by stat type
  const statMap = {};
  for (const leg of allLegs) {
    if (!statMap[leg.stat]) statMap[leg.stat] = { hit: 0, total: 0 };
    statMap[leg.stat].total++;
    if (leg.result === 'hit') statMap[leg.stat].hit++;
  }
  const statRates = Object.entries(statMap)
    .map(([stat, d]) => ({ stat, hitRate: Math.round((d.hit/d.total)*100), total: d.total }))
    .sort((a,b) => b.hitRate - a.hitRate);

  // 3. Hit rate by player (min 2 legs)
  const playerMap = {};
  for (const leg of allLegs) {
    const key = leg.player;
    if (!playerMap[key]) playerMap[key] = { hit: 0, total: 0, stat: leg.stat, lines: [] };
    playerMap[key].total++;
    playerMap[key].lines.push(leg.line);
    if (leg.result === 'hit') playerMap[key].hit++;
  }
  const playerRates = Object.entries(playerMap)
    .filter(([, d]) => d.total >= 2)
    .map(([player, d]) => ({
      player,
      hitRate: Math.round((d.hit/d.total)*100),
      total: d.total,
      avgLine: Math.round(d.lines.reduce((a,b)=>a+b,0)/d.lines.length),
      stat: d.stat,
    }))
    .sort((a,b) => b.hitRate - a.hitRate);

  // 4. Line size analysis — are high lines missing more?
  const disposalLegs = allLegs.filter(l => l.stat === 'disposals');
  const lowLines = disposalLegs.filter(l => l.line <= 22);
  const midLines = disposalLegs.filter(l => l.line > 22 && l.line <= 27);
  const highLines = disposalLegs.filter(l => l.line > 27);
  const lineAnalysis = {
    low: { range: '≤22', hitRate: lowLines.length ? Math.round(lowLines.filter(l=>l.result==='hit').length/lowLines.length*100) : null, total: lowLines.length },
    mid: { range: '23-27', hitRate: midLines.length ? Math.round(midLines.filter(l=>l.result==='hit').length/midLines.length*100) : null, total: midLines.length },
    high: { range: '28+', hitRate: highLines.length ? Math.round(highLines.filter(l=>l.result==='hit').length/highLines.length*100) : null, total: highLines.length },
  };

  // 5. Venue analysis
  const venueMap = {};
  for (const leg of allLegs) {
    if (!leg.venue) continue;
    if (!venueMap[leg.venue]) venueMap[leg.venue] = { hit: 0, total: 0 };
    venueMap[leg.venue].total++;
    if (leg.result === 'hit') venueMap[leg.venue].hit++;
  }
  const venueRates = Object.entries(venueMap)
    .filter(([, d]) => d.total >= 3)
    .map(([venue, d]) => ({ venue, hitRate: Math.round((d.hit/d.total)*100), total: d.total }))
    .sort((a,b) => b.hitRate - a.hitRate);

  // 6. Multi success by rating
  const ratingMap = {};
  for (const multi of trackerData) {
    const settled = multi.legs.every(l => l.result !== 'pending');
    if (!settled) continue;
    const won = multi.legs.every(l => l.result === 'hit');
    const rating = multi.combinedRating || 'Unknown';
    if (!ratingMap[rating]) ratingMap[rating] = { won: 0, total: 0 };
    ratingMap[rating].total++;
    if (won) ratingMap[rating].won++;
  }
  const ratingRates = Object.entries(ratingMap)
    .map(([rating, d]) => ({ rating, winRate: Math.round((d.won/d.total)*100), total: d.total }));

  // 7. Generate rules for AI prompt injection
  const rules = [];

  // Best stat types
  const bestStat = statRates[0];
  const worstStat = statRates[statRates.length - 1];
  if (bestStat && bestStat.total >= 3) rules.push(`LEARNT: ${bestStat.stat} legs hit ${bestStat.hitRate}% of the time — prioritise these`);
  if (worstStat && worstStat.total >= 3 && worstStat.hitRate < 40) rules.push(`LEARNT: ${worstStat.stat} legs only hit ${worstStat.hitRate}% — use sparingly or avoid`);

  // Line size rules
  if (lineAnalysis.high.total >= 3 && lineAnalysis.high.hitRate < 40) rules.push(`LEARNT: Disposal lines 28+ only hit ${lineAnalysis.high.hitRate}% — be conservative with high lines`);
  if (lineAnalysis.low.total >= 3 && lineAnalysis.low.hitRate > 60) rules.push(`LEARNT: Disposal lines ≤22 hit ${lineAnalysis.low.hitRate}% — lower lines are more reliable`);

  // Player rules
  const hotPlayers = playerRates.filter(p => p.hitRate >= 75 && p.total >= 2);
  const coldPlayers = playerRates.filter(p => p.hitRate <= 33 && p.total >= 2);
  for (const p of hotPlayers.slice(0, 3)) rules.push(`LEARNT: ${p.player} hits ${p.hitRate}% — reliable pick (avg line ${p.avgLine}+)`);
  for (const p of coldPlayers.slice(0, 3)) rules.push(`LEARNT: ${p.player} only hits ${p.hitRate}% — avoid or use cautiously`);

  // Venue rules
  for (const v of venueRates) {
    if (v.hitRate >= 70) rules.push(`LEARNT: Legs at ${v.venue} hit ${v.hitRate}% — good venue`);
    if (v.hitRate <= 35) rules.push(`LEARNT: Legs at ${v.venue} only hit ${v.hitRate}% — be conservative here`);
  }

  res.json({
    summary: {
      totalLegs: allLegs.length,
      overallHitRate,
      settledMultis: trackerData.filter(t => t.legs.every(l => l.result !== 'pending')).length,
    },
    statRates,
    playerRates: playerRates.slice(0, 10),
    lineAnalysis,
    venueRates,
    ratingRates,
    rules, // inject these into AI prompt
  });
});

app.post('/analyse', async (req, res) => {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// PWA manifest — enables Add to Home Screen on Android
app.get('/manifest.json', (req, res) => {
  res.json({
    name: 'AFL Multi Builder',
    short_name: 'AFL Multi',
    description: 'Build smart AFL same-game multis with live odds and AI analysis',
    start_url: '/app',
    display: 'standalone',
    background_color: '#f2ede4',
    theme_color: '#1a3a6b',
    icons: [
      { src: '/icon.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon.png', sizes: '512x512', type: 'image/png' }
    ]
  });
});

// Simple football emoji icon as SVG served as PNG workaround
app.get('/icon.png', (req, res) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192">
    <rect width="192" height="192" rx="32" fill="#1a3a6b"/>
    <text x="96" y="130" font-size="100" text-anchor="middle">🏉</text>
  </svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(svg);
});

// Service worker for PWA
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send('self.addEventListener("fetch", e => e.respondWith(fetch(e.request)));');
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
