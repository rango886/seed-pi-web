<script setup>
import { computed, onMounted, onUnmounted } from 'vue';
import { S, openSession, sessionStatus } from '../store.js';
import { view } from '../settings.js';
import TreeNode from './TreeNode.vue';
import Icon from './Icon.vue';

// 右边的浮动侧栏：文件树 / pi 进程。浮在对话上面，不挤占对话的宽度。
// 打开它的按钮在顶栏右边；点面板外面、按 Esc、再点一次按钮都会关掉。
const base = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
const title = computed(() => (view.panel === 'files' ? '文件' : '进程'));
// 顶部有标签栏时往下让一点，别挡住标签栏右边的“关闭全部”
const hasTabs = computed(() => S.tabs.length > 0 || S.terms.length > 0);

function onDown(e) {
  if (!view.panel) return;
  // 面板自己、顶栏上的开关按钮、右键菜单、弹窗里点击都不算“外面”
  if (e.target.closest('.rpanel, .panel-btn, .ctxmenu, .modal-mask')) return;
  view.panel = null;
}
onMounted(() => window.addEventListener('mousedown', onDown));
onUnmounted(() => window.removeEventListener('mousedown', onDown));
</script>

<template>
  <Transition name="rp">
    <aside v-if="view.panel" class="rpanel" :class="{ low: hasTabs }">
      <div class="rhead">
        <Icon :name="view.panel === 'files' ? 'folder' : 'cpu'" :size="16" />
        <span class="rtitle">{{ title }}</span>
        <span v-if="view.panel === 'agents' && S.agents.length" class="cnt">{{ S.agents.length }}</span>
        <div class="grow" />
        <button v-if="view.panel === 'files'" class="ib" title="刷新" @click="S.fsEpoch++"><Icon name="refresh" :size="15" /></button>
        <button class="ib" title="关闭 (Esc)" @click="view.panel = null"><Icon name="close" :size="15" /></button>
      </div>

      <!-- 两个面板都用 v-show 挂着：来回切换不用重新读目录 -->
      <div v-show="view.panel === 'files'" class="pane">
        <div class="sub ellipsis" :title="S.cwd">{{ S.cwd }}</div>
        <div class="list tree">
          <TreeNode v-if="S.cwd" :key="S.cwd" :entry="{ name: base(S.cwd), path: S.cwd, dir: true }" :depth="0" root />
        </div>
      </div>

      <div v-show="view.panel === 'agents'" class="pane">
        <div class="sub">每个会话一个 pi 进程，切走后会在后台继续跑</div>
        <div class="list">
          <div v-if="!S.agents.length" class="empty">没有运行中的 pi</div>
          <div
            v-for="a in S.agents"
            :key="a.id"
            class="agent"
            :class="{ active: a.id === S.agentId }"
            :title="`${a.cwd}${a.sessionName ? '\n' + a.sessionName : ''}`"
            @click="openSession(a.sessionFile)"
          >
            <span class="dot" :class="a.running ? 'busy' : 'on'" />
            <span class="ellipsis aname">{{ base(a.cwd) }}</span>
            <span v-if="a.sessionName" class="ellipsis grow asess">{{ a.sessionName }}</span>
            <span v-else-if="!a.saved" class="ellipsis grow asess">新会话</span>
            <span v-else class="grow" />
            <span class="astate" :class="{ busy: a.running }">{{ a.waitingUi ? '等你操作' : a.running ? '运行中' : sessionStatus(a.sessionFile)?.unread ? '有新回复' : sessionStatus(a.sessionFile)?.elsewhere ? '别的窗口在用' : '空闲' }}</span>
          </div>
        </div>
      </div>
    </aside>
  </Transition>
</template>

<style scoped>
.rpanel { position: absolute; z-index: 30; top: 58px; right: 8px; bottom: 8px; width: min(340px, calc(100% - 16px)); display: flex; flex-direction: column; background: var(--elev); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow-lg); overflow: hidden; user-select: none; }
.rpanel.low { top: 98px; }
.rhead { display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 6px 0 14px; flex: none; color: var(--text-2); border-bottom: 1px solid var(--line-2); }
.rtitle { font-weight: 600; color: var(--text); }
.cnt { font-size: 11px; background: var(--active); padding: 0 6px; border-radius: var(--r-pill); color: var(--text-2); }
.ib { width: 30px; height: 30px; border: 0; background: transparent; border-radius: var(--r-sm); color: var(--text-2); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; flex: none; }
.ib:hover { background: var(--active); color: var(--text); }
.pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.sub { font-size: var(--fs-xs); color: var(--text-3); padding: 8px 14px 4px; flex: none; }
.list { flex: 1; overflow-y: auto; padding: 2px 8px 12px; }
.tree { padding: 2px 6px 12px; }
.empty { padding: 32px 12px; text-align: center; font-size: var(--fs-sm); color: var(--text-3); }

.agent { display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 10px 0 6px; border-radius: var(--r-sm); cursor: pointer; }
.agent:hover { background: var(--active); }
.agent.active { background: var(--accent-softer); }
.agent.active .aname { font-weight: 600; color: var(--accent-text); }
.agent .dot { margin: 0 4px; }
.aname { flex: 0 1 auto; max-width: 60%; }
.asess { min-width: 0; font-size: var(--fs-xs); color: var(--text-3); }
.astate { flex: none; font-size: var(--fs-xs); color: var(--text-3); }
.astate.busy { color: var(--accent-text); }

.rp-enter-active, .rp-leave-active { transition: opacity 0.15s, transform 0.15s; }
.rp-enter-from, .rp-leave-to { opacity: 0; transform: translateX(12px); }
</style>
