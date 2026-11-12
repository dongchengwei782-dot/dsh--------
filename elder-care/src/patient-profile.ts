// 老人档案读取工具（原型版）。
// 现在只是读取 data/patients/<编号>.json，是之后"患者长期记忆"的占位：
// 每条事实已经带有来源、确认状态和时间，之后换成记忆服务时返回格式不用变。
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'care-patient-profile'
export const inject = ['tools']

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'patients')

interface Fact {
  id: string
  type: string
  content: string
  status: string
  source: string
  recordedAt: string
  validFrom?: string
  validTo?: string
}

interface Profile {
  id: string
  displayName: string
  age: number
  sex: string
  facts: Fact[]
}

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'read_patient_profile',
    description:
      '读取老人档案中已记录的事实（疾病、在用药物、过敏、监测、生活方式），每条带确认状态、来源和记录时间。'
      + '只有状态为"已确认"的事实可以当作确定信息使用；用户在本次对话里新说的情况不在档案中，属于待确认信息。',
    parameters: {
      patient_id: { type: 'string', description: '老人编号，默认 elder-a' },
      type: { type: 'string', description: '只看某一类事实：疾病、用药、过敏、监测、生活方式；不填则返回全部' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const id = (args.patient_id ?? 'elder-a').trim() || 'elder-a'
      if (!/^[a-z0-9-]+$/.test(id)) return `老人编号"${id}"格式不正确，只能包含小写字母、数字和连字符。`
      let profile: Profile
      try {
        profile = JSON.parse(await readFile(join(DATA_DIR, `${id}.json`), 'utf8')) as Profile
      } catch {
        return `没有找到编号为"${id}"的老人档案。`
      }
      const facts = profile.facts.filter(fact => !args.type || fact.type === args.type)
      const lines = facts.map(fact => {
        const since = fact.validFrom ? `${fact.validFrom} 起` : '起始时间未知'
        const validity = fact.validTo ? `${since}，至 ${fact.validTo} 失效` : `${since}，当前有效`
        return `- [${fact.id}] ${fact.type}：${fact.content}｜状态：${fact.status}｜来源：${fact.source}｜记录时间：${fact.recordedAt}｜有效期：${validity}`
      })
      return [
        `老人档案 ${profile.id}（${profile.displayName}，${profile.age} 岁，${profile.sex}）`,
        facts.length ? lines.join('\n') : '没有符合条件的记录。',
      ].join('\n')
    },
  }))
}
