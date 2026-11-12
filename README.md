# 老年健康服务系统原型（基于 DeepSeek Harness）

第一版最小原型：一个照护主智能体加三个子智能体（知识检索、用药核查、照护计划），跑在开源的 DeepSeek Harness（下称 dsh）上。

- 自己写的代码都在 `elder-care/` 这一个组合包里，没有改动 dsh 本身。
- dsh 程序、配置、密钥、会话记录、工作区全部放在项目文件夹内，不需要全局安装，也不读写用户目录。整个文件夹可以拷到别的机器部署。

## 目录

```
dsh（养老照护医疗）/
├── README.md
├── start-elder-care.bat        Windows 双击启动；首次运行会自动安装依赖
├── scripts/dsh.mjs             启动入口：把 dsh 的数据目录指到 .dsh-home，并优先用项目内的 pnpm
├── package.json                项目依赖：dsh 0.2.2-rc.1、pnpm 12.18.0（版本锁定）
├── package-lock.json           npm 记录的精确依赖版本，保证每台机器装出来一样
├── .gitignore                  不提交 node_modules、密钥、会话记录、工作区
├── node_modules/               npm install 生成：dsh 程序本体和全部依赖，不用改、不用拷
│
├── elder-care/                 ★ 自己的代码：照护组合包
│   ├── package.json            组合包声明（dsh.bundle 指向下面的 patch）
│   ├── cordis.patch.yml        系统配置：4 个智能体的提示词和分工、接入的模型提供方、界面插件
│   ├── src/                    工具代码（智能体可调用的函数）
│   │   ├── evidence.ts         search_medical_evidence：检索本地医学资料
│   │   ├── patient-profile.ts  read_patient_profile：读取老人档案
│   │   ├── present-answer.ts   present_care_answer：主智能体用它交出结构化的最终答复
│   │   └── ui-host.ts          界面插件的宿主半侧：把老人档案生成为给浏览器用的数据分块
│   ├── ui/
│   │   ├── client.js           界面插件的浏览器半侧：照护模式的全部界面
│   │   └── client.patients.js  老人档案数据分块（自动生成，不要手改）
│   └── data/
│       ├── evidence/*.md       医学资料（3 份演示摘要，正式使用前要换成审核过的原文）
│       └── patients/elder-a.json  虚构的老人 A 档案
│
└── .dsh-home/                  dsh 数据目录（通过环境变量 DSH_HOME 指定）
    ├── profiles/web/           "web" 这套运行配置
    │   ├── package.json        装了哪些组合包；用相对路径 link:../../../elder-care 链接照护包
    │   ├── cordis.patch.yml    本机配置：默认工作区位置；网页"设置"里改的偏好也写在这里
    │   ├── cordis.yml、pnpm-*.yaml  dsh / pnpm 自动维护，不用动
    │   └── node_modules/、.plugin-manager/  自动生成
    ├── .env.example            密钥文件模板（不含密钥，可以随项目分发）
    ├── .env                    🔒 模型密钥（文件方式填写）
    ├── .credentials.yaml       🔒 网页里保存的密钥和浏览器登录凭证
    ├── .anonymous-user-id      dsh 的匿名设备编号
    ├── sessions/               🔒 对话记录
    ├── storages/               界面状态和工作区注册表（记的是本机绝对路径）
    └── deepseek-harness/default-workspace/  默认工作区：智能体读写文件的工作目录
```

标 🔒 的是本机私有内容，不要提交、拷给别人或随部署带走。

项目里有两个 `cordis.patch.yml`，分工不同：

| 文件 | 管什么 | 跟谁走 |
| --- | --- | --- |
| `elder-care/cordis.patch.yml` | 系统本身：智能体、提示词、模型提供方 | 跟着项目走，所有部署一致 |
| `.dsh-home/profiles/web/cordis.patch.yml` | 这一份部署：工作区位置、界面主题等偏好 | 本机层，排在照护包之后叠加 |

## 系统架构

一句话：基于插件化智能体框架（DeepSeek Harness）的层级式多智能体架构。

