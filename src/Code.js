// Card UI and Gmail API calls. Pure logic lives in filters.js.

const PAGE_SIZE = 20; // keeps each section well under the 100-widget card limit

// ---------- Contextual card: create a filter from the open email ----------

function onGmailMessage(e) {
  GmailApp.setCurrentMessageAccessToken(e.gmail.accessToken);
  const msg = GmailApp.getMessageById(e.gmail.messageId);
  return createFilterCard(msg.getFrom(), msg.getSubject());
}

function createFilterCard(from, subject) {
  const address = parseAddress(from);
  const domain = senderDomain(address);

  const fromSuggestions = CardService.newSuggestions().addSuggestion(address);
  if (domain) fromSuggestions.addSuggestion('@' + domain);

  const labelSuggestions = CardService.newSuggestions();
  userLabels().forEach((l) => labelSuggestions.addSuggestion(l.name));

  const actions = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.CHECK_BOX)
    .setFieldName('actions')
    .setTitle('Then');
  Object.keys(ACTIONS).forEach((key) => actions.addItem(ACTIONS[key].title, key, false));

  const section = CardService.newCardSection()
    .addWidget(
      CardService.newTextInput()
        .setFieldName('from')
        .setTitle('From')
        .setValue(address)
        .setHint(domain ? 'Use @' + domain + ' to match the whole domain' : '')
        .setSuggestions(fromSuggestions)
    )
    .addWidget(
      CardService.newTextInput()
        .setFieldName('subject')
        .setTitle('Subject contains')
        .setHint('Leave empty to match any subject')
        .setSuggestions(CardService.newSuggestions().addSuggestion(subject || ''))
    )
    .addWidget(
      CardService.newTextInput()
        .setFieldName('label')
        .setTitle('Apply label')
        .setHint('Pick one or type a new name')
        .setSuggestions(labelSuggestions)
    )
    .addWidget(actions)
    .addWidget(
      CardService.newTextButton()
        .setText('Create filter')
        .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
        .setOnClickAction(CardService.newAction().setFunctionName('onCreateFilter'))
    );

  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Create a filter from this email'))
    .addSection(section)
    .build();
}

function onCreateFilter(e) {
  const inputs = e.commonEventObject.formInputs || {};
  const values = (name) => (inputs[name] ? inputs[name].stringInputs.value : []);
  const spec = {
    from: (values('from')[0] || '').trim(),
    subject: (values('subject')[0] || '').trim(),
    label: (values('label')[0] || '').trim(),
    actions: values('actions'),
  };

  const invalid = filterError(spec);
  if (invalid) return notify(invalid);

  try {
    const existing = listFilters();
    if (existing.length >= MAX_FILTERS) {
      return notify('Gmail allows ' + MAX_FILTERS + ' filters and you have reached it. Delete one from the add-on homepage first.');
    }
    // Check duplicates before creating a label, so a duplicate leaves nothing behind.
    const existingLabel = spec.label && findLabel(spec.label);
    if (!spec.label || existingLabel) {
      const filter = buildFilter(spec, existingLabel ? existingLabel.id : null);
      if (existing.some((f) => sameFilter(f, filter))) return notify('You already have this exact filter.');
    }
    const labelId = spec.label ? (existingLabel || createLabel(spec.label)).id : null;
    Gmail.Users.Settings.Filters.create(buildFilter(spec, labelId), 'me');
    return notify('Filter created. It applies to new email.');
  } catch (err) {
    return notify('Gmail rejected the filter: ' + err.message);
  }
}

// ---------- Homepage: list and delete filters ----------

function onHomepage() {
  return filterListCard(0);
}

function filterListCard(page) {
  const filters = listFilters();
  const names = {};
  userLabels().forEach((l) => (names[l.id] = l.name));

  const pages = Math.max(1, Math.ceil(filters.length / PAGE_SIZE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = filters.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const section = CardService.newCardSection();
  if (filters.length === 0) {
    section.addWidget(CardService.newTextParagraph().setText('No filters yet. Open an email to create one.'));
  }
  slice.forEach((f) => {
    const text = describeFilter(f, names);
    section.addWidget(
      CardService.newDecoratedText()
        .setText(text)
        .setWrapText(true)
        .setButton(
          CardService.newTextButton()
            .setText('Delete')
            .setOnClickAction(
              CardService.newAction().setFunctionName('onDeleteFilter').setParameters({ id: f.id, text: text })
            )
        )
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

function onDeleteFilter(e) {
  const p = e.commonEventObject.parameters;
  const confirm = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Delete this filter?'))
    .addSection(
      CardService.newCardSection()
        .addWidget(CardService.newTextParagraph().setText(p.text))
        .addWidget(
          CardService.newButtonSet()
            .addButton(
              CardService.newTextButton()
                .setText('Delete')
                .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
                .setOnClickAction(CardService.newAction().setFunctionName('onConfirmDelete').setParameters({ id: p.id }))
            )
            .addButton(
              CardService.newTextButton()
                .setText('Cancel')
                .setOnClickAction(CardService.newAction().setFunctionName('onCancel'))
            )
        )
    )
    .build();
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().pushCard(confirm))
    .build();
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

function notify(text) {
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(text))
    .build();
}
