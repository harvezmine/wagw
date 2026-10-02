import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from '../src/utils/html.js';
import { renderMessagePage, renderQrPage } from '../src/views/sessionPages.js';

test('escapeHtml escapes markup characters', () => {
  assert.equal(escapeHtml(`<img src=x onerror="alert('x')">&`), '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;');
  assert.equal(escapeHtml(null), '');
});

test('session pages never render the session id unescaped', () => {
  const evil = '<script>alert(1)</script>';
  assert.ok(!renderQrPage(evil, 'data:image/png;base64,AAAA').includes(evil));
  assert.ok(!renderMessagePage(evil, { title: 'x', message: evil }).includes(evil));
});
