const app = document.querySelector('#app');
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const toLocalInput = date => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const fmt = (value, timeZone) => new Intl.DateTimeFormat([], { dateStyle:'medium', timeStyle:'short', ...(timeZone ? { timeZone } : {}) }).format(new Date(value));
const hostTokens = () => JSON.parse(localStorage.getItem('pickloop-hosts') || '{}');
const hostToken = id => hostTokens()[id];
const setHostToken = (id, secret) => { const tokens = hostTokens(); tokens[id] = secret; localStorage.setItem('pickloop-hosts', JSON.stringify(tokens)); };
const key = (kind, id) => `pickloop-${kind}-${id}`;
const randomToken = (bytes = 18) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), value => value.toString(16).padStart(2, '0')).join('');
const guestToken = id => { const tokenKey = key('guest', id); let value = localStorage.getItem(tokenKey); if (!value) { value = randomToken(); localStorage.setItem(tokenKey, value); } return value; };
const api = async (url, options = {}) => {
  const response = await fetch(url, { ...options, headers: { 'Content-Type':'application/json', ...(options.headers || {}) } });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body.error || 'Request failed.');
  return body;
};
const decisionUrl = id => `${location.origin}/d/${encodeURIComponent(id)}`;
const hostUrl = (id, token) => `${location.origin}/host/${encodeURIComponent(id)}#recover=${encodeURIComponent(token)}`;
const inviteText = decision => `Help choose: ${decision.title}\nRank your top picks here (no account needed): ${decisionUrl(decision.id)}`;
const shareOrCopy = async (text, title, button) => {
  const original = button.textContent;
  try {
    if (navigator.share) await navigator.share({ title, text });
    else await navigator.clipboard.writeText(text);
    button.textContent = navigator.share ? 'Shared' : 'Copied!';
  } catch (error) {
    if (error.name === 'AbortError') return;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied!';
    } catch {
      const input = document.createElement('textarea'); input.value = text; document.body.append(input); input.select();
      document.execCommand('copy'); input.remove(); button.textContent = 'Copied!';
    }
  }
  setTimeout(() => { if (button.isConnected) button.textContent = original; }, 1500);
};
const copyText = async (text, button) => {
  const original = button.textContent;
  try { await navigator.clipboard.writeText(text); }
  catch { const input = document.createElement('textarea'); input.value = text; document.body.append(input); input.select(); document.execCommand('copy'); input.remove(); }
  button.textContent = 'Copied!'; setTimeout(() => { if (button.isConnected) button.textContent = original; }, 1500);
};
const detailHtml = decision => {
  const d = decision.details || {};
  return `<div class="details"><span class="detail">◷ ${esc(fmt(d.when, d.timeZone))} · ${esc(d.durationMinutes || 60)} min</span>${d.location ? `<span class="detail">⌖ ${esc(d.location)}</span>` : ''}${d.budget ? `<span class="detail">$ ${esc(d.budget)}</span>` : ''}${d.vibe ? `<span class="detail">✳ ${esc(d.vibe)}</span>` : ''}</div>${d.availability ? `<p class="footer-note" style="margin-top:10px">Availability: ${esc(d.availability)}</p>` : ''}`;
};
const layout = (main, aside = '') => `<div class="layout"><section>${main}</section>${aside ? `<aside class="side-panel">${aside}</aside>` : ''}</div>`;
const resultsHtml = decision => {
  const rows = decision.results.options, max = Math.max(...rows.map(row => row.points), 1);
  return `<div class="result-list">${rows.map(row => `<div class="result ${decision.closedAt && row.id === decision.winnerId ? 'winner' : ''}"><div class="result-top"><span class="result-name">${esc(row.name)}</span><span>${row.points} pts · ${row.firsts} first-place</span></div><div class="bar"><span style="width:${Math.max(row.points / max * 100, row.points ? 4 : 0)}%"></span></div></div>`).join('')}</div><p class="rationale" style="margin:16px 0 0">${esc(decision.results.rationale)} Scoring: 1st choice earns 3 points, 2nd earns 2, and 3rd earns 1. Ties go to more first-place votes, then the option listed first.</p>`;
};

