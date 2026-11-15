// Pure filter logic: no Google services here, so it runs under `node --test`.

// shortcut: Gmail doesn't document an exact criteria limit; 1,500 is a conservative guess. Gmail's own error still gets shown if it's lower.
const MAX_CRITERIA_CHARS = 1500;
const MAX_FILTERS = 1000;

const ACTIONS = {
  skipInbox: { title: 'Skip the inbox', remove: 'INBOX' },
  markRead: { title: 'Mark as read', remove: 'UNREAD' },
  star: { title: 'Star it', add: 'STARRED' },
  neverSpam: { title: 'Never send to spam', remove: 'SPAM' },
};

/** "Jane <jane@x.com>" -> "jane@x.com" */
function parseAddress(from) {
  const m = /<([^>]+)>/.exec(from || '');
  return (m ? m[1] : from || '').trim().toLowerCase();
}

function senderDomain(address) {
  return address.split('@')[1] || '';
}

// Criteria the forms can edit. Anything else on a filter (size, attachments, categories, forwarding,
// extra labels) is kept as-is, so editing never drops part of a filter the form doesn't show.
const EDITABLE_CRITERIA = ['from', 'to', 'subject', 'query', 'negatedQuery'];
const MANAGED_ADD = ['STARRED'];
const MANAGED_REMOVE = ['INBOX', 'UNREAD', 'SPAM'];
const isUserLabel = (id) => /^Label_/.test(id);

/**
 * Applies form values to a filter. base: existing filter ({} to create);
 * spec: {from?, to?, subject?, query?, negatedQuery?, actions: string[]}, where an undefined field is left alone;
 * labelId: the one editable user label, or null for none.
 */
function applyEdits(base, spec, labelId) {
  const criteria = Object.assign({}, base.criteria);
  EDITABLE_CRITERIA.forEach((k) => {
    if (spec[k] === undefined) return;
    if (spec[k]) criteria[k] = spec[k];
    else delete criteria[k];
  });

  const old = base.action || {};
  const oldUserLabel = (old.addLabelIds || []).find(isUserLabel);
  const add = labelId ? [labelId] : [];
  (old.addLabelIds || []).forEach((id) => {
    if (id !== oldUserLabel && !MANAGED_ADD.includes(id) && !add.includes(id)) add.push(id);
  });
  const remove = (old.removeLabelIds || []).filter((id) => !MANAGED_REMOVE.includes(id));
  spec.actions.forEach((key) => {
    const a = ACTIONS[key];
    if (a.add && !add.includes(a.add)) add.push(a.add);
    if (a.remove && !remove.includes(a.remove)) remove.push(a.remove);
  });

  const action = Object.assign({}, old);
  delete action.addLabelIds;
  delete action.removeLabelIds;
  if (add.length) action.addLabelIds = add;
  if (remove.length) action.removeLabelIds = remove;
  return { criteria, action };
}

function buildFilter(spec, labelId) {
  return applyEdits({}, spec, labelId);
}

/** The form values for an existing filter. */
function formValues(filter, labelNames) {
  const c = filter.criteria || {};
  const a = filter.action || {};
  const add = a.addLabelIds || [];
  const remove = a.removeLabelIds || [];
  const userLabel = add.find(isUserLabel);
  const values = { label: userLabel ? labelNames[userLabel] || '' : '', actions: [] };
  EDITABLE_CRITERIA.forEach((k) => (values[k] = c[k] || ''));
  Object.keys(ACTIONS).forEach((key) => {
    const x = ACTIONS[key];
    if ((x.add && add.includes(x.add)) || (x.remove && remove.includes(x.remove))) values.actions.push(key);
  });
  return values;
}

/** Returns a user-facing message, or null when the filter can be saved. */
function filterError(filter) {
  const c = filter.criteria || {};
  const a = filter.action || {};
  if (Object.keys(c).length === 0) return 'Fill in at least one condition, like From or Subject.';
  if (!(a.addLabelIds || []).length && !(a.removeLabelIds || []).length && !a.forward) {
    return 'Pick a label or at least one action.';
  }
  const length = EDITABLE_CRITERIA.reduce((n, k) => n + String(c[k] || '').length, 0);
  if (length > MAX_CRITERIA_CHARS) return 'The conditions are too long for a Gmail filter. Shorten them.';
  return null;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort();
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((o, k) => ((o[k] = canonical(value[k])), o), {});
  }
  return value;
}