```
网页界面（浏览器）
  │
  ▼
dsh 宿主进程（Node.js + Cordis 插件框架）
  │
  ├─ 照护组合包 elder-care（自己写的）
  │    │
  │    ├─ 主智能体 care-lead：读档案、委派、汇总答复
  │    │    ├─ 子智能体 care-knowledge：知识检索
  │    │    ├─ 子智能体 care-med：用药核查
  │    │    └─ 子智能体 care-plan：照护计划
  │    │
  │    ├─ 工具
  │    │    ├─ read_patient_profile（src/patient-profile.ts）──▶ data/patients/*.json 老人档案
  │    │    ├─ search_medical_evidence（src/evidence.ts）─────▶ data/evidence/*.md 医学资料
  │    │    └─ present_care_answer（src/present-answer.ts）───▶ 结构化答复，交给界面渲染
  │    │
  │    └─ 界面插件 care-ui（ui/client.js）：只在照护会话里生效
  │
  └─ dsh 自带插件
       ├─ 网页服务、子智能体调度、会话存储、密钥管理
       └─ 模型路由 ──▶ 大模型接口（DeepSeek、Kimi、通义千问、智谱 GLM、小米 MiMo）
```

### 四个层面

1. **运行框架：DeepSeek Harness（dsh）**
   - Node.js 写的智能体框架，核心是 Cordis 插件加载器，其他功能（调用模型、存会话、网页界面、子智能体调度）全是插件。
   - **配置驱动**：系统由哪些插件、怎么组合，写在 `cordis.patch.yml` 里，按"dsh 自带配置 → 照护组合包 → 本机设置"的顺序叠加。
   - **B/S 结构**：后台是一个本地 Node 进程，用户在浏览器里使用。
2. **智能体组织：层级式多智能体（主管 + 工作者）**
   - 主智能体 `care-lead` 理解问题、读档案、决定委派给谁，最后汇总成面向家属的答复。
   - 三个子智能体各管一类专业任务，互相独立，可以并行。它们看不到原始对话，只拿到主智能体写的任务说明（问题、已确认事实、待确认的新情况）。
   - 每个智能体是一个 preset：人设提示词 + 允许使用的工具。
3. **工具与数据**
   - 三个工具是 TypeScript 插件，智能体通过工具调用（function calling）使用。
   - 结构化答复：主智能体不直接写大段文字，而是调用 `present_care_answer`，把结论级别、理由、依据、需医生决定的事项、待确认的新情况分字段交出来，界面据此渲染卡片。调用后本轮直接结束。
   - 资料检索：医学资料按二级标题切成片段，用关键词重合度检索，再交给模型作答，是检索增强生成（RAG）的雏形。
   - 老人档案：JSON 文件，每条事实带确认状态、来源和时间，是患者长期记忆的雏形。
4. **模型层：可替换**
   - dsh 的模型路由把"调用哪家模型"和智能体逻辑分开，切换模型不用改智能体和工具（见"可用的模型"）。

### 智能体分工

| 角色 | preset 编号 | 能用的工具 |
| --- | --- | --- |
| 照护主智能体 | `care-lead` | 读档案、委派子智能体、呈现答复 |
| 知识检索 | `care-knowledge` | 检索医学资料 |
| 用药核查 | `care-med` | 检索医学资料、读档案 |
| 照护计划 | `care-plan` | 检索医学资料、读档案 |

### 一次提问的处理过程

以"我爸膝盖疼，能吃布洛芬吗？"为例：

1. 家属在照护会话里提问。
2. 主智能体调用 `read_patient_profile`，从档案里看到在用华法林（已确认）。
3. 主智能体同时委派子智能体（实测是"用药核查"和"知识检索"），任务里写明问题和相关的已确认事实，然后只回一句"正在核查，请稍等"。
4. 子智能体各自调用 `search_medical_evidence`，拿到带出处和版本的资料片段，按固定格式返回结论、原句、风险、证据缺口。
5. 主智能体等结果都回来，调用 `present_care_answer` 交出结构化答复；界面渲染成答复卡片，右侧栏列出依据和用到的档案记录。

### 技术栈

| 层面 | 技术 |
| --- | --- |
| 运行环境 | Node.js 24.9+ |
| 智能体框架 | DeepSeek Harness 0.2.2-rc.1（Cordis 插件框架） |
| 业务代码 | TypeScript（工具插件）+ YAML（智能体与模型配置） |
| 大模型 | DeepSeek 为主，可切换 Kimi、通义千问、智谱 GLM、小米 MiMo |
| 数据 | 本地 JSON（老人档案）、Markdown（医学资料） |
| 界面 | dsh 自带网页界面 + 照护界面插件（`elder-care/ui/client.js`，React，手写无构建） |
| 包管理 | npm（项目依赖）、pnpm（dsh profile 内部） |

### 后续研究内容的接入位置

整体架构不用改，新增能力都以插件形式加进来：

