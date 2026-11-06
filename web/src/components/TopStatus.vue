<script setup>
// 顶栏右侧的用量状态：格式照搬 pi 终端底栏
// ↑输入 ↓输出 R缓存读 W缓存写 CH命中率 $花费 上下文%/窗口
// 顶栏变窄时按优先级隐藏：先藏 ↑↓RW（p3），再藏 CH（p2），再藏花费（p1），上下文一直留着
import { computed } from 'vue';
import { S, compact, showSessionInfo, contextUsage } from '../store.js';

const ctx = contextUsage;
const ctxEmpty = computed(() => (S.stats?.contextEstimate ? '模型窗口未知，无法计算占比' : '暂无可用用量数据'));
// 缓存命中率：直接从当前对话里最后一条带用量的回复算（pi 实时统计里不带这个数）
const latestCacheHit = computed(() => {
  for (let i = S.messages?.length - 1; i >= 0; i--) {
    const u = S.messages[i]?.role === 'assistant' && S.messages[i].usage;
    if (!u) continue;
    const prompt = (Number(u.input) || 0) + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite) || 0);
    if (prompt > 0) return ((Number(u.cacheRead) || 0) / prompt) * 100;
  }
  return null;
});
const piTok = (n) => (n < 1000 ? String(n) : n < 1e4 ? `${(n / 1000).toFixed(1)}k` : n < 1e6 ? `${Math.round(n / 1000)}k` : n < 1e7 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e6)}M`);
const items = computed(() => {
  const s = S.stats;
  if (!s) return [];
  const t = s.tokens || {};
  const out = [];
  if (t.input) out.push({ text: `↑${piTok(t.input)}`, cls: 'p3', title: `累计「没命中缓存」的输入 ${t.input} tokens（整个会话，所有分支）\n命中缓存的那部分算在 R 里，两者加起来才是总输入` });
  if (t.output) out.push({ text: `↓${piTok(t.output)}`, cls: 'p3', title: `累计输出 ${t.output} tokens` });
  if (t.cacheRead) out.push({ text: `R${piTok(t.cacheRead)}`, cls: 'p3', title: `累计缓存读 ${t.cacheRead} tokens` });
  if (t.cacheWrite) out.push({ text: `W${piTok(t.cacheWrite)}`, cls: 'p3', title: `累计缓存写 ${t.cacheWrite} tokens` });
  const hit = latestCacheHit.value ?? s.latestCacheHitRate;
  if ((t.cacheRead > 0 || t.cacheWrite > 0) && hit != null) out.push({ text: `CH${hit.toFixed(1)}%`, cls: 'p2', title: '最近一次请求的缓存命中率：缓存读 ÷ 这次请求的全部输入' });
  if (s.cost) out.push({ text: `$${s.cost.toFixed(3)}`, cls: 'p1', title: '整个会话累计花费（所有分支），点击查看会话详情', run: showSessionInfo });
  const win = ctx.value?.contextWindow ?? S.state?.model?.contextWindow ?? 0;
  const p = ctx.value?.percent;
  out.push({
    text: `${Number.isFinite(p) ? p.toFixed(1) + '%' : '?'}/${piTok(win)}`,
    cls: p > 90 ? 'danger' : p > 70 ? 'warn' : '',
    title: ctx.value?.tokens != null ? `当前上下文 ${ctx.value.tokens} / ${win} tokens，点击压缩` : ctxEmpty.value,
    run: compact,
  });
  return out;
});
// 自己有动作（花费 / 上下文）就干自己的事；没动作的冒上去，让整条去打开会话详情
function onItemClick(it, e) {
  if (!it.run) return;
  e.stopPropagation();
  it.run();
}
</script>

<template>
  <div v-if="items.length" class="tstat" title="点击查看会话详情" @click="showSessionInfo()">
    <span v-for="(it, i) in items" :key="i" class="it" :class="[it.cls, { click: !!it.run }]" :title="it.title" @click="onItemClick(it, $event)">{{ it.text }}</span>
  </div>
</template>

<style scoped>
.tstat { flex: none; display: flex; align-items: center; gap: 8px; height: 26px; padding: 0 8px; border-radius: var(--r-sm); font-size: 11.5px; color: var(--text-2); white-space: nowrap; font-variant-numeric: tabular-nums; cursor: pointer; }
.tstat:hover { background: var(--active); }
.tstat:hover .it { color: var(--text); }
.it.warn, .tstat:hover .it.warn { color: var(--warn); }
.it.danger, .tstat:hover .it.danger { color: var(--err); }
/* 顶栏（.top 是 container）变窄时按优先级收起 */
@container topbar (max-width: 820px) { .p3 { display: none; } }
@container topbar (max-width: 640px) { .p2 { display: none; } }
@container topbar (max-width: 480px) { .p1 { display: none; } }
</style>
