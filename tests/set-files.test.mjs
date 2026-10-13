import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createSetFilesAcrossFrames,
  normalizeSetFilesBody,
  SetFilesError,
} from '../scripts/set-files.mjs';

function documentNode(nodeId, documentURL) {
  return { nodeId, nodeType: 9, documentURL, children: [] };
}

function createMock({ matches = {}, includeSecondFrame = false, queryErrors = {}, staleTargets = [] } = {}) {
  const calls = [];
  const targetInfos = [
    { targetId: 'PAGE', type: 'page', url: 'https://app.example.test' },
    { targetId: 'FRAME_A', type: 'iframe', url: 'https://upload.example.test/form', parentId: 'PAGE' },
    { targetId: 'OTHER_PAGE', type: 'page', url: 'https://other.example.test' },
    { targetId: 'OTHER_FRAME', type: 'iframe', url: 'https://upload.example.test/unrelated', parentId: 'OTHER_PAGE' },
  ];
  if (includeSecondFrame) {
    targetInfos.push({ targetId: 'FRAME_B', type: 'iframe', url: 'https://upload.example.test/second', parentId: 'FRAME_A' });
  }

  const roots = {
    SID_PAGE: documentNode(1, 'https://app.example.test'),
    SID_FRAME_A: documentNode(2, 'https://upload.example.test/form'),
    SID_FRAME_B: documentNode(3, 'https://upload.example.test/second'),
    SID_OTHER_FRAME: documentNode(4, 'https://upload.example.test/unrelated'),
  };

  async function sendCDP(method, params, sessionId) {
    calls.push({ method, params, sessionId });
    if (method === 'Target.getTargets') return { result: { targetInfos } };
    if (method === 'DOM.enable') return { result: {} };
    if (method === 'DOM.getDocument') return { result: { root: roots[sessionId] } };
    if (method === 'DOM.querySelectorAll') {
      const error = queryErrors[`${sessionId}:${params.nodeId}`];
      if (error) return { error: { message: error } };
      return { result: { nodeIds: matches[`${sessionId}:${params.nodeId}`] || [] } };
    }
    if (method === 'DOM.setFileInputFiles') return { result: {} };
    throw new Error(`Unexpected method: ${method}`);
  }

  async function ensureSession(targetId) {
    if (staleTargets.includes(targetId)) throw new Error('No target with given id found');
    return {
      PAGE: 'SID_PAGE',
      FRAME_A: 'SID_FRAME_A',
      FRAME_B: 'SID_FRAME_B',
      OTHER_FRAME: 'SID_OTHER_FRAME',
    }[targetId];
  }

  return {
    calls,
    setFiles: createSetFilesAcrossFrames({ sendCDP, ensureSession }),
  };
}

