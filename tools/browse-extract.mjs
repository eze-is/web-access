#!/usr/bin/env node
/**
 * 高阶工具：一次调用完成 URL 打开 + 内容提取
 * 用法：node browse-extract.mjs <url> [提取目标]
 */
const PROXY = process.env.CDP_PROXY || 'http://localhost:3456';

async function browseAndExtract(url, goal = '页面全部内容') {
  // 1. 智能打开（复用同域 Tab）
  const openRes = await fetch(`${PROXY}/smart-open?url=${encodeURIComponent(url)}&reuse=true`);
  const { targetId, reused } = await openRes.json();
  console.error(`[browse] ${reused ? '复用' : '新建'} Tab: ${targetId}`);

  // 2. 批处理：提取
  const batchRes = await fetch(`${PROXY}/batch`, {
    method: 'POST',
    body: JSON.stringify({
      target: targetId,
      commands: [
        {
          action: 'eval',
          expression: `
            (() => {
              const extractors = {
                article: () => {
                  const a = document.querySelector('article,[role="article"],.article,.post,.entry');
                  if (a) return { type: 'article', content: a.innerText.slice(0, 15000) };
                },
                table: () => {
                  const t = document.querySelector('table');
                  if (t) return { type: 'table', rows: [...t.querySelectorAll('tr')].slice(0,50).map(r => [...r.querySelectorAll('td,th')].map(c => c.innerText.trim())) };
                },
                list: () => {
                  const items = [...document.querySelectorAll('[class*="item"],[class*="card"],li')].slice(0,20);
                  if (items.length > 3) return { type: 'list', items: items.map(e => e.innerText.slice(0,500)) };
                },
                generic: () => ({ type: 'generic', title: document.title, content: document.body.innerText.slice(0, 15000) })
              };
              for (const fn of Object.values(extractors)) { const r = fn(); if (r) return r; }
            })()
          `
        },
        {
          action: 'eval',
          expression: `JSON.stringify({
            title: document.title,
            url: location.href,
            links: [...document.querySelectorAll('a[href]')].slice(0,20).map(a=>({t:a.innerText.trim().slice(0,80),h:a.href})).filter(l=>l.t&&l.h.startsWith('http'))
          })`
        }
      ]
    })
  });

  const [contentResult, metaResult] = await batchRes.json();
  const content = contentResult?.success ? contentResult.value : null;
  const meta = metaResult?.success ? JSON.parse(metaResult.value) : {};

  return {
    targetId,
    reused,
    type: content?.type,
    title: meta.title || content?.title,
    content: content?.content || content,
    table: content?.rows ? { rows: content.rows } : null,
    list: content?.items ? { items: content.items } : null,
    links: meta.links || [],
    url
  };
}

if (process.argv[2]) {
  browseAndExtract(process.argv[2], process.argv[3])
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(e => console.error('Error:', e.message));
}

export { browseAndExtract };
