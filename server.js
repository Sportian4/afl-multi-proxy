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

// Fetch live 2026 stats for a list of player names from aflml.com
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

    res.json({ players: results, source: 'aflml.com', season: 2026, found: results.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proxy Anthropic API call — includes web_search tool so Claude can look up named teams
app.post('/analyse', async (req, res) => {
  try {
    // Inject web_search tool into every analysis request
    const body = {
      ...req.body,
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
        }
      ],
    };

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05',
      },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