| 研究内容 | 接入方式 |
| --- | --- |
| 安全规则监听 | 插件挂到 `agent/pre-step`（每一步执行前）和 `tools/pre-execute`（调用工具前） |
| 证据核验 | 插件挂到 `agent/turn-stopping`（答复发出前），核对结论和引文是否一致 |
| 患者长期记忆 | 把 `patient-profile.ts` 背后的 JSON 换成记忆服务，增加事实抽取、确认写入和版本；工具名和返回格式不变 |
| 更好的检索 | 把 `evidence.ts` 里的关键词匹配换成向量检索或外部知识库；工具名和返回格式不变 |

## 运行

机器上唯一需要预先安装的是 **Node.js 24.9 或更高版本**（dsh 的硬性要求），用 `node -v` 确认。

1. **启动**：双击 `start-elder-care.bat`，或在项目根目录运行 `npm start`。
   浏览器会自动打开 `http://127.0.0.1:3080/?token=...`；如果浏览器被关了，带 token 的地址在启动窗口里能找到。
   关掉启动窗口就是停止服务。
2. **填模型密钥**（只需一次，二选一；两处都填了以网页里保存的为准）：
   - **网页里填**：设置 → 模型，在对应提供方里填 API 密钥并保存，存进 `.dsh-home\.credentials.yaml`。
   - **文件里填**：打开 `.dsh-home\.env`，把对应行开头的 `# ` 删掉，在等号后粘贴密钥，然后重启服务。
3. **进入照护助手**：打开后是普通的 DeepSeek 聊天窗口。新建会话，点输入框上方的"养老照护助手"
   （或在智能体下拉里选"照护主智能体"），界面就切换成照护模式。想回到普通对话，点首屏的"返回普通对话"。
   没填任何密钥也能打开界面看，弹出的"开始使用"点 × 关掉即可，只是选不到模型、发不了消息。

其他 dsh 命令都通过 `node scripts/dsh.mjs` 运行，例如确认配置层生效（应能看到 `care-lead` 等四个 preset）：

```powershell
node scripts/dsh.mjs --profile web --dump-config | Select-String "care-"
```

如果机器上另外全局装了 dsh，不要用全局的 `dsh` 命令：它读写的是用户目录下的 `~/.dsh`，看不到这里的配置。

## 可用的模型

除了 dsh 自带的 DeepSeek 官方路线，`elder-care/cordis.patch.yml` 里通过 dsh 内置的 pi-ai 适配器另接了四家（都走 OpenAI 兼容接口）：

| 提供方 | 路线编号 | 密钥变量 | 模型 | 状态 |
| --- | --- | --- | --- | --- |
| DeepSeek（dsh 自带） | `deepseek-official` | `DEEPSEEK_API_KEY` | 官方列表 | 已实测对话 |
| Kimi | `moonshotai-cn` | `MOONSHOT_API_KEY` | pi-ai 内置目录（kimi-k3 等） | 已注册，未实测 |
| 小米 MiMo | `xiaomi` | `XIAOMI_API_KEY` | pi-ai 内置目录（mimo-v2.6-pro 等） | 已注册，未实测 |
| 智谱 GLM | `zai-coding-cn` | `ZHIPU_API_KEY` | pi-ai 内置目录（glm-5.3 等） | 已注册，未实测 |
| 通义千问 | `dashscope` | `DASHSCOPE_API_KEY` | qwen-max / qwen-plus / qwen-flash | 已注册，未实测 |

- 模型选择器里只显示已填密钥的提供方。
- 智谱借用了 pi-ai 内置目录的模型信息，但地址改成了普通按量付费接口（内置目录默认指向 GLM Coding 套餐地址）。
- 通义千问是手写的路线，走阿里云百炼按量付费接口；模型名用的是始终指向最新版的别名。
- 这两家如果报"模型不存在"，多半是模型名和平台当前名称对不上，改 `elder-care/cordis.patch.yml` 里对应的 `models`。
- 换模型后子智能体委派是否正常，取决于该模型的工具调用能力，需要实测。
- 再加一家：照着 `elder-care/cordis.patch.yml` 里 `llm-pi-ai` 那段写，或在 设置 → 模型 →"添加模型提供商"里加。

## 界面定制

网页界面用的是 dsh 自带的前端，没有改它的文件，而是在照护组合包里加了一个界面插件 `care-ui`。
外面是 dsh 原样的聊天窗口；**只有当前会话的智能体是"照护主智能体"时，界面才变成照护模式**，其他会话完全不受影响。
浏览器侧的代码只有一个文件：`elder-care/ui/client.js`（手写，不需要构建）。

