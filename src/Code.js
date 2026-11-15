// Card UI and Gmail API calls. Pure logic lives in filters.js; the popup pages live in manager.html.

const PAGE_SIZE = 20; // keeps each section well under the 100-widget card limit

// ScriptApp.getService().getUrl() returns an ID that 404s when called from the add-on, so the URL is set here.
// shortcut: this is the HEAD deployment's /dev URL (latest pushed code, editors only); switch to a versioned /exec URL when publishing.
const FULL_VIEW_URL = 'https://script.google.com/macros/s/AKfycbxi1gHaR5HU1UcOxmZWDXMKOePCxFp0MR1WYV0Aaek/dev';

// Text criteria besides From that the forms can edit.
const OTHER_FIELDS = {
  subject: 'And the subject contains',
  to: 'To',
  query: 'Has the words',
  negatedQuery: "Doesn't have",
};

const ADD_HINT = 'Use domain.com to select all emails from the domain, or mail@domain.com to add a particular email. Press Enter to add.';

// ---------- The filter form (create, new, edit) ----------
// Cards keep no state between clicks, so every action carries `ctx`: the senders so far and how to redraw the form.
// Typed values (subject, label, checkboxes) come back in formInputs and are redrawn as they were.

function onGmailMessage(e) {
  GmailApp.setCurrentMessageAccessToken(e.gmail.accessToken);
  const msg = GmailApp.getMessageById(e.gmail.messageId);
  const address = parseAddress(msg.getFrom());
  const domain = senderDomain(address);
  const subject = msg.getSubject() || '';
  const ctx = {
    senders: normalizeSender(address) ? [address] : [],
    subtitle: subject ? 'From “' + shorten(subject, 60) + '”' : 'From this email',
    subjectSuggestion: subject,
    suggestions: domain ? [{ label: 'Widen to ' + domain, value: '@' + domain, replace: address }] : [],
  };
  return filterFormCard(ctx, { subject: '', label: '', actions: [] }, []);
}

/** The quick "create from this email" form. Editing and blank new filters happen in the popup. */
function filterFormCard(ctx, v, messages) {
  const from = CardService.newCardSection().setHeader('From any of these' + (ctx.senders.length ? ' · ' + ctx.senders.length : ''));
  if (ctx.senders.length) {
    const chips = CardService.newChipList().setLayout(CardService.ChipListLayout.WRAPPED);
    ctx.senders.forEach((s, i) => {
      chips.addChip(
        CardService.newChip()
          .setLabel((isDomainSender(s) ? s.slice(1) : s) + '  ✕')
          .setIcon(icon(isDomainSender(s) ? 'domain' : 'person'))
          .setOnClickAction(formAction('onRemoveSender', ctx, { index: String(i) }))
      );
    });
    from.addWidget(chips);
  } else {
    from.addWidget(CardService.newTextParagraph().setText('<font color="#444746">No senders yet: matches email from anyone.</font>'));
  }

  const suggestions = ctx.suggestions.filter((x) => ctx.senders.indexOf(x.value) === -1);
  if (suggestions.length) {
    const chips = CardService.newChipList().setLayout(CardService.ChipListLayout.WRAPPED);
    suggestions.forEach((x) => {
      chips.addChip(
        CardService.newChip().setLabel(x.label).setIcon(icon('domain'))
          .setOnClickAction(formAction('onSuggestSender', ctx, { value: x.value, replace: x.replace }))
      );
    });
    from.addWidget(chips);
  }

  // No Add button: the field adds what's typed when you press Enter or leave it. The hints sit in its own small hint text.
  from.addWidget(
    CardService.newTextInput()
      .setFieldName('add')
      .setTitle(ctx.senders.length ? 'Add more' : 'Add address or domain')
      .setValue(v.add || '')
      .setHint(ADD_HINT)
      .setOnChangeAction(formAction('onAddSenders', ctx))
  );
  messages.forEach((m) => {
    const color = /^Skipped/.test(m) ? '#444746' : '#b3261e';
    from.addWidget(CardService.newTextParagraph().setText('<font color="' + color + '">' + escapeHtml(m) + '</font>'));
  });

  const subject = CardService.newTextInput().setFieldName('subject').setTitle('And the subject contains')
    .setValue(v.subject || '').setHint('Leave empty to match any subject');
  if (ctx.subjectSuggestion) subject.setSuggestions(CardService.newSuggestions().addSuggestion(ctx.subjectSuggestion));

  const labels = CardService.newSuggestions();
  userLabels().forEach((l) => labels.addSuggestion(l.name));
  const checks = CardService.newSelectionInput().setType(CardService.SelectionInputType.CHECK_BOX).setFieldName('actions');
  Object.keys(ACTIONS).forEach((key) => checks.addItem(ACTIONS[key].title, key, (v.actions || []).indexOf(key) !== -1));
  const then = CardService.newCardSection()
    .setHeader('Then')
    .addWidget(
      CardService.newTextInput().setFieldName('label').setTitle('Apply label').setValue(v.label || '')
        .setHint('Pick one or type a new name').setSuggestions(labels)
    )
    .addWidget(checks);

  // Short labels keep both footer buttons on one row in the narrow panel.
  const footer = CardService.newFixedFooter()
    .setPrimaryButton(filledButton('Create', formAction('onSaveFilter', ctx)))
    .setSecondaryButton(overlayButton('Expand', popupUrl({ view: 'new', from: ctx.senders.join(',') })));

  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Create a filter').setSubtitle(ctx.subtitle))
    .addSection(from)
    .addSection(CardService.newCardSection().addWidget(subject))
    .addSection(then)
    .setFixedFooter(footer)
    .build();
}