async function withTempFile(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-access-set-files-'));
  const file = path.join(dir, 'fixture.txt');
  fs.writeFileSync(file, 'fixture');
  try {
    return await callback(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('normalizeSetFilesBody resolves, validates, and deduplicates files', async () => {
  await withTempFile(file => {
    const body = normalizeSetFilesBody({
      selector: ' input[type=file] ',
      files: [file, file],
      frameUrl: ' upload.example.test ',
      frameIndex: 0,
    });
    assert.equal(body.selector, 'input[type=file]');
    assert.deepEqual(body.files, [file]);
    assert.equal(body.frameUrl, 'upload.example.test');
    assert.equal(body.frameIndex, 0);
  });
});

test('normalizeSetFilesBody rejects missing files and invalid frameIndex', () => {
  assert.throws(
    () => normalizeSetFilesBody({ selector: 'input', files: ['/missing/file'] }),
    error => error instanceof SetFilesError && error.statusCode === 400,
  );
  assert.throws(
    () => normalizeSetFilesBody({ selector: 'input', files: ['x'], frameIndex: -1 }, () => ({ isFile: () => true })),
    error => error instanceof SetFilesError && error.statusCode === 400,
  );
});

test('uploads to a single top-level file input', async () => {
  await withTempFile(async file => {
    const { calls, setFiles } = createMock({ matches: { 'SID_PAGE:1': [11] } });
    const result = await setFiles('PAGE', { selector: 'input[type=file]', files: [file] });
    assert.equal(result.context, 'page');
    assert.equal(result.targetId, 'PAGE');
    const upload = calls.find(call => call.method === 'DOM.setFileInputFiles');
    assert.equal(upload.sessionId, 'SID_PAGE');
    assert.equal(upload.params.nodeId, 11);
  });
});

test('uploads to an OOPIF owned by the requested page', async () => {
  await withTempFile(async file => {
    const { calls, setFiles } = createMock({ matches: { 'SID_FRAME_A:2': [21] } });
    const result = await setFiles('PAGE', {
      selector: 'input[type=file]',
      files: [file],
      frameUrl: 'upload.example.test',
    });
    assert.equal(result.context, 'iframe');
    assert.equal(result.targetId, 'FRAME_A');
    const upload = calls.find(call => call.method === 'DOM.setFileInputFiles');
    assert.equal(upload.sessionId, 'SID_FRAME_A');
  });
});

test('never scans an iframe outside the requested page target hierarchy', async () => {
  await withTempFile(async file => {
    const { calls, setFiles } = createMock({ matches: { 'SID_FRAME_A:2': [21] } });
    await setFiles('PAGE', {
      selector: 'input[type=file]',
      files: [file],
      frameUrl: 'upload.example.test',
    });
    assert.equal(calls.some(call => call.sessionId === 'SID_OTHER_FRAME'), false);
  });
});

test('refuses ambiguous matches before changing any input', async () => {
  await withTempFile(async file => {
    const { calls, setFiles } = createMock({
      matches: { 'SID_PAGE:1': [11], 'SID_FRAME_A:2': [21] },
    });
    await assert.rejects(
      setFiles('PAGE', { selector: 'input[type=file]', files: [file] }),
      error => error instanceof SetFilesError && error.statusCode === 409,
    );
    assert.equal(calls.some(call => call.method === 'DOM.setFileInputFiles'), false);
  });
});

test('frameIndex selects a deterministic candidate within the requested page', async () => {
  await withTempFile(async file => {
    const { calls, setFiles } = createMock({
      includeSecondFrame: true,
      matches: { 'SID_FRAME_A:2': [21], 'SID_FRAME_B:3': [31] },
    });
    const result = await setFiles('PAGE', {
      selector: 'input[type=file]',
      files: [file],
      frameUrl: 'upload.example.test',
      frameIndex: 1,
    });
    assert.equal(result.targetId, 'FRAME_B');
    const upload = calls.find(call => call.method === 'DOM.setFileInputFiles');
    assert.equal(upload.sessionId, 'SID_FRAME_B');
    assert.equal(upload.params.nodeId, 31);
  });
});

test('reports an invalid selector instead of treating it as a missing element', async () => {
  await withTempFile(async file => {
    const { setFiles } = createMock({ queryErrors: { 'SID_PAGE:1': 'DOM Error while querying' } });
    await assert.rejects(
      setFiles('PAGE', { selector: '[', files: [file] }),
      error => error instanceof SetFilesError && error.statusCode === 400 && /无效 selector/.test(error.message),
    );
  });
});

test('skips an OOPIF that disappears after target discovery', async () => {
  await withTempFile(async file => {
    const { calls, setFiles } = createMock({
      includeSecondFrame: true,
      staleTargets: ['FRAME_A'],
      matches: { 'SID_FRAME_B:3': [31] },
    });
    const result = await setFiles('PAGE', {
      selector: 'input[type=file]',
      files: [file],
      frameUrl: 'upload.example.test',
    });
    assert.equal(result.targetId, 'FRAME_B');
    const upload = calls.find(call => call.method === 'DOM.setFileInputFiles');
    assert.equal(upload.sessionId, 'SID_FRAME_B');
  });
});
