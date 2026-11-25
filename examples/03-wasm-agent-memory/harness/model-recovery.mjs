// @ts-check
import assert from 'node:assert/strict';

/**
 * Exercise the Retry model button in a fresh context. The offline run supplies only the embedding
 * worker transport. Relate, its indexes, the chat and the cache of typed turns are the actual app.
 * The live smoke interrupts the first request for the real pinned model, then lets the retry fetch it.
 * @param {import('playwright').BrowserContext} parent
 * @param {string} base
 * @param {{live?: boolean}} options
 */
export async function checkModelRecovery(parent, base, { live = false } = {}) {
  const browser = parent.browser();
  if (!browser) throw new Error('Browser required for the model recovery check');
  const ctx = await browser.newContext();
  try {
    let attempts = 0;
    let interrupted = false;
    if (live) {
      await ctx.route('https://huggingface.co/**', async (route) => {
        if (interrupted) return route.continue();
        interrupted = true;
        await route.abort('connectionfailed');
      });
    } else {
      // Substitute a known vector only to exercise the protocol and UI after retry.
      // The live smoke separately verifies actual inference for a novel paraphrase.
      await ctx.route('**/embed.worker.js', async (route) => {
        attempts++;
        await route.fulfill({
          contentType: 'text/javascript',
          body: attempts === 1
            ? "self.onmessage = ({data}) => self.postMessage({id:data.id, ok:false, error:'test download interrupted'});"
            : `self.onmessage = async ({data}) => {
                let result = {cached:false};
                if (data.op === 'embed') {
                  const file = await (await fetch('data/embeddings.json')).json();
                  result = data.texts.map(() => file.vectors['Tomás is away next week at a conference in Lisbon']);
                }
                self.postMessage({id:data.id, ok:true, result});
              };`,
        });
      });
    }
    const page = await ctx.newPage();
    await page.goto(`${base}?scenario=team&test=1&embed=live`);
    await page.waitForFunction(() => document.body.dataset.ready === '1');
    await page.evaluate(async () => {
      for (let i = 0; i < 3; i++) await /** @type {any} */ (window).ex03.next();
    });
    const saved = 'The registry lists the azimuth notebook.';
    const savedTurn = await page.evaluate((text) => /** @type {any} */ (window).ex03.send(text, 'save'), saved);
    const note = savedTurn.steps.find((/** @type {any} */ step) => step.tool === 'remember').memories[0];
    assert.equal(note.embedding, null);
    assert.equal(await page.locator('body').getAttribute('data-embed'), 'failed');
    assert.equal(await page.getByRole('button', { name: 'Retry model' }).isVisible(), true);
    const wordQuery = 'Where is the azimuth notebook?';
    const ask = (/** @type {string} */ text) => page.evaluate((t) => /** @type {any} */ (window).ex03.send(t, 'ask'), text);
    const checkWordHit = (/** @type {any} */ turn) => assert.ok(turn.steps[0].rows.some(
      (/** @type {any} */ hit) => hit.id === note.id && hit.by.includes('words')
    ), 'Word search finds the fallback note');
    checkWordHit(await ask(wordQuery));

    const capture = () => page.evaluate(() => {
      const { store, calls, cursor, lit } = /** @type {any} */ (window).ex03.state();
      return { store, calls, cursor, lit, transcript: document.getElementById('transcript')?.textContent };
    });
    const before = await capture();
    await page.locator('#retry-model').evaluate((el) => {
      const button = /** @type {HTMLButtonElement} */ (el);
      button.click();
      button.click();
    });
    await page.waitForFunction(() => document.body.dataset.embed === 'ready', null, { timeout: live ? 180000 : 15000 });
    assert.deepEqual(await capture(), before, 'Retry retains the store, transcript, cursor and selection');
    if (live) assert.ok(interrupted, 'Interrupted one cold model fetch');
    else assert.equal(attempts, 2, 'Double-clicking Retry started only one fresh worker');
    checkWordHit(await ask(wordQuery));
    const paraphrase = await ask('Is anybody travelling abroad soon?');
    assert.ok(paraphrase.steps[0].rows.some((/** @type {any} */ row) =>
      row.id === 'tomas-away' && row.by.includes('meaning')), 'A fresh question uses the recovered embedding path');
    assert.deepEqual((await capture()).store, before.store, 'Recovery and questions wrote no duplicate note');
  } finally {
    await ctx.close();
  }
}