### 照护模式里有什么

| 界面 | 内容 | 在 `client.js` 里的位置 |
| --- | --- | --- |
| 入口 | 普通新会话的输入框上方有一个"养老照护助手"按钮，点了把这个会话切到照护主智能体 | `CareDock`（非照护分支） |
| 左侧栏 | 左上角的标志和名称换成"养老照护助手"；标志行下面多出照护对象卡片和"咨询对话 / 老人档案"导航（有待确认的新情况时显示条数） | `CareNav`、`CSS`（`_brandMark`、`_brandName`） |
| 首屏 | 照护助手标题、照护对象、4 个快捷问题、"返回普通对话"；输入框提示和发送按钮颜色换成照护用的 | `CareDock`、`QUICK_QUESTIONS`、`CSS` |
| 答复卡片 | 每轮末尾：一句话结论（按级别分蓝、黄、红三种）、理由和依据编号、可以做的事、特别提醒、需医生或药师决定的事项、没有找到依据的问题、追问和可点的选项 | `AnswerCard`、`CareTurnTail` |
| 急症横幅 | 结论级别是急症时，卡片顶部整条红色，带"拨打 120"按钮；右侧栏显示触发的安全规则 | `AnswerCard`（`care-level-emergency`） |
| 右侧栏 | 照护对象、本次答复依据（出处、版本、原句）、用到的档案记录、本次提到的新情况（待确认）、参与核查的子智能体 | `CareSide` |
| 老人档案页 | 点"查看完整档案"打开，盖在对话区上：分类筛选、记录表、在用药物、监测、过敏 | `ProfilePage` |
| 安全提示 | 输入框上方常驻一行"不能代替医生诊断，急症拨打 120" | `CareDock` |

对话区宽度不到 980 像素时右侧栏收起，依据改为列在答复卡片里，输入框上方多一个"查看档案"入口。

### 数据从哪来

| 界面需要的数据 | 来源 |
| --- | --- |
| 当前会话是不是照护会话 | dsh 会话摘要里的 `projectionValues.agentPreset` |
| 答复卡片、依据、新情况、急症级别 | 主智能体调用 `present_care_answer` 时的参数（`src/present-answer.ts` 定义字段） |
| 参与核查的子智能体 | 最后一条用户消息之后的 `subagent` 工具调用 |
| 老人档案 | `src/ui-host.ts` 把 `data/patients/*.json` 生成为数据分块 `ui/client.patients.js`，浏览器按需加载 |

### 改界面时要知道的

- 改完 `client.js` 保存，打开着的页面会热重载；没生效就刷新。
- 想调整答复里有哪些栏目：先改 `src/present-answer.ts` 的参数定义（改完要重启服务），再改 `client.js` 里的 `parseAnswer` 和 `AnswerCard`。
- 改了老人档案后，重启服务时数据分块会重新生成（已实测）。服务运行期间修改也写了自动重新生成的逻辑，但还没有实测，没更新就重启服务。
- 界面靠 dsh 页面元素的类名后缀（如 `_scrollBody`、`_composerHero`、`_logoRow`、`_brandMark`）定位对话区和左侧栏。dsh 升级后如果右侧栏、首屏或左上角错位，先检查 `client.js` 里这几处选择器。
- 左侧栏里 dsh 原有的"新会话、插件、自动化任务、工作区"没有动，照护导航是插在它们上面的。
- 想完全去掉照护界面：删掉 `elder-care/cordis.patch.yml` 里 `care-ui` 那一行（答复会退回成工具调用的原始显示）。

### 还没做的

- "待确认的新情况"只是展示，还不能确认写入档案（档案目前只读）。
- 设计稿里的"通知其他家属""生成就医情况说明""生成给医生的问题清单"按钮没有做。
- 目前只支持一位老人（取档案目录里的第一份），还没有照护对象切换。
- 深色主题只按 dsh 的主题标记写了样式，没有实际切换过去检查。

## 试一试

先进入照护助手（见"运行"第 3 步），再按顺序发这几句，对应开题报告里的示例场景：

1. `我爸膝盖疼，能吃布洛芬吗？`
   预期：先读档案，发现在用华法林，委派子智能体核查；一两分钟后出现黄色答复卡片"不建议自己给他吃布洛芬"，
   理由后面带依据编号，右侧栏列出依据原句和用到的档案记录，卡片底部有一个追问和可点的选项。
