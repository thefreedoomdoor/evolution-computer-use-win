/**
 * 静态所有权回归：设置插件卸载时必须只释放 activity/routes 自己的订阅，
 * 不能 dispose 仍被 gateway/probe 引用的进程级 multi-mouse runtime。
 * （不加载 index.js，避免测试环境依赖 DSH profile 的 @deepseek-ai/schemastery。）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../plugin/lib/index.js', import.meta.url), 'utf8')

test('settings plugin never disposes the shared multi-mouse runtime', () => {
  assert.equal(/multiMouse\s*\.\s*dispose\s*\(/.test(source), false, '不得调用 runtime.dispose()')
  assert.match(source, /本插件不注册 runtime\.dispose/)
  assert.match(source, /ctx\.on\('dispose', \(\) => disposers\.forEach\(drop\)\)/, 'routes 仍释放自己的注册')
})
