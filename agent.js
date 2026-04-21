require('dotenv').config();
const { WebClient } = require('@slack/web-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const APOLLO_BASE = 'https://api.apollo.io/api/v1';
const apolloClient = axios.create({
  baseURL: APOLLO_BASE,
  headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json' }
});
const STATE_FILE = path.join(__dirname, 'state.json');
const WEB_VISITORS_LABEL_ID = '69e2856c8982aa002116395f';         // "Website Visitors (RB2B)" contacts list
const WEB_VISITORS_ACCOUNT_LABEL_ID = '69e6fa81161800000d621980'; // "Website Visitors (RB2B)" accounts list

// ─── State Management ─────────────────────────────────────────────────────────

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }
  // Default: start from 1 hour ago
  return { lastTimestamp: String(Date.now() / 1000 - 3600) };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── Slack Helpers ────────────────────────────────────────────────────────────

async function getChannelId(name) {
  let cursor;
  do {
    const res = await slack.conversations.list({
      types: 'public_channel,private_channel',
      limit: 200,
      cursor
    });
    const found = res.channels.find(c => c.name === name);
    if (found) return found.id;
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  return null;
}

// ─── RB2B Message Parsing ─────────────────────────────────────────────────────

function parseRB2BMessage(message) {
  // message.text has clean data (no Slack mailto/URL formatting)
  const text = message.text || '';

  // Name: new visitor header is "Name from Company"; repeat visitor header is "REPEAT VISITOR SIGNAL"
  // so fall back to the first section block containing " from " for repeat visitor messages
  const headerBlock = message.blocks?.find(b => b.type === 'header');
  const headerText = headerBlock?.text?.text?.trim() || '';
  let name;
  if (headerText.includes(' from ')) {
    name = headerText.split(' from ')[0].trim();
  } else {
    const sectionWithFrom = message.blocks?.find(b => b.type === 'section' && b.text?.text?.includes(' from '));
    const sectionText = sectionWithFrom?.text?.text?.trim() || '';
    name = sectionText.includes(' from ') ? sectionText.replace(/\*/g, '').split(' from ')[0].trim() : null;
  }

  const isRepeatVisitor = headerText.toLowerCase().includes('repeat visitor');

  const get = (label) => {
    const m = text.match(new RegExp(`\\*${label}\\*:\\s*([^\\n*\\r]+?)(?:\\s*(?:First identified|company logo|\\n)|$)`, 'i'));
    if (m) return m[1].trim();
    // Fallback: simple match up to newline
    const m2 = text.match(new RegExp(`\\*${label}\\*:\\s*([^\\n*]+)`, 'i'));
    return m2 ? m2[1].trim() : null;
  };

  const title = get('Title');
  const company = get('Company');
  const location = get('Location');

  // Email is clean in message.text (no mailto wrapper)
  const emailMatch = text.match(/\*Email\*:\s*([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i);
  const email = emailMatch ? emailMatch[1] : null;

  // LinkedIn URL
  const linkedinMatch = text.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[^\s>]+/);
  const linkedin = linkedinMatch ? linkedinMatch[0] : null;

  // Page visited + timestamp
  let pageVisited = null, visitTime = null;
  const newVisitMatch = text.match(/First identified visiting\s+\*?<?([^>*\s]+)>?\*?\s+on\s+\*?([^*\n]+)\*?/i);
  const repeatVisitMatch = text.match(/has visited\s+(\d+)\s+pages? on your site since\s+([^\n.]+)/i);
  if (newVisitMatch) {
    pageVisited = newVisitMatch[1];
    visitTime = newVisitMatch[2].trim();
  } else if (repeatVisitMatch) {
    pageVisited = `${repeatVisitMatch[1]} page(s) on rmone.com`;
    visitTime = repeatVisitMatch[2].trim();
  }

  return { name, title, company, email, linkedin, location, pageVisited, visitTime, isRepeatVisitor };
}

// ─── LinkedIn Helpers ─────────────────────────────────────────────────────────

function normalizeLinkedInUrl(url) {
  if (!url) return null;
  try {
    const match = url.match(/linkedin\.com\/in\/([^/?&#\s]+)/);
    if (!match) return null;
    const username = decodeURIComponent(match[1]).replace(/\/$/, '');
    if (!username || username.length < 3) return null;
    return `https://www.linkedin.com/in/${username}`;
  } catch {
    return null;
  }
}

function isValidLinkedInUrl(url) {
  const normalized = normalizeLinkedInUrl(url);
  if (!normalized) return false;
  const username = normalized.split('/in/')[1];
  // Valid LinkedIn usernames: letters, numbers, hyphens, underscores, 3–100 chars
  return /^[a-zA-Z0-9\-_]{3,100}$/.test(username);
}

// ─── Apollo API ───────────────────────────────────────────────────────────────

async function apolloMatchByEmail(email) {
  try {
    const res = await apolloClient.post('/people/match', { email });
    return res.data.person || null;
  } catch (err) {
    console.error('Apollo match error:', err.response?.data?.error || err.message);
    return null;
  }
}

async function apolloSearchByName(name, company) {
  try {
    const res = await apolloClient.post('/mixed_people/api_search', {
      q_organization_name: company,
      q_keywords: name,
      page: 1,
      per_page: 3
    });
    return res.data.people?.[0] || null;
  } catch (err) {
    console.error('Apollo search error:', err.response?.data?.error || err.message);
    return null;
  }
}

async function getContactFull(contactId) {
  try {
    const res = await apolloClient.get(`/contacts/${contactId}`);
    return res.data.contact || null;
  } catch (err) {
    console.error('Contact fetch error:', err.response?.data?.error || err.message);
    return null;
  }
}

async function getAccountDetails(accountId) {
  try {
    const res = await apolloClient.get(`/accounts/${accountId}`);
    return res.data.account || null;
  } catch (err) {
    console.error('Account fetch error:', err.response?.data?.error || err.message);
    return null;
  }
}

async function getAllLabels() {
  try {
    const res = await apolloClient.get('/labels');
    return res.data.labels || [];
  } catch (err) {
    console.error('Labels fetch error:', err.response?.data?.error || err.message);
    return [];
  }
}

async function findAccountByName(name) {
  try {
    const res = await apolloClient.post('/accounts/search', {
      q_organization_name: name,
      page: 1,
      per_page: 3
    });
    const accounts = res.data.accounts || [];
    const match = accounts.find(a => a.name?.toLowerCase() === name?.toLowerCase()) || accounts[0];
    return match?.id || null;
  } catch (err) {
    console.error('Account search error:', err.response?.data?.error || err.message);
    return null;
  }
}

async function getDealsByAccount(accountId) {
  try {
    const res = await apolloClient.post('/opportunities/search', {
      account_ids: [accountId],
      page: 1,
      per_page: 10
    });
    return res.data.opportunities || [];
  } catch (err) {
    return [];
  }
}

async function createContact(visitor, person, accountId) {
  try {
    const nameParts = (visitor.name || '').split(' ');
    const res = await apolloClient.post('/contacts', {
      first_name: nameParts[0] || '',
      last_name: nameParts.slice(1).join(' ') || '',
      email: visitor.email || person?.email,
      title: visitor.title || person?.title,
      organization_name: visitor.company || person?.organization?.name,
      website_url: person?.organization?.website_url,
      linkedin_url: normalizeLinkedInUrl(visitor.linkedin) || undefined,
      ...(accountId ? { account_id: accountId } : {})
    });
    return res.data.contact || null;
  } catch (err) {
    console.error('Create contact error:', err.response?.data?.error || err.message);
    return null;
  }
}

async function updateContactLinkedIn(contactId, linkedinUrl) {
  try {
    await apolloClient.put(`/contacts/${contactId}`, { linkedin_url: linkedinUrl });
    return true;
  } catch (err) {
    console.error('LinkedIn update error:', err.response?.data?.error || err.message);
    return false;
  }
}

async function logNote(contactId, visitor) {
  try {
    await apolloClient.post('/notes', {
      contact_ids: [contactId],
      body: `RB2B: Identified visiting ${visitor.pageVisited || 'rmone.com'} on ${visitor.visitTime || new Date().toISOString()}. Location: ${visitor.location || 'unknown'}.`
    });
    return true;
  } catch (err) {
    console.error('Log note error:', err.response?.data?.error || err.message);
    return false;
  }
}

// ─── Slack Post ───────────────────────────────────────────────────────────────

const CTA_USER = 'U0ANH541WQ5';

function buildVisitorBlocks(visitor, apollo) {
  const { name, title, company, email, location, pageVisited, visitTime } = visitor;

  const accountLink = apollo.accountId
    ? `<https://app.apollo.io/#/accounts/${apollo.accountId}|View Company>`
    : null;

  // ── Company-only card (no contact found)
  if (!apollo.found && apollo.accountId) {
    const companyLinkedin = apollo.accountLinkedin
      ? `<${apollo.accountLinkedin}|View Company LinkedIn>`
      : '_Not available_';
    const companyWebsite = apollo.accountWebsite
      ? `<${apollo.accountWebsite}|${apollo.accountWebsite}>`
      : '_Not available_';
    const companyLists = apollo.accountLabels?.length > 0
      ? apollo.accountLabels.map(l => `• ${l}`).join('\n')
      : '_None_';
    const dealsText = apollo.deals?.length > 0
      ? apollo.deals.map(d => `• ${d.name} — ${d.stage_name || 'unknown stage'}${d.amount ? ` ($${Number(d.amount).toLocaleString()})` : ''}`).join('\n')
      : '_No associated deals_';

    return {
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: visitor.isRepeatVisitor ? '🔁 Repeat Website Visitor' : '🌐 New Website Visitor' } },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${company || 'Unknown Company'}*${location ? ` · ${location}` : ''}\n_No contact identified_`
          }
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Website:*\n${companyWebsite}` },
            { type: 'mrkdwn', text: `*LinkedIn:*\n${companyLinkedin}` },
            { type: 'mrkdwn', text: `*Page Visited:*\n${pageVisited || 'N/A'}` },
            { type: 'mrkdwn', text: `*Visit Time:*\n${visitTime || 'N/A'}` }
          ]
        },
        { type: 'divider' },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Apollo Status:* \`Company Only\`\n${accountLink || '_No Apollo account found_'}` }
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Company Lists*\n${companyLists}` }
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Associated Deals*\n${dealsText}` }
        },
        { type: 'divider' },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: '🏢 Company tagged in Website Visitors (RB2B) list' }]
        }
      ],
      fallbackText: `New website visitor from ${company || 'Unknown Company'} — no contact identified`
    };
  }

  // ── Contact card (known or net-new contact)
  const resolvedLinkedIn = apollo.linkedin || normalizeLinkedInUrl(visitor.linkedin);
  const linkedInDisplay = resolvedLinkedIn
    ? `<${resolvedLinkedIn}|View Profile>${apollo.linkedInSource === 'apollo' ? ' _↩ from Apollo_' : apollo.linkedInSource === 'rb2b_updated' ? ' _↑ updated Apollo_' : ''}`
    : '_Bad URL — not found in Apollo_';

  const statusLine = apollo.found ? '`Known Contact`' : '`Net New` — not found in Apollo';

  const contactLink = apollo.contactId
    ? `<https://app.apollo.io/#/contacts/${apollo.contactId}|View Contact>`
    : null;
  const linksLine = [contactLink, accountLink].filter(Boolean).join('  ·  ') || '_No links available_';

  const peopleLists = apollo.contactLabels?.length > 0
    ? apollo.contactLabels.map(l => `• ${l}`).join('\n')
    : '_None_';
  const companyLists = apollo.accountLabels?.length > 0
    ? apollo.accountLabels.map(l => `• ${l}`).join('\n')
    : '_None_';
  const listsText = apollo.found
    ? `*People Lists:*\n${peopleLists}\n\n*Company Lists:*\n${companyLists}`
    : '_Not in Apollo_';

  const seqText = apollo.found
    ? (apollo.sequences?.length > 0
        ? apollo.sequences.map(s => `• ${s.emailer_campaign_name || s.emailer_campaign_id} _(${s.status})_`).join('\n')
        : '_Not enrolled in any sequences_')
    : '_Not in Apollo_';

  const dealsText = apollo.found
    ? (apollo.deals?.length > 0
        ? apollo.deals.map(d => `• ${d.name} — ${d.stage_name || 'unknown stage'}${d.amount ? ` ($${Number(d.amount).toLocaleString()})` : ''}`).join('\n')
        : '_No associated deals_')
    : '_Not in Apollo_';

  const footerText = apollo.noted
    ? '✅ Note logged to Apollo contact record'
    : apollo.found
      ? '⚠️ Could not log note to Apollo'
      : '➕ Not in Apollo — contact created, note pending';

  return {
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: visitor.isRepeatVisitor ? '🔁 Repeat Website Visitor' : '🌐 New Website Visitor' } },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${name || 'Unknown'}*${title ? `\n${title}` : ''}${company ? `\n${company}` : ''}${location ? ` · ${location}` : ''}`
        }
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Email:*\n${email || 'N/A'}` },
          { type: 'mrkdwn', text: `*LinkedIn:*\n${linkedInDisplay}` },
          { type: 'mrkdwn', text: `*Page Visited:*\n${pageVisited || 'N/A'}` },
          { type: 'mrkdwn', text: `*Visit Time:*\n${visitTime || 'N/A'}` }
        ]
      },
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Apollo Status:* ${statusLine}\n${linksLine}` }
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Associated Lists*\n${listsText}` }
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Associated Sequences*\n${seqText}` }
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Associated Deals*\n${dealsText}` }
      },
      { type: 'divider' },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: footerText }]
      }
    ],
    fallbackText: `New visitor: ${name || 'Unknown'} from ${company || 'Unknown'}`
  };
}

