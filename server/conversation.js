// Shared, dependency-free projections of pi's append-only session tree.
export const NAVIGATION_TYPE = 'seed-web.navigation';
export const BRIDGE_COMMAND = 'seed-web-tree';
export const BRIDGE_REPLY = 'seed-web-tree:';

export function branchOf(entries, leafId = entries.at(-1)?.id ?? null) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const seen = new Set();
  const out = [];
  for (let e = byId.get(leafId); e && !seen.has(e.id); e = byId.get(e.parentId)) {
    seen.add(e.id);
    out.push(e);
  }
  return out.reverse();
}

export function selectionOf(branch) {
  let model = null;
  let thinkingLevel = 'off';
  for (const e of branch) {
    if (e.type === 'custom' && e.customType === NAVIGATION_TYPE) {
      if (e.data?.model) model = e.data.model;
      if (e.data?.thinkingLevel) thinkingLevel = e.data.thinkingLevel;
    } else if (e.type === 'model_change') model = { provider: e.provider, id: e.modelId };
    else if (e.type === 'thinking_level_change') thinkingLevel = e.thinkingLevel;
    else if (e.type === 'message' && e.message?.role === 'assistant') {
      model = { provider: e.message.provider, id: e.message.model };
      if (e.message.thinkingLevel) thinkingLevel = e.message.thinkingLevel;
    }
  }
  return { model, thinkingLevel };
}

export function usageOf(entries) {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let cost = 0, userMessages = 0, assistantMessages = 0, toolCalls = 0;
  const add = (u) => {
    if (!u) return;
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) tokens[k] += Number(u[k]) || 0;
    cost += Number(u.cost?.total) || 0;
  };
  for (const e of entries) {
    if (e.type === 'usage' || e.type === 'compaction' || e.type === 'branch_summary') add(e.usage);
    if (e.type !== 'message') continue;
    const m = e.message;
    if (m?.role === 'user') userMessages++;
    if (m?.role === 'assistant') {
      assistantMessages++;
      toolCalls += Array.isArray(m.content) ? m.content.filter((b) => b?.type === 'toolCall').length : 0;
      add(m.usage);
    } else if (m?.role === 'toolResult') add(m.usage);
  }
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  return { tokens, cost, userMessages, assistantMessages, toolCalls };
}

const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
const isUser = (e) => e.type === 'message' && e.message?.role === 'user';
const isAnchor = (e) => (e.type === 'message' && e.message?.role !== 'system') || ['compaction', 'branch_summary', 'custom_message'].includes(e.type);

// Metadata/system entries are not visible forks. Stable entry ids, never message text,
// identify versions (including repeated identical questions and image-only messages).
export function conversationOf(entries, leafId = entries.at(-1)?.id ?? null) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const branch = branchOf(entries, leafId);
  const activeIds = new Set(branch.map((e) => e.id));
  const labels = new Map();
  for (const e of entries) if (e.type === 'label') labels.set(e.targetId, e.label || '');
  const caches = new Map();
  const nearest = (id, predicate) => {
    if (!caches.has(predicate)) caches.set(predicate, new Map());
    const cache = caches.get(predicate), seen = new Set();
    let found = null;
    for (let e = byId.get(id); e && !seen.has(e.id); e = byId.get(e.parentId)) {
      if (cache.has(e.id)) { found = cache.get(e.id); break; }
      seen.add(e.id);
      if (predicate(e)) { found = e.id; break; }
    }
    for (const key of seen) cache.set(key, found);
    return found;
  };
  const nodes = entries.filter(isUser).map((e) => {
    const raw = textOf(e.message.content);
    const clean = raw.replace(/<attachments>[\s\S]*?<\/attachments>/g, '').replace(/\s+/g, ' ').trim();
    return {
      id: e.id, parentId: nearest(e.parentId, isUser), anchor: nearest(e.parentId, isAnchor),
      text: clean || (raw ? '[附件]' : '[图片 / 空消息]'),
      timestamp: e.timestamp, label: labels.get(e.id) || '', active: activeIds.has(e.id), targetId: e.id,
    };
  });
  // Last visited descendant for every question. Navigation records also remember
  // where we left an older path, even if that path contains no newly appended answer.
  const visits = new Map();
  const remember = (id, targetId, rank) => {
    const userId = nearest(id, isUser);
    if (userId && rank >= (visits.get(userId)?.rank ?? -1)) visits.set(userId, { targetId, rank });
  };
  entries.forEach((e, i) => {
    if (e.type === 'custom' && e.customType === NAVIGATION_TYPE && byId.has(e.data?.fromLeafId)) remember(e.data.fromLeafId, e.data.fromLeafId, i * 2);
    remember(e.id, e.id, i * 2 + 1);
  });
  if (leafId) remember(leafId, leafId, Infinity);
  // Tree navigation stops at this question's own turn, before the next user
  // message. Version navigation still resumes the last visited descendant below.
  for (const n of nodes) n.turnTargetId = visits.get(n.id)?.targetId || n.id;
  // Parents precede children in append order. Propagate the latest descendant
  // once, rather than walking the full ancestor chain for every entry.
  for (const n of [...nodes].reverse()) {
    const visit = visits.get(n.id);
    if (!visit) continue;
    n.targetId = visit.targetId;
    if (n.parentId && visit.rank > (visits.get(n.parentId)?.rank ?? -1)) visits.set(n.parentId, visit);
  };
  const groups = new Map();
  for (const n of nodes) {
    const key = n.anchor || 'root';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n.id);
  }
  for (const n of nodes) n.versions = groups.get(n.anchor || 'root');
  const checkpoint = branch.findLast((e) => e.type === 'custom' && e.customType === NAVIGATION_TYPE);
  return { leafId, nodes, branchStats: usageOf(branch), totals: usageOf(entries), selection: selectionOf(branch), historicalSelection: checkpoint?.data?.previousSelection };
}
