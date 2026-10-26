# Gene Editing

**让你用八个 Gene，调节 DeepSeek 看待问题和展开思考的方式。**

这是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的第三方插件，包含中文面板和原生工具调用集成。每个 Gene 提供「低 / 中 / 高」三档，点击旁边的 `i` 可以查看具体逻辑和实际指令。

## 我们想实现什么

同一道题，你可能希望模型更直接，也可能希望它多联想、深入机制、重新审视前提，或把零散想法整理成一个整体。Gene Editing 让这些偏好变成可以调节、组合和持续使用的控制项。

**体验上的可辨识变化和人的掌控感，是这个项目的核心。** 两个回答都正确，仍然可能体现不同的思考取向；探索带来的绕路也可能是你想要的。正确率、调用次数和耗时可以辅助分析，但不能替代人的判断。

Gene 表达倾向，模型仍根据问题决定怎么做。不要把它实现成固定的「先探索→再质疑→再总结」流水线，也不要强迫模型交付规定数量的方案、反例或标题。Gene 不修改模型权重，也不读取私人思考内容。

## 八个 Gene

| Gene | 更强调时，希望模型自然倾向于…… |
| --- | --- |
| EXP 探索 | 注意不同方向，寻找有意义的其他方法 |
| RIG 严谨 | 关注事实、约束、依据和细节之间是否一致 |
| CRE 创造 | 重组熟悉的要素，考虑有用的非常规做法 |
| DEP 深度 | 深入影响问题的机制、关系和关键细节 |
| SKE 质疑 | 重新审视重要前提，检查值得怀疑的假设 |
| ABS 抽象 | 寻找共同结构，把具体问题联系到可复用原则 |
| FOC 聚焦 | 把注意力集中到当前意图，减少无关展开 |
| SYN 整合 | 联系分散的发现，形成连贯的理解和选择 |

这些是设计方向，不是对每次输出的保证。低档是一种偏好，不等于停用；停用需要点击「停用 Gene」。**effort 由 Harness 自己的模型设置控制，不属于 Gene。**

## 安装

当前版本：`0.6.2`。已针对 Harness `0.2.1-rc.3`、Cordis `4.0.5` 验证；需要 Node.js `24.9.0+`。其他宿主版本需要重新检查兼容性。

1. 从 [Releases](https://github.com/Lynn-Sunset/dsh-gene-editing/releases) 下载 `dsh-gene-editing-0.6.2.tgz`。
2. 在你的 Harness 环境安装到目标 profile，例如 `web`：

   ```sh
   dsh plugin --profile web add "/完整路径/dsh-gene-editing-0.6.2.tgz"
   ```

3. 重启目标 Harness 服务并刷新页面，在会话入口打开 **Gene Editing**。

Windows 可以将路径写成 `"C:\Downloads\dsh-gene-editing-0.6.2.tgz"`。如果 `dsh` 不在 PATH，请使用你原来启动 Harness 的 CLI 入口。保留 profile 原有配置，不要用本仓库的 `controlled.patch.yml` 覆盖个人配置。

本项目发布 GitHub 安装包，未发布 npm registry 包；请使用下载的 `.tgz`，不要直接运行 `npm install dsh-gene-editing`。

## 使用

1. 打开需要调节的会话，进入 Gene Editing。
2. 调整八个 Gene，点击「应用到当前会话」。
3. 在 Harness 原来的输入框提问；应用 Gene 本身不会发送消息。
4. 会话空闲时可以再次调整；运行中的请求不会被中途改写。
5. 配置会持续用于该会话，直到重新应用或停用。普通会话分叉会继承偏好，但使用独立执行记录。

先只调整一两个 Gene，比较同一道开放问题的回应，通常更容易理解它们的影响。查看关注点、展开方向、表达取舍和行动选择；无需给每次回答打一个总分。

## 当前实际怎么工作

```text
三档面板 → 会话 Gene 配置 → 具体语义偏好 → 原生模型请求
                                       ↓
原生工具结果 → 执行记录 → 在已有工具续步中加入相关 Gene 提示
```

- 偏好会变成具体指令，不只把一个分数塞进提示词。
- `gene_tools_inspect` 能查看当前会话真正可用的工具及执行记录。
- 工具调用后的提示只加入宿主本来就要继续的步骤，不另外制造模型请求。
- 模型、effort、请求预算、工具授权和重试仍由 Harness 管理。

**实现还在迭代。** 当前工具反馈对没有声明业务契约的工具只记录 `unknown`，不能自动理解所有「成功/失败」含义。实际对照已确认工具链能运行，也观察到选择和过程差异；这不等于八个 Gene 已经能稳定、独立地塑造思考方式。后续重点是改善这种可塑性和用户体验。[架构与边界](docs/ARCHITECTURE.md)

## 从源码开发

```sh
git clone https://github.com/Lynn-Sunset/dsh-gene-editing.git
cd dsh-gene-editing
npm ci --ignore-scripts
npm run check
npm pack
```

Windows 若 PowerShell 拦截 `npm.ps1`，使用 `npm.cmd`。`check` 会构建并运行自动化测试；测试使用本地 fixture，不消耗 DeepSeek API 额度。`npm pack` 会重新构建并生成可安装的 `.tgz`。

| 需要改什么 | 从这里开始 |
| --- | --- |
| 面板、按钮和三档交互 | `src/client.jsx`、`src/gene-levels.js` |
| Gene 的实际语义偏好 | `shared/public/compact-policy.js` |
| 中文说明与指令预览 | `src/gene-help.js` |
| 会话应用、停用、恢复、分叉 | `src/index.mjs` |
| 工具发现、执行记录、续步提示 | `src/tool-integration.mjs` |
| 集成回归测试 | `test/` |

`shared/src/v4/verifiers/` 保留显式验证任务的兼容代码，普通面板使用 `preferences` 模式，不会自动启动这些任务。`lib/` 是构建产物，不直接编辑。

## 交给 AI 继续实施

可以把下面这段话连同仓库一起交给 AI：

> 先读 README、AGENTS.md 和 docs/AI_HANDOFF.md，再检查现有代码。Gene Editing 的目标是让人能塑造模型关注什么、如何联想、怎样选择方向；人的可感知变化与掌控感优先，效能指标只是辅助。保留八项独立 Gene、三档面板和原生 Harness 集成。不要改成固定思维链，不增加强制输出模板，不把 effort 放回 Gene。根据用户这次指定的范围实施，先说明实际改动会影响哪个控制点，再完成代码和相关测试。用同题、同上下文的公开回应帮助人比较变化，如实区分已实现能力和设想。

详细实施路线、接口位置与验收方法见 [AI 接手说明](docs/AI_HANDOFF.md)。

## 许可

[MIT](LICENSE)。本项目不是 DeepSeek 官方产品；依赖组件保留各自许可。
