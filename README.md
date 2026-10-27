# ChatGPT Voyager

<p align="center"><img src="docs/images/icon.png" width="160" height="160" alt="ChatGPT Voyager 图标"></p>

让 ChatGPT 长对话更好读的 Chrome 扩展。

当前版本：**1.2.2** · [下载插件 ZIP](https://github.com/zdsun01/chatgpt_voyager/releases/download/v1.2.2/chatgpt-question-timeline-1.2.2.zip)

## 功能

- **返回原文**：引用追问后，一键回到原来的段落。
- **侧边临时聊天（试用）**：在右侧开启独立的官方临时聊天，不携带主对话上下文，不留在聊天历史中。
- **时间线**：快速预览和跳转自己的提问，随阅读位置高亮对应节点。

## 安装

1. 下载上方 ZIP 并解压。
2. 打开 `chrome://extensions`，开启**开发者模式**。
3. 点击**加载已解压的扩展程序**，选择包含 `manifest.json` 的文件夹。
4. 刷新 ChatGPT 网页即可使用。

更新时覆盖原目录，点击扩展的**重新加载**，再刷新网页。无需卸载重装。

## 使用说明

- **返回原文**：选中文字，使用网页自带的“向 ChatGPT 提问”追问，再点击新回答底部的 `↩` 返回。
- **侧边临时聊天**：点击右上角 **⋯ → 新建侧边聊天**，或按 **Ctrl + Alt + S**；点击 **×** 关闭，再打开是空白聊天。
- **时间线**：鼠标悬停右侧圆点预览提问，点击圆点跳转；更早的节点会在向上加载历史后出现。

## 开发

源码安装选择 `extension/` 文件夹。运行测试需要 Node.js 和 Chrome：

```sh
npm ci
npm test
```

版本详情见 [更新记录](CHANGELOG.md)。
