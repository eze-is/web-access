import fs from 'node:fs';
import path from 'node:path';

export class SetFilesError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'SetFilesError';
    this.statusCode = statusCode;
  }
}

export function normalizeSetFilesBody(body, statSync = fs.statSync) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new SetFilesError(400, 'POST body 必须是 JSON 对象');
  }
  if (typeof body.selector !== 'string' || !body.selector.trim()) {
    throw new SetFilesError(400, '需要非空 selector 字段');
  }
  if (!Array.isArray(body.files) || body.files.length === 0 ||
      !body.files.every(file => typeof file === 'string' && file.trim())) {
    throw new SetFilesError(400, 'files 必须是非空文件路径数组');
  }

  const files = [...new Set(body.files.map(file => path.resolve(file)))];
  for (const file of files) {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      throw new SetFilesError(400, `文件不存在: ${file}`);
    }
    if (!stat.isFile()) {
      throw new SetFilesError(400, `不是普通文件: ${file}`);
    }
  }

  const frameIndex = body.frameIndex == null ? null : Number(body.frameIndex);
  if (frameIndex != null && (!Number.isInteger(frameIndex) || frameIndex < 0)) {
    throw new SetFilesError(400, 'frameIndex 必须是非负整数');
  }

  return {
    selector: body.selector.trim(),
    files,
    frameUrl: typeof body.frameUrl === 'string' ? body.frameUrl.trim() : '',
    frameIndex,
  };
}

function unwrapResult(response, method) {
  if (response?.error) {
    throw new Error(`${method} 失败: ${response.error.message || JSON.stringify(response.error)}`);
  }
  return response?.result || {};
}

function isTransientFrameError(error) {
  return /No target with given id|Session with given id not found|Target closed|detached|not attached/i
    .test(error?.message || '');
}

function collectSearchRoots(node, inheritedUrl = '', roots = [], seen = new Set()) {
  if (!node || seen.has(node.nodeId)) return roots;
  seen.add(node.nodeId);

  const url = node.documentURL || inheritedUrl;
  if (node.nodeType === 9 || node.shadowRootType) {
    roots.push({ nodeId: node.nodeId, url });
  }

  if (node.contentDocument) collectSearchRoots(node.contentDocument, url, roots, seen);
  for (const shadowRoot of node.shadowRoots || []) {
    collectSearchRoots(shadowRoot, url, roots, seen);
  }
  for (const child of node.children || []) {
    collectSearchRoots(child, url, roots, seen);
  }
  return roots;
}

function isTargetDescendantOf(targetInfo, pageTargetId, targetsById) {
  const seen = new Set([targetInfo.targetId]);
  let parentId = targetInfo.parentId || targetInfo.parentFrameId;
  while (parentId && !seen.has(parentId)) {
    if (parentId === pageTargetId) return true;
    seen.add(parentId);
    const parent = targetsById.get(parentId);
    if (!parent) return false;
    parentId = parent.parentId || parent.parentFrameId;
  }
  return false;
}

async function findCandidatesInSession({
  sendCDP,
  sessionId,
  selector,
  frameUrl,
  targetId,
  context,
  defaultUrl,
  order,
}) {
  unwrapResult(await sendCDP('DOM.enable', {}, sessionId), 'DOM.enable');
  const documentResponse = await sendCDP(
    'DOM.getDocument',
    { depth: -1, pierce: true },
    sessionId,
  );
  const root = unwrapResult(documentResponse, 'DOM.getDocument').root;
  if (!root?.nodeId) return [];

  const candidates = [];
  for (const searchRoot of collectSearchRoots(root, defaultUrl)) {
    const url = searchRoot.url || defaultUrl;
    if (frameUrl && !url.includes(frameUrl)) continue;

    const queryResponse = await sendCDP(
      'DOM.querySelectorAll',
      { nodeId: searchRoot.nodeId, selector },
      sessionId,
    );
    if (queryResponse?.error) {
      const detail = queryResponse.error.message || JSON.stringify(queryResponse.error);
      if (/selector|query/i.test(detail)) {
        throw new SetFilesError(400, `无效 selector: ${selector}（${detail}）`);
      }
      throw new Error(`DOM.querySelectorAll 失败: ${detail}`);
    }
    const nodeIds = (queryResponse?.result || {}).nodeIds || [];
    for (const nodeId of nodeIds) {
      candidates.push({
        targetId,
        sessionId,
        nodeId,
        context,
        frameUrl: url,
        order,
      });
    }
  }
  return candidates;
}