function createForm(template = null) {
  const eventTime = new Date(); eventTime.setDate(eventTime.getDate() + 1); eventTime.setHours(19, 0, 0, 0);
  const votingDeadline = new Date(eventTime.getTime() - 60 * 60 * 1000);
  const optionNames = template?.options?.map(option => option.name) || ['Dinner at Nori', 'Mini golf', 'Movie night'];
  const durations = [30, 60, 90, 120, 180, 240], selectedDuration = Number(template?.details?.durationMinutes || 60);
  const durationOptions = durations.map(minutes => `<option value="${minutes}" ${minutes === selectedDuration ? 'selected' : ''}>${minutes < 60 ? `${minutes} minutes` : `${Math.floor(minutes / 60)} hour${minutes >= 120 ? 's' : ''}${minutes % 60 ? ` ${minutes % 60} minutes` : ''}`}</option>`).join('');
  const rows = optionNames.map((_, index) => `<div class="option-input"><span class="option-number">${index + 1}</span><input name="option" maxlength="80" value="${template ? esc(optionNames[index]) : ''}" placeholder="${esc(optionNames[index])}" required>${index >= 3 ? '<button class="btn btn-quiet remove-option" type="button" aria-label="Remove option">×</button>' : ''}</div>`).join('');
  const form = `<form id="create-form" class="card stack"><div class="section-head"><h2>${template ? 'Start from this decision' : 'Start a decision'}</h2><p>Enter a short list and the details your group needs.</p></div><div id="create-error" class="error"></div><div class="form-grid"><div class="field full"><label for="title">What are we deciding?</label><input id="title" name="title" maxlength="100" value="${template ? esc(template.title) : ''}" placeholder="A Friday night plan" required></div><div class="field full"><div class="row between"><label>Options <span class="hint">(3–6)</span></label><button class="btn btn-quiet" id="add-option" type="button">+ Add option</button></div><div class="options" id="options">${rows}</div></div><div class="field"><label for="when">Date and time</label><input id="when" name="when" type="datetime-local" min="${esc(toLocalInput(new Date()))}" value="${esc(toLocalInput(eventTime))}" required></div><div class="field"><label for="deadline">Voting closes</label><input id="deadline" name="deadline" type="datetime-local" min="${esc(toLocalInput(new Date()))}" value="${esc(toLocalInput(votingDeadline))}"><span class="hint">Leave empty for no automatic deadline.</span></div><div class="field"><label for="duration">Event length</label><select id="duration" name="duration">${durationOptions}</select></div><div class="field"><label for="availability">Availability</label><input id="availability" name="availability" maxlength="200" value="${template ? esc(template.details.availability) : ''}" placeholder="Friday evening"></div><div class="field"><label for="budget">Budget</label><input id="budget" name="budget" maxlength="80" value="${template ? esc(template.details.budget) : ''}" placeholder="Around $30 each"></div><div class="field"><label for="location">Area</label><input id="location" name="location" maxlength="120" value="${template ? esc(template.details.location) : ''}" placeholder="Downtown"></div><div class="field full"><label for="vibe">The vibe</label><input id="vibe" name="vibe" maxlength="120" value="${template ? esc(template.details.vibe) : ''}" placeholder="Relaxed, a little celebratory"></div><input type="hidden" name="timeZone" value="${esc(template?.details?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')}"></div><button class="btn btn-primary wide" type="submit">Create decision →</button><p class="footer-note">No account needed. Save the host recovery link after creation. Guest links expire after 30 days.</p></form>`;
  const aside = `<div class="card"><h3>How PickLoop works</h3><div class="step"><b>1</b><span><strong>Offer a shortlist</strong><br>Add 3 to 6 options and the details that matter.</span></div><div class="step"><b>2</b><span><strong>Share one link</strong><br>Guests rank up to three picks without signing up.</span></div><div class="step"><b>3</b><span><strong>Close the loop</strong><br>Get a clear winner and calendar event.</span></div></div><div class="card"><p class="method">First choice earns 3 points, second earns 2, and third earns 1. Guest results stay hidden until you reveal them or close voting.</p></div>`;
  app.innerHTML = `<div class="hero"><div class="eyebrow">A little less back-and-forth</div><h1>Make a plan<br>everyone can get behind.</h1><p>Put a few good options on the table. Your group ranks them, and you leave with one plan.</p></div>${layout(form, aside)}`;
  const options = document.querySelector('#options');
  function updateRows() {
    [...options.children].forEach((row, index) => { row.querySelector('.option-number').textContent = index + 1; const remove = row.querySelector('.remove-option'); if (remove) remove.style.visibility = options.children.length > 3 ? 'visible' : 'hidden'; });
    document.querySelector('#add-option').disabled = options.children.length >= 6;
  }
  updateRows();
  document.querySelector('#add-option').addEventListener('click', () => {
    if (options.children.length >= 6) return;
    const index = options.children.length;
    options.insertAdjacentHTML('beforeend', `<div class="option-input"><span class="option-number">${index + 1}</span><input name="option" maxlength="80" placeholder="Another good option" required><button class="btn btn-quiet remove-option" type="button" aria-label="Remove option">×</button></div>`);
    updateRows(); options.lastElementChild.querySelector('input').focus();
  });
  options.addEventListener('click', event => { if (event.target.closest('.remove-option') && options.children.length > 3) { event.target.closest('.option-input').remove(); updateRows(); } });
  document.querySelector('#create-form').addEventListener('submit', async event => {
    event.preventDefault(); const error = document.querySelector('#create-error'); error.classList.remove('show');
    const values = new FormData(event.currentTarget), names = values.getAll('option').map(value => value.trim()).filter(Boolean);
    try {
      const result = await api('/api/decisions', { method:'POST', body:JSON.stringify({ title:values.get('title'), options:names, when:new Date(values.get('when')).toISOString(), deadlineAt:values.get('deadline') ? new Date(values.get('deadline')).toISOString() : null, durationMinutes:Number(values.get('duration')), timeZone:values.get('timeZone'), availability:values.get('availability'), budget:values.get('budget'), location:values.get('location'), vibe:values.get('vibe') }) });
      setHostToken(result.decision.id, result.hostToken); localStorage.setItem(key('recovery-pending', result.decision.id), result.hostToken);
      history.pushState({}, '', `/host/${encodeURIComponent(result.decision.id)}`); renderHost(result.decision.id, result.hostToken);
    } catch (err) { error.textContent = err.message; error.classList.add('show'); }
  });
}

