// 成图 HTML 会被缓存、重复插入；每个实例的 SVG 引用必须独立，不能引用到隐藏的另一张图。
export function prefixSvgIds(markup, prefix) {
  const ids = [...new Set([...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))]
    .sort((a, b) => b.length - a.length);
  if (!ids.length) return markup;
  // 一次替换，避免新前缀恰好含有另一个旧 id 时被再次替换。
  const alternatives = ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const renamed = markup.replace(new RegExp(`(\\sid="|#)(${alternatives})(?![\\w-])`, 'g'), (_, lead, id) => `${lead}${prefix}${id}`);
  const known = new Set(ids);
  return renamed.replace(/(\saria-(?:labelledby|describedby)=")([^"]*)"/g, (_, lead, value) =>
    `${lead}${value.replace(/\S+/g, (id) => known.has(id) ? prefix + id : id)}"`);

}
