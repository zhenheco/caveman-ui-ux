// The blind evaluator prompt and schemas/blind.schema.json are two halves of one contract:
// the prompt tells the evaluator what to emit, the schema decides whether `caveman ingest`
// accepts it. They diverged once (uncertainties nesting, `note` vs `rationale`, a stray
// `report_locale`), which silently broke Stage C while every --no-llm test stayed green.
// These assertions are that missing proof surface.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { evaluatorPrompt, withEvaluatorIdentity } from '../lib/blind.mjs';
import { DIMENSIONS } from '../lib/scoring.mjs';
import { validateSubset } from '../lib/validate.mjs';

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BLIND_SCHEMA = JSON.parse(readFileSync(join(SKILL_ROOT, 'schemas', 'blind.schema.json'), 'utf8'));
const PLACEHOLDERS = ['screen_id', 'image_pixels', 'viewport', 'target_locale', 'report_locale', 'screenshot_path', 'profile_block'];

const SCREEN_ID = 'scr_0123456789ab';
const PAYLOAD = {
  screen_id: SCREEN_ID,
  viewport: { id: 'mobile', width: 375, height: 812, device_scale_factor: 2 },
  target_locale: 'zh-TW',
  report_locale: 'zh-TW',
  screenshot_path: `.caveman-ui-ux/runs/run_20260819T000000Z_abcdef/screens/${SCREEN_ID}/screenshot.png`,
  profile: 'generic',
  task_framing: null,
};
const STAGED = `/Users/example/.claude/state/caveman-ui-ux/blind/run_20260819T000000Z_abcdef/${SCREEN_ID}.png`;

const prompt = evaluatorPrompt(PAYLOAD, { screenshotAbsPath: STAGED });
const example = prompt.match(/```json\s*\n([\s\S]*?)```/)?.[1];

describe('blind prompt template', () => {
  test('every placeholder is substituted and none survives', () => {
    for (const key of PLACEHOLDERS) {
      assert.ok(!prompt.includes(`{{${key}}}`), `{{${key}}} was not substituted`);
    }
    assert.ok(!/\{\{[a-z_]+\}\}/.test(prompt), 'an unknown {{placeholder}} survived substitution');
  });

  test('the rendered prompt carries the staged screenshot path, not the project path', () => {
    assert.ok(prompt.includes(STAGED), 'the prompt must name the screenshot the evaluator should read');
    assert.ok(!prompt.includes(PAYLOAD.screenshot_path), 'the in-project screenshot path must not reach the evaluator');
  });

  test('the prompt ships exactly one JSON example', () => {
    assert.ok(example, 'no ```json example block found in the prompt');
    assert.equal((prompt.match(/```json/g) || []).length, 1, 'more than one JSON example invites the wrong shape');
  });

  test('the example validates against blind.schema.json once ingest stamps the identity', () => {
    const doc = JSON.parse(example);
    const stamped = withEvaluatorIdentity(doc, { evaluatorId: 'e1', runtimeHost: 'claude', model: 'test-model' });
    const result = validateSubset(BLIND_SCHEMA, stamped);
    assert.ok(
      result.valid,
      `the prompt's own example is not a valid blind response:\n  - ${result.errors.map((e) => `${e.path || '(root)'}: ${e.message}`).join('\n  - ')}`,
    );
  });

  test('the example emits only the four keys the evaluator owns', () => {
    const doc = JSON.parse(example);
    assert.deepEqual(
      Object.keys(doc).sort(),
      ['answers', 'confidence', 'dimensions', 'screen_id'],
      'the evaluator must not emit evaluator/_ingested_at/report_locale — ingest fills those in',
    );
  });

  test('uncertainties sits inside answers and dimensions use rationale', () => {
    const doc = JSON.parse(example);
    assert.ok(Array.isArray(doc.answers.uncertainties), 'answers.uncertainties must be the array');
    assert.equal(doc.uncertainties, undefined, 'uncertainties must not also sit at the top level');
    for (const { key } of DIMENSIONS) {
      const dimension = doc.dimensions[key];
      assert.ok(dimension, `example is missing dimension ${key}`);
      assert.equal(typeof dimension.rationale, 'string', `${key} must use "rationale"`);
      assert.equal(dimension.note, undefined, `${key} must not use "note" (that word belongs to evidence)`);
    }
  });

  test('the example obeys its own evidence rule: score <= 6 carries a screenshot region', () => {
    const doc = JSON.parse(example);
    for (const { key } of DIMENSIONS) {
      const dimension = doc.dimensions[key];
      if (dimension.score > 6) continue;
      const regions = dimension.evidence.filter((entry) => entry.type === 'screenshot_region');
      assert.ok(regions.length >= 1, `${key} scores ${dimension.score} but shows no screenshot_region evidence`);
      for (const region of regions) {
        assert.equal(region.screen_id, SCREEN_ID, `${key} evidence must reference the screen it was given`);
        for (const side of ['x', 'y', 'w', 'h']) {
          assert.equal(typeof region.box[side], 'number', `${key} evidence box.${side} must be a number`);
        }
      }
    }
  });

  test('the maintainer-only HTML comment never reaches the evaluator', () => {
    // blind-prompt.md opens with a 繁中 note for maintainers that names lib/blind.mjs and
    // references/{blind-protocol,rubric}.md — file-layout context ADR-002 forbids the
    // evaluator from having. evaluatorPrompt() must strip it before substituting.
    assert.ok(!prompt.includes('<!--'), 'an HTML comment survived into the rendered prompt');
    assert.ok(!prompt.includes('給維護者讀的'), 'the maintainer note reached the evaluator');
    assert.ok(!/references\//.test(prompt), 'the prompt must not name the skill\'s reference files');
    assert.ok(prompt.startsWith('# Blind first-impression evaluation'), 'the prompt must start at its own heading');
  });

  test('the prompt states the screenshot pixel size and the example agrees with it', () => {
    // A viewport of 375x812 at dsf 2 is a 750x1624 image. Two real evaluators disagreed about
    // which space to measure in, so the size must be stated and the example must match it.
    assert.match(prompt, /750 x 1624/, 'the prompt must state the image size in pixels');
    assert.match(prompt, /image's own pixels/, 'the prompt must name the coordinate space');
    const doc = JSON.parse(example);
    const boxes = Object.values(doc.dimensions)
      .flatMap((dimension) => dimension.evidence)
      .filter((item) => item.type === 'screenshot_region')
      .map((item) => item.box);
    assert.ok(boxes.length >= 6, 'the example should demonstrate several boxes');
    const maxRight = Math.max(...boxes.map((box) => box.x + box.w));
    const maxBottom = Math.max(...boxes.map((box) => box.y + box.h));
    assert.ok(maxRight <= 750 && maxBottom <= 1624, 'example boxes must fit the stated image');
    assert.ok(maxRight > 375, 'example boxes must be in image space, not CSS space');
  });

  test('the prompt states the blind prohibitions it depends on', () => {
    for (const needle of ['read any other file', 'cannot tell from this screen', 'confidence']) {
      assert.ok(prompt.toLowerCase().includes(needle.toLowerCase()), `prompt no longer states: ${needle}`);
    }
  });
});
