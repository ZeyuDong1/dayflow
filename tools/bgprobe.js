// 注入：报告 body/html 计算背景与 :has 匹配
const js = `
(() => {
  const b = getComputedStyle(document.body).backgroundImage.slice(0, 60)
  const has = document.body.querySelector('.ow-root') ? 'ow-root-present' : 'no-ow-root'
  document.title = 'BG[' + has + '|' + b + ']'
})()
`
process.env.DAYFLOW_SHOT_JS = js