function sameFilter(a, b) {
  const pick = (f) => JSON.stringify(canonical({ c: f.criteria || {}, a: f.action || {} }));
  return pick(a) === pick(b);
}

const SYSTEM_ACTION_TEXT = {
  'remove:INBOX': 'Skip inbox',
  'remove:UNREAD': 'Mark read',
  'add:STARRED': 'Star',
  'remove:SPAM': 'Never spam',
  'add:IMPORTANT': 'Mark important',
  'remove:IMPORTANT': 'Never important',
  'add:TRASH': 'Delete',
  'add:CATEGORY_PERSONAL': 'Primary tab',
  'add:CATEGORY_SOCIAL': 'Social tab',
  'add:CATEGORY_PROMOTIONS': 'Promotions tab',
  'add:CATEGORY_UPDATES': 'Updates tab',
  'add:CATEGORY_FORUMS': 'Forums tab',
};

/** "(*@a.com | b@c.com OR d@e.com)" -> ["@a.com", "b@c.com", "d@e.com"] */
function splitAlternatives(value) {
  return String(value)
    .replace(/^\s*\((.*)\)\s*$/, '$1')
    .split(/\s*(?:\||\bOR\b)\s*/)
    .map((s) => s.trim().replace(/^\*@/, '@'))
    .filter(Boolean);
}

/** [{name, values}] for each criterion the filter uses. */
function filterCriteria(filter) {
  const c = filter.criteria || {};
  const out = [];
  if (c.from) out.push({ name: 'From', values: splitAlternatives(c.from) });
  if (c.to) out.push({ name: 'To', values: splitAlternatives(c.to) });
  if (c.subject) out.push({ name: 'Subject', values: [c.subject] });
  if (c.query) out.push({ name: 'Has', values: splitAlternatives(c.query) });
  if (c.negatedQuery) out.push({ name: "Doesn't have", values: splitAlternatives(c.negatedQuery) });
  if (c.hasAttachment) out.push({ name: 'Has attachment', values: [] });
  return out;
}

/** Plain-language actions, e.g. ["Work", "Skip inbox"]. User labels show by name. */
function filterActions(filter, labelNames) {
  const a = filter.action || {};
  const out = [];
  (a.addLabelIds || []).forEach((id) => out.push(SYSTEM_ACTION_TEXT['add:' + id] || labelNames[id] || id));
  (a.removeLabelIds || []).forEach((id) => out.push(SYSTEM_ACTION_TEXT['remove:' + id] || 'Remove ' + (labelNames[id] || id)));
  if (a.forward) out.push('Forward to ' + a.forward);
  return out;
}

/** A Material icon name for what the filter mainly does. */
function filterIcon(filter) {
  const a = filter.action || {};
  const add = a.addLabelIds || [];
  const remove = a.removeLabelIds || [];
  if (add.some(isUserLabel)) return 'label';
  if (add.includes('TRASH')) return 'delete';
  if (add.includes('STARRED')) return 'star';
  if (remove.includes('INBOX')) return 'archive';
  if (remove.includes('SPAM')) return 'report_off';
  if (remove.includes('UNREAD')) return 'mark_email_read';
  if (a.forward) return 'forward_to_inbox';
  if (add.some((id) => /^CATEGORY_/.test(id))) return 'tab';
  return 'filter_alt';
}

const shorten = (s, max) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

/** Two short lines for a list row: what happens (title) and what it matches (subtitle). */
function summarizeFilter(filter, labelNames) {
  const when = filterCriteria(filter).map((c) => {
    if (!c.values.length) return c.name;
    const shown = c.values.slice(0, 2).map((v) => shorten(v, 40)).join(', ');
    return c.name + ': ' + shown + (c.values.length > 2 ? ' +' + (c.values.length - 2) + ' more' : '');
  });
  return {
    title: filterActions(filter, labelNames).join(' · ') || 'No action',
    subtitle: when.join(' · ') || 'Any email',
  };
}
