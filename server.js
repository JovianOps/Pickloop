const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const DATA_FILE = process.env.PICKLOOP_DATA_FILE || path.join(ROOT, 'data', 'decisions.json');
const TTL_DAYS = 30;

function loadDecisions() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

function saveDecisions(decisions) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const temp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(decisions, null, 2));
  fs.renameSync(temp, DATA_FILE);
}

function score(decision) {
  const points = decision.options.map((option, index) => ({ option, index, points: 0, firsts: 0 }));
  for (const ballot of Object.values(decision.ballots)) {
    ballot.ranking.forEach((optionId, rank) => {
      const item = points.find(row => row.option.id === optionId);
      if (item) {
        item.points += [3, 2, 1][rank];
        if (rank === 0) item.firsts += 1;
      }
    });
  }
  points.sort((a, b) => b.points - a.points || b.firsts - a.firsts || a.index - b.index);
  const totalVotes = Object.keys(decision.ballots).length;
  return {
    totalVotes,
    options: points.map(({ option, points: total, firsts }) => ({ ...option, points: total, firsts })),
    winner: totalVotes ? points[0].option : null
  };
}

function publicDecision(decision) {
  const results = score(decision);
  const winnerRow = results.options.find(row => row.id === results.winner?.id);
  const rationale = !results.totalVotes ? (decision.closedAt ? 'No guest votes were submitted; the host’s first-listed option is the default.' : 'No votes yet. The winner will be the option with the most points.') :
    `${winnerRow.option?.name || winnerRow.name} leads with ${winnerRow.points} points and ${winnerRow.firsts} first-place ${winnerRow.firsts === 1 ? 'vote' : 'votes'} from ${results.totalVotes} ${results.totalVotes === 1 ? 'ballot' : 'ballots'}.`;
  return {
    id: decision.id, title: decision.title, options: decision.options,
    details: decision.details, createdAt: decision.createdAt, expiresAt: decision.expiresAt,
    closedAt: decision.closedAt, winnerId: decision.winnerId,
    results: { ...results, rationale }
  };
}

function send(res, status, body, type = 'application/json; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

async function bodyJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw Object.assign(new Error('Request is too large.'), { status: 413 });
  }
  try { return raw ? JSON.parse(raw) : {}; }
  catch { throw Object.assign(new Error('Send valid JSON.'), { status: 400 }); }
}

