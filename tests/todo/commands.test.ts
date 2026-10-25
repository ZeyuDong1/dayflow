import { describe, it, expect } from 'vitest'
import { parseCommand } from '../../src/main/todo/commands'

describe('parseCommand', () => {
  it('空输入', () => {
    expect(parseCommand('')).toEqual({ type: 'EMPTY' })
    expect(parseCommand('   ')).toEqual({ type: 'EMPTY' })
  })

  it('MEMO：> 开头，余文为备注（后续规则不再执行）', () => {
    expect(parseCommand('> 备注内容')).toEqual({ type: 'MEMO', memo: '备注内容' })
    expect(parseCommand('>时间@5m $x')).toEqual({ type: 'MEMO', memo: '时间@5m $x' })
  })

  it('SUSPEND 推断：CREATE/FOCUS 且 main 空且有时间', () => {
    expect(parseCommand('@25m')).toEqual({ type: 'SUSPEND', time: 1500 })
    expect(parseCommand('@ 25m')).toEqual({ type: 'SUSPEND', time: 1500 })
    expect(parseCommand('@7')).toEqual({ type: 'SUSPEND', time: 420 }) // 缺省单位=分钟
    expect(parseCommand('@2h')).toEqual({ type: 'SUSPEND', time: 7200 })
    expect(parseCommand('@45s')).toEqual({ type: 'SUSPEND', time: 45 })
    expect(parseCommand('!@25m')).toEqual({ type: 'SUSPEND', time: 1500 })
  })

  it('REMINDER 推断：CREATE 且 main 非空且有时间', () => {
    expect(parseCommand('洗衣服@5m')).toEqual({ type: 'REMINDER', main: '洗衣服', time: 300 })
    expect(parseCommand('task @ 25m')).toEqual({ type: 'REMINDER', main: 'task', time: 1500 })
  })

  it('类型前缀', () => {
    expect(parseCommand('+ ratio 3:2')).toEqual({ type: 'REMINDER', main: 'ratio 3:2' }) // 冒号原样保留
    expect(parseCommand('+ 提醒 @10m')).toEqual({ type: 'REMINDER', main: '提醒', time: 600 })
    expect(parseCommand('%训练模型')).toEqual({ type: 'TRAINING', main: '训练模型' })
    expect(parseCommand('#query词')).toEqual({ type: 'COMPLETE', query: 'query词' })
    expect(parseCommand('!写代码')).toEqual({ type: 'FOCUS', main: '写代码' })
    expect(parseCommand('买牛奶')).toEqual({ type: 'CREATE', main: '买牛奶' })
  })

  it('子任务语法（仅 FOCUS/CREATE）：第一个冒号劈出 parentSearch', () => {
    expect(parseCommand('子 : 父搜索')).toEqual({ type: 'CREATE', main: '子', isSubtask: true, parentSearch: '父搜索' })
    expect(parseCommand('child:')).toEqual({ type: 'CREATE', main: 'child', isSubtask: true })
    expect(parseCommand('! child:parent')).toEqual({ type: 'FOCUS', main: 'child', isSubtask: true, parentSearch: 'parent' })
  })

  it('项目 $ 与 GPU 反引号（CREATE/FOCUS 带 GPU 升级 TRAINING）', () => {
    expect(parseCommand('fix bug $EpochToDo')).toEqual({ type: 'CREATE', main: 'fix bug', project: 'EpochToDo' })
    expect(parseCommand('任务 `4090')).toEqual({ type: 'TRAINING', main: '任务', gpu: '4090' })
    expect(parseCommand('! 跑实验 `A100')).toEqual({ type: 'TRAINING', main: '跑实验', gpu: 'A100' })
    expect(parseCommand('+ status update `A100')).toEqual({ type: 'REMINDER', main: 'status update', gpu: 'A100' })
    expect(parseCommand('%模型 `A100')).toEqual({ type: 'TRAINING', main: '模型', gpu: 'A100' })
  })

  it('main/sub 按首个 ! 切分；时间 token 只删第一个', () => {
    expect(parseCommand('任务!上下文')).toEqual({ type: 'CREATE', main: '任务', sub: '上下文' })
    expect(parseCommand('a @1m @2m')).toEqual({ type: 'REMINDER', main: 'a @2m', time: 60 })
  })

  it('水槽用例：! finetune bert`A100 @90m $LLM!v2', () => {
    expect(parseCommand('! finetune bert`A100 @90m $LLM!v2')).toEqual({
      type: 'TRAINING',
      main: 'finetune bert',
      sub: 'v2',
      time: 5400,
      gpu: 'A100',
      project: 'LLM',
    })
  })
})
