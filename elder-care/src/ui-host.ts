// 照护界面插件的宿主（Node）半侧。
// 界面本身在浏览器半侧 ui/client.js 里。这里做两件事：
//   1. 给 dsh 的插件加载器一行可挂载的入口，client-modules 才会把 ui/client.js 发给浏览器；
//   2. 把 data/patients/*.json 生成为数据分块 ui/client.patients.js，
//      浏览器用 require.async("./client.patients.js") 取到老人档案（dsh 没有现成的通道把任意文件传给浏览器）。
// client.patients.js 是生成文件，不要手改；服务运行期间改了档案，打开着的页面会自动更新。
import { readdirSync, readFileSync, utimesSync, watch, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'care-ui'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PATIENTS_DIR = join(ROOT, 'data', 'patients')
const CHUNK_PATH = join(ROOT, 'ui', 'client.patients.js')
const CLIENT_PATH = join(ROOT, 'ui', 'client.js')

function generate() {
  const patients: Record<string, unknown> = {}
  for (const file of readdirSync(PATIENTS_DIR).filter(f => f.endsWith('.json')).sort()) {
    try {
      const profile = JSON.parse(readFileSync(join(PATIENTS_DIR, file), 'utf8'))
      patients[typeof profile.id === 'string' ? profile.id : file.slice(0, -5)] = profile
    } catch {
      // 写到一半或格式有误的档案先跳过，等下一次文件变化再生成。
    }
  }
  const content = [
    '// 由 src/ui-host.ts 根据 data/patients/*.json 自动生成，不要手改。',
    'window.__ModuleLoader__.load({',
    '\tid: "dsh-elder-care",',
    '\tchunk: "client.patients.js",',
    `\tfactory: () => ({ patients: ${JSON.stringify(patients)} })`,
    '});',
    '',
  ].join('\n')
  let current = ''
  try {
    current = readFileSync(CHUNK_PATH, 'utf8')
  } catch {
    // 第一次生成。
  }
  if (current === content) return
  writeFileSync(CHUNK_PATH, content)
  // 分块的地址只带 client.js 的修订号（由它的修改时间算出），而且浏览器会长期缓存。
  // 所以档案变了以后要顺带更新 client.js 的修改时间：地址随之改变，打开着的页面也会热重载拿到新档案。
  const now = new Date()
  utimesSync(CLIENT_PATH, now, now)
}

export function apply(ctx: Context) {
  generate()
  ctx.effect(() => {
    let timer: NodeJS.Timeout | undefined
    const watcher = watch(PATIENTS_DIR, () => {
      clearTimeout(timer)
      timer = setTimeout(generate, 200)
    })
    return () => {
      clearTimeout(timer)
      watcher.close()
    }
  }, 'care-ui: patient data chunk')
}