function formAction(fn, ctx, extra) {
  return CardService.newAction().setFunctionName(fn).setParameters(Object.assign({ ctx: JSON.stringify(ctx) }, extra || {}));
}

/** Reads the form back. Empty inputs are left out of formInputs, so a missing field means it's empty. */
function readForm(e) {
  const inputs = e.commonEventObject.formInputs || {};
  const value = (name) => ((inputs[name] ? inputs[name].stringInputs.value : [])[0] || '').trim();
  return { subject: value('subject'), label: value('label'), add: value('add'), actions: inputs.actions ? inputs.actions.stringInputs.value : [] };
}

function redraw(ctx, v, messages) {
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(filterFormCard(ctx, v, messages)))
    .build();
}

function onAddSenders(e) {
  const ctx = JSON.parse(e.commonEventObject.parameters.ctx);
  const v = readForm(e);
  if (!v.add) return redraw(ctx, v, []); // leaving an empty field isn't an error
  const r = parseSenders(v.add, ctx.senders);
  ctx.senders = ctx.senders.concat(r.added);
  v.add = r.bad.join(', '); // only what needs fixing stays in the field
  return redraw(ctx, v, r.messages);
}

function onRemoveSender(e) {
  const p = e.commonEventObject.parameters;
  const ctx = JSON.parse(p.ctx);
  ctx.senders.splice(Number(p.index), 1);
  return redraw(ctx, readForm(e), []);
}

function onSuggestSender(e) {
  const p = e.commonEventObject.parameters;
  const ctx = JSON.parse(p.ctx);
  // Widening to a domain replaces the address it came from and any other address at that domain.
  ctx.senders = ctx.senders.filter((s) => s !== p.replace && !(isDomainSender(p.value) && senderDomain(s) === p.value.slice(1)));
  if (ctx.senders.indexOf(p.value) === -1) ctx.senders.push(p.value);
  return redraw(ctx, readForm(e), []);
}

function onSaveFilter(e) {
  const ctx = JSON.parse(e.commonEventObject.parameters.ctx);
  const v = readForm(e);
  if (v.add) {
    // Text typed but not added yet: add it, or show why not.
    const r = parseSenders(v.add, ctx.senders);
    ctx.senders = ctx.senders.concat(r.added);
    v.add = r.bad.join(', ');
    if (r.bad.length) return redraw(ctx, v, r.messages);
  }
  try {
    return notify(saveFilter(null, { senders: ctx.senders, subject: v.subject, label: v.label, actions: v.actions }));
  } catch (err) {
    return notify(err.message);
  }
}

/**
 * Creates a filter, or replaces filter `id` (Gmail can't update filters in place).
 * spec.senders (an array), when given, becomes the From criterion.
 * The new version is created before the old one is deleted, so a failure never loses a filter.
 * Throws an Error whose message is safe to show the user.
 */
