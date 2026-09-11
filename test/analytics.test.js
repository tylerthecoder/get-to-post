import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('analytics removes sensitive URL state before loading the tracking script', async () => {
  const window = {};
  const scripts = [];
  const document = {
    createElement(tag) { assert.equal(tag, 'script'); return {}; },
    head: {
      appendChild(script) {
        assert.equal(window.vaq[0][0], 'beforeSend');
        scripts.push(script);
      },
    },
  };
  runInNewContext(await readFile(new URL('../public/analytics.js', import.meta.url), 'utf8'), { window, document, URL });
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].src, '/_vercel/insights/script.js');
  assert.equal(scripts[0].defer, true);

  const beforeSend = window.vaq[0][1];
  for (const path of ['/', '/builder', '/api/builder']) {
    const original = `https://www.postviaget.com${path}?state=encoded-secret&headers=secret#private`;
    const event = { type: 'pageview', url: original };
    const cleaned = beforeSend(event);
    assert.equal(cleaned.url, `https://www.postviaget.com${path}`);
    assert.equal(cleaned.type, 'pageview');
    assert.equal(event.url, original);
  }
  assert.equal(beforeSend({ type: 'pageview', url: 'https://www.postviaget.com/' }).url, 'https://www.postviaget.com/');
});
