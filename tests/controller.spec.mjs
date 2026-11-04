import assert from 'node:assert/strict'
import test from 'node:test'
import { createUnrestrictedController } from '../src/client/controller.ts'

const settle = () => new Promise(setImmediate)
const status = (version, sessions = ['s1']) => ({ sessions, version, modes: {} })

/** 保留真实控制器，仅控制设置提交、配置事件和 RPC 的完成时序。 */
async function fixture() {
  let value = { sessions: { s1: true } }
  const subscribers = new Set()
  const events = new Map()
  const pending = {
    status: [],
    recheck: [],
    preview: [],
    write: [],
  }
  function defer(endpoint, payload) {
    return new Promise((resolve, reject) => pending[endpoint].push({ payload, resolve, reject }))
  }
  const settings = {
    getSnapshot: () => ({ status: 'ready', writable: true, value }),
    subscribe(listener) {
      subscribers.add(listener)
      return () => subscribers.delete(listener)
    },
    set: (field, next) => defer('write', { field, next }),
  }
  const ctx = {
    get: () => ({ rpc: { call: (_channel, endpoint, payload) => defer(endpoint, payload) } }),
    configForms: { get: () => settings },
    remote: { $on(event, listener) { events.set(event, listener); return () => events.delete(event) } },
    effect: effect => effect(),
  }
  const controller = createUnrestrictedController(ctx)
  const face = controller.face()
  const root = controller.composer('s1')
  const answer = (request, value) => request.resolve({ ok: true, value })
  answer(pending.status.shift(), status('0.2.6'))
  await settle()
  return {
    face,
    root,
    take: (endpoint) => {
      const request = pending[endpoint].shift()
      assert.ok(request, `missing ${endpoint} request`)
      return request
    },
    answer,
    view: () => face.hooks.view.getSnapshot(),
    composer: (sessionId) => controller.composer(sessionId).hooks.unrestrictedSession.getSnapshot(),
    documentUpdated: () => events.get('settings/document-updated')('unrestricted'),
    commitSessions(sessions) {
      value = { sessions }
      for (const listener of subscribers) listener()
      events.get('settings/document-updated')('unrestricted')
    },
  }
}

test('刷新或重检后，迟到的旧预览不能覆盖已显示的新正文', async () => {
  for (const action of ['refresh', 'recheck']) {
    const f = await fixture()
    const previous = f.face.loadPreview('standard')
    const previousRequest = f.take('preview')
    assert.equal(f.view().busy, false, '加载预览时界面允许刷新和重检')
    const updating = f.face[action]()
    f.answer(f.take(action === 'refresh' ? 'status' : 'recheck'), status('0.2.6'))
    await updating
    assert.equal(f.view().previews.standard, undefined)

    // 卡片在打开的预览失效后通过 effect 自动发起这一请求。
    const current = f.face.loadPreview('standard')
    f.answer(f.take('preview'), { available: true, text: 'current prompt' })
    await current
    f.answer(previousRequest, { available: true, text: 'obsolete prompt' })
    await previous
    assert.equal(f.view().previews.standard.preview.text, 'current prompt', action)
  }
})

test('失效预览的迟到错误不影响新请求，不同预设分别接收自己的结果', async () => {
  const f = await fixture()
  const previous = f.face.loadPreview('standard')
  const previousRequest = f.take('preview')
  const updating = f.face.refresh()
  f.answer(f.take('status'), status('0.2.6'))
  await updating
  const current = f.face.loadPreview('standard')
  const currentRequest = f.take('preview')
  const otherPreset = f.face.loadPreview('ptc')
  f.answer(f.take('preview'), { available: true, text: 'ptc prompt' })
  await otherPreset
  previousRequest.reject(new Error('obsolete preview failure'))
  await previous
  assert.equal(f.view().previews.standard.status, 'loading')
  assert.equal(f.view().previews.ptc.preview.text, 'ptc prompt')
  f.answer(currentRequest, { available: true, text: 'standard prompt' })
  await current
  assert.equal(f.view().previews.standard.preview.text, 'standard prompt')
})

test('配置事件与手动刷新重叠时保留新状态，所有请求结束后才解除忙碌', async () => {
  for (const outcome of ['success', 'failure']) {
    const f = await fixture()
    const older = f.face.refresh()
    const olderRequest = f.take('status')
    f.documentUpdated()
    f.answer(f.take('status'), status('0.2.6'))
    await settle()
    assert.equal(f.view().busy, true)
    if (outcome === 'success') f.answer(olderRequest, status('0.2.5'))
    else olderRequest.reject(new Error('obsolete status failure'))
    await older
    assert.equal(f.view().status.version, '0.2.6')
    assert.equal(f.view().message, undefined)
    assert.equal(f.view().busy, false)
  }
})

test('会话开关只写该会话的键，关闭时删除键而不是写 false', async () => {
  const f = await fixture()
  const preview = f.face.loadPreview('standard')
  const previewRequest = f.take('preview')

  const writing = f.face.setSessionEnabled('s2', true)
  const write = f.take('write')
  assert.equal(write.payload.field, 'sessions')
  assert.deepEqual(write.payload.next, { s1: true, s2: true })

  // 写入还在途中时，配置事件已把新会话带回；旧预览必须已失效。
  f.commitSessions({ s1: true, s2: true })
  assert.deepEqual(f.view().sessions, { s1: true, s2: true })
  assert.equal(f.view().previews.standard, undefined)
  assert.equal(f.composer('s2').enabled, true)
  assert.equal(f.composer('s1').enabled, true)
  f.answer(previewRequest, { available: true, text: 'before toggle' })
  await preview
  assert.equal(f.view().previews.standard, undefined)

  f.answer(f.take('status'), status('0.2.6', ['s1', 's2']))
  write.resolve(true)
  await settle()
  assert.equal(f.view().busy, true, '配置事件的读取结束后，写入仍在等待应答')
  f.answer(f.take('status'), status('0.2.6', ['s1', 's2']))
  await writing
  assert.equal(f.view().busy, false)
  assert.deepEqual(f.view().sessions, { s1: true, s2: true })

  // 关闭：键被删除，宿主侧因此回到「未开启」默认。
  const disabling = f.face.setSessionEnabled('s1', false)
  const disable = f.take('write')
  assert.deepEqual(disable.payload.next, { s2: true })
  disable.resolve(true)
  await settle()
  f.answer(f.take('status'), status('0.2.6', ['s2']))
  await disabling
  f.commitSessions({ s2: true })
  assert.deepEqual(f.view().sessions, { s2: true })
  assert.equal(f.composer('s1').enabled, false)
})

test('会话开关状态跟随配置快照，未知会话默认关闭', async () => {
  const f = await fixture()
  assert.deepEqual(f.view().sessions, { s1: true })
  assert.equal(f.composer('s1').enabled, true)
  assert.equal(f.composer('never-toggled').enabled, false)

  f.commitSessions({})
  assert.deepEqual(f.view().sessions, {})
  assert.equal(f.composer('s1').enabled, false)
})
