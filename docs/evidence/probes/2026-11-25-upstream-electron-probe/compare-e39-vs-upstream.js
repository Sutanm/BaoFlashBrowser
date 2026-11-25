// 逐条把上游补丁的「修复前代码块」拿到 E39 源码里找：能找到 → E39 确实带着同一个缺陷，移植才有意义；
// 找不到 → 要么该代码路径在 E39 不存在（补丁无意义），要么写法漂移（需要人工定位锚点）。
const { readFileSync, readdirSync, existsSync } = require('node:fs')
const { join } = require('node:path')

const tree = 'D:\\electron-build-142\\cr\\src\\electron'
const dir = 'D:\\java_workspace\\BaoFlashBrowserNext\\docs\\kernel\\upstream'

function parsePatch(text) {
  const sections = []
  let cur = null
  for (const line of text.split(/\r?\n/)) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (m) { cur = { path: m[2], hunks: [] }; sections.push(cur); continue }
    if (!cur) continue
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (h) { cur.hunks.push({ oldStart: +h[1], pre: [], post: [] }); continue }
    if (!cur.hunks.length) continue
    const hunk = cur.hunks[cur.hunks.length - 1]
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) hunk.post.push(line.slice(1))
    else if (line.startsWith('-')) hunk.pre.push(line.slice(1))
    else if (line.startsWith(' ')) { hunk.pre.push(line.slice(1)); hunk.post.push(line.slice(1)) }
  }
  return sections
}

const norm = (s) => s.replace(/\r\n/g, '\n')
const results = []

for (const name of readdirSync(dir).filter((f) => f.endsWith('.patch')).sort()) {
  const text = readFileSync(join(dir, name), 'utf8')
  for (const sec of parsePatch(text)) {
    if (!sec.path.startsWith('shell/')) continue
    const target = join(tree, sec.path)
    if (!existsSync(target)) { results.push({ name, path: sec.path, status: 'E39 无此文件' }); continue }
    const src = norm(readFileSync(target, 'utf8'))
    for (const [i, hunk] of sec.hunks.entries()) {
      const pre = hunk.pre.join('\n')
      // 去掉行首缩进差异影响：先精确找，再退化为「首个被删除行」的定位
      if (pre.trim() && src.includes(pre)) { results.push({ name, path: sec.path, hunk: i, status: 'E39 原样存在' }); continue }
      const removed = hunk.pre.find((l) => l.trim().length > 8)
      const anchor = removed ? src.indexOf(removed) : -1
      results.push({
        name, path: sec.path, hunk: i,
        status: anchor >= 0 ? 'E39 有锚点(写法已漂移)' : 'E39 找不到锚点',
        line: anchor >= 0 ? src.slice(0, anchor).split('\n').length : null,
        sample: removed ? removed.trim().slice(0, 70) : null
      })
    }
  }
}

for (const r of results) {
  console.log([r.name.replace(/\.patch$/, ''), r.path, `h${r.hunk}`, r.status, r.line ? `L${r.line}` : '', r.sample ? `| ${r.sample}` : ''].join('  '))
}
const tally = results.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m }, {})
console.log('\nTALLY', JSON.stringify(tally))