2. `他自己已经吃了两次布洛芬，今天有点头晕，还能继续吃吗？`
   预期：把"吃了两次""头晕"列进"本次提到的新情况"（待确认）；不推断头晕的原因；是否继续服用列在"需要医生或药师决定"。
3. `他血压有点高，平时饮食和运动要注意什么？`
   预期：委派照护计划，答复带出处。
4. `今天大便发黑，还有点头痛。`（或在场景 1 的追问里点"有黑便或呕血"）
   预期：红色急症卡片，顶部提示立即就医并带"拨打 120"按钮，右侧栏显示触发的安全规则。

## 改动后怎么生效

- 改 `elder-care/cordis.patch.yml`（提示词、子智能体组成、模型）：`web` profile 默认会热重载；不确定时重启服务。
- 改 `elder-care/src/*.ts` 或 `elder-care/data/`：重启服务（关掉启动窗口，再双击 `start-elder-care.bat`）。
- 新增一个子智能体：在 `elder-care/cordis.patch.yml` 里照着 `preset-care-plan` 再写一段，把它的编号加进主智能体的 `allowedAgentPresets`，并在主智能体提示词里写一句它的适用情形。

## 部署到别的机器

1. 拷贝项目文件夹，或用 git 提交后在新机器上拉取。`.gitignore` 排除的内容都不要带过去：
   - `node_modules/`：体积大，新机器上重新装；
   - 🔒 密钥和对话记录；
   - `.dsh-home\storages\` 和 `.dsh-home\deepseek-harness\`：工作区注册表记的是本机绝对路径，不带过去时新机器会在 `.dsh-home\deepseek-harness\default-workspace` 自动新建默认工作区。
2. 新机器装好 Node.js 24.9+，双击 `start-elder-care.bat`。它在缺少依赖时会自动依次执行
   `npm install` 和 `node scripts/dsh.mjs plugin --profile web install`，然后启动；也可以手动运行这三条（最后一条是 `npm start`）。
3. 照着 `.dsh-home\.env.example` 新建 `.dsh-home\.env` 填密钥，或启动后在网页里填。
4. Linux 服务器上没有 .bat，手动执行上面三条命令。要让其他电脑访问，需要用 `--host` 绑定本机网卡地址（不接受 0.0.0.0 这类通配地址），
   并在前面加 HTTPS 反向代理；参数见 `node scripts/dsh.mjs web --help`。

## 卸载

所有东西都在项目文件夹里，删掉文件夹即可。只想从 web profile 里摘掉照护组合包：

```powershell
node scripts/dsh.mjs plugin --profile web remove dsh-elder-care
```

## 当前状态与已知问题

已验证：

- 三个工具能正常注册；配置层生效。新会话默认是 dsh 的标准助手，点入口后切到照护主智能体。
- 界面切换：普通会话保持 dsh 原样；进入、退出照护模式和老人档案页都实测过。
- 场景 1（用 DeepSeek V4 Pro 实测）：读档案 → 并行委派用药核查和知识检索 → 结构化答复渲染成黄色卡片，
  结论里明确写了请先问医生或药师，理由带依据编号，没有依据的问题单独列出，没有再套用高血压人群的建议。
- 场景 4（在场景 1 的追问里点"有黑便或呕血"实测）：红色急症卡片和"拨打 120"按钮，右侧栏显示触发的安全规则。

已知问题：

- 模型偶尔会把 `present_care_answer` 的参数写成不合法的 JSON，那一轮会报"本轮运行失败 … tool input is invalid JSON"。
  第一次实测就遇到了；把工具说明和提示词里的英文双引号举例去掉、并要求内容里不用英文双引号后，后面两次都成功。
  样本很少，不能说已经根治；再遇到时重发一次问题即可。
- 最终答复前仍有一两句过程消息（"正在核查，请稍等""正在进一步核查，请稍等"），比之前短，但没有完全去掉。
- 一次用药咨询从提问到出卡片大约两分钟（子智能体检索加上模型思考），偏慢。
- 场景 2、3 在改成结构化答复之后还没有重新实测。

这一版还没有的东西：

- 患者长期记忆：现在档案是只读的 JSON 文件，没有事实抽取、确认写入和版本。
- 安全规则监听：急症和专业决定目前只靠提示词约束，还没有挂到 `agent/pre-step` 和 `tools/pre-execute` 上。
- 证据核验（研究内容二）：还没有接到 `agent/turn-stopping`。
- 医学资料只有 3 份演示摘要（布洛芬、华法林、高血压），没有骨关节炎等内容；检索是关键词匹配。
