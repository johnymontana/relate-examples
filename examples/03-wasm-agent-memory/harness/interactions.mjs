// @ts-check
/** Additional browser journeys. The checks exercise the public controls on a fresh, offline page. */
import assert from 'node:assert/strict';

/** @param {import('playwright').Page} page @param {string} base */
export async function checkPlaygroundInteractions(page, base) {
  const state = () => page.evaluate(() => /** @type {any} */ (window).ex03.state());
  const idle = () => page.waitForFunction(() => document.body.dataset.busy === '0');
  const input = page.locator('#input');
  const dialog = page.locator('#discard-dialog');
  const detail = page.locator('#inspector');
  const reply = page.locator('#transcript .msg.agent').last();
  const result = page.locator('#result');
  const ledger = page.getByTestId('tab-ledger');
  const graph = page.getByTestId('tab-graph');
  const hood = page.getByTestId('tab-hood');

  /** @param {string} scenario @param {number|'all'} turns */
  async function open(scenario, turns = 0) {
    await page.goto(`${base}?scenario=${scenario}&test=1`);
    await page.waitForFunction(() => document.body.dataset.ready === '1');
    const n = turns === 'all' ? (await state()).steps : turns;
    for (let i = 0; i < n; i++) await page.evaluate(() => /** @type {any} */ (window).ex03.next());
  }
  /** @param {string} message @param {'ask'|'save'|'enter'} action */
  async function submit(message, action = 'ask') {
    await input.fill(message);
    const n = await page.locator('#transcript .msg.agent').count();
    if (action === 'enter') await input.press('Enter');
    else await page.locator(action === 'save' ? '#save-note' : '#send').click();
    await page.waitForFunction((before) => document.querySelectorAll('#transcript .msg.agent').length > before, n);
    await idle();
  }
  /** @param {string} statement */
  async function run(statement) {
    await hood.click();
    await page.locator('#cypher').fill(statement);
    const calls = (await state()).calls;
    await page.locator('#run').click();
    await page.waitForFunction((n) => /** @type {any} */ (window).ex03.state().calls > n, calls);
    await idle();
  }
  /** @param {import('playwright').Locator} control */
  const focused = (control) => control.evaluate((el) => el === document.activeElement);

  // The suggested Cypher write has a genuine prerequisite. Check it before any scripted data.
  await open('team');
  assert.match(await page.locator('#pane-graph').ariaSnapshot(), /Nothing remembered yet/);
  await hood.click();
  const forbidden = page.getByRole('button', { name: /An edge the shape forbids/ });
  assert.equal(await forbidden.isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: /A malformed memory/ }).isEnabled(), true);
  // Measure the actual text/background pairs in each theme, including the placeholder pseudo-element.
  for (let i = 0; i < 2; i++) {
    const ratios = await page.evaluate(() => {
      /** @param {string} color */
      function luminance(color) {
        const [r, g, b] = (color.match(/[\d.]+/g) ?? []).map(Number).map((c) => {
          const channel = c / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return r * 0.2126 + g * 0.7152 + b * 0.0722;
      }
      /** @param {string} fg @param {string} bg */
      function contrast(fg, bg) {
        const a = luminance(fg), b = luminance(bg);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      }
      const input = /** @type {HTMLElement} */ (document.querySelector('#input'));
      const number = /** @type {HTMLElement} */ (document.querySelector('#calls .n'));
      return [
        contrast(getComputedStyle(input, '::placeholder').color, getComputedStyle(input).backgroundColor),
        contrast(getComputedStyle(number).color, getComputedStyle(/** @type {HTMLElement} */ (number.closest('.calls'))).backgroundColor),
      ];
    });
    assert.ok(ratios.every((r) => r >= 4.5), 'input hint and statement number contrast');
    await page.locator('#theme').click();
  }
  await page.getByTestId('next').click();
  await idle();
  assert.equal(await forbidden.isEnabled(), true);
  await forbidden.click();
  const initial = (await state()).store;
  await page.locator('#run').click();
  await result.locator('.result-error').waitFor();
  assert.match(await result.innerText(), /ConstraintValidationFailed/);
  assert.deepEqual((await state()).store, initial);
  await graph.click();
  assert.doesNotMatch(await page.locator('#pane-graph').ariaSnapshot(), /Nothing remembered yet/);

  // Move through the tablist and ledger using only the keyboard. The same fact appears under two entities.
  await graph.press('ArrowRight');
  assert.equal(await focused(ledger), true);
  await page.keyboard.press('Tab');
  const lead = page.locator('button.mem[data-memory="lead"]').first();
  // A focusable panel may precede its controls. Follow normal Tab order to the exact row.
  for (let i = 0; i < 8 && !(await focused(lead)); i++) await page.keyboard.press('Tab');
  assert.equal(await focused(lead), true, 'Tab reaches the first ledger entry for Priya’s fact');
  await page.keyboard.press('Enter');
  await detail.waitFor();
  assert.match(await detail.innerText(), /Priya leads the checkout rewrite/);
  assert.match(await detail.innerText(), /We're starting the checkout rewrite/);
  assert.match(await detail.innerText(), /Monday · kickoff/);
  await page.keyboard.press('Escape');
  assert.equal(await focused(lead), true, 'closing the inspector restores the same ledger entry');

  await open('team', 'all');
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 640 }]) {
    await page.setViewportSize(viewport);
    const citation = page.locator('button.cite[data-memory="lead"]').first();
    await citation.click();
    assert.deepEqual((await state()).drawn.selectedMemories, ['lead']);
    assert.match(await page.locator('#caption-text').innerText(), /Priya/);
    const heading = detail.locator('h3');
    const rect = await heading.boundingBox();
    assert.ok(rect && rect.y >= 0 && rect.y + rect.height <= viewport.height, 'the selected fact is on screen');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'no page-level horizontal scroll');
    await detail.getByRole('button', { name: /Return to reply/i }).click();
    assert.equal(await focused(citation), true);
    await citation.click();
    await page.locator('#caption-clear').click();
    const dana = page.locator('button.cite[data-memory="owner-dana"]').first();
    await dana.click();
    assert.match(await page.locator('#caption-text').innerText(), /Dana/);
    assert.deepEqual((await state()).drawn.selectedMemories, ['owner-dana']);
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1360, height: 860 });

  // These exact prompts were previously routed to a write by their punctuation and wording.
  const beforeAsk = (await state()).store;
  const digestPrompt = 'Catch me up on the checkout rewrite.';
  await submit(digestPrompt, 'enter');
  assert.deepEqual((await state()).store, beforeAsk);
  assert.equal((await state()).last.steps[0].tool, 'recall');
  await submit('How do you know Dana is on holiday?');
  assert.match(await reply.innerText(), /Dana owns the payments service/);
  assert.doesNotMatch(await reply.innerText(), /You told me/i);
  await submit('Who owns the payments service?');
  assert.equal((await state()).last.steps[0].rows.length, 6);
  assert.match(await reply.innerText(), /Dana owns the payments service/);
  const related = reply.locator('details.related');
  assert.equal(await related.getAttribute('open'), null);
  const primary = await reply.evaluate((el) => [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join(''));
  assert.doesNotMatch(primary, /CockroachDB/);
  assert.match(await related.locator('summary').innerText(), /Related context/);
  await related.locator('summary').click();
  assert.match(await related.innerText(), /CockroachDB/);
  await submit(digestPrompt, 'save');
  assert.equal((await state()).stored.memories, 8);
  const saved = (await state()).store;
  const count = await page.locator('#transcript .msg.agent').count();
  await input.fill('draft');
  await page.locator('#scenarios [data-id="team"]').click();
  assert.deepEqual((await state()).store, saved);
  assert.equal(await dialog.isVisible(), false);
  for (const action of [page.locator('#restart'), page.locator('#scenarios [data-id="trip"]')]) {
    await action.click();
    await dialog.getByRole('button', { name: 'Keep working' }).click();
    await idle();
    assert.deepEqual((await state()).store, saved);
    assert.equal(await input.inputValue(), 'draft');
    assert.equal(await page.locator('#transcript .msg.agent').count(), count);
    assert.equal(new URL(page.url()).searchParams.get('scenario'), 'team');
  }

  // The staged suggestions become available only after their actual note has been stored.
  await open('trip', 'all');
  const askMuseum = page.locator('#chips button').filter({ hasText: 'Any sightseeing plans?' });
  const addMuseum = page.locator('#chips button').filter({ hasText: 'Maya wants to see the tile museum' });
  assert.equal(await askMuseum.isDisabled(), true);
  await submit('Any sightseeing plans?');
  assert.doesNotMatch(await reply.innerText(), /tile museum/i);
  await addMuseum.click();
  await idle();
  assert.equal(await askMuseum.isEnabled(), true);
  await askMuseum.click();
  await idle();
  assert.match(await reply.innerText(), /Maya wants to see the tile museum/);

  // Adding an independent note and replacing a belief are different operations.
  const vegan = 'Maya is vegan now and no longer eats any animal products.';
  await open('trip', 3);
  await submit(vegan, 'save');
  await page.getByTestId('next').click();
  await idle();
  assert.ok((await reply.innerText()).includes(vegan), 'the dinner answer surfaces the visitor note returned by recall');
  await open('trip', 3);
  await ledger.click();
  await page.locator('button.mem[data-memory="maya-diet"]').first().click();
  await detail.getByRole('button', { name: 'Replace this memory' }).click();
  await detail.locator('#replacement-text').fill(vegan);
  const beforeCorrection = (await state()).store;
  await detail.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.deepEqual((await state()).store, beforeCorrection);
  await detail.getByRole('button', { name: 'Replace this memory' }).click();
  await detail.locator('#replacement-text').fill(vegan);
  await detail.getByRole('button', { name: 'Save replacement' }).click();
  await page.waitForFunction(() => /** @type {any} */ (window).ex03.state().stored.superseded === 1);
  await page.getByTestId('next').click();
  await idle();
  assert.ok((await reply.innerText()).includes(vegan));

  await open('code', 'all');
  const codingPrompt = 'Add a test for the login flow in the auth module.';
  const codeStore = (await state()).store;
  await submit(codingPrompt, 'enter');
  assert.deepEqual((await state()).store, codeStore);
  await submit(codingPrompt, 'save');
  assert.equal((await state()).last.steps.at(-1).tool, 'remember');
  const wikiNote = 'Kenji uses [[Mural]] for planning.';
  await submit(wikiNote, 'save');
  await submit('What does Kenji use for planning?');
  assert.ok((await reply.innerText()).includes(wikiNote));
  assert.equal(await reply.locator('.cite.missing').count(), 0);
  await reply.locator('button.cite').first().click();
  assert.ok((await detail.innerText()).includes(wikiNote));
  const selectedNote = (await state()).drawn.selectedMemories;
  await run('RETURN 42 AS answer');
  await graph.click();
  assert.deepEqual((await state()).drawn.selectedMemories, selectedNote);
  assert.ok((await detail.innerText()).includes(wikiNote), 'an unrelated scalar query preserves the citation detail');

  // Page through the original result. The call count also catches accidental re-execution of writes.
  for (const rows of [0, 1, 100, 101]) {
    await run(rows === 0 ? "MATCH (m:Memory {id:'absent'}) RETURN m.id AS n" : `UNWIND range(1, ${rows}) AS n RETURN n AS n ORDER BY n`);
    assert.equal(await result.getAttribute('data-state'), 'ok');
    assert.equal(await result.locator('table.rows td').count(), Math.min(100, rows));
  }
  const calls = (await state()).calls;
  await result.getByRole('button', { name: 'Next page' }).click();
  assert.equal((await result.locator('table.rows td').allTextContents()).join(), '101');
  await result.getByRole('button', { name: 'Previous page' }).click();
  assert.equal(await result.locator('table.rows td').count(), 100);
  assert.equal((await state()).calls, calls);
  for (const statement of ['RETURN 42 AS answer', "MATCH (m:Memory {id:'absent'}) RETURN m AS m", 'RETURN (']) {
    await run('MATCH (e:Entity) RETURN e AS e LIMIT 1');
    await run(statement);
    await graph.click();
    assert.equal(await page.locator('#caption').isVisible(), false, 'a new scalar, empty or refused result retires the console caption');
  }

  // A property edit changes no node count, but still marks the experiment as visitor-edited.
  await open('team', 3);
  const n = (await state()).store.nodes;
  await run("MATCH (m:Memory {id:'lead'}) SET m.text = 'Dana leads the checkout rewrite' RETURN m.text AS text");
  assert.equal((await state()).store.nodes, n);
  await page.locator('#restart').click();
  await dialog.getByRole('button', { name: 'Keep working' }).click();
  await idle();
  await page.getByTestId('next').click();
  await idle();
  assert.match(await reply.innerText(), /Dana leads the checkout rewrite/);
  assert.doesNotMatch(await reply.innerText(), /Priya leads it/);
}
