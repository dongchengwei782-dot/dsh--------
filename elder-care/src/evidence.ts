// 医学证据检索工具（原型版）。
// 从 data/evidence/*.md 读取资料，按二级标题切成片段，用关键词重合度做本地检索。
// 之后可以把这里的检索换成向量检索或外部知识库，工具的名称和返回格式保持不变。
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'care-medical-evidence'
export const inject = ['tools']

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'evidence')

interface Chunk {
  doc: string
  source: string
  version: string
  url: string
  section: string
  text: string
}

async function loadChunks(): Promise<Chunk[]> {
  const chunks: Chunk[] = []
  const files = (await readdir(DATA_DIR)).filter(f => f.endsWith('.md')).sort()
  for (const file of files) {
    const raw = await readFile(join(DATA_DIR, file), 'utf8')
    const meta: Record<string, string> = {}
    let section = ''
    let buffer: string[] = []
    const flush = () => {
      const text = buffer.join('\n').trim()
      if (section && text) {
        chunks.push({
          doc: file,
          source: meta['来源'] ?? file,
          version: meta['版本'] ?? '未注明',
          url: meta['链接'] ?? '',
          section,
          text,
        })
      }
      buffer = []
    }
    for (const line of raw.split(/\r?\n/)) {
      const metaMatch = /^>\s*(来源|版本|链接|说明)[:：]\s*(.+)$/.exec(line)
      if (metaMatch) {
        meta[metaMatch[1]] = metaMatch[2].trim()
        continue
      }
      if (line.startsWith('## ')) {
        flush()
        section = line.slice(3).trim()
        continue
      }
      if (line.startsWith('# ')) continue
      buffer.push(line)
    }
    flush()
  }
  return chunks
}

// 查询拆成检索词：英文按单词，中文按相邻两个字。
function terms(query: string): string[] {
  const out = new Set<string>()
  for (const word of query.toLowerCase().match(/[a-z0-9]+/g) ?? []) out.add(word)
  for (const run of query.match(/[一-鿿]+/g) ?? []) {
    if (run.length === 1) out.add(run)
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2))
  }
  return [...out]
}

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'search_medical_evidence',
    description:
      '检索本地医学资料库（药品说明书摘要、用药须知、指南要点），返回最相关的资料片段及其出处、版本和链接。'
      + '回答任何医学事实之前先调用本工具；资料库里查不到时，如实说明没有找到依据。',
    parameters: {
      query: { type: 'string', required: true, description: '检索内容，例如"华法林 布洛芬 合用 出血"' },
      limit: { type: 'number', description: '最多返回几个片段，默认 3' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const chunks = await loadChunks()
      const queryTerms = terms(args.query)
      const limit = Math.max(1, Math.min(8, Math.floor(args.limit ?? 3)))
      const scored = chunks
        .map(chunk => {
          const haystack = `${chunk.section}\n${chunk.text}`.toLowerCase()
          const score = queryTerms.filter(term => haystack.includes(term)).length
          return { chunk, score }
        })
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
      if (scored.length === 0) {
        return `资料库中没有找到与"${args.query}"相关的片段。当前资料库共 ${chunks.length} 个片段。`
      }
      return scored
        .map(({ chunk }, index) => [
          `【片段 ${index + 1}】${chunk.section}`,
          `出处：${chunk.source}`,
          `版本：${chunk.version}`,
          chunk.url ? `链接：${chunk.url}` : '',
          `内容：${chunk.text}`,
        ].filter(Boolean).join('\n'))
        .join('\n\n')
    },
  }))
}
