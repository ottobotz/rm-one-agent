require('dotenv').config();
const { WebClient } = require('@slack/web-api');
const axios = require('axios');

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const apolloClient = axios.create({
  baseURL: 'https://api.apollo.io/api/v1',
  headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json' }
});

const CESAR_USER_ID = 'U0AJE6TJS5P';

// Target call outcomes — add Bad/Wrong Number ID once confirmed in Apollo Settings
const TARGET_OUTCOMES = [
  { id: '69a5b9edc0b4450011dbc9b0', label: 'No Longer with Company' },
  { id: '69de55ce10d58d00215bdf77', label: 'Retired' },
  { id: '68b857524a96d50019c50117', label: 'Bad/Wrong Number' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayMidnightCST() {
  // Returns midnight CST (UTC-6) for the current calendar day
  const now = new Date();
  const cst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  cst.setHours(0, 0, 0, 0);
  const offsetMs = now.getTime() - new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' })).getTime();
  return new Date(cst.getTime() + offsetMs);
}

async function getChannelId(name) {
  let cursor;
  do {
    const res = await slack.conversations.list({ types: 'public_channel,private_channel', limit: 200, cursor });
    const found = res.channels.find(c => c.name === name);
    if (found) return found.id;
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  return null;
}

async function fetchCallsForOutcome(outcomeId, sinceDate) {
  const calls = [];
  let page = 1;

  while (true) {
    const res = await apolloClient.post('/phone_calls/search', {
      phone_call_outcome_ids: [outcomeId],
      page,
      per_page: 100
    });

    const batch = res.data.phone_calls || [];
    let doneEarly = false;

    for (const call of batch) {
      const callTime = new Date(call.start_time);
      if (callTime < sinceDate) { doneEarly = true; break; }
      if (call.contact_id) calls.push(call);
    }

    if (doneEarly || batch.length < 100) break;
    page++;
  }

  return calls;
}

async function getContactDetails(contactId) {
  try {
    const res = await apolloClient.post('/contacts/search', {
      contact_ids: [contactId], page: 1, per_page: 1
    });
    return res.data.contacts?.[0] || null;
  } catch {
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const since = todayMidnightCST();
  const dateLabel = since.toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'long', day: 'numeric', year: 'numeric' });
  console.log(`[${new Date().toISOString()}] Running call audit for ${dateLabel} (since ${since.toISOString()})`);

  const channelId = await getChannelId('company-and-conact-enrichment');
  if (!channelId) { console.error('Cannot find #company-and-contact-enrichment channel'); return; }

  // Fetch calls for each target outcome
  const sections = [];

  for (const outcome of TARGET_OUTCOMES) {
    const calls = await fetchCallsForOutcome(outcome.id, since);
    console.log(`${outcome.label}: ${calls.length} call(s) today`);
    if (calls.length === 0) continue;

    // Fetch contact details in parallel (batches of 10)
    const contacts = [];
    for (let i = 0; i < calls.length; i += 10) {
      const batch = calls.slice(i, i + 10);
      const details = await Promise.all(batch.map(c => getContactDetails(c.contact_id)));
      contacts.push(...details);
    }

    const lines = contacts
      .filter(Boolean)
      .map(c => {
        const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Unknown';
        const title = c.title ? ` — ${c.title}` : '';
        const company = c.organization_name ? `, ${c.organization_name}` : '';
        const link = `https://app.apollo.io/#/contacts/${c.id}`;
        return `• <${link}|${name}>${title}${company}`;
      });

    if (lines.length > 0) {
      sections.push({ label: outcome.label, lines });
    }
  }

  if (sections.length === 0) {
    console.log('No flagged calls today — skipping Slack post.');
    return;
  }

  // Build Slack blocks
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `<@${CESAR_USER_ID}> — here are today's calls (${dateLabel}) that need contact enrichment or cleanup:`
      }
    },
    { type: 'divider' }
  ];

  for (const section of sections) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*🔴 ${section.label}*\n${section.lines.join('\n')}` }
    });
  }

  const fallbackText = `Call audit for ${dateLabel}: ${sections.map(s => `${s.lines.length} ${s.label}`).join(', ')}`;
  await slack.chat.postMessage({ channel: channelId, text: fallbackText, blocks });
  console.log('Posted to #company-and-contact-enrichment');
}

run().catch(console.error);
