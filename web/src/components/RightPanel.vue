<script setup>
import { computed, onMounted, onUnmounted } from 'vue';
import { S, openSession, sessionStatus, isFav, toggleFavorite, killAgent } from '../store.js';
import { view, openMenu } from '../settings.js';
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
// 文件面板顶上那行路径：右键能把当前工作目录收藏起来（树里根节点本身不画，所以给它留个入口）
function cwdMenu(e) {
  openMenu(e.clientX, e.clientY, [
    { label: isFav(S.cwd) ? '取消收藏这个目录' : '收藏这个目录', run: () => toggleFavorite(S.cwd) },
    { label: '复制路径', run: () => navigator.clipboard.writeText(S.cwd) },
  ]);
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
        <div class="sub ellipsis" :title="`${S.cwd}\n右键可以收藏这个目录`" @contextmenu.prevent.stop="cwdMenu($event)">{{ S.cwd }}</div>
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
            :title="a.sessionFile || a.cwd"
            @click="a.sessionFile && openSession(a.sessionFile)"
          >
            <span class="dot" :class="a.running ? 'busy' : 'on'" />
            <span class="amain">
              <span class="ellipsis aname">{{ a.sessionName || (a.saved ? '未命名会话' : '新会话') }}</span>
              <span class="ellipsis apath">{{ a.cwd }}</span>
            </span>
            <span class="astate" :class="{ busy: a.running }">{{ a.waitingUi ? '等你操作' : a.running ? '运行中' : sessionStatus(a.sessionFile)?.unread ? '有新回复' : sessionStatus(a.sessionFile)?.elsewhere ? '别的窗口在用' : '空闲' }}</span>
            <button class="ib kill" title="强行关闭这个 pi 进程" @click.stop="killAgent(a)"><Icon name="power" :size="15" /></button>
          </div>
        </div>
      </div>
    </aside>
  </Transition>
</template>

<style scoped>
.rpanel { position: absolute; z-index: 30; top: 58px; right: 8px; bottom: 8px; width: min(340px, calc(100% - 16px)); display: flex; flex-direction: column; background: var(--elev); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow-lg); overflow: hidden; user-select: none; }
.rpanel.low { top: 86px; }
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

.agent { display: flex; align-items: center; gap: 8px; padding: 5px 8px 5px 6px; border-radius: var(--r-sm); cursor: pointer; }
.agent:hover { background: var(--active); }
.agent.active { background: var(--accent-softer); }
.agent.active .aname { font-weight: 600; color: var(--accent-text); }
.agent .dot { margin: 0 4px; flex: none; }
/* 左边两行：上面会话名称，下面这个进程的工作目录（太长就省略，悬停看完整路径） */
.amain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.aname { font-size: var(--fs-sm); line-height: 1.35; }
.apath { font-size: var(--fs-xs); color: var(--text-3); line-height: 1.3; }
.astate { flex: none; font-size: var(--fs-xs); color: var(--text-3); }
.astate.busy { color: var(--accent-text); }
/* 强行关闭：点了就直接关（会中断正在跑的回复） */
.kill { width: 26px; height: 26px; opacity: 0.5; }
.kill:hover { background: var(--err); color: #fff; opacity: 1; }

.rp-enter-active, .rp-leave-active { transition: opacity 0.15s, transform 0.15s; }
.rp-enter-from, .rp-leave-to { opacity: 0; transform: translateX(12px); }
</style>
