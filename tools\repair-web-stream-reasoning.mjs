#!/usr/bin/env node
/**
 * 修复被“实时思考流”污染的 dsh 会话日志。
 *
 * 事故（2026-09-25）：插件的实时增量轮询在镜像捕获到非对话流（状态/心跳通道）时，
 * 把原始 SSE 响应体（"event: ready data: {"request_message_id":…}"）当作正文增量
 * 灌进了 assistant 消息的 reasoning（思考）块并被会话日志持久化，导致对话视图
 * 渲染异常、看起来“历史丢失”。
 *
 * 本脚本：
 * 1. 解码 session.v3.jsonl.zstd（多帧 zstd 拼接）；
 * 2. 清理 assistant/message 事件里被污染的 reasoning 块与 stream 记录
 *   （只删匹配原始流特征的 reasoning，正常思考与全部正文/工具调用原样保留）；
 * 3. 逐行重新 zstd 压缩写回（原文件自动备份为 *.bak-<时间戳>）。
 *
 * 用法：
 *   node repair-web-stream-reasoning.mjs            # 扫描两个数据目录并修复
 *   node repair-web-stream-reasoning.mjs <file>...  # 只处理指定日志文件
 */
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
// 与插件 playwright-channel.ts 的 POLLUTION_PATTERN 保持一致
const POLLUTION = /(^|\n)\s*(event:\s*\w+|data:\s*\{)|request_message_id/
const isPolluted = (text) => POLLUTION.test(String(text ?? '').slice(0, 4000))

function decodeAll(buf) {
  const frames = []
  let start = buf.indexOf(MAGIC)
  if (start < 0) return ''
  let next = buf.indexOf(MAGIC, start + 4)
  while (next >= 0) {
    frames.push(buf.subarray(start, next))
    start = next
    next = buf.indexOf(MAGIC, start + 4)
  }
  frames.push(buf.subarray(start))
  let out = ''
  for (const frame of frames) {
    try { out += zlib.zstdDecompressSync(frame).toString('utf8') } catch { /* 跳过坏帧 */ }
  }
  return out
}

function cleanLine(line) {
  let event
  try { event = JSON.parse(line) } catch { return { line, cleaned: false } }
  if (event.type !== 'assistant/message') return { line, cleaned: false }
  const data = event.data
  if (!data) return { line, cleaned: false }
  let cleaned = false

  const message = data.message
  if (message && Array.isArray(message.content)) {
    const before = message.content.length
    message.content = message.content.filter(block => {
      if (block.type === 'reasoning' && isPolluted(block.text)) return false
      return true
    })
    if (message.content.length !== before) cleaned = true
  }

  if (Array.isArray(data.stream)) {
    // 先找出被判定为污染的 reasoning 块序号，再统一过滤
    const pollutedIndexes = new Set()
    for (const record of data.stream) {
      if (record.type === 'reasoning-chunks' && isPolluted((record.texts ?? []).join(''))) {
        pollutedIndexes.add(record.index)
      }
      if (record.type === 'chunk' && record.chunk?.type === 'block-end'
        && record.chunk.block?.type === 'reasoning'
        && isPolluted(record.chunk.block.text)) {
        pollutedIndexes.add(record.chunk.block ? record.chunk.index : undefined)
      }
    }
    const before = data.stream.length
    data.stream = data.stream.filter(record => {
      if (record.type === 'reasoning-chunks' && pollutedIndexes.has(record.index)) return false
      if (record.type === 'chunk' && record.chunk?.type === 'block-start'
        && record.chunk.blockType === 'reasoning' && pollutedIndexes.has(record.chunk.index)) return false
      if (record.type === 'chunk' && record.chunk?.type === 'block-end'
        && record.chunk.block?.type === 'reasoning' && pollutedIndexes.has(record.chunk.index)) return false
      return true
    })
    if (data.stream.length !== before) cleaned = true
  }

  return { line: JSON.stringify(event), cleaned }
}

function repairFile(file) {
  const original = fs.readFileSync(file)
  const text = decodeAll(original)
  if (!text) return { file, changed: false, reason: '空/不可解码' }
  const lines = text.split('\n').filter(l => l.trim().length > 0)
  const cleanedLines = []
  let cleanedCount = 0
  for (const line of lines) {
    const result = cleanLine(line)
    if (result.cleaned) cleanedCount++
    cleanedLines.push(result.line)
  }
  if (cleanedCount === 0) return { file, changed: false, cleanedCount }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  fs.copyFileSync(file, `${file}.bak-${stamp}`)
  // 与 harness 写入行为一致：每条事件一个带校验和的独立 zstd 帧，
  // 且每行必须以 \n 结尾（harness 断言第一帧 = 恰好一行 + 换行）
  const parts = []
  for (const line of cleanedLines) {
    const payload = line.endsWith('\n') ? line : `${line}\n`
    parts.push(zlib.zstdCompressSync(Buffer.from(payload, 'utf8'), {
      params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
    }))
  }
  fs.writeFileSync(file, Buffer.concat(parts))
  return { file, changed: true, cleanedCount, backup: `${file}.bak-${stamp}` }
}

function walk(dir, files) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, files)
    else if (entry.name === 'session.v3.jsonl.zstd') files.push(p)
  }
}

const home = process.env.DSH_HOME
  ?? path.join(process.env.USERPROFILE ?? os.homedir(), '.dsh')
const targets = process.argv.slice(2)
const files = []
if (targets.length > 0) {
  files.push(...targets)
} else {
  walk(path.join(home, 'sessions'), files)
}

let changedTotal = 0
for (const file of [...new Set(files)]) {
  const result = repairFile(file)
  if (result.changed) {
    changedTotal++
    console.log(`已修复 ${result.cleanedCount} 条事件: ${file}\n  备份: ${result.backup}`)
  } else {
    console.log(`无需处理: ${file} (${result.reason ?? '无污染'})`)
  }
}
console.log(changedTotal === 0 ? '全部干净，无需修复。' : `共修复 ${changedTotal} 个文件。`)