function validText(value, max = 160) { return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max; }

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'decisions' && parts[2]) {
        const id = parts[2];
        const decision = loadDecisions()[id];
        if (!decision || Date.now() > Date.parse(decision.expiresAt)) return send(res, 404, { error: 'This decision link is missing or expired.' });
        if (parts[3] === 'calendar') {
          if (!decision.closedAt) return send(res, 409, { error: 'Close the decision before downloading its calendar event.' });
          const winner = decision.options.find(option => option.id === decision.winnerId);
          const dt = new Date(decision.details.when);
          const fmt = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
          const escape = s => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
          const start = fmt(dt), end = fmt(new Date(dt.getTime() + 60 * 60 * 1000));
          const lines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//PickLoop//Decision Planner//EN','CALSCALE:GREGORIAN','BEGIN:VEVENT',`UID:${decision.id}@pickloop.local`,`DTSTAMP:${fmt(new Date())}`,`DTSTART:${start}`,`DTEND:${end}`,`SUMMARY:${escape(`${decision.title}: ${winner.name}`)}`,`DESCRIPTION:${escape([decision.details.location, decision.details.budget, decision.details.vibe].filter(Boolean).join(' · '))}`,'END:VEVENT','END:VCALENDAR'];
          return send(res, 200, `${lines.join('\r\n')}\r\n`, 'text/calendar; charset=utf-8', { 'Content-Disposition': `attachment; filename="pickloop-${id}.ics"` });
        }
        return send(res, 200, publicDecision(decision));
      }
      if (req.method === 'POST' && url.pathname === '/api/decisions') {
        const input = await bodyJson(req);
        if (!validText(input.title, 100)) return send(res, 400, { error: 'Add a title up to 100 characters.' });
        if (!Array.isArray(input.options) || input.options.length < 3 || input.options.length > 6 || input.options.some(o => !validText(o, 80))) return send(res, 400, { error: 'Add 3 to 6 options, each with a name up to 80 characters.' });
        const names = input.options.map(o => o.trim());
        if (new Set(names.map(n => n.toLowerCase())).size !== names.length) return send(res, 400, { error: 'Options must be unique.' });
        const when = new Date(input.when);
        if (!Number.isFinite(when.getTime()) || when <= new Date()) return send(res, 400, { error: 'Choose a future date and time.' });
        const id = crypto.randomBytes(12).toString('base64url');
        const hostToken = crypto.randomBytes(32).toString('base64url');
        const decision = {
          id, title: input.title.trim(), options: names.map((name, index) => ({ id: String(index + 1), name })),
          details: {
            when: when.toISOString(), availability: String(input.availability || '').trim().slice(0, 200),
            budget: String(input.budget || '').trim().slice(0, 80), location: String(input.location || '').trim().slice(0, 120),
            vibe: String(input.vibe || '').trim().slice(0, 120)
          }, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + TTL_DAYS * 86_400_000).toISOString(),
          closedAt: null, winnerId: null, hostTokenHash: crypto.createHash('sha256').update(hostToken).digest('hex'), ballots: {}
        };
        const all = loadDecisions(); all[id] = decision; saveDecisions(all);
        return send(res, 201, { decision: publicDecision(decision), hostToken });
      }
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'decisions' && parts[2]) {
        const all = loadDecisions(), decision = all[parts[2]];
        if (!decision || Date.now() > Date.parse(decision.expiresAt)) return send(res, 404, { error: 'This decision link is missing or expired.' });
        const input = await bodyJson(req);
        if (parts[3] === 'votes') {
          if (decision.closedAt) return send(res, 409, { error: 'Voting is closed.' });
          if (!validText(input.guestToken, 100)) return send(res, 400, { error: 'Could not identify this guest. Refresh and try again.' });
          if (!Array.isArray(input.ranking) || input.ranking.length < 1 || input.ranking.length > 3 || new Set(input.ranking).size !== input.ranking.length || input.ranking.some(id => !decision.options.some(o => o.id === id))) return send(res, 400, { error: 'Rank up to 3 different options.' });
          decision.ballots[input.guestToken] = { ranking: input.ranking, updatedAt: new Date().toISOString() };
        } else if (parts[3] === 'close') {
          const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
          const hash = crypto.createHash('sha256').update(supplied).digest('hex');
          if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(decision.hostTokenHash))) return send(res, 403, { error: 'Only the host can close this decision.' });
          if (!decision.closedAt) { decision.closedAt = new Date().toISOString(); decision.winnerId = score(decision).winner?.id || decision.options[0].id; }
        } else return send(res, 404, { error: 'Unknown action.' });
        saveDecisions(all);
        return send(res, 200, publicDecision(decision));
      }
      if (req.method === 'GET') {
        const appRoute = !parts.length || parts[0] === 'd' || parts[0] === 'host';
        const file = path.resolve(ROOT, appRoute ? 'index.html' : parts.join(path.sep));
        if (!file.startsWith(`${ROOT}${path.sep}`) && file !== path.join(ROOT, 'index.html')) return send(res, 404, { error: 'Not found.' });
        let data;
        try { data = fs.readFileSync(file); } catch { return send(res, 404, { error: 'Not found.' }); }
        const ext = path.extname(file);
        const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
        return send(res, 200, data, types[ext] || 'application/octet-stream');
      }
      return send(res, 404, { error: 'Not found.' });
    } catch (error) {
      return send(res, error.status || 500, { error: error.status ? error.message : 'Something went wrong.' });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, '127.0.0.1', () => console.log(`PickLoop running at http://localhost:${port}`));
}

module.exports = { createServer, score };
