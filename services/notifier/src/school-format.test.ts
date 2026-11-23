import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from './format.js';
import { formatSchool, parseSchool } from './school-format.js';

describe('school events', () => {
  it('renders important items with a mention and digests without', () => {
    const now = formatSchool(parseSchool({
      mode: 'now',
      items: [{ service: 'quercus', kind: 'grade', course: 'CSC207', title: 'Graded: A2 - 18/20', summary: 'A2 점수 공개', url: 'https://q.utoronto.ca/courses/1/assignments/2' }],
    }), '42424242');
    assert.match(now, /^<@42424242> \*\*📌 학교 새 소식\*\*/);
    assert.match(now, /📊 Quercus \[CSC207\] Graded: A2 - 18\/20/);
    assert.match(now, /<https:\/\/q\.utoronto\.ca\/courses\/1\/assignments\/2>/);
    const digest = formatSchool(parseSchool({ mode: 'digest', items: [{ service: 'piazza', kind: 'post', course: 'STA 256', title: '@12 question', summary: null, url: null }], more: 3 }), '42424242');
    assert.doesNotMatch(digest, /<@/);
    assert.match(digest, /외 3건/);
  });

  it('sends ordinary mail right away without a ping', () => {
    const out = formatSchool(parseSchool({
      mode: 'now', ping: false,
      items: [{ service: 'gmail', kind: 'email', course: null, title: 'Club: newsletter', summary: '동아리 소식', url: null }],
    }), '42424242');
    assert.match(out, /^\*\*📬 새 메일\*\*/);
    assert.doesNotMatch(out, /<@/);
    assert.throws(() => parseSchool({ mode: 'now', ping: 'yes', items: [{ service: 'outlook', kind: 'email', course: null, title: 't', summary: null, url: null }] }), ValidationError);
  });

  it('keeps text from school services plain: no mentions, links or markdown', () => {
    const out = formatSchool(parseSchool({
      mode: 'digest',
      items: [{ service: 'outlook', kind: 'email', course: null, title: '@everyone **click** [here](https://evil.example)', summary: '`code` <@1>', url: 'https://evil.example/x' }],
    }), null);
    assert.doesNotMatch(out, /@everyone/);
    assert.doesNotMatch(out, /\]\(https/);
    assert.doesNotMatch(out, /evil\.example\/x/); // only school hosts become links
    assert.doesNotMatch(out, /`/);
  });

  it('rejects unknown fields and services', () => {
    assert.throws(() => parseSchool({ mode: 'now', items: [{ service: 'acorn', kind: 'grade', course: null, title: 'x', summary: null, url: null }] }), ValidationError);
    assert.throws(() => parseSchool({ mode: 'now', items: [], extra: 1 }), ValidationError);
    assert.throws(() => parseSchool({ mode: 'later', items: [{ service: 'piazza', kind: 'post', course: null, title: 'x', summary: null, url: null }] }), ValidationError);
  });
});
