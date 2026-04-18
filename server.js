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
  const markets = [
    'player_disposals',
    'player_goals',
    'player_marks',
    'player_tackles',
  ].join(',');
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

// Scrape named lineups from footywire for both teams
// Usage: GET /lineups?home=Hawthorn Hawks&away=Port Adelaide Power
app.get('/lineups', async (req, res) => {
  const { home, away } = req.query;
  if (!home || !away) return res.status(400).json({ error: 'home and away required' });

  try {
    const r = await fetch('https://www.footywire.com/afl/footy/afl_team_selections', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = await r.text();

    // Extract all player names from footywire links
    // Pattern: pp-team-name--player-name
    const allLinks = [...html.matchAll(/pp-([a-z-]+)--([a-z-]+)">([^<]+)<\/a>/g)];

    // Build team -> players map
    const teamMap = {};
    for (const [, teamSlug, , playerName] of allLinks) {
      const clean = playerName.trim();
      if (!clean || clean.length < 3) continue;
      if (!teamMap[teamSlug]) teamMap[teamSlug] = new Set();
      teamMap[teamSlug].add(clean);
    }

    // Normalise team name to slug
    const toSlug = (name) => {
      const lower = name.toLowerCase();
      // Common mappings
      const map = {
        'hawthorn hawks': 'hawthorn-hawks',
        'hawthorn': 'hawthorn-hawks',
        'port adelaide power': 'port-adelaide-power',
        'port adelaide': 'port-adelaide-power',
        'gold coast suns': 'gold-coast-suns',
        'gold coast': 'gold-coast-suns',
        'essendon bombers': 'essendon-bombers',
        'essendon': 'essendon-bombers',
        'adelaide crows': 'adelaide-crows',
        'adelaide': 'adelaide-crows',
        'st kilda saints': 'st-kilda-saints',
        'st kilda': 'st-kilda-saints',
        'north melbourne kangaroos': 'north-melbourne-kangaroos',
        'north melbourne': 'north-melbourne-kangaroos',
        'richmond tigers': 'richmond-tigers',
        'richmond': 'richmond-tigers',
        'melbourne demons': 'melbourne-demons',
        'melbourne': 'melbourne-demons',
        'brisbane lions': 'brisbane-lions',
        'brisbane': 'brisbane-lions',
        'west coast eagles': 'west-coast-eagles',
        'west coast': 'west-coast-eagles',
        'fremantle dockers': 'fremantle-dockers',
        'fremantle': 'fremantle-dockers',
        'geelong cats': 'geelong-cats',
        'geelong': 'geelong-cats',
        'western bulldogs': 'western-bulldogs',
        'bulldogs': 'western-bulldogs',
        'collingwood magpies': 'collingwood-magpies',
        'collingwood': 'collingwood-magpies',
        'carlton blues': 'carlton-blues',
        'carlton': 'carlton-blues',
        'sydney swans': 'sydney-swans',
        'sydney': 'sydney-swans',
        'gws giants': 'greater-western-sydney-giants',
        'greater western sydney': 'greater-western-sydney-giants',
        'gwsgiants': 'greater-western-sydney-giants',
      };
      return map[lower] || lower.replace(/\s+/g, '-');
    };

    const homeSlug = toSlug(home);
    const awaySlug = toSlug(away);

    // Find matching team keys (partial match fallback)
    const findTeam = (slug) => {
      if (teamMap[slug]) return [...teamMap[slug]];
      // Try partial
      const key = Object.keys(teamMap).find(k => k.includes(slug.split('-')[0]) || slug.includes(k.split('-')[0]));
      return key ? [...teamMap[key]] : [];
    };

    const homePlayers = findTeam(homeSlug);
    const awayPlayers = findTeam(awaySlug);

    res.json({
      home,
      away,
      homePlayers,
      awayPlayers,
      totalNamed: homePlayers.length + awayPlayers.length,
      source: 'footywire.com',
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

    const toFetch = players.slice(0, 20).map(name => ({
      name,
      id: findId(name)
    })).filter(p => p.id);

    const results = await Promise.all(toFetch.map(async ({ name, id }) => {
      try {
        const r = await fetch(`https://aflml.com/players/${id}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AFL-Multi-Builder/1.0)' }
        });
        const html = await r.text();

        const extract = (pattern) => {
          const m = html.match(pattern);
          return m ? parseFloat(m[1]) : null;
        };

        const avgDisposals  = extract(/Games[\s\S]{0,300}?Disposals[\s\S]{0,50}?(\d+\.?\d*)/);
        const avgGoals      = extract(/Goals[\s\S]{0,50}?(\d+\.?\d{0,2})(?!\d)/);
        const avgMarks      = extract(/Marks[\s\S]{0,50}?(\d+\.?\d{0,2})(?!\d)/);
        const avgTackles    = extract(/Tackles[\s\S]{0,50}?(\d+\.?\d{0,2})(?!\d)/);
        const avgKicks      = extract(/Kicks[\s\S]{0,50}?(\d+\.?\d{0,2})(?!\d)/);
        const games         = extract(/Games[\s\S]{0,50}?(\d+)(?!\d)/);
        const last5Avg      = extract(/Last 5 avg:\s*([\d.]+)/);
        const predicted     = extract(/Predicted Disposals[\s\S]{0,100}?([\d.]+)/);

        const hitRates = {};
        const hrMatches = [...html.matchAll(/(\d+)\+[^%]{0,100}?(\d+)%\s*\|\s*(\d+)%\s*\|\s*(\d+)%\s*\|\s*(\d+)%/g)];
        for (const hr of hrMatches) {
          hitRates[`${hr[1]}plus`] = { season: parseInt(hr[2]), last10: parseInt(hr[3]), last5: parseInt(hr[4]) };
        }

        const dispMatches = [...html.matchAll(/<td[^>]*>\s*(\d{1,2})\s*<\/td>/g)]
          .map(m => parseInt(m[1])).filter(n => n > 0 && n < 60).slice(0, 5);

        return {
          name, id,
          season2026: {
            avgDisposals, avgGoals, avgMarks, avgTackles, avgKicks, games,
            last5Avg, predictedDisposals: predicted,
            recentDisposals: dispMatches.length > 0 ? dispMatches : null,
            hitRates: Object.keys(hitRates).length > 0 ? hitRates : null,
          }
        };
      } catch (e) {
        return { name, id, error: e.message };
      }
    }));

    res.json({
      players: results,
      source: 'aflml.com',
      season: 2026,
      found: results.length,
      notFound: players.filter(p => !findId(p)),
    });

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
