// Loaded explicitly by seed-pi-web, not installed into the user's global extensions.
// Only documented extension APIs; notify is our correlated, non-persisted RPC reply.
import { BRIDGE_COMMAND, BRIDGE_REPLY, NAVIGATION_TYPE, conversationOf, selectionOf } from '../conversation.js';
import { estimateContext } from '../context-usage.js';

export default function conversationExtension(pi) {
  let navigating = false;
  pi.on('session_start', async (_event, ctx) => {
    if (ctx.mode !== 'rpc') return;
    const branch = ctx.sessionManager.getBranch();
    // Native resume cannot interpret our selection checkpoint. Restore it once,
    // while honoring subsequent native model/thinking changes on this path.
    if (!branch.some((e) => e.type === 'custom' && e.customType === NAVIGATION_TYPE)) return;
    const selection = selectionOf(branch);
    if (selection.model && (selection.model.provider !== ctx.model?.provider || selection.model.id !== ctx.model?.id)) {
      const m = ctx.modelRegistry.find(selection.model.provider, selection.model.id);
      if (!m || !(await pi.setModel(m))) ctx.ui.notify('此分支保存的模型不可用，已保留 pi 当前模型', 'warning');
    }
    pi.setThinkingLevel(selection.thinkingLevel);
  });

  pi.registerCommand(BRIDGE_COMMAND, {
    description: 'seed-pi-web internal conversation navigation',
    handler: async (args, ctx) => {
      if (ctx.mode !== 'rpc') return;
      let req;
      const reply = (payload) => ctx.ui.notify(BRIDGE_REPLY + JSON.stringify({ requestId: req?.requestId, ...payload }), 'info');
      try {
        req = JSON.parse(args);
        if (typeof req.requestId !== 'string') throw new Error('缺少请求编号');
        const sm = ctx.sessionManager;
        if (req.op === 'navigate') {
          if (navigating || !ctx.isIdle() || ctx.hasPendingMessages()) throw new Error('pi 正在运行，先停止或等它结束');
          if (req.expectedLeafId !== sm.getLeafId()) throw new Error('对话位置已经改变，请刷新后重试');
          const target = sm.getEntry(req.targetId);
          if (!target) throw new Error('找不到这个对话节点');
          if (req.requireUser && (target.type !== 'message' || target.message.role !== 'user')) throw new Error('只能修改用户消息');
          navigating = true;
          try {
            const fromLeafId = sm.getLeafId();
            const model = ctx.model && { provider: ctx.model.provider, id: ctx.model.id };
            const thinkingLevel = pi.getThinkingLevel();
            // Native navigation treats the current leaf as a no-op. A checkpoint
            // lets an unanswered final user prompt be re-edited as well.
            const fromEntry = sm.getEntry(fromLeafId);
            if (fromEntry?.type === 'message' && fromEntry.message.role === 'user') pi.appendEntry(NAVIGATION_TYPE, { model, thinkingLevel });
            const rollbackId = sm.getLeafId();
            const result = await ctx.navigateTree(req.targetId, { summarize: false });
            if (result.cancelled) return reply({ ok: false, error: '扩展取消了分支切换' });
            const previousSelection = selectionOf(sm.getBranch());
            pi.appendEntry(NAVIGATION_TYPE, { fromLeafId, targetId: req.targetId, model, thinkingLevel, previousSelection });
            // RPC command contexts return only cancellation status, not native
            // editorText. Restore the selected user message from its stored entry.
            const content = target.type === 'message' && target.message?.role === 'user' ? target.message.content : undefined;
            const editorText = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text).join('') : undefined;
            reply({ ok: true, data: { leafId: sm.getLeafId(), rollbackId, editorText, editorImages: Array.isArray(content) ? content.filter(b => b.type === 'image') : [] } });
          } finally {
            navigating = false;
          }
        } else if (req.op === 'restore-selection') {
          if (!ctx.isIdle() || navigating) throw new Error('请等 pi 空闲后再恢复模型设置');
          if (req.expectedLeafId !== sm.getLeafId()) throw new Error('对话位置已经改变，请刷新后重试');
          const checkpoint = sm.getBranch().findLast((e) => e.type === 'custom' && e.customType === NAVIGATION_TYPE);
          const selection = checkpoint?.data?.previousSelection;
          if (!selection?.model) throw new Error('这个分支没有保存历史模型设置');
          const model = ctx.modelRegistry.find(selection.model.provider, selection.model.id);
          if (!model || !(await pi.setModel(model))) throw new Error('历史模型不可用或未配置认证，未恢复设置');
          pi.setThinkingLevel(selection.thinkingLevel);
          reply({ ok: true, data: { thinkingLevel: pi.getThinkingLevel(), requestedThinkingLevel: selection.thinkingLevel } });
        } else if (req.op === 'label') {
          if (!ctx.isIdle() || navigating) throw new Error('请等 pi 空闲后再命名分支');
          if (!sm.getEntry(req.targetId)) throw new Error('找不到这个对话节点');
          pi.setLabel(req.targetId, String(req.label || '').trim().slice(0, 100) || undefined);
          reply({ ok: true, data: { leafId: sm.getLeafId() } });
        } else if (req.op === 'snapshot') {
          const entries = sm.getEntries();
          const projection = sm.buildSessionProjection();
          const messages = req.includeMessages === false ? undefined : projection.entries.flatMap((e) => e.messages.map((m) => ({ ...m, _entryId: e.sourceEntry.id })));
          const messageIds = projection.entries.flatMap((e) => e.messages.map((m) => ({ role: m.role, timestamp: m.timestamp, _entryId: e.sourceEntry.id })));
          const checkpoint = sm.getBranch().findLast((e) => e.type === 'custom' && e.customType === NAVIGATION_TYPE);
          reply({ ok: true, data: { ...conversationOf(entries, sm.getLeafId()), messages, messageIds, contextUsage: ctx.getContextUsage(), contextEstimate: estimateContext(sm.getBranch()), historicalSelection: checkpoint?.data?.previousSelection } });
        } else throw new Error('未知的分支操作');
      } catch (error) {
        reply({ ok: false, error: error.message });
      }
    },
  });
}