function saveFilter(id, spec) {
  const existing = listFilters();
  const base = id ? existing.find((f) => f.id === id) : {};
  if (!base) throw new Error('This filter no longer exists. Reload to refresh the list.');
  if (existing.length >= MAX_FILTERS) {
    throw new Error(
      id
        ? 'Gmail is at its 1,000-filter limit, and saving a change needs one free slot. Delete another filter first.'
        : 'Gmail allows 1,000 filters and you have reached it. Delete one first.'
    );
  }
  spec = Object.assign({}, spec);
  if (Array.isArray(spec.senders)) {
    spec.from = sendersToFrom(spec.senders, base.criteria && base.criteria.from);
    delete spec.senders;
  }

  // Check with a placeholder label first, so an invalid or duplicate filter never creates a new label.
  const label = spec.label ? findLabel(spec.label) : null;
  const draft = applyEdits(base, spec, spec.label ? (label ? label.id : 'Label_new') : null);
  const problem = filterError(draft);
  if (problem) throw new Error(problem);
  if (id && sameFilter(base, draft)) return 'Nothing changed.';
  if ((!spec.label || label) && existing.some((f) => f.id !== id && sameFilter(f, draft))) {
    throw new Error('You already have this exact filter.');
  }

  try {
    const labelId = spec.label ? (label || createLabel(spec.label)).id : null;
    Gmail.Users.Settings.Filters.create(applyEdits(base, spec, labelId), 'me');
  } catch (err) {
    throw new Error("Gmail didn't accept this filter: " + err.message);
  }
  if (!id) return 'Filter created. It applies to new email.';
  try {
    Gmail.Users.Settings.Filters.remove('me', id);
  } catch (err) {
    throw new Error('The new version is saved, but the old one could not be removed. Delete the old one by hand.');
  }
  return 'Filter updated.';
}

/** The parts of a filter the forms don't edit, in words. They're kept as they are on save. */
function keptParts(filter, names) {
  const c = filter.criteria || {};
  const a = filter.action || {};
  const otherCriteria = Object.keys(c)
    .filter((k) => EDITABLE_CRITERIA.indexOf(k) === -1)
    .reduce((o, k) => ((o[k] = c[k]), o), {});
  const managed = Object.keys(ACTIONS).map((k) => ACTIONS[k].add || ACTIONS[k].remove);
  const userLabel = (a.addLabelIds || []).find(isUserLabel);
  return {
    criteria: filterCriteria({ criteria: otherCriteria }).map((x) => x.name + (x.values.length ? ': ' + x.values.join(', ') : '')),
    actions: filterActions(
      {
        action: {
          addLabelIds: (a.addLabelIds || []).filter((x) => x !== userLabel && managed.indexOf(x) === -1),
          removeLabelIds: (a.removeLabelIds || []).filter((x) => managed.indexOf(x) === -1),
          forward: a.forward,
        },
      },
      names
    ),
  };
}

// ---------- Homepage: list, view and delete filters ----------

function onHomepage() {
  return filterListCard(0);
}

function labelNames() {
  const names = {};
  userLabels().forEach((l) => (names[l.id] = l.name));
  return names;
}

