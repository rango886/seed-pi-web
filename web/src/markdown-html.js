// v-html 会在流式更新时重建整段 DOM，让图的工具条反复淡入，也丢掉缩放状态。
// 图和播放器内部由各自的绑定器接管；流式更新不碰它们的运行时状态。
function prepareMedia(root) {
  for (const media of root.querySelectorAll('video, audio')) {
    let host = media.parentElement;
    if (!host?.classList.contains('md-media')) {
      host = document.createElement('span');
      host.className = 'md-media';
      media.before(host);
      host.appendChild(media);
    }
    // preload 在流式结束时会改变，不属于资源身份；其他声明（source/track/poster 等）变了则重建。
    const attrs = [...media.attributes]
      .filter((a) => a.name !== 'preload')
      .map((a) => [a.name, a.value])
      .sort(([a], [b]) => a.localeCompare(b));
    host.setAttribute('data-media-key', JSON.stringify([media.localName, attrs, media.innerHTML]));
  }
}

function patchChildren(parent, next) {
  let current = parent.firstChild;
  for (const node of [...next.childNodes]) {
    if (!current) {
      parent.appendChild(node);
      continue;
    }
    const following = current.nextSibling;
    if (current.nodeType !== node.nodeType || current.nodeName !== node.nodeName) {
      parent.replaceChild(node, current);
    } else if (node.nodeType === 1) {
      const key = node.getAttribute('data-dgm-key') || node.getAttribute('data-media-key');
      const oldKey = current.getAttribute('data-dgm-key') || current.getAttribute('data-media-key');
      if ((key || oldKey) && key !== oldKey) {
        // 源码/字体变了，连容器一起换掉，让图绑定器重新初始化缩放。
        parent.replaceChild(node, current);
      } else if (node.hasAttribute('data-media-key')) {
        // 保留播放器和控件，只在流式结束时恢复元数据预加载。
        const media = current.querySelector('video, audio');
        const preload = node.querySelector('video, audio')?.getAttribute('preload');
        if (media && preload !== null && media.getAttribute('preload') !== preload) media.setAttribute('preload', preload);
      } else if (!key) {
        for (const attr of [...current.attributes]) {
          if (!node.hasAttribute(attr.name)) current.removeAttribute(attr.name);
        }
        for (const attr of [...node.attributes]) {
          if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
        }
        patchChildren(current, node);
      }
    } else if (current.nodeValue !== node.nodeValue) {
      current.nodeValue = node.nodeValue;
    }
    current = following;
  }
  while (current) {
    const following = current.nextSibling;
    current.remove();
    current = following;
  }
}

function update(el, { value, oldValue }) {
  if (value === oldValue) return;
  const hasState = !!el.querySelector('[data-dgm-key], [data-media-key]');
  // 普通 Markdown 不需要解析第二遍。
  if (!hasState && !/<(?:video|audio)\b/i.test(value || '')) {
    el.innerHTML = value || '';
    return;
  }
  const template = document.createElement('template');
  template.innerHTML = value || '';
  prepareMedia(template.content);
  if (hasState) patchChildren(el, template.content);
  else el.replaceChildren(template.content);
}

// 输入必须是 renderMarkdown 返回的已净化 HTML，不能直接传模型原文。
export const vMarkdownHtml = { mounted: update, updated: update };
