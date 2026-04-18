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

// Fetch live 2026 player stats from aflml.com for both teams in a match
// Usage: GET /stats?home=Hawthorn Hawks&away=Port Adelaide Power
app.get('/stats', async (req, res) => {
  const { home, away } = req.query;
  if (!home || !away) return res.status(400).json({ error: 'home and away query params required' });

  try {
    // 1. Get the full player list page to find player IDs for these teams
    const playersPage = await fetch('https://aflml.com/players', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AFL-Multi-Builder/1.0)' }
    });
    const html = await playersPage.text();

    // Extract player links: /players/123 with names from surrounding text
    const playerLinks = [...html.matchAll(/href="\/players\/(\d+)"/g)].map(m => m[1]);
    const uniqueIds = [...new Set(playerLinks)];

    // Map team names to aflml team names (normalise)
    const normalise = str => str.toLowerCase().replace(/\s+/g, ' ').trim();
    const homeNorm = normalise(home);
    const awayNorm = normalise(away);

    // Extract team sections from HTML — aflml lists players by team
    // Find players listed under each team heading
    const teamPlayerMap = {};
    const teamSectionRegex = /<h3[^>]*>([\w\s]+)<\/h3>[\s\S]*?(<\/ul>|(?=<h3))/g;

    // Simpler approach: extract all /players/ID hrefs with surrounding context
    // We'll fetch the players page and parse team->player relationships
    const teamBlocks = html.split(/(?=<h3)/);

    for (const block of teamBlocks) {
      const teamMatch = block.match(/<h3[^>]*>([^<]+)<\/h3>/);
      if (!teamMatch) continue;
      const teamName = normalise(teamMatch[1]);
      const ids = [...block.matchAll(/href="\/players\/(\d+)"/g)].map(m => m[1]);
      if (ids.length > 0) teamPlayerMap[teamName] = ids;
    }

    // Find which team keys match home/away
    const findTeamKey = (norm) => {
      // Direct match first
      for (const key of Object.keys(teamPlayerMap)) {
        if (key.includes(norm) || norm.includes(key)) return key;
      }
      // Partial word match (e.g. "hawthorn" matches "hawthorn hawks")
      const words = norm.split(' ');
      for (const key of Object.keys(teamPlayerMap)) {
        if (words.some(w => w.length > 4 && key.includes(w))) return key;
      }
      return null;
    };

    const homeKey = findTeamKey(homeNorm);
    const awayKey = findTeamKey(awayNorm);

    const homeIds = homeKey ? (teamPlayerMap[homeKey] || []).slice(0, 8) : [];
    const awayIds = awayKey ? (teamPlayerMap[awayKey] || []).slice(0, 8) : [];
    const allIds = [...homeIds, ...awayIds];

    if (allIds.length === 0) {
      return res.json({ players: [], note: 'Could not find players for these teams on aflml.com' });
    }

    // 2. Fetch individual player pages for key stats
    const playerStats = [];

    await Promise.all(allIds.map(async (id) => {
      try {
        const r = await fetch(`https://aflml.com/players/${id}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AFL-Multi-Builder/1.0)' }
        });
        const phtml = await r.text();

        // Extract player name
        const nameMatch = phtml.match(/<h1[^>]*>([^<]+)<\/h1>/);
        const name = nameMatch ? nameMatch[1].trim() : `Player ${id}`;

        // Extract team
        const teamMatch = phtml.match(/\/players\]\s*\/([^/]+)\//);

        // Extract career averages section
        const avgDisp = phtml.match(/Disposals<\/[^>]+>\s*[\r\n\s]*(\d+\.?\d*)/);
        const avgGoals = phtml.match(/Goals<\/[^>]+>\s*[\r\n\s]*(\d+\.?\d*)/);
        const avgMarks = phtml.match(/Marks<\/[^>]+>\s*[\r\n\s]*(\d+\.?\d*)/);
        const avgTackles = phtml.match(/Tackles<\/[^>]+>\s*[\r\n\s]*(\d+\.?\d*)/);
        const avgKicks = phtml.match(/Kicks<\/[^>]+>\s*[\r\n\s]*(\d+\.?\d*)/);
        const avgHB = phtml.match(/Handballs<\/[^>]+>\s*[\r\n\s]*(\d+\.?\d*)/);
        const gamesMatch = phtml.match(/Games<\/[^>]+>\s*[\r\n\s]*(\d+)/);

        // Extract last 5 form from table rows - look for recent match data
        const recentRows = [...phtml.matchAll(/>\s*(\d+)\s*<\/td>\s*<td[^>]*>\s*(\d+)\s*<\/td>\s*<td[^>]*>\s*(\d+)\s*<\/td>/g)].slice(0, 5);
        const last5Disposals = recentRows.map(r => parseInt(r[1])).filter(n => !isNaN(n) && n > 0 && n < 60);

        // Extract predicted disposals for next game
        const predictedMatch = phtml.match(/Predicted Disposals[\s\S]{0,200}?(\d+\.?\d+)/);

        // Extract betting lines - look for "15+", "20+", "25+" with percentages
        const line20 = phtml.match(/20\+[\s\S]{0,100}?(\d+)%/);
        const line25 = phtml.match(/25\+[\s\S]{0,100}?(\d+)%/);

        playerStats.push({
          id,
          name,
          avgDisposals: avgDisp ? parseFloat(avgDisp[1]) : null,
          avgGoals: avgGoals ? parseFloat(avgGoals[1]) : null,
          avgMarks: avgMarks ? parseFloat(avgMarks[1]) : null,
          avgTackles: avgTackles ? parseFloat(avgTackles[1]) : null,
          avgKicks: avgKicks ? parseFloat(avgKicks[1]) : null,
          avgHandballs: avgHB ? parseFloat(avgHB[1]) : null,
          games: gamesMatch ? parseInt(gamesMatch[1]) : null,
          last5Disposals: last5Disposals.length > 0 ? last5Disposals : null,
          last5Avg: last5Disposals.length > 0 ? (last5Disposals.reduce((a,b)=>a+b,0)/last5Disposals.length).toFixed(1) : null,
          predictedDisposals: predictedMatch ? parseFloat(predictedMatch[1]) : null,
          hitRate20plus: line20 ? parseInt(line20[1]) : null,
          hitRate25plus: line25 ? parseInt(line25[1]) : null,
        });
      } catch (e) {
        // Skip individual player fetch errors
      }
    }));

    res.json({
      home,
      away,
      players: playerStats.filter(p => p.name && p.name !== `Player ${p.id}`),
      source: 'aflml.com',
      season: 2026,
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proxy Anthropic API call (avoids browser CORS restriction)
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