// Card text accepts a small HTML subset, so user-written filter text must be escaped.
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function filterListCard(page) {
  const names = labelNames();
  // Sorting by destination puts filters that file mail to the same place next to each other.
  const filters = listFilters()
    .map((f) => ({ id: f.id, icon: filterIcon(f), summary: summarizeFilter(f, names) }))
    .sort((a, b) => a.summary.title.localeCompare(b.summary.title));

  const pages = Math.max(1, Math.ceil(filters.length / PAGE_SIZE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = filters.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const section = CardService.newCardSection();
  if (filters.length === 0) {
    section.addWidget(decorated('filter_alt', '', 'No filters yet. Create one, or open an email to start from it.'));
  }
  slice.forEach((f, i) => {
    if (i > 0) section.addWidget(CardService.newDivider());
    section.addWidget(
      CardService.newDecoratedText()
        .setStartIcon(icon(f.icon))
        .setEndIcon(icon('chevron_right'))
        .setText(escapeHtml(f.summary.title))
        .setBottomLabel(escapeHtml(f.summary.subtitle))
        .setWrapText(true)
        .setOnClickAction(CardService.newAction().setFunctionName('onOpenFilter').setParameters({ id: f.id }))
    );
  });

  const card = CardService.newCardBuilder()
    .setHeader(
      CardService.newCardHeader()
        .setTitle('Your filters')
        .setSubtitle(filters.length + ' of ' + MAX_FILTERS + (pages > 1 ? ' · page ' + (page + 1) + ' of ' + pages : ''))
    )
    .addSection(section);

  if (pages > 1) {
    const nav = CardService.newButtonSet();
    if (page > 0) nav.addButton(pageButton('Previous', page - 1));
    if (page < pages - 1) nav.addButton(pageButton('Next', page + 1));
    card.addSection(CardService.newCardSection().addWidget(nav));
  }

  card.setFixedFooter(
    CardService.newFixedFooter()
      .setPrimaryButton(overlayButton('New filter', popupUrl({ view: 'new' }), true))
      .setSecondaryButton(overlayButton('Full view', popupUrl({})))
  );
  return card.build();
}

function pageButton(text, page) {
  return CardService.newTextButton()
    .setText(text)
    .setOnClickAction(CardService.newAction().setFunctionName('onPage').setParameters({ page: String(page) }));
}

function onPage(e) {
  const card = filterListCard(Number(e.commonEventObject.parameters.page));
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(card))
    .build();
}

function getFilter(id) {
  try {
    return Gmail.Users.Settings.Filters.get('me', id);
  } catch (err) {
    return null;
  }
}

function onOpenFilter(e) {
  const id = e.commonEventObject.parameters.id;
  const filter = getFilter(id);
  if (!filter) return notify('This filter no longer exists. Reload the add-on to refresh the list.');
  const names = labelNames();
  const summary = summarizeFilter(filter, names);
  const c = filter.criteria || {};
  const senders = sendersFromCriteria(c.from);

  const when = CardService.newCardSection().setHeader('When an email matches');
  if (senders && senders.length) {
    const chips = CardService.newChipList().setLayout(CardService.ChipListLayout.WRAPPED);
    senders.forEach((s) => chips.addChip(CardService.newChip().setLabel(isDomainSender(s) ? s.slice(1) : s).setIcon(icon(isDomainSender(s) ? 'domain' : 'person'))));
    when.addWidget(CardService.newTextParagraph().setText('<font color="#444746">From any of these · ' + senders.length + '</font>')).addWidget(chips);
  }
  const icons = { From: 'person', To: 'alternate_email', Subject: 'subject', Has: 'search', "Doesn't have": 'search_off' };
  filterCriteria(filter)
    .filter((x) => !(x.name === 'From' && senders))
    .forEach((x) => when.addWidget(decorated(icons[x.name] || 'attach_file', x.name, x.values.map(escapeHtml).join('<br>') || 'Yes')));

  const then = CardService.newCardSection().setHeader('Then');
  filterActions(filter, names).forEach((a) => then.addWidget(decorated('arrow_forward', '', escapeHtml(a))));

  const card = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle(summary.title).setSubtitle('Filter'))
    .addSection(when)
    .addSection(then)
    .setFixedFooter(
      CardService.newFixedFooter()
        .setPrimaryButton(overlayButton('Edit', popupUrl({ view: 'edit', id: id }), true))
        .setSecondaryButton(
          CardService.newTextButton()
            .setText('Delete')
            .setOnClickAction(
              CardService.newAction().setFunctionName('onDeleteFilter').setParameters({ id: id, text: summary.title + '\n' + summary.subtitle })
            )
        )
    )
    .build();
  return pushCard(card);
}

function onDeleteFilter(e) {
  const p = e.commonEventObject.parameters;
  const confirm = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Delete this filter?'))
    .addSection(
      CardService.newCardSection().addWidget(
        CardService.newTextParagraph().setText(escapeHtml(p.text).replace('\n', '<br>') + "<br><br>This can't be undone.")
      )
    )
    .setFixedFooter(
      CardService.newFixedFooter()
        .setPrimaryButton(
          filledButton('Delete', CardService.newAction().setFunctionName('onConfirmDelete').setParameters({ id: p.id })).setBackgroundColor('#b3261e')
        )
        .setSecondaryButton(CardService.newTextButton().setText('Cancel').setOnClickAction(CardService.newAction().setFunctionName('onCancel')))
    )
    .build();
  return pushCard(confirm);
}

