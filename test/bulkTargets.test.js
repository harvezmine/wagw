import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBulkTarget, parseTargets, renderTemplate } from '../src/services/bulkTargets.js';

test('parses Fonnte-style targets with names and variables', () => {
  assert.deepEqual(parseTargets('0811|Budi|VIP|Jakarta, 0812|Ani,, 120363@g.us'), [
    { number: '0811', name: 'Budi', vars: ['VIP', 'Jakarta'] },
    { number: '0812', name: 'Ani', vars: [] },
    { number: '120363@g.us', name: '', vars: [] }
  ]);
  assert.deepEqual(parseTargets(['0811|Budi', '0812']), [
    { number: '0811', name: 'Budi', vars: [] },
    { number: '0812', name: '', vars: [] }
  ]);
});

test('renders {name} and {varN}; missing values become empty', () => {
  const target = { name: 'Budi', vars: ['VIP'] };
  assert.equal(renderTemplate('Halo {name}, level {var1}{var2}! {other}', target), 'Halo Budi, level VIP! {other}');
});

test('detects requests that need the bulk path', () => {
  assert.equal(isBulkTarget('0811'), false);
  assert.equal(isBulkTarget(['0811']), false);
  assert.equal(isBulkTarget('0811,0812'), true);
  assert.equal(isBulkTarget('0811|Budi'), true);
  assert.equal(isBulkTarget(['0811', '0812']), true);
});
