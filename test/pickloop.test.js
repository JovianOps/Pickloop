const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer, JsonDecisionStore } = require('../server');

const DAY = 86_400_000;

async function fixture(t, initialTime = Date.now()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickloop-test-'));
  let clock = initialTime;
  const store = new JsonDecisionStore(path.join(dir, 'decisions.json'));
  const server = createServer({ store, now:() => clock });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, options = {}) => {
    const response = await fetch(`${origin}${route}`, { ...options, headers:{ 'content-type':'application/json', ...(options.headers || {}) } });
    const type = response.headers.get('content-type') || '';
    return { response, body:type.includes('application/json') ? await response.json() : await response.text() };
  };
  t.after(async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive:true, force:true }); });
  return { request, store, setTime:value => { clock = value; }, time:() => clock };
}

async function createDecision(request, now, extra = {}) {
  return request('/api/decisions', { method:'POST', body:JSON.stringify({
    title:'Friday together', options:['Dinner','Mini golf','Movie night'], when:new Date(now + 5 * DAY).toISOString(),
    timeZone:'Asia/Bangkok', durationMinutes:60, availability:'Friday evening', budget:'$30 each', location:'Downtown', vibe:'Relaxed', ...extra
  }) });
}

test('create → private guest vote → reveal/close → recover host → timezone-aware calendar', async t => {
  const base = Date.parse('2026-11-21T12:00:00Z'), { request } = await fixture(t, base);
  assert.equal((await request('/')).response.status, 200);
  const health = await request('/healthz');
  assert.equal(health.response.status, 200);
  assert.equal(health.body.storage, 'json-file');

  const created = await createDecision(request, base, { when:'2026-12-01T19:30:00-08:00', timeZone:'America/Los_Angeles', durationMinutes:90 });
  assert.equal(created.response.status, 201);
  const { decision, hostToken } = created.body;
  assert.equal(decision.results, undefined, 'create response does not expose scores');
  assert.equal(decision.details.timeZone, 'America/Los_Angeles');
  assert.equal((await request(`/api/decisions/${decision.id}/calendar`)).response.status, 409, 'calendar is unavailable before a winner is finalized');
  const badZone = await createDecision(request, base, { title:'Invalid zone', timeZone:'Mars/Olympus' });
  assert.equal(badZone.response.status, 400);

  const guestRead = await request(`/api/decisions/${decision.id}`);
  assert.equal(guestRead.body.results, undefined);
  assert.equal(guestRead.body.totalVotes, undefined);
  assert.equal((await request(`/api/decisions/${decision.id}/host`)).response.status, 403);
  const privateHost = await request(`/api/decisions/${decision.id}/host`, { headers:{ authorization:`Bearer ${hostToken}` } });
  assert.equal(privateHost.body.results.totalVotes, 0);

  const badBallot = await request(`/api/decisions/${decision.id}/votes`, { method:'POST', body:JSON.stringify({ guestToken:'guest-a', ranking:['1','1'] }) });
  assert.equal(badBallot.response.status, 400);
  const vote = await request(`/api/decisions/${decision.id}/votes`, { method:'POST', body:JSON.stringify({ guestToken:'guest-a', ranking:['2','1','3'] }) });
  assert.equal(vote.body.results, undefined, 'vote response does not leak aggregate scores');
  await request(`/api/decisions/${decision.id}/votes`, { method:'POST', body:JSON.stringify({ guestToken:'guest-b', ranking:['1','2'] }) });
  await request(`/api/decisions/${decision.id}/votes`, { method:'POST', body:JSON.stringify({ guestToken:'guest-a', ranking:['1'] }) });
  const stillHidden = await request(`/api/decisions/${decision.id}`);
  assert.equal(stillHidden.body.results, undefined);
  const aggregate = await request(`/api/decisions/${decision.id}/host`, { headers:{ authorization:`Bearer ${hostToken}` } });
  assert.equal(aggregate.body.results.totalVotes, 2, 'a resubmitted browser token replaces its prior ballot');
  assert.equal(aggregate.body.results.winner.id, '1');
  assert.match(aggregate.body.results.rationale, /leads with/);

  const revealed = await request(`/api/decisions/${decision.id}/results`, { method:'POST', headers:{ authorization:`Bearer ${hostToken}` }, body:JSON.stringify({ enabled:true }) });
  assert.equal(revealed.response.status, 200);
  const publicResults = await request(`/api/decisions/${decision.id}`);
  assert.equal(publicResults.body.resultsVisible, true);
  assert.equal(publicResults.body.results.totalVotes, 2);
  const closed = await request(`/api/decisions/${decision.id}/close`, { method:'POST', headers:{ authorization:`Bearer ${hostToken}` }, body:'{}' });
  assert.equal(closed.body.winnerId, '1');
  assert.ok(closed.body.closedAt);
  const blockedVote = await request(`/api/decisions/${decision.id}/votes`, { method:'POST', body:JSON.stringify({ guestToken:'guest-c', ranking:['3'] }) });
  assert.equal(blockedVote.response.status, 409);

  const rotate = await request(`/api/decisions/${decision.id}/recovery`, { method:'POST', headers:{ authorization:`Bearer ${hostToken}` }, body:'{}' });
  assert.equal(rotate.response.status, 200);
  assert.notEqual(rotate.body.hostToken, hostToken);
  assert.equal((await request(`/api/decisions/${decision.id}/host`, { headers:{ authorization:`Bearer ${hostToken}` } })).response.status, 403);
  assert.equal((await request(`/api/decisions/${decision.id}/host`, { headers:{ authorization:`Bearer ${rotate.body.hostToken}` } })).response.status, 200);
  assert.equal(JSON.stringify(await request(`/api/decisions/${decision.id}`)).includes(rotate.body.hostToken), false, 'normal reads never return the recovery secret');

  const calendar = await request(`/api/decisions/${decision.id}/calendar`);
  assert.equal(calendar.response.status, 200);
  assert.match(calendar.response.headers.get('content-type'), /text\/calendar/);
  assert.match(calendar.response.headers.get('content-disposition'), /attachment; filename="pickloop-/);
  assert.match(calendar.body, /X-WR-TIMEZONE:America\/Los_Angeles/);
  assert.match(calendar.body, /DTSTART:20261202T033000Z/);
  assert.match(calendar.body, /DTEND:20261202T050000Z/);
  assert.match(calendar.body, /SUMMARY:Friday together: Dinner/);
});

test('deadline auto-closes voting; expiration cleanup returns 410', async t => {
  const base = Date.parse('2026-11-21T12:00:00Z'), fixtureData = await fixture(t, base), { request, setTime } = fixtureData;
  const deadlineAt = new Date(base + 60_000).toISOString();
  const created = await createDecision(request, base, { deadlineAt });
  const id = created.body.decision.id, hostToken = created.body.hostToken;
  assert.equal((await request(`/api/decisions/${id}`)).body.closedAt, null);
  setTime(base + 60_000);
  const afterDeadline = await request(`/api/decisions/${id}/votes`, { method:'POST', body:JSON.stringify({ guestToken:'late-guest', ranking:['2'] }) });
  assert.equal(afterDeadline.response.status, 409);
  const final = await request(`/api/decisions/${id}/host`, { headers:{ authorization:`Bearer ${hostToken}` } });
  assert.equal(final.body.closedAt, deadlineAt);
  assert.equal(final.body.winnerId, '1', 'no-vote deadline uses the documented first-option fallback');
  assert.match(final.body.results.rationale, /first-listed option/);

  const expiring = await createDecision(request, base, { title:'Temporary plan' });
  const expiredId = expiring.body.decision.id;
  setTime(base + 31 * DAY);
  const expiredRead = await request(`/api/decisions/${expiredId}`);
  assert.equal(expiredRead.response.status, 410);
  assert.equal(fixtureData.store.readAll()[expiredId], undefined, 'expired decision data is removed from storage');
});

test('storage restores an atomic backup and reports health', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickloop-store-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const file = path.join(dir, 'decisions.json'), store = new JsonDecisionStore(file);
  store.saveAll({ one:{ id:'one', expiresAt:new Date(Date.now() + DAY).toISOString() } });
  store.saveAll({ one:{ id:'one', expiresAt:new Date(Date.now() + DAY).toISOString() }, two:{ id:'two', expiresAt:new Date(Date.now() + DAY).toISOString() } });
  fs.writeFileSync(file, '{ truncated');
  assert.equal(Object.keys(store.readAll()).length, 1, 'corrupt primary recovers the previous valid backup');
  assert.equal(store.recoveredFromBackup, true);
  assert.equal(store.health().status, 'ok');
});
