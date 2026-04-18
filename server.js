const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const ODDS_API_KEY = process.env.ODDS_API_KEY || '400af89e913b5ebcc39b09af5dfadcc6';
const AFL_SPORT = 'aussierules_afl';
const BASE = 'https://api.the-odds-api.com/v4';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/', (req, res) => res.json({ status: 'AFL Multi Builder proxy running' }));

// Get upcoming AFL games
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

// Get markets for a specific game
app.get('/markets/:eventId', async (req, res) => {
  const markets = ['player_disposals','player_goals','player_marks','player_tackles'].join(',');
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

// Squiggle team name map
const toSquiggle = (name) => {
  const map = {
    'hawthorn hawks': 'Hawthorn', 'hawthorn': 'Hawthorn',
    'port adelaide power': 'Port Adelaide', 'port adelaide': 'Port Adelaide',
    'gold coast suns': 'Gold Coast', 'gold coast': 'Gold Coast',
    'essendon bombers': 'Essendon', 'essendon': 'Essendon',
    'adelaide crows': 'Adelaide', 'adelaide': 'Adelaide',
    'st kilda saints': 'St Kilda', 'st kilda': 'St Kilda',
    'north melbourne kangaroos': 'North Melbourne', 'north melbourne': 'North Melbourne',
    'richmond tigers': 'Richmond', 'richmond': 'Richmond',
    'melbourne demons': 'Melbourne', 'melbourne': 'Melbourne',
    'brisbane lions': 'Brisbane', 'brisbane': 'Brisbane',
    'west coast eagles': 'West Coast', 'west coast': 'West Coast',
    'fremantle dockers': 'Fremantle', 'fremantle': 'Fremantle',
    'geelong cats': 'Geelong', 'geelong': 'Geelong',
    'western bulldogs': 'Western Bulldogs', 'bulldogs': 'Western Bulldogs',
    'collingwood magpies': 'Collingwood', 'collingwood': 'Collingwood',
    'carlton blues': 'Carlton', 'carlton': 'Carlton',
    'sydney swans': 'Sydney', 'sydney': 'Sydney',
    'gws giants': 'GWS', 'greater western sydney': 'GWS',
    'greater western sydney giants': 'GWS',
  };
  return map[name.toLowerCase()] || name;
};

// Get named lineups via Squiggle API
// Usage: GET /lineups?home=Hawthorn Hawks&away=Port Adelaide Power
app.get('/lineups', async (req, res) => {
  const { home, away } = req.query;
  if (!home || !away) return res.status(400).json({ error: 'home and away required' });

  const homeS = toSquiggle(home);
  const awayS = toSquiggle(away);

  // Squiggle requires a proper Accept header and no bot-like UA
  const squiggleHeaders = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://squiggle.com.au/',
  };

  try {
    // Step 1: Get all 2026 games to find the matching game ID
    const gamesRes = await fetch('https://api.squiggle.com.au/?q=games;year=2026', { headers: squiggleHeaders });
    const gamesText = await gamesRes.text();

    let games = [];
    try {
      const gamesData = JSON.parse(gamesText);
      games = gamesData.games || [];
    } catch(e) {
      return res.status(502).json({ error: 'Squiggle returned non-JSON', raw: gamesText.slice(0, 200) });
    }

    // Find matching game
    const match = games.find(g => {
      const h = (g.hteam || '').toLowerCase();
      const a = (g.ateam || '').toLowerCase();
      const hs = homeS.toLowerCase();
      const as = awayS.toLowerCase();
      return (h.includes(hs) || hs.includes(h)) && (a.includes(as) || as.includes(a));
    });

    if (!match) {
      return res.json({ home, away, homePlayers: [], awayPlayers: [], note: `No game found for ${homeS} vs ${awayS}` });
    }

    // Step 2: Get lineup for the game
    const lineupRes = await fetch(`https://api.squiggle.com.au/?q=lineup;game=${match.id}`, { headers: squiggleHeaders });
    const lineupText = await lineupRes.text();

    let lineups = [];
    try {
      const lineupData = JSON.parse(lineupText);
      lineups = lineupData.lineups || [];
    } catch(e) {
      return res.status(502).json({ error: 'Squiggle lineup returned non-JSON', raw: lineupText.slice(0, 200) });
    }

    const homePlayers = [...new Set(
      lineups.filter(p => p.teamid === match.hteamid).map(p => p.player).filter(Boolean)
    )];
    const awayPlayers = [...new Set(
      lineups.filter(p => p.teamid === match.ateamid).map(p => p.player).filter(Boolean)
    )];

    res.json({
      home, away, homePlayers, awayPlayers,
      gameId: match.id, round: match.round,
      source: 'squiggle.com.au',
      totalNamed: homePlayers.length + awayPlayers.length,
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fetch live 2026 stats for a list of player names from aflml.com
// Usage: POST /stats with body { players: ["Lachie Neale", "Jeremy Cameron"] }
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
      const id = m[1];
      const name = m[2].trim();
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
      const parts = lower.split(' ');
      const surname = parts[parts.length - 1];
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
        const avgKicks     = extract(/Kicks[\s\S]{0,50}?(\d+\.?\d{0,2})(?!\d)/);
        const games        = extract(/Games[\s\S]{0,50}?(\d+)(?!\d)/);
        const last5Avg     = extract(/Last 5 avg:\s*([\d.]+)/);
        const predicted    = extract(/Predicted Disposals[\s\S]{0,100}?([\d.]+)/);

        const hitRates = {};
        const hrMatches = [...html.matchAll(/(\d+)\+[^%]{0,100}?(\d+)%\s*\|\s*(\d+)%\s*\|\s*(\d+)%\s*\|\s*(\d+)%/g)];
        for (const hr of hrMatches) {
          hitRates[`${hr[1]}plus`] = { season: parseInt(hr[2]), last10: parseInt(hr[3]), last5: parseInt(hr[4]) };
        }
        const dispMatches = [...html.matchAll(/<td[^>]*>\s*(\d{1,2})\s*<\/td>/g)]
          .map(m => parseInt(m[1])).filter(n => n > 0 && n < 60).slice(0, 5);

        return { name, id, season2026: { avgDisposals, avgGoals, avgMarks, avgTackles, avgKicks, games, last5Avg, predictedDisposals: predicted, recentDisposals: dispMatches.length > 0 ? dispMatches : null, hitRates: Object.keys(hitRates).length > 0 ? hitRates : null } };
      } catch (e) {
        return { name, id, error: e.message };
      }
    }));

    res.json({ players: results, source: 'aflml.com', season: 2026, found: results.length, notFound: players.filter(p => !findId(p)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proxy Anthropic API call
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

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