export function createSetFilesAcrossFrames({ sendCDP, ensureSession }) {
  return async function setFilesAcrossFrames(pageTargetId, rawBody) {
    if (typeof pageTargetId !== 'string' || !pageTargetId) {
      throw new SetFilesError(400, '需要 target 参数');
    }
    const body = normalizeSetFilesBody(rawBody);
    const pageSessionId = await ensureSession(pageTargetId);

    const targetsResponse = await sendCDP('Target.getTargets');
    const targetInfos = unwrapResult(targetsResponse, 'Target.getTargets').targetInfos || [];
    const pageInfo = targetInfos.find(info => info.targetId === pageTargetId && info.type === 'page');
    if (!pageInfo) {
      throw new SetFilesError(404, `未找到页面 target: ${pageTargetId}`);
    }

    const candidates = await findCandidatesInSession({
      sendCDP,
      sessionId: pageSessionId,
      selector: body.selector,
      frameUrl: body.frameUrl,
      targetId: pageTargetId,
      context: 'page',
      defaultUrl: pageInfo.url || '',
      order: -1,
    });

    const targetsById = new Map(targetInfos.map(info => [info.targetId, info]));
    const oopifTargets = targetInfos
      .filter(info => info.type === 'iframe' && isTargetDescendantOf(info, pageTargetId, targetsById))
      .sort((a, b) =>
        (a.url || '').localeCompare(b.url || '') || a.targetId.localeCompare(b.targetId));

    for (const [index, info] of oopifTargets.entries()) {
      const url = info.url || '';
      if (body.frameUrl && !url.includes(body.frameUrl)) continue;

      try {
        const sessionId = await ensureSession(info.targetId);
        candidates.push(...await findCandidatesInSession({
          sendCDP,
          sessionId,
          selector: body.selector,
          frameUrl: body.frameUrl,
          targetId: info.targetId,
          context: 'iframe',
          defaultUrl: url,
          order: index,
        }));
      } catch (error) {
        // OOPIF 可能在枚举后导航或销毁；跳过失效 target，继续检查同一页面的其他候选。
        if (!isTransientFrameError(error)) throw error;
      }
    }

    candidates.sort((a, b) => a.order - b.order);
    if (candidates.length === 0) {
      const scope = body.frameUrl
        ? `URL 包含 ${body.frameUrl} 的页面 frame`
        : '主文档及其 iframe';
      throw new SetFilesError(404, `未在${scope}找到元素: ${body.selector}`);
    }

    let chosen;
    if (body.frameIndex != null) {
      chosen = candidates[body.frameIndex];
      if (!chosen) {
        throw new SetFilesError(
          400,
          `frameIndex ${body.frameIndex} 超出候选范围（共 ${candidates.length} 个）`,
        );
      }
    } else if (candidates.length === 1) {
      chosen = candidates[0];
    } else {
      const summary = candidates.map(({ context, frameUrl: url }) => ({ context, url }));
      throw new SetFilesError(
        409,
        `找到 ${candidates.length} 个匹配文件控件，请提供 frameUrl 或 frameIndex: ${JSON.stringify(summary)}`,
      );
    }

    unwrapResult(await sendCDP(
      'DOM.setFileInputFiles',
      { nodeId: chosen.nodeId, files: body.files },
      chosen.sessionId,
    ), 'DOM.setFileInputFiles');

    return {
      success: true,
      files: body.files.length,
      targetId: chosen.targetId,
      context: chosen.context,
      frameUrl: chosen.frameUrl || null,
    };
  };
}
