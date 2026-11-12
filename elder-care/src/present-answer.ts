// 呈现答复工具：主智能体用它把最终答复交给界面，而不是写一大段文字。
// 答复被拆成结构化字段（结论级别、理由、依据、需医生决定的事项、待确认的新情况……），
// 界面插件（ui/client.js）读取这次调用的参数，渲染成答复卡片、右侧依据栏和急症横幅。
// 调用后本轮直接结束，主智能体不用再补一句话。
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'care-present-answer'
export const inject = ['tools']

const textList = (description: string) => ({ type: 'array', items: { type: 'string' }, description }) as const

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'present_care_answer',
    description:
      '把最终答复展示给老人或家属。所有面向用户的答复（包括追问和急症提示）都必须通过本工具给出，不要用普通文字作答。'
      + '调用后本轮自动结束。每个字段都用简短、通俗的中文，不用英文缩写。'
      + '所有文字内容里都不要出现英文双引号和换行；需要引用原话时用「」。',
    parameters: {
      level: {
        type: 'string',
        enum: ['info', 'caution', 'emergency'],
        required: true,
        description: '结论级别：info 一般说明或追问；caution 有风险、需要谨慎或先问医生药师；emergency 出现急症警示，需要立即就医或拨打 120。',
      },
      headline: { type: 'string', required: true, description: '一句话结论，20 字以内。例如：不建议自己给他吃布洛芬' },
      summary: { type: 'string', required: true, description: '一到两句话的说明。涉及用药决定时，在这里写明请先问医生或药师。' },
      reasons: {
        type: 'array',
        description: '为什么这样说。每条一个意思；evidence 填支持这条理由的依据编号（对应 evidence 数组，从 1 开始）。没有依据支持的内容不要写成理由。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            evidence: { type: 'array', items: { type: 'integer' } },
          },
        },
      },
      evidence: {
        type: 'array',
        description: '本次答复引用的依据，只能来自子智能体检索到的资料，不能凭记忆补充。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true, description: '资料名称，例如：布洛芬片药品标签' },
            source: { type: 'string', required: true, description: '出处机构，例如 DailyMed、NHS' },
            version: { type: 'string', description: '版本或日期' },
            quote: { type: 'string', description: '资料中的原句或贴近原文的摘句。只写句子本身，不要加任何引号（界面会自动加）。' },
          },
        },
      },
      profile_facts: textList('本次用到的档案记录编号，例如 f4 和 f5。只填状态为已确认的记录。'),
      actions: textList('现在可以做的事。急症时写去医院前后要做的事（带上药单、告诉医生什么）。'),
      warnings: textList('特别提醒，例如：不要自己停华法林，也不要自己改剂量'),
      needs_doctor: textList('需要医生或药师决定的事项（停药、换药、调整剂量、是否继续服用等）。只列出事项，不替他们决定。'),
      no_evidence: textList('目前没有找到依据的问题，如实列出。'),
      new_facts: {
        type: 'array',
        description: '用户在本次对话里新说的、档案里没有的情况（待确认信息）。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { type: 'string', required: true, description: '类别：症状、用药、监测、生活方式 等' },
            content: { type: 'string', required: true },
          },
        },
      },
      follow_up: {
        type: 'object',
        additionalProperties: false,
        description: '还需要向用户确认的最关键的一个问题。options 给出 2 到 4 个简短的可选回答，用户点一下就能回复。',
        properties: {
          question: { type: 'string', required: true },
          options: { type: 'array', items: { type: 'string' } },
        },
      },
      safety_rule: { type: 'string', description: 'level 为 emergency 时填写触发的警示，例如：服用抗凝药期间出现黑便' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(_args, exec) {
      // 答复已经完整地放在调用参数里，展示由界面完成；这里只负责结束本轮。
      exec.concludeTurn()
      return '答复已展示给用户，本轮结束。'
    },
  }))
}
