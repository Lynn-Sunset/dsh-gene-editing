// Trusted public task specifications. Hidden acceptance inputs live in a separate module.
const check = (id, kind, input, expected, summary, mandatory = false) => ({ id, kind, input, expected, summary, mandatory });
const task = (id, title, family, specification, starter, starterStatus, checks) => ({
  id, title, family, specification, starter, starterStatus, checks,
  prompt: `请审查下面的纯函数实现，修复确实存在的错误；正确的实现应保留。\n${specification}\n实现同步 JavaScript 函数 solve(input)。不要导入模块或使用文件、网络、时钟、随机数；只返回 JSON 可表示的数据。请交付一个完整的 JavaScript 代码块，可附一段简短说明，不需要 JSON 包装、检查清单或私有思考过程。\n现有实现：\n\`\`\`js\n${starter}\n\`\`\``
});

export const TASKS = [
  task('tuple_dedup', '结构化键去重', 'structured-identity',
    'input 是字符串二元组数组。仅当两个位置的字符串分别完全相等时才算重复；返回首次出现的二元组，保持原顺序。字符串可以为空、包含分隔符或 Unicode，大小写有区别。',
    `function solve(input) {\n  const seen = new Set();\n  return input.filter(pair => {\n    const key = pair.join('|');\n    if (seen.has(key)) return false;\n    seen.add(key);\n    return true;\n  });\n}`, 'defective', [
      check('tuple_dedup.smoke', 'baseline', [['a','1'],['b','2'],['a','1']], [['a','1'],['b','2']], '同一二元组只保留首次出现', true),
      check('tuple_dedup.normal', 'baseline', [['red','x'],['blue','y'],['red','x'],['green','z']], [['red','x'],['blue','y'],['green','z']], '普通键的去重和原顺序'),
      check('tuple_dedup.case', 'constraint', [['A','x'],['a','x'],['A','x']], [['A','x'],['a','x']], '大小写相异的键不可合并'),
      check('tuple_dedup.delimiter', 'boundary', [['a|b','c'],['a','b|c'],['a|b','c']], [['a|b','c'],['a','b|c']], '分隔符不能制造二元组碰撞')
    ]),
  task('tuple_counts', '结构化键计数', 'structured-identity',
    'input 是字符串二元组数组。输出 [{pair:[字符串,字符串],count:次数}]，按每个二元组首次出现顺序排列。只有两个位置分别完全相同才归为同组；空字符串、分隔符、Unicode 与对象属性名都只是普通字符串。空输入返回 []。',
    `function solve(input) {\n  const counts = new Map();\n  for (const pair of input) {\n    const key = JSON.stringify(pair);\n    const item = counts.get(key);\n    if (item) item.count++;\n    else counts.set(key, { pair: [pair[0], pair[1]], count: 1 });\n  }\n  return Array.from(counts.values());\n}`, 'correct', [
      check('tuple_counts.smoke', 'baseline', [['a','b'],['a','b'],['c','d']], [{pair:['a','b'],count:2},{pair:['c','d'],count:1}], '计数与首次出现顺序', true),
      check('tuple_counts.normal', 'baseline', [['x','1'],['y','2'],['x','1'],['y','2']], [{pair:['x','1'],count:2},{pair:['y','2'],count:2}], '交错重复键分别计数'),
      check('tuple_counts.empty', 'constraint', [], [], '空输入没有分组'),
      check('tuple_counts.special', 'boundary', [['__proto__',''],['','__proto__'],['__proto__',''],['a|b','c'],['a','b|c']], [{pair:['__proto__',''],count:2},{pair:['','__proto__'],count:1},{pair:['a|b','c'],count:1},{pair:['a','b|c'],count:1}], '特殊字符串不触发属性冲突或分隔符碰撞')
    ]),
  task('interval_union', '半开区间并集', 'interval-algebra',
    'input 是有限整数半开区间 [start,end) 的数组，保证 start < end，输入可无序、重叠或重复。返回并集的规范表示：按起点升序排列、非空且互不重叠的最大区间；相接区间也必须合并，例如 [0,2) 和 [2,3) 合并为 [0,3)。空输入返回 []。',
    `function solve(input) {\n  const sorted = input.map(x => x.slice()).sort((a, b) => a[0] - b[0]);\n  const result = [];\n  for (const interval of sorted) {\n    const last = result[result.length - 1];\n    if (last && interval[0] < last[1]) last[1] = Math.max(last[1], interval[1]);\n    else result.push(interval);\n  }\n  return result;\n}`, 'defective', [
      check('interval_union.smoke', 'baseline', [[0,3],[2,5]], [[0,5]], '重叠区间合并', true),
      check('interval_union.normal', 'baseline', [[7,9],[1,3]], [[1,3],[7,9]], '不相交区间排序'),
      check('interval_union.nested', 'constraint', [[1,10],[3,5],[1,10]], [[1,10]], '嵌套和重复区间不缩短并集'),
      check('interval_union.touching', 'boundary', [[0,2],[4,6],[2,4]], [[0,6]], '连锁相接必须形成最大区间')
    ]),
  task('interval_difference', '半开区间扣除', 'interval-algebra',
    'input={base:[start,end],blocked:[[a,b],...]}，均是有限整数半开区间且左端点小于右端点。blocked 可无序、相交、重复或在 base 外。返回 base 扣除所有 blocked 后的非空最大区间，按起点升序；端点相接不产生交集。空 blocked 应保留整个 base。',
    `function solve(input) {\n  let pieces = [input.base.slice()];\n  for (const [a, b] of input.blocked) {\n    const next = [];\n    for (const [s, e] of pieces) {\n      if (b <= s || a >= e) next.push([s, e]);\n      else {\n        if (s < a) next.push([s, Math.min(a, e)]);\n        if (b < e) next.push([Math.max(b, s), e]);\n      }\n    }\n    pieces = next;\n  }\n  return pieces;\n}`, 'correct', [
      check('interval_difference.smoke', 'baseline', {base:[0,10],blocked:[[3,7]]}, [[0,3],[7,10]], '中间扣除产生两个片段', true),
      check('interval_difference.normal', 'baseline', {base:[0,10],blocked:[[2,4],[6,8]]}, [[0,2],[4,6],[8,10]], '多个分离禁用区间'),
      check('interval_difference.covered', 'constraint', {base:[0,10],blocked:[[-2,20]]}, [], '完全覆盖后返回空集合'),
      check('interval_difference.touching', 'boundary', {base:[0,10],blocked:[[-5,0],[10,15]]}, [[0,10]], '相接的外部区间不能扣除端点或产生空段')
    ]),
  task('version_sort', '数值版本稳定排序', 'ordered-selection',
    'input 是 {id,version} 记录数组；id 为字符串，version 恰有三个以点分隔的非负十进制整数，每个值不超过 1000000，可以有前导零。按 major、minor、patch 的数值升序排列，返回 id 数组；数值版本相等时保持原输入顺序。这里只处理上述格式，不处理 prerelease。',
    `function solve(input) {\n  return input.slice().sort((a, b) => a.version < b.version ? -1 : a.version > b.version ? 1 : 0).map(x => x.id);\n}`, 'defective', [
      check('version_sort.smoke', 'baseline', [{id:'b',version:'2.0.0'},{id:'a',version:'1.0.0'}], ['a','b'], '主版本升序', true),
      check('version_sort.normal', 'baseline', [{id:'c',version:'1.2.3'},{id:'a',version:'1.1.0'},{id:'b',version:'1.2.0'}], ['a','b','c'], '普通次版本和补丁顺序'),
      check('version_sort.stable', 'constraint', [{id:'z',version:'1.2.3'},{id:'a',version:'1.2.3'}], ['z','a'], '相同版本保持输入顺序'),
      check('version_sort.multi_digit', 'boundary', [{id:'ten',version:'1.10.0'},{id:'two',version:'1.2.0'},{id:'nine',version:'1.9.0'}], ['two','nine','ten'], '多位版本号使用数值比较')
    ]),
  task('cursor_page', '复合游标分页', 'ordered-selection',
    'input={rows:[{id,score},...],after:null或{id,score},limit}。id 为唯一字符串，score 为有限整数，limit 为非负整数。顺序是 score 降序、同分时 id 按 JavaScript 字符串 < / > 的 UTF-16 码元顺序升序。返回排在 after 游标之后（严格排除游标本身）的前 limit 个 id；游标可以不在 rows 中；after 为 null 从头开始。不得先截取 limit 再过滤游标。',
    `function solve(input) {\n  const compare = (a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);\n  return input.rows.slice().sort(compare)\n    .filter(row => input.after === null || compare(row, input.after) > 0)\n    .slice(0, input.limit).map(row => row.id);\n}`, 'correct', [
      check('cursor_page.smoke', 'baseline', {rows:[{id:'b',score:2},{id:'a',score:3}],after:null,limit:1}, ['a'], '无游标时按分数取首页', true),
      check('cursor_page.normal', 'baseline', {rows:[{id:'a',score:3},{id:'b',score:2},{id:'c',score:1}],after:{id:'a',score:3},limit:2}, ['b','c'], '游标之后取完整下一页'),
      check('cursor_page.zero', 'constraint', {rows:[{id:'a',score:3}],after:null,limit:0}, [], '零条数返回空页'),
      check('cursor_page.absent_tie', 'boundary', {rows:[{id:'a',score:4},{id:'c',score:4},{id:'d',score:2}],after:{id:'b',score:4},limit:2}, ['c','d'], '不存在的同分游标仍按完整排序键定位')
    ])
];