function recoveryCard(id, secret) {
  const link = hostUrl(id, secret);
  return `<div class="card recovery-card"><span class="badge">Save this now</span><h2 style="margin-top:16px">Your host recovery link</h2><p class="method">This private link restores host control if browser storage is cleared. Anyone who has it can reveal results, close voting, or replace the recovery link. It will not be shown again after you acknowledge saving it.</p><div class="share-row"><input id="recovery-link" readonly value="${esc(link)}"><button class="btn btn-light" id="copy-recovery">Copy recovery link</button></div><p class="footer-note" style="margin-top:14px">By continuing, you confirm you saved this private link somewhere safe.</p><button id="ack-recovery" class="btn btn-primary wide" style="margin-top:12px">I saved the recovery link — continue</button></div>`;
}

async function renderHost(id, recoveredToken = null) {
  const secret = recoveredToken || hostToken(id);
  if (!secret) { app.innerHTML = `<div class="card empty"><strong>Host controls need your recovery link.</strong>Open the link you saved, or use the guest view.<p style="margin-top:16px"><a href="${decisionUrl(id)}">Open guest view →</a></p></div>`; return; }
  try {
    const d = await api(`/api/decisions/${encodeURIComponent(id)}/host`, { headers:{ Authorization:`Bearer ${secret}` } });
    const pendingSecret = recoveredToken || localStorage.getItem(key('recovery-pending', id));
    const needsAck = Boolean(pendingSecret && localStorage.getItem(key('recovery-ack', id)) !== 'yes');
    const winner = d.options.find(option => option.id === d.winnerId);
    const invite = inviteText(d), planText = `${d.title}\n${winner?.name || ''}\n${fmt(d.details.when, d.details.timeZone)} (${d.details.timeZone}) · ${d.details.durationMinutes} min${d.details.location ? `\n${d.details.location}` : ''}${d.details.budget ? `\n${d.details.budget}` : ''}`;
    const recovery = needsAck ? recoveryCard(id, pendingSecret) : '';
    const hostLock = needsAck ? 'disabled' : '';
    const resultsButton = !d.closedAt && !d.resultsVisible ? `<button id="show-results" class="btn btn-light" ${hostLock}>Show results to guests</button>` : '';
    const main = `<div class="card"><div class="title-row"><div><div class="eyebrow">Your group decision</div><h1>${esc(d.title)}</h1><div class="vote-summary">${d.results.totalVotes} ${d.results.totalVotes === 1 ? 'vote' : 'votes'} · ${d.deadlineAt ? `voting deadline ${esc(fmt(d.deadlineAt, d.details.timeZone))}` : 'no voting deadline'}</div></div><span class="badge"><i class="status-dot"></i>${d.closedAt ? 'Finalized' : 'Voting open'}</span></div>${detailHtml(d)}<hr class="rule"><div class="section-head"><h2>${d.closedAt ? 'The plan is set' : 'Private live results'}</h2><p>${d.closedAt ? 'Your group has a finalized plan.' : d.resultsVisible ? 'Guests can now see the live results.' : 'Only you can see these rankings until you reveal them or close voting.'}</p></div>${d.closedAt ? `<div class="closed-card"><div class="host-tag">The group picked</div><div class="winner-name">${esc(winner?.name || 'Plan finalized')}</div></div>` : ''}<div style="margin-top:18px">${resultsHtml(d)}</div>${d.closedAt ? `<hr class="rule"><article class="closed-card" id="winner-card"><div class="host-tag">PickLoop · finalized plan</div><div class="winner-name">${esc(d.title)}: ${esc(winner?.name || '')}</div><p class="footer-note">${esc(fmt(d.details.when, d.details.timeZone))} · ${esc(d.details.timeZone)} · ${d.details.durationMinutes} minutes${d.details.location ? ` · ${esc(d.details.location)}` : ''}</p></article><div class="row" style="margin-top:14px;flex-wrap:wrap"><button class="btn btn-light" id="copy-plan">Copy winner card</button><button class="btn btn-light" id="share-plan">Share winner card</button><a class="btn btn-primary" href="/api/decisions/${encodeURIComponent(id)}/calendar">Download .ics</a></div><button class="btn btn-quiet" id="template-decision" style="margin-top:12px">Start another decision with these details →</button>` : `<hr class="rule"><div class="stack"><div><h2>Invite your group</h2><p class="footer-note">Sharing never includes your host recovery link.</p></div><div class="share-row"><input id="guest-link" readonly value="${esc(decisionUrl(id))}"><button id="copy-link" class="btn btn-light">Copy link</button><button id="share-invite" class="btn btn-light">Share invite</button><button id="copy-invite" class="btn btn-light">Copy invite text</button></div><div class="row" style="flex-wrap:wrap">${resultsButton}<button id="close-decision" class="btn btn-primary" ${hostLock}>Close voting and finalize</button></div><div id="host-error" class="error"></div></div>`}</div>`;
    const aside = `<div class="card"><span class="badge">Host view</span><h3 style="margin-top:17px">A clear result</h3><p class="method">Ranked votes: 3, 2, then 1 point. Ties go to first-place votes, then original option order.</p><hr class="rule"><p class="method">Host recovery link is a private capability. Use “Rotate recovery link” to invalidate the previous one.</p><button class="btn btn-quiet" id="rotate-recovery">Rotate recovery link</button></div><div class="card"><h3>Decision link</h3><div class="step"><b>↗</b><span>Share the guest invite. It has no host controls.</span></div><div class="step"><b>◎</b><span>Guests can revise their ballot until voting closes.</span></div><div class="step"><b>✓</b><span>Close voting to lock a winner and enable its calendar file.</span></div></div>`;
    app.innerHTML = `${recovery}${layout(main, aside)}`;
    document.querySelector('#copy-recovery')?.addEventListener('click', event => copyText(hostUrl(id, pendingSecret), event.currentTarget));
    document.querySelector('#ack-recovery')?.addEventListener('click', () => { localStorage.setItem(key('recovery-ack', id), 'yes'); localStorage.removeItem(key('recovery-pending', id)); renderHost(id); });
    document.querySelector('#copy-link')?.addEventListener('click', event => copyText(decisionUrl(id), event.currentTarget));
    document.querySelector('#share-invite')?.addEventListener('click', event => shareOrCopy(invite, d.title, event.currentTarget));
    document.querySelector('#copy-invite')?.addEventListener('click', event => copyText(invite, event.currentTarget));
    document.querySelector('#copy-plan')?.addEventListener('click', event => copyText(planText, event.currentTarget));
    document.querySelector('#share-plan')?.addEventListener('click', event => shareOrCopy(planText, 'Finalized plan', event.currentTarget));
    document.querySelector('#template-decision')?.addEventListener('click', () => { location.href = `/?template=${encodeURIComponent(id)}`; });
    document.querySelector('#close-decision')?.addEventListener('click', async event => { event.currentTarget.disabled = true; try { await api(`/api/decisions/${encodeURIComponent(id)}/close`, { method:'POST', headers:{ Authorization:`Bearer ${secret}` }, body:'{}' }); renderHost(id); } catch (error) { const box = document.querySelector('#host-error'); box.textContent = error.message; box.classList.add('show'); event.currentTarget.disabled = false; } });
    document.querySelector('#show-results')?.addEventListener('click', async () => { try { await api(`/api/decisions/${encodeURIComponent(id)}/results`, { method:'POST', headers:{ Authorization:`Bearer ${secret}` }, body:JSON.stringify({ enabled:true }) }); renderHost(id); } catch (error) { const box = document.querySelector('#host-error'); box.textContent = error.message; box.classList.add('show'); } });
    const rotateButton = document.querySelector('#rotate-recovery'); if (rotateButton) { rotateButton.disabled = needsAck; rotateButton.addEventListener('click', async event => { event.currentTarget.disabled = true; try { const result = await api(`/api/decisions/${encodeURIComponent(id)}/recovery`, { method:'POST', headers:{ Authorization:`Bearer ${secret}` }, body:'{}' }); setHostToken(id, result.hostToken); localStorage.setItem(key('recovery-pending', id), result.hostToken); localStorage.removeItem(key('recovery-ack', id)); renderHost(id, result.hostToken); } catch (error) { const box = document.querySelector('#host-error'); if (box) { box.textContent = error.message; box.classList.add('show'); } } }); }
    if (!d.closedAt) setTimeout(() => { if (location.pathname === `/host/${id}`) renderHost(id).catch(() => {}); }, 5000);
  } catch (error) { app.innerHTML = `<div class="card notice">${esc(error.message)}</div>`; }
}

