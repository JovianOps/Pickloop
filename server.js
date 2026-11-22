const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const DATA_FILE = process.env.PICKLOOP_DATA_FILE || path.join(ROOT, 'data', 'decisions.json');
const TTL_DAYS = 30;
const DAY_MS = 86_400_000;

class JsonDecisionStore {
  constructor(file = DATA_FILE) {
    this.file = file;
    this.backupFile = `${file}.bak`;
    this.expiredFile = `${file}.expired.json`;
    this.recoveredFromBackup = false;
    this.expiryIndexError = null;
    try { this.expiredIds = this.readExpired(); }
    catch (error) { this.expiredIds = new Map(); this.expiryIndexError = error; }
  }

  readExpired() {
    try { return new Map(Object.entries(JSON.parse(fs.readFileSync(this.expiredFile, 'utf8')))); }
    catch (error) { if (error.code === 'ENOENT') return new Map(); throw new Error(`Expired-link index cannot be read: ${error.message}`); }
  }

  readAll() {
    try {
      const all = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!all || typeof all !== 'object' || Array.isArray(all)) throw new Error('Decision file must contain an object.');
      return this.normalize(all);
    }
    catch (error) {
      if (error.code === 'ENOENT') {
        try {
          const backup = JSON.parse(fs.readFileSync(this.backupFile, 'utf8'));
          if (!backup || typeof backup !== 'object' || Array.isArray(backup)) throw new Error('Backup must contain an object.');
          this.atomicWrite(this.file, JSON.stringify(backup, null, 2)); this.recoveredFromBackup = true;
          return this.normalize(backup);
        }
        catch (backupError) { if (backupError.code === 'ENOENT') return {}; throw new Error(`Decision data and its backup cannot be read: ${backupError.message}`); }
      }
      try {
        const backup = JSON.parse(fs.readFileSync(this.backupFile, 'utf8'));
        if (!backup || typeof backup !== 'object' || Array.isArray(backup)) throw new Error('Backup must contain an object.');
        this.atomicWrite(this.file, JSON.stringify(backup, null, 2));
        this.recoveredFromBackup = true;
        return this.normalize(backup);
      } catch (backupError) { throw new Error(`Decision data is damaged and its backup cannot be read: ${backupError.message}`); }
    }
  }

  normalize(all) {
    for (const decision of Object.values(all)) {
      decision.deadlineAt ??= null;
      decision.resultsVisible ??= false;
      decision.details ||= {};
      decision.details.timeZone ||= 'UTC';
      decision.details.durationMinutes ||= 60;
      decision.ballots ||= {};
    }
    return all;
  }

  atomicWrite(target, content) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
    try { fs.writeFileSync(temp, content, { flag: 'wx' }); fs.renameSync(temp, target); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }

  saveAll(decisions) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
    const backupTemp = `${this.backupFile}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(decisions, null, 2), { flag: 'wx' });
      if (fs.existsSync(this.file)) {
        fs.copyFileSync(this.file, backupTemp);
        fs.renameSync(backupTemp, this.backupFile);
      }
      fs.renameSync(temp, this.file);
    } finally {
      for (const candidate of [temp, backupTemp]) if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
    }
  }

  persistExpired() { this.atomicWrite(this.expiredFile, JSON.stringify(Object.fromEntries(this.expiredIds), null, 2)); }

  cleanup(now = Date.now()) {
    if (this.expiryIndexError) throw this.expiryIndexError;
    const all = this.readAll();
    let changed = false;
    for (const [id, decision] of Object.entries(all)) {
      if (Date.parse(decision.expiresAt) <= now) {
        delete all[id]; this.expiredIds.set(id, now + TTL_DAYS * DAY_MS); changed = true;
      }
    }
    for (const [id, keepUntil] of this.expiredIds) if (keepUntil <= now) { this.expiredIds.delete(id); changed = true; }
    if (changed) { this.saveAll(all); this.persistExpired(); }
    return all;
  }

  get(id, now = Date.now()) {
    const all = this.cleanup(now);
    return { decision: all[id] || null, expired: !all[id] && this.expiredIds.has(id) };
  }

  create(decision, now = Date.now()) { const all = this.cleanup(now); all[decision.id] = decision; this.saveAll(all); this.expiredIds.delete(decision.id); this.persistExpired(); }

  update(id, updater, now = Date.now()) {
    const all = this.cleanup(now);
    if (!all[id]) return null;
    updater(all[id]); this.saveAll(all); return all[id];
  }

  health(now = Date.now()) {
    const all = this.cleanup(now);
    const probe = `${this.file}.${process.pid}.health`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try { fs.writeFileSync(probe, 'ok', { flag: 'wx' }); }
    finally { if (fs.existsSync(probe)) fs.unlinkSync(probe); }
    return { status: 'ok', storage: 'json-file', decisions: Object.keys(all).length, recoveredFromBackup: this.recoveredFromBackup };
  }
}

function score(decision) {
  const points = decision.options.map((option, index) => ({ option, index, points: 0, firsts: 0 }));
  for (const ballot of Object.values(decision.ballots)) ballot.ranking.forEach((optionId, rank) => {
    const item = points.find(row => row.option.id === optionId);
    if (item) { item.points += [3, 2, 1][rank]; if (rank === 0) item.firsts += 1; }
  });
  points.sort((a, b) => b.points - a.points || b.firsts - a.firsts || a.index - b.index);
  const totalVotes = Object.keys(decision.ballots).length;
  return { totalVotes, options: points.map(({ option, points: total, firsts }) => ({ ...option, points: total, firsts })), winner: totalVotes ? points[0].option : null };
}

function publicDecision(decision, { includeResults = false } = {}) {
  const visible = includeResults || decision.resultsVisible || decision.closedAt;
  const result = {
    id: decision.id, title: decision.title, options: decision.options, details: decision.details,
    createdAt: decision.createdAt, expiresAt: decision.expiresAt, deadlineAt: decision.deadlineAt,
    closedAt: decision.closedAt, winnerId: decision.closedAt ? decision.winnerId : undefined,
    resultsVisible: Boolean(visible)
  };
  if (visible) {
    const results = score(decision);
    const winnerRow = results.options.find(row => row.id === results.winner?.id);
    const rationale = !results.totalVotes ? (decision.closedAt ? 'No guest votes were submitted; the host’s first-listed option is the default.' : 'No votes yet. The winner will be the option with the most points.') :
      `${winnerRow.name} leads with ${winnerRow.points} points and ${winnerRow.firsts} first-place ${winnerRow.firsts === 1 ? 'vote' : 'votes'} from ${results.totalVotes} ${results.totalVotes === 1 ? 'ballot' : 'ballots'}.`;
    result.results = { ...results, rationale };
  }
  return result;
}

function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

async function bodyJson(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 100_000) throw Object.assign(new Error('Request is too large.'), { status: 413 }); }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error('Send valid JSON.'), { status: 400 }); }
}
function validText(value, max = 160) { return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max; }
function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function authorized(req, decision) {
  const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
  const hash = tokenHash(supplied);
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(decision.hostTokenHash));
}
function closeDecision(decision, now) {
  if (!decision.closedAt) { decision.closedAt = new Date(now).toISOString(); decision.winnerId = score(decision).winner?.id || decision.options[0].id; }
}
function icsEscape(value) { return String(value || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;'); }
function foldIcsLine(line) {
  let output = '', current = '', bytes = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char);
    if (bytes + size > 73) { output += `${current}\r\n `; current = ''; bytes = 1; }
    current += char; bytes += size;
  }
  return output + current;
}
function calendarFor(decision, now) {
  const winner = decision.options.find(option => option.id === decision.winnerId);
  const start = new Date(decision.details.when);
  const end = new Date(start.getTime() + decision.details.durationMinutes * 60_000);
  const utc = value => value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const description = [decision.details.location, decision.details.budget, decision.details.vibe, `Timezone: ${decision.details.timeZone}`].filter(Boolean).join(' · ');
  const lines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//PickLoop//Decision Planner//EN','CALSCALE:GREGORIAN',`X-WR-TIMEZONE:${icsEscape(decision.details.timeZone)}`,'BEGIN:VEVENT',`UID:${decision.id}@pickloop.local`,`DTSTAMP:${utc(new Date(now))}`,`DTSTART:${utc(start)}`,`DTEND:${utc(end)}`,`SUMMARY:${icsEscape(`${decision.title}: ${winner.name}`)}`,`DESCRIPTION:${icsEscape(description)}`,'END:VEVENT','END:VCALENDAR'];
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}

function createServer({ store = new JsonDecisionStore(), now = () => Date.now() } = {}) {
  try { store.cleanup(now()); } catch {}
  const load = id => {
    const found = store.get(id, now());
    if (found.expired) return { error: 'expired' };
    if (!found.decision) return { error: 'missing' };
    const d = found.decision;
    if (!d.closedAt && d.deadlineAt && now() >= Date.parse(d.deadlineAt)) {
      store.update(id, current => closeDecision(current, Date.parse(current.deadlineAt)), now());
      return { decision: store.get(id, now()).decision };
    }
    return found;
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, store.health(now()));
      if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'decisions' && parts[2]) {
        const id = parts[2], found = load(id);
        if (found.error) return send(res, found.error === 'expired' ? 410 : 404, { error: found.error === 'expired' ? 'This decision has expired and its data was removed.' : 'This decision link was not found.' });
        const decision = found.decision;
        if (parts[3] === 'host') {
          if (!authorized(req, decision)) return send(res, 403, { error: 'Only the host can view private results.' });
          return send(res, 200, publicDecision(decision, { includeResults: true }));
        }
        if (parts[3] === 'calendar') {
          if (!decision.closedAt) return send(res, 409, { error: 'Close voting before downloading the calendar event.' });
          return send(res, 200, calendarFor(decision, now()), 'text/calendar; charset=utf-8', { 'Content-Disposition': `attachment; filename="pickloop-${id}.ics"` });
        }
        return send(res, 200, publicDecision(decision));
      }
      if (req.method === 'POST' && url.pathname === '/api/decisions') {
        const input = await bodyJson(req);
        if (!validText(input.title, 100)) return send(res, 400, { error: 'Add a title up to 100 characters.' });
        if (!Array.isArray(input.options) || input.options.length < 3 || input.options.length > 6 || input.options.some(option => !validText(option, 80))) return send(res, 400, { error: 'Add 3 to 6 options, each with a name up to 80 characters.' });
        const names = input.options.map(option => option.trim());
        if (new Set(names.map(name => name.toLowerCase())).size !== names.length) return send(res, 400, { error: 'Options must be unique.' });
        const when = new Date(input.when), clock = now();
        if (!Number.isFinite(when.getTime()) || when <= new Date(clock)) return send(res, 400, { error: 'Choose a future event date and time.' });
        let timeZone = input.timeZone || 'UTC';
        try { new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(clock)); } catch { return send(res, 400, { error: 'Choose a valid time zone.' }); }
        const durationMinutes = Number(input.durationMinutes ?? 60);
        if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 480) return send(res, 400, { error: 'Event duration must be between 15 minutes and 8 hours.' });
        const deadlineAt = input.deadlineAt ? new Date(input.deadlineAt) : null;
        if (deadlineAt && (!Number.isFinite(deadlineAt.getTime()) || deadlineAt <= new Date(clock) || deadlineAt > when)) return send(res, 400, { error: 'Voting deadline must be in the future and no later than the event.' });
        const id = crypto.randomBytes(12).toString('base64url'), hostToken = crypto.randomBytes(32).toString('base64url');
        const decision = {
          id, title: input.title.trim(), options: names.map((name, index) => ({ id: String(index + 1), name })),
          details: { when: when.toISOString(), timeZone, durationMinutes, availability: String(input.availability || '').trim().slice(0, 200), budget: String(input.budget || '').trim().slice(0, 80), location: String(input.location || '').trim().slice(0, 120), vibe: String(input.vibe || '').trim().slice(0, 120) },
          createdAt: new Date(clock).toISOString(), expiresAt: new Date(clock + TTL_DAYS * DAY_MS).toISOString(), deadlineAt: deadlineAt?.toISOString() || null,
          closedAt: null, winnerId: null, resultsVisible: false, hostTokenHash: tokenHash(hostToken), ballots: {}
        };
        store.create(decision, clock);
        return send(res, 201, { decision: publicDecision(decision), hostToken });
      }
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'decisions' && parts[2]) {
        const input = await bodyJson(req), id = parts[2], found = load(id);
        if (found.error) return send(res, found.error === 'expired' ? 410 : 404, { error: found.error === 'expired' ? 'This decision has expired and its data was removed.' : 'This decision link was not found.' });
        const decision = found.decision;
        if (parts[3] === 'votes') {
          if (decision.closedAt) return send(res, 409, { error: 'Voting is closed.' });
          if (!validText(input.guestToken, 100)) return send(res, 400, { error: 'Could not identify this guest. Refresh and try again.' });
          if (!Array.isArray(input.ranking) || input.ranking.length < 1 || input.ranking.length > 3 || new Set(input.ranking).size !== input.ranking.length || input.ranking.some(optionId => !decision.options.some(option => option.id === optionId))) return send(res, 400, { error: 'Rank up to 3 different options.' });
          store.update(id, current => { current.ballots[input.guestToken] = { ranking: input.ranking, updatedAt: new Date(now()).toISOString() }; }, now());
          return send(res, 200, publicDecision(store.get(id, now()).decision));
        } else if (parts[3] === 'close' || parts[3] === 'results' || parts[3] === 'recovery') {
          if (!authorized(req, decision)) return send(res, 403, { error: 'Only the host can change this decision.' });
          if (parts[3] === 'close') store.update(id, current => closeDecision(current, now()), now());
          if (parts[3] === 'results') {
            if (input.enabled !== true) return send(res, 400, { error: 'Guest results can only be enabled.' });
            store.update(id, current => { current.resultsVisible = true; }, now());
          }
          if (parts[3] === 'recovery') {
            const nextToken = crypto.randomBytes(32).toString('base64url');
            store.update(id, current => { current.hostTokenHash = tokenHash(nextToken); }, now());
            return send(res, 200, { decision: publicDecision(store.get(id, now()).decision, { includeResults: true }), hostToken: nextToken });
          }
        } else return send(res, 404, { error: 'Unknown action.' });
        return send(res, 200, publicDecision(store.get(id, now()).decision, { includeResults: true }));
      }
      if (req.method === 'GET') {
        const appRoute = !parts.length || parts[0] === 'd' || parts[0] === 'host';
        const file = path.resolve(ROOT, appRoute ? 'index.html' : parts.join(path.sep));
        if (!file.startsWith(`${ROOT}${path.sep}`) && file !== path.join(ROOT, 'index.html')) return send(res, 404, { error: 'Not found.' });
        let data; try { data = fs.readFileSync(file); } catch { return send(res, 404, { error: 'Not found.' }); }
        const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
        return send(res, 200, data, types[path.extname(file)] || 'application/octet-stream');
      }
      return send(res, 404, { error: 'Not found.' });
    } catch (error) {
      const storageError = error.message.includes('decision data') || error.message.includes('Expired-link index') || ['EACCES','EROFS','ENOSPC','EIO','EPERM'].includes(error.code);
      return send(res, error.status || (storageError ? 503 : 500), { error: error.status ? error.message : storageError ? 'Local decision storage is unavailable. Check the data folder and disk permissions.' : 'Something went wrong.' });
    }
  });
  server.store = store;
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000), host = process.env.HOST || '127.0.0.1';
  createServer().listen(port, host, () => console.log(`PickLoop running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));
}

module.exports = { createServer, score, JsonDecisionStore, publicDecision };
