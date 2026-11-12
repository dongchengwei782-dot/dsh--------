// 项目内的 dsh 启动入口：不依赖全局安装，也不读写用户目录下的 ~/.dsh。
//   - DSH_HOME 指向项目里的 .dsh-home（profile、会话记录、密钥都在这里）；
//   - 把项目 node_modules/.bin 放到 PATH 最前面，`dsh plugin` 调用的 pnpm 用项目里装的那份。
// 用法：node scripts/dsh.mjs <dsh 参数...>，例如 node scripts/dsh.mjs web
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
if (!existsSync(bin)) {
  console.error('没有找到项目内的 dsh。请先在项目根目录运行：npm install')
  process.exit(1)
}

const home = process.env.DSH_HOME || join(root, '.dsh-home')
mkdirSync(home, { recursive: true })

// Windows 上环境变量名可能是 Path 而不是 PATH，沿用已有的那个键。
const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
const env = {
  ...process.env,
  DSH_HOME: home,
  [pathKey]: [join(root, 'node_modules', '.bin'), process.env[pathKey]].filter(Boolean).join(delimiter),
}

const child = spawn(process.execPath, [bin, ...process.argv.slice(2)], { stdio: 'inherit', env, cwd: root })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0))
