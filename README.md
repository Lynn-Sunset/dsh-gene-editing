# 声明：本插件仍处于开发、迭代的初期阶段，有任何反馈可通过Issues直接提出
# Gene Editing

**用八个 Gene，调节 DeepSeek 看待问题和展开思考的方式。**

这是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的第三方插件，包含中文面板和原生工具调用集成。每个 Gene 提供「低 / 中 / 高」三档，点击旁边的 `i` 可以查看具体逻辑和实际指令。

## 我们想实现什么

同一条Prompt，你可能希望模型更直接作出回答，也可能希望它多联想、深入机制、重新审视前提，或把零散想法整理成一个整体。Gene Editing 让这些偏好变成可以调节、组合和持续使用的控制项。


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

**effort 由 Harness 自己的模型设置控制，不属于 Gene。**

## 安装

当前版本：`0.6.2`。已针对 Harness `0.2.1-rc.3`、Cordis `4.0.5` 验证；需要 Node.js `24.9.0+`。其他宿主版本需要重新检查兼容性。

1. 从 [Releases](https://github.com/Lynn-Sunset/dsh-gene-editing/releases) 下载 `dsh-gene-editing-0.6.2.tgz`。
2. 在你的 Harness 环境安装到目标 profile，例如 `web`：

   ```sh
   dsh plugin --profile web add "/完整路径/dsh-gene-editing-0.6.2.tgz"
   ```

本项目发布 GitHub 安装包，未发布 npm registry 包；请使用下载的 `.tgz`，不要直接运行 `npm install dsh-gene-editing`。

## 使用

1. 打开需要调节的会话，进入 Gene Editing。
2. 调整八个 Gene，点击「应用到当前会话」。
3. 在 Harness 原来的输入框提问；应用 Gene 本身不会发送消息。
4. 会话空闲时可以再次调整；运行中的请求不会被中途改写。
5. 配置会持续用于该会话，直到重新应用或停用。普通会话分叉会继承偏好，但使用独立执行记录。
。
- 模型、effort、请求预算、工具授权和重试仍由 Harness 管理。



## 交给 AI 继续实施

可以把下面这段话连同仓库一起交给 AI：

> 先读 README、AGENTS.md 和 docs/AI_HANDOFF.md，再检查现有代码。Gene Editing 的目标是让人能塑造模型关注什么、如何联想、怎样选择方向；人的可感知变化与掌控感优先，效能指标只是辅助。保留八项独立 Gene、三档面板和原生 Harness 集成。不要改成固定思维链，不增加强制输出模板，不把 effort 放回 Gene。根据用户这次指定的范围实施，先说明实际改动会影响哪个控制点，再完成代码和相关测试。用同题、同上下文的公开回应帮助人比较变化，如实区分已实现能力和设想。

详细实施路线、接口位置与验收方法见 [AI 接手说明](docs/AI_HANDOFF.md)。

## 许可

[MIT](LICENSE)。本项目不是 DeepSeek 官方产品；依赖组件保留各自许可。
