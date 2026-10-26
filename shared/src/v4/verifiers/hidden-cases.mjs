// Acceptance-only fixtures. Never expose this module through the runtime task catalogue or feedback.
export const HIDDEN_CASES = {
  tuple_dedup: [
    {id:'tuple_dedup.hidden.empty',input:[],expected:[]},
    {id:'tuple_dedup.hidden.collisions',input:[['|',''],['','|'],['|',''],['||','']],expected:[['|',''],['','|'],['||','']]},
    {id:'tuple_dedup.hidden.unicode',input:[['甲','乙'],['甲','乙'],['甲乙',''],['','甲乙']],expected:[['甲','乙'],['甲乙',''],['','甲乙']]},
    {id:'tuple_dedup.hidden.special',input:[['constructor','prototype'],['__proto__',''],['constructor','prototype']],expected:[['constructor','prototype'],['__proto__','']]}
  ],
  tuple_counts: [
    {id:'tuple_counts.hidden.empty',input:[],expected:[]},
    {id:'tuple_counts.hidden.escaping',input:[['"','\\'],['"','\\'],['\\','"']],expected:[{pair:['"','\\'],count:2},{pair:['\\','"'],count:1}]},
    {id:'tuple_counts.hidden.unicode',input:[['甲','乙'],['甲乙',''],['甲','乙'],['甲乙','']],expected:[{pair:['甲','乙'],count:2},{pair:['甲乙',''],count:2}]},
    {id:'tuple_counts.hidden.special',input:[['toString','x'],['constructor','x'],['toString','x']],expected:[{pair:['toString','x'],count:2},{pair:['constructor','x'],count:1}]}
  ],
  interval_union: [
    {id:'interval_union.hidden.empty',input:[],expected:[]},
    {id:'interval_union.hidden.chain',input:[[8,11],[-3,0],[0,4],[4,8]],expected:[[-3,11]]},
    {id:'interval_union.hidden.enclosure',input:[[2,3],[0,10],[4,5],[-2,0],[12,13]],expected:[[-2,10],[12,13]]},
    {id:'interval_union.hidden.gap',input:[[-10,-8],[-7,-3],[-5,0]],expected:[[-10,-8],[-7,0]]}
  ],
  interval_difference: [
    {id:'interval_difference.hidden.empty',input:{base:[-5,5],blocked:[]},expected:[[-5,5]]},
    {id:'interval_difference.hidden.overlap',input:{base:[0,20],blocked:[[12,16],[4,9],[7,14],[4,9]]},expected:[[0,4],[16,20]]},
    {id:'interval_difference.hidden.edges',input:{base:[0,10],blocked:[[-4,2],[8,20]]},expected:[[2,8]]},
    {id:'interval_difference.hidden.adjacent',input:{base:[0,9],blocked:[[2,4],[4,7]]},expected:[[0,2],[7,9]]}
  ],
  version_sort: [
    {id:'version_sort.hidden.empty',input:[],expected:[]},
    {id:'version_sort.hidden.numeric',input:[{id:'a',version:'10.0.0'},{id:'b',version:'2.0.9'},{id:'c',version:'2.0.10'}],expected:['b','c','a']},
    {id:'version_sort.hidden.leading_zero',input:[{id:'first',version:'01.002.3'},{id:'second',version:'1.2.03'},{id:'before',version:'1.2.2'}],expected:['before','first','second']},
    {id:'version_sort.hidden.tie',input:[{id:'c',version:'0.0.0'},{id:'b',version:'0.0.0'},{id:'a',version:'0.0.0'}],expected:['c','b','a']}
  ],
  cursor_page: [
    {id:'cursor_page.hidden.empty',input:{rows:[],after:{id:'a',score:1},limit:4},expected:[]},
    {id:'cursor_page.hidden.tie',input:{rows:[{id:'c',score:8},{id:'a',score:8},{id:'b',score:8},{id:'d',score:1}],after:{id:'b',score:8},limit:2},expected:['c','d']},
    {id:'cursor_page.hidden.absent',input:{rows:[{id:'a',score:9},{id:'b',score:4},{id:'c',score:-1}],after:{id:'z',score:7},limit:2},expected:['b','c']},
    {id:'cursor_page.hidden.code_units',input:{rows:[{id:'ä',score:2},{id:'z',score:2},{id:'A',score:2}],after:{id:'A',score:2},limit:9},expected:['z','ä']}
  ]
};