function onConfirmDelete(e) {
  try {
    Gmail.Users.Settings.Filters.remove('me', e.commonEventObject.parameters.id);
  } catch (err) {
    return notify('Could not delete the filter: ' + err.message);
  }
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().popToRoot().updateCard(filterListCard(0)))
    .setNotification(CardService.newNotification().setText('Filter deleted.'))
    .build();
}

function onCancel() {
  return CardService.newActionResponseBuilder().setNavigation(CardService.newNavigation().popCard()).build();
}

// ---------- Popup pages (manager.html, opened as an overlay) ----------

function doGet() {
  const page = HtmlService.createTemplateFromFile('manager');
  page.shared = sharedSource();
  return page.evaluate().setTitle('Better Gmail Filters').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** The sender parsing code, sent to the popup page so the tag input there works instantly with the same rules. */
function sharedSource() {
  return [parseAddress, senderDomain, splitAlternatives, isDomainSender, senderLabel, normalizeSender, parseSenders]
    .map(String)
    .join('\n');
}

/** Popup URL for a view: {} = all filters, {view:'edit', id}, {view:'new', from:'a@x.com,@y.com'}. */
function popupUrl(params) {
  const query = Object.keys(params)
    .filter((k) => params[k])
    .map((k) => k + '=' + encodeURIComponent(params[k]))
    .join('&');
  return FULL_VIEW_URL + (query ? '?' + query : '');
}

/** Everything the popup needs in one call. */
function managerData() {
  const names = labelNames();
  return {
    labels: Object.keys(names).map((id) => names[id]).sort(),
    actions: Object.keys(ACTIONS).map((k) => ({ key: k, title: ACTIONS[k].title })),
    fields: OTHER_FIELDS,
    filters: listFilters().map((f) => {
      const senders = sendersFromCriteria((f.criteria || {}).from);
      return {
        id: f.id,
        icon: filterIcon(f),
        summary: summarizeFilter(f, names),
        senders: senders,
        criteria: filterCriteria(f).filter((x) => !(x.name === 'From' && senders)),
        values: formValues(f, names),
        kept: keptParts(f, names),
      };
    }),
  };
}

function managerSave(id, spec) {
  return saveFilter(id || null, spec);
}

function managerDelete(id) {
  Gmail.Users.Settings.Filters.remove('me', id);
  return 'Filter deleted.';
}

// ---------- Small card helpers ----------

function icon(name) {
  return CardService.newIconImage().setMaterialIcon(CardService.newMaterialIcon().setName(name));
}

function decorated(iconName, topLabel, html) {
  const w = CardService.newDecoratedText().setStartIcon(icon(iconName)).setText(html).setWrapText(true);
  if (topLabel) w.setTopLabel(topLabel);
  return w;
}

function filledButton(text, action) {
  return CardService.newTextButton().setText(text).setTextButtonStyle(CardService.TextButtonStyle.FILLED).setOnClickAction(action);
}

function overlayButton(text, url, filled) {
  return CardService.newTextButton()
    .setText(text)
    .setTextButtonStyle(filled ? CardService.TextButtonStyle.FILLED : CardService.TextButtonStyle.OUTLINED)
    .setOpenLink(
      CardService.newOpenLink().setUrl(url).setOpenAs(CardService.OpenAs.OVERLAY).setOnClose(CardService.OnClose.RELOAD_ADD_ON)
    );
}

function pushCard(card) {
  return CardService.newActionResponseBuilder().setNavigation(CardService.newNavigation().pushCard(card)).build();
}

function notify(text) {
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(text))
    .build();
}

// ---------- Gmail API helpers ----------

function listFilters() {
  return Gmail.Users.Settings.Filters.list('me').filter || [];
}

function userLabels() {
  return (Gmail.Users.Labels.list('me').labels || []).filter((l) => l.type === 'user');
}

function findLabel(name) {
  const lower = name.toLowerCase();
  return userLabels().find((l) => l.name.toLowerCase() === lower) || null;
}

function createLabel(name) {
  return Gmail.Users.Labels.create(
    { name: name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
    'me'
  );
}