async function renderGuest(id) {
  try {
    const d = await api(`/api/decisions/${encodeURIComponent(id)}`), closed = Boolean(d.closedAt);
    const token = guestToken(id), prior = localStorage.getItem(key('submitted', id)) === 'yes';
    const resultBlock = d.resultsVisible ? `<div style="margin-top:18px">${resultsHtml(d)}</div>` : `<div class="notice" style="margin-top:16px">${prior ? 'Your ranking is saved.' : 'Your vote is private.'} The host will share the group result when voting closes or they choose to reveal it.</div>`;
    const main = `<div class="card"><div class="title-row"><div><div class="eyebrow">A group decision</div><h1>${esc(d.title)}</h1></div><span class="badge"><i class="status-dot"></i>${closed ? 'Finalized' : 'Voting open'}</span></div>${detailHtml(d)}${closed ? `<hr class="rule"><div class="closed-card"><div class="host-tag">The group picked</div><div class="winner-name">${esc(d.options.find(option => option.id === d.winnerId)?.name || 'Plan finalized')}</div></div>${resultsBlock}<article class="closed-card" style="margin-top:16px"><div class="host-tag">PickLoop · finalized plan</div><div class="winner-name">${esc(d.title)}: ${esc(d.options.find(option => option.id === d.winnerId)?.name || '')}</div><p class="footer-note">${esc(fmt(d.details.when, d.details.timeZone))} · ${esc(d.details.timeZone)} · ${d.details.durationMinutes} minutes${d.details.location ? ` · ${esc(d.details.location)}` : ''}</p></article><div class="row" style="margin-top:14px;flex-wrap:wrap"><button class="btn btn-light" id="copy-plan">Copy winner card</button><button class="btn btn-light" id="share-plan">Share winner card</button><a class="btn btn-primary" href="/api/decisions/${encodeURIComponent(id)}/calendar">Download .ics</a></div>` : `<hr class="rule"><div class="section-head"><h2>Rank your top picks</h2><p>Tap options in order. Choose up to three; your first pick counts most.</p></div><div class="choice-list">${d.options.map(option => `<label class="choice" data-option="${esc(option.id)}"><input type="checkbox" value="${esc(option.id)}"><span class="vote-rank"></span><strong>${esc(option.name)}</strong></label>`).join('')}</div><p class="hint" style="margin:11px 0 15px">Tap again to remove a pick. You can update your vote until the host closes it.</p><button id="submit-vote" class="btn btn-primary wide">${prior ? 'Update my ranking' : 'Submit my ranking'}</button><div id="vote-error" class="error" style="margin-top:12px"></div><div id="vote-success" class="notice success" style="display:${prior ? 'block' : 'none'};margin-top:12px">Your vote is saved. Share the invite with someone else if your group needs another voice.</div><div class="row" style="margin-top:12px;flex-wrap:wrap"><button id="share-after-vote" class="btn btn-light" ${prior ? '' : 'hidden'}>Share invite</button><button id="copy-after-vote" class="btn btn-light" ${prior ? '' : 'hidden'}>Copy invite text</button></div>${resultBlock}`}</div>`;
    const aside = `<div class="card"><h3>How the score works</h3><div class="step"><b>1</b><span>Your first choice gets 3 points.</span></div><div class="step"><b>2</b><span>Your second choice gets 2 points.</span></div><div class="step"><b>3</b><span>Your third choice gets 1 point.</span></div><p class="method">${d.resultsVisible ? 'Most points wins. Ties go to more first-place votes, then the original list order.' : 'Your vote is private until the host closes or reveals results.'}</p></div><div class="card"><span class="badge">No sign-up</span><p class="method" style="margin-top:15px">This browser uses a random token so you can revise your anonymous ballot before voting closes.</p></div>`;
    app.innerHTML = layout(main, aside);
    const text = inviteText(d), plan = `${d.title}\n${d.options.find(option => option.id === d.winnerId)?.name || ''}\n${fmt(d.details.when, d.details.timeZone)} (${d.details.timeZone}) · ${d.details.durationMinutes} min${d.details.location ? `\n${d.details.location}` : ''}`;
    document.querySelector('#share-after-vote')?.addEventListener('click', event => shareOrCopy(text, d.title, event.currentTarget));
    document.querySelector('#copy-after-vote')?.addEventListener('click', event => copyText(text, event.currentTarget));
    document.querySelector('#copy-plan')?.addEventListener('click', event => copyText(plan, event.currentTarget));
    document.querySelector('#share-plan')?.addEventListener('click', event => shareOrCopy(plan, 'Finalized plan', event.currentTarget));
    if (!closed) {
      const selected = [], list = document.querySelector('.choice-list');
      try { const saved = JSON.parse(localStorage.getItem(key('ballot', id)) || '[]'); if (Array.isArray(saved)) selected.push(...saved.filter(option => d.options.some(item => item.id === option)).slice(0, 3)); } catch {}
      const paint = () => list.querySelectorAll('.choice').forEach(row => { const rank = selected.indexOf(row.dataset.option); row.classList.toggle('selected', rank >= 0); row.querySelector('input').checked = rank >= 0; row.querySelector('.vote-rank').textContent = rank >= 0 ? rank + 1 : ''; });
      paint();
      list.addEventListener('click', event => { const choice = event.target.closest('.choice'); if (!choice) return; event.preventDefault(); const at = selected.indexOf(choice.dataset.option); if (at >= 0) selected.splice(at, 1); else if (selected.length < 3) selected.push(choice.dataset.option); localStorage.setItem(key('ballot', id), JSON.stringify(selected)); paint(); });
      document.querySelector('#submit-vote').addEventListener('click', async () => {
        const error = document.querySelector('#vote-error'); error.classList.remove('show');
        try {
          if (!selected.length) throw new Error('Choose at least one option first.');
          await api(`/api/decisions/${encodeURIComponent(id)}/votes`, { method:'POST', body:JSON.stringify({ guestToken:token, ranking:selected }) });
          localStorage.setItem(key('submitted', id), 'yes'); renderGuest(id);
        } catch (err) { error.textContent = err.message; error.classList.add('show'); }
      });
      setTimeout(() => { if (location.pathname === `/d/${id}`) renderGuest(id); }, 5000);
    }
  } catch (error) { app.innerHTML = `<div class="card empty"><strong>We couldn’t open this decision.</strong>${esc(error.message)}<p style="margin-top:16px"><a href="/">Start a new decision →</a></p></div>`; }
}

async function route() {
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts[0] === 'd' && parts[1]) return renderGuest(decodeURIComponent(parts[1]));
  if (parts[0] === 'host' && parts[1]) {
    const id = decodeURIComponent(parts[1]), recovery = new URLSearchParams(location.hash.slice(1)).get('recover');
    if (recovery) { setHostToken(id, recovery); localStorage.setItem(key('recovery-pending', id), recovery); history.replaceState({}, '', `/host/${encodeURIComponent(id)}`); }
    return renderHost(id, recovery);
  }
  const templateId = new URLSearchParams(location.search).get('template');
  if (templateId) { try { const template = await api(`/api/decisions/${encodeURIComponent(templateId)}`); createForm(template); } catch { createForm(); } }
  else createForm();
}
window.addEventListener('popstate', route);
route();
