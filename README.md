# ChatGPT Voyager · 提问时间线

轻量的 Chrome 扩展，在 ChatGPT 网页右侧显示当前聊天的提问时间线。悬停预览自己的提问，点击跳转，滚动阅读时自动高亮对应节点。

当前版本：**1.0.13**。支持 `chatgpt.com` 和 `chat.openai.com`，采用 Manifest V3。

## 功能

- **提问导航**：只显示自己的提问，不预览模型回答；长问题可在预览框内滚动阅读。
- **点击跳转**：点击圆点定位到对应提问。
- **阅读高亮**：随页面滚动自动切换高亮，阅读某次提问下的回答时保持对应节点选中。
- **历史累积**：向上加载历史时加入新发现的提问，已加载的最新节点不会因为网页卸载消息而消失。
- **聊天隔离**：切换聊天立即清空旧节点，避免混入网页缓存的其他会话。
- **简洁外观**：浅蓝圆点、磨砂玻璃滑轨，支持深色页面。顶部与分享按钮下沿保持 3px 间距，底部留 6px。
- **键盘操作**：Tab 进入节点，方向键切换，Home / End 前往首尾，Enter 跳转，Esc 关闭预览。

## 安装

使用扩展不需要构建，也不需要安装 Node.js。

### 直接下载（推荐）

打开 [最新 Release](https://github.com/zdsun01/chatgpt_voyager/releases/latest)，在 **Assets** 中下载 `chatgpt-question-timeline-版本号.zip`，解压后在 Chrome 扩展管理页选择该文件夹即可，不需要 Git 或 `git pull`。

当前安装包：[chatgpt-question-timeline-1.0.13.zip](https://github.com/zdsun01/chatgpt_voyager/releases/download/v1.0.13/chatgpt-question-timeline-1.0.13.zip)。选择插件 ZIP，不要选择 GitHub 自动生成的 Source code 源码包。

### 从源码安装

1. 克隆本仓库，或通过仓库页面的 **Code → Download ZIP** 下载并解压源码。
2. 在 Chrome 地址栏打开 `chrome://extensions`。
3. 打开右上角的**开发者模式**。
4. 点击**加载已解压的扩展程序**，选择仓库中的 **extension 文件夹**，该目录下应直接包含 `manifest.json`。
5. 刷新 ChatGPT 页面，进入有提问的聊天即可看到时间线。

如果使用单独打包的扩展 ZIP，解压后选择直接包含 `manifest.json` 的目录。没有提问时，时间线隐藏。

### 更新

用新版文件覆盖原来的扩展目录；使用 Git 克隆安装的，也可以在仓库目录执行 `git pull`。随后在 `chrome://extensions` 中点击本扩展的**重新加载**，再刷新 ChatGPT 页面。当前版本应显示 **1.0.13**。

## 使用说明

普通圆点为 12px 浅蓝色。悬停或键盘聚焦时放大至 14px，并显示蓝色外圈；当前阅读节点使用蓝色填充和浅蓝光圈。界面不显示提问序号或操作说明，预览只包含提问正文。

高亮以聊天可视区域中线为参考：提问经过中线后，对应节点保持高亮，直到下一次提问经过中线；滚到底部时高亮最新节点。节点很多时，时间线自动滚动以显示当前节点，也可在滑轨上使用滚轮查看其他节点。

向上翻阅时，逐步累积当前聊天已经加载过的提问。切换浏览器标签页后保留这些记录；切换聊天或刷新网页后重新积累。

## 常见问题

**安装或更新后没有时间线？**

确认加载的是包含 `manifest.json` 的 `extension` 目录，扩展已启用且允许访问当前站点，然后重新加载扩展并刷新 ChatGPT 网页。空聊天不显示时间线。

**为什么很早的提问还没有节点？**

先向上滚动，让 ChatGPT 加载相应历史消息。插件发现后会将这些节点加入时间线。

**为什么长对话的滑轨可以滚动？**

节点多时保留最小点击间距，并通过虚拟列表显示可见部分。可使用滑轨滚轮或键盘查看其他节点。

## 项目结构

```text
extension/
  manifest.json                 Chrome 扩展配置
  content.js                    页面识别、缓存、样式和交互
tests/
  timeline.test.cjs              基础交互与大量节点测试
  chat-switch.test.cjs           聊天切换与缓存页面隔离测试
  virtual-history.test.cjs       历史累积、卸载与重新挂载测试
  scroll-active.test.cjs         滚动高亮与监听生命周期测试
CHANGELOG.md                    更新记录
```

## 开发与验证

本机需安装支持当前 Playwright 的 Node.js 版本和 Google Chrome。测试通过 Playwright 启动本机 Chrome，使用拦截的模拟网页，不需要登录 ChatGPT。

```sh
npm ci
npm test
```

测试覆盖新旧页面结构、预览与跳转、动态增删、聊天隔离、历史累积、滚动高亮、后台恢复、纯文本渲染，以及 2,000 条提问时有限的按钮渲染数量。也检查模型流式输出和单纯滚动不会触发提问列表重扫。

Playwright 仅用于开发，不随扩展运行。`node_modules/`、`test-results/` 和 ZIP 包不纳入源码版本控制。

### 打包

在仓库根目录使用 PowerShell：

```powershell
Compress-Archive -Path extension/* -DestinationPath chatgpt-question-timeline.zip -Force
```

包内仅包含 `manifest.json` 和 `content.js`，不包含测试或开发依赖。

## 更新记录

- **1.0.13**：新增随阅读位置变化的节点高亮。
- **1.0.12**：修复向上加载历史时最新节点消失，按聊天累积已加载提问。
- **1.0.11**：修复切换聊天后混入旧节点。

完整记录见 [CHANGELOG.md](CHANGELOG.md)。
