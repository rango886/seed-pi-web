// Offline context estimate. Never sum request usage: each request already includes
// earlier context. A valid recent assistant usage is the baseline, not a counter.
const number = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
const textTokens = (text) => {
  // English/code is roughly four characters per token; CJK needs a higher weight.
  let chars = 0;
  for (const ch of String(text ?? '')) chars += ch.codePointAt(0) > 127 ? 4 : 1;
  return Math.ceil(chars / 4);
};
function contentTokens(content) {
  if (typeof content === 'string') return textTokens(content);
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, block) => {
    if (block.type === 'image') return sum + 1200; // Don't count base64 as text.
    if (block.type === 'toolCall') return sum + textTokens(block.name) + textTokens(JSON.stringify(block.arguments ?? {}));
    return sum + textTokens(block.text ?? block.thinking ?? '');
  }, 0);
}
function messageTokens(m) {
  if (m.excludeFromContext) return 0;
  if (m.role === 'bashExecution') return textTokens(m.command) + textTokens(m.output);
  if (m.role === 'compactionSummary' || m.role === 'branchSummary') return textTokens(m.summary);
  let tokens = contentTokens(m.content);
  if (m.role === 'system') {
    for (const section of Object.values(m.sections || {})) tokens += textTokens(section);
    if (m.toolsAdded) tokens += textTokens(JSON.stringify(m.toolsAdded));
  }
  return tokens;
}
function messagesOf(e) {
  if (e.type === 'message') return e.message ? [e.message] : [];
  if (e.type === 'custom_message') return [{ role: 'custom', content: e.content }];
  if (e.type === 'branch_summary') return [{ role: 'branchSummary', summary: e.summary }];
  if (e.type === 'compaction') return [...(e.systemMessage ? [e.systemMessage] : []), { role: 'compactionSummary', summary: e.summary }];
  return [];
}

/** branch must be the selected leaf's ancestor path, in chronological order. */
export function estimateContext(branch) {
  const ci = branch.findLastIndex((e) => e.type === 'compaction');
  let picked = branch;
  if (ci >= 0) {
    const c = branch[ci];
    const ki = branch.findIndex((e) => e.id === c.firstKeptEntryId);
    const kept = ki >= 0 && ki < ci ? branch.slice(ki, ci).filter((e) => !(e.type === 'message' && e.message?.role === 'system')) : [];
    picked = [c, ...kept, ...branch.slice(ci + 1)];
  }
  const edits = new Map(picked.filter((e) => e.type === 'context_edit').map((e) => [e.targetId, e]));
  // Usage before a compaction or content edit describes the old request, even if
  // that assistant is among the messages retained by the latest compaction.
  const barrier = Math.max(ci, branch.findLastIndex((e) => e.type === 'context_edit'));
  const usableIds = new Set(branch.slice(barrier + 1).map((e) => e.id));
  const projected = picked.flatMap((e, i) => {
    if (e.type === 'compaction' && i > 0) return [];
    const edit = edits.get(e.id);
    if (edit?.replacement === null) return [];
    return messagesOf(e).map((m) => ({
      message: edit && ['user', 'assistant', 'toolResult', 'custom'].includes(m.role) ? { ...m, content: edit.replacement?.content } : m,
      usable: usableIds.has(e.id),
    }));
  }).filter(({ message }) => !message.excludeFromContext);

  let content = 0, trailing = 0, baseline = 0, usageModel = null;
  for (const { message: m, usable } of projected) {
    const size = messageTokens(m);
    content += size;
    const u = m.usage;
    const total = u && (number(u.totalTokens) || number(u.input) + number(u.output) + number(u.cacheRead) + number(u.cacheWrite));
    if (usable && m.role === 'assistant' && !['error', 'aborted'].includes(m.stopReason) && total > 0 && m.provider && m.model) {
      baseline = total;
      trailing = 0;
      usageModel = { provider: m.provider, id: m.model };
    } else trailing += size;
  }
  return { tokens: baseline ? baseline + trailing : content, contentTokens: content, usageModel };
}
