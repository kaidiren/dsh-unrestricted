import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionEnabled } from '../src/rules.js'

const top = (id) => ({ id, origin: undefined, parent: undefined })
const child = (id, parent) => ({ id, origin: 'subagent', parent })

test('未开启的会话使用原版提示词（默认关闭）', () => {
  assert.equal(sessionEnabled(undefined, top('s1')), false)
  assert.equal(sessionEnabled({}, top('s1')), false)
  assert.equal(sessionEnabled({ s2: true }, top('s1')), false)
  assert.equal(sessionEnabled(null, top('s1')), false)
})

test('显式开启的会话才融合破限规则', () => {
  assert.equal(sessionEnabled({ s1: true }, top('s1')), true)
  assert.equal(sessionEnabled({ s1: false }, top('s1')), false)
})

test('子代理继承父会话的开关', () => {
  assert.equal(sessionEnabled({ s1: true }, child('sub-1', 's1')), true)
  assert.equal(sessionEnabled({ s1: true }, child('sub-1', 's2')), false)
  assert.equal(sessionEnabled({}, child('sub-1', 's1')), false)
})

test('子代理的显式条目覆盖继承', () => {
  assert.equal(sessionEnabled({ s1: true, 'sub-1': false }, child('sub-1', 's1')), false)
  assert.equal(sessionEnabled({ s1: false, 'sub-1': true }, child('sub-1', 's1')), true)
})

test('普通分叉会话不因父会话字段而被继承', () => {
  assert.equal(sessionEnabled({ s1: true }, { id: 'fork-1', origin: undefined, parent: 's1' }), false)
})