async function postToInboundLeads(channelId, visitor, apollo) {
  const { blocks, fallbackText } = buildVisitorBlocks(visitor, apollo);
  await slack.chat.postMessage({ channel: channelId, text: fallbackText, blocks });
}

async function postCTANotification(channelId, visitor, apollo) {
  const { blocks, fallbackText } = buildVisitorBlocks(visitor, apollo);
  const { name, company } = visitor;

  // Prepend @mention CTA block
  const ctaBlocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `<@${CTA_USER}> — new website visitor: *${name || 'Unknown'}* from *${company || 'Unknown'}*. Details below 👇`
      }
    },
    ...blocks
  ];

  await slack.chat.postMessage({ channel: channelId, text: `<@${CTA_USER}> ${fallbackText}`, blocks: ctaBlocks });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`[${new Date().toISOString()}] Running visitor agent...`);

  const state = loadState();

  const [rb2bChannelId, inboundChannelId, generalChannelId] = await Promise.all([
    getChannelId('rb2b-profiles'),
    getChannelId('inbound-leads'),
    getChannelId('general')
  ]);

  if (!rb2bChannelId) { console.error('Cannot find #rb2b-profiles — is the bot invited?'); return; }
  if (!inboundChannelId) { console.error('Cannot find #inbound-leads — is the bot invited?'); return; }

  const history = await slack.conversations.history({
    channel: rb2bChannelId,
    oldest: state.lastTimestamp,
    limit: 50
  });

  const allMessages = history.messages || [];
  console.log(`Raw messages: ${allMessages.length}, oldest cursor: ${state.lastTimestamp}`);
  allMessages.slice(0, 5).forEach(m => console.log(`  ts=${m.ts} text=${(m.text||'').slice(0,60)}`));

  const rb2bMessages = allMessages
    .filter(m =>
      m.bot_profile?.name?.toLowerCase().includes('rb2b') ||
      m.username?.toLowerCase().includes('rb2b') ||
      m.text?.toLowerCase().includes('first identified visiting') ||
      m.text?.toLowerCase().includes('pages on your site')
    )
    .reverse(); // process oldest first

  console.log(`Found ${rb2bMessages.length} new RB2B message(s)`);

  for (const message of rb2bMessages) {
    const visitor = parseRB2BMessage(message);
    console.log(`Processing: ${visitor.name} from ${visitor.company} | email: ${visitor.email}`);

    // Skip only if there is truly nothing to work with
    if (!visitor.email && !visitor.company) {
      console.log('  → Skipping: no email or company identified');
      state.lastTimestamp = String(parseFloat(message.ts) + 0.001);
      saveState(state);
      continue;
    }

    // Apollo lookup — email first, then name + company (only when name differs from company)
    let person = null;
    if (visitor.email) {
      person = await apolloMatchByEmail(visitor.email);
    }
    if (!person && visitor.name && visitor.company && visitor.name !== visitor.company) {
      person = await apolloSearchByName(visitor.name, visitor.company);
    }

    const apollo = {
      found: !!person,
      contactId: null, accountId: null,
      contactLabels: [], accountLabels: [],
      sequences: [], deals: [],
      noted: false
    };

    if (person) {
      // Use CRM contact ID if they're already in the account, otherwise create them
      let contactId = person.contact?.id;
      // account_id is reliably on the match response — capture it here
      let accountId = person.contact?.account_id || null;

      if (!contactId) {
        console.log(`  → Not in CRM, creating contact for ${visitor.name}`);
        const newContact = await createContact(visitor, person, accountId);
        contactId = newContact?.id;
        accountId = newContact?.account_id || accountId;
      }

      if (contactId) {
        // Fetch full contact + all labels in parallel
        const [contact, allLabels] = await Promise.all([
          getContactFull(contactId),
          getAllLabels()
        ]);

        const labelMap = Object.fromEntries((allLabels).map(l => [l.id, l.name]));
        // Prefer match-response account_id, fall back to contact fetch, then search by company name
        accountId = accountId || contact?.account_id;
        if (!accountId) {
          const companyName = visitor.company || person?.organization?.name;
          if (companyName) accountId = await findAccountByName(companyName);
        }

        // Active sequences only (exclude finished/removed)
        const sequences = (contact?.contact_campaign_statuses || [])
          .filter(s => !['finished', 'removed', 'stopped'].includes(s.status));

        // Add to "Website Visitors (RB2B)" list if not already on it
        const existingLabelIds = contact?.label_ids || [];
        if (!existingLabelIds.includes(WEB_VISITORS_LABEL_ID)) {
          await apolloClient.put(`/contacts/${contactId}`, {
            label_ids: [...existingLabelIds, WEB_VISITORS_LABEL_ID]
          }).catch(err => console.error('Add to web visitors list error:', err.response?.data?.error || err.message));
        }

        // Contact (people) lists
        const contactLabels = [...existingLabelIds, WEB_VISITORS_LABEL_ID]
          .filter((id, i, arr) => arr.indexOf(id) === i)
          .map(id => labelMap[id] || id);

        // Account details + deals — both keyed off accountId
        let accountLabels = [];
        let deals = [];
        if (accountId) {
          const [account, accountDeals] = await Promise.all([
            getAccountDetails(accountId),
            getDealsByAccount(accountId)
          ]);
          accountLabels = (account?.label_ids || []).map(id => labelMap[id] || id);
          deals = accountDeals;
        }

        // ── LinkedIn resolution
        const rb2bLinkedIn = normalizeLinkedInUrl(visitor.linkedin);
        const apolloLinkedIn = normalizeLinkedInUrl(contact?.linkedin_url);
        const rb2bValid = isValidLinkedInUrl(rb2bLinkedIn);
        const apolloValid = isValidLinkedInUrl(apolloLinkedIn);

        let resolvedLinkedIn = null;
        let linkedInSource = null; // 'rb2b' | 'apollo' | null

        if (rb2bValid && apolloValid && rb2bLinkedIn !== apolloLinkedIn) {
          // Both valid but different — trust RB2B (fresh signal), update Apollo
          resolvedLinkedIn = rb2bLinkedIn;
          linkedInSource = 'rb2b_updated';
          await updateContactLinkedIn(contactId, rb2bLinkedIn);
        } else if (rb2bValid) {
          resolvedLinkedIn = rb2bLinkedIn;
          linkedInSource = 'rb2b';
          if (!apolloValid) await updateContactLinkedIn(contactId, rb2bLinkedIn);
        } else if (apolloValid) {
          // RB2B URL was bad — fall back to Apollo's stored URL
          resolvedLinkedIn = apolloLinkedIn;
          linkedInSource = 'apollo';
          console.log(`  → Bad RB2B LinkedIn URL, using Apollo's: ${apolloLinkedIn}`);
        }

        apollo.contactId = contactId;
        apollo.accountId = accountId;
        apollo.contactLabels = contactLabels;
        apollo.accountLabels = accountLabels;
        apollo.sequences = sequences;
        apollo.deals = deals;
        apollo.linkedin = resolvedLinkedIn;
        apollo.linkedInSource = linkedInSource;
        apollo.noted = await logNote(contactId, visitor);
      }
    } else if (visitor.company) {
      // No contact found — tag the company account and pull account-level details
      const accountId = await findAccountByName(visitor.company);
      if (accountId) {
        const [account, allLabels, deals] = await Promise.all([
          getAccountDetails(accountId),
          getAllLabels(),
          getDealsByAccount(accountId)
        ]);
        const existingAccountLabelIds = account?.label_ids || [];
        if (!existingAccountLabelIds.includes(WEB_VISITORS_ACCOUNT_LABEL_ID)) {
          await apolloClient.put(`/accounts/${accountId}`, {
            label_ids: [...existingAccountLabelIds, WEB_VISITORS_ACCOUNT_LABEL_ID]
          }).catch(err => console.error('Add account to web visitors list error:', err.response?.data?.error || err.message));
        }
        const labelMap = Object.fromEntries(allLabels.map(l => [l.id, l.name]));
        const updatedLabelIds = [...new Set([...existingAccountLabelIds, WEB_VISITORS_ACCOUNT_LABEL_ID])];
        apollo.accountId = accountId;
        apollo.accountLabels = updatedLabelIds.map(id => labelMap[id] || id);
        apollo.accountWebsite = account?.website_url || null;
        apollo.accountLinkedin = account?.linkedin_url || null;
        apollo.deals = deals;
        console.log(`  → No contact found, tagged company account ${accountId} in Website Visitors list`);
      }
    }

    await postToInboundLeads(inboundChannelId, visitor, apollo);
    if (generalChannelId) await postToInboundLeads(generalChannelId, visitor, apollo);

    // React to the original RB2B message to confirm it was processed
    await slack.reactions.add({
      channel: rb2bChannelId,
      timestamp: message.ts,
      name: 'white_check_mark'
    }).catch(() => {}); // non-fatal if it fails

    state.lastTimestamp = String(parseFloat(message.ts) + 0.001);
    saveState(state);
  }

  console.log('Done.');
}

const POLL_INTERVAL_MINUTES = 5;

async function main() {
  await run();
  setInterval(() => run().catch(console.error), POLL_INTERVAL_MINUTES * 60 * 1000);
}

main().catch(console.error);
