const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const ODDS_API_KEY = process.env.ODDS_API_KEY || '400af89e913b5ebcc39b09af5dfadcc6';
const AFL_SPORT = 'aussierules_afl';
const BASE = 'https://api.the-odds-api.com/v4';

app.use(cors());
app.use(express.json());

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

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
