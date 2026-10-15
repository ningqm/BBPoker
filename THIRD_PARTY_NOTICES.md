# 第三方资料与依赖说明

## 网页与服务端

根目录网页和 Node.js 后端没有第三方 npm 运行依赖，使用 Node.js 内置模块与浏览器标准 API。界面 SVG 图标由本项目绘制，不包含竞品商标、图片、字体、表情图片包或音效。字符表情由用户系统字体显示。

本项目独立实现牌局逻辑，没有随仓库分发其他扑克引擎。产品公开界面的参考关系不是代码复制或授权背书。

## PHH 规范与 PokerKit

- `src/phh.js` 按 [PHH 公开规范](https://github.com/uoftcprg/phh-std) 独立实现。详细来源与兼容性边界见 [牌谱说明](docs/hand-history.md)。
- `test/poker.test.js` 中的 Ivey–Dwan 测试依据 [PokerKit 公开牌例](https://github.com/uoftcprg/pokerkit#a-sample-no-limit-texas-holdem-hand) 独立转录行动，用于核对结算。来源注释保留在测试中。
- 可选交叉验证由部署者在单独的 Python 环境安装 PokerKit；本仓库不包含 PokerKit 源码或其二进制分发。所核对的 [PokerKit 固定提交许可证](https://github.com/uoftcprg/pokerkit/blob/b2fcc75c05ac43b210dd7e5ea71c0bd2f82ac3d6/LICENSE) 为 MIT，版权归 Universal, Open, Free, and Transparent Computer Poker Research Group（2023–2026）所有。

如后续复制或重新分发第三方代码、文档或二进制，应按对应版本的许可证保留版权与许可声明。本说明不替代第三方许可证。

## 中文动作语音、筹码录音与过牌敲桌

`public/audio/{bet,raise,reraise,call,check,fold,allin}.wav` 是离线生成的固定动作提示。使用 [hexgrad/Kokoro-82M-v1.1-zh](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh) 模型（模型卡标注 Apache-2.0），当前声音为 `zm_009`、语速 1.08；All-in 使用中文“凹印”读法。它们不是竞品音效，也不是用户声音的录制或克隆。

生成工具为 [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx/blob/main/LICENSE)（MIT，版权为 2025 github.com/thewh1teagle）和 [Misaki](https://github.com/hexgrad/misaki/blob/main/LICENSE)（Apache-2.0）。本仓库仅包含生成的短音频和本项目重建脚本，不分发模型权重、训练数据、上述依赖代码或二进制。运行网站无需语音模型或在线语音服务。

`public/audio/chips.wav` 来源为 Joma86 的 [AllInPushChips.wav](https://freesound.org/people/Joma86/sounds/532861/)，按作者公开 HQ MP3 预览解码并线性衰减，许可为 [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/)。来源、输入及输出哈希、处理方式和复现步骤见 [筹码声音素材](docs/chip-sound-source.md)。未提取任何商业扑克平台的音轨，也不表示作者对 BBPoker 的背书。

当前过牌使用 Rvgerxini 的 [Knocking / 462317](https://freesound.org/people/Rvgerxini/sounds/462317/) 录音，原作者标注 [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/)。项目从两次不同的真实敲击裁剪、滤波和渐隐为 360 毫秒双敲声；`public/check-knock.js` 内嵌 PCM 与 `public/audio/check-knock.wav` 一致。旧 `check.wav` 保留兼容，但不再作为局内过牌声音。来源、构建输入哈希和复现步骤见 [过牌音效](docs/check-knock-sound.md) 与 [全部音频说明](docs/audio-assets.md)。项目没有分发整段原始 MP3，录音作者未对 BBPoker 作背书。

工具及模型许可证不等于第三方背书；自行重建或分发依赖／模型时应保留其完整许可和版权要求。

## 实验性客户端相关项目

`apps/` 仅包含本项目编写且为测试保留的桥接辅助文件，没有随附 Electron、Electron Forge、Capacitor、esbuild、sharp 或其平台工程。以后提供完整原生 App 或依赖分发时，需要另行列出实际分发版本及完整许可清单。

## BBPoker 自有实现

本仓库目前没有为 BBPoker 自有实现额外指定 MIT、Apache、GPL 等开源许可证，`package.json` 标记为 `UNLICENSED`。公开可见不能替代额外的许可授权；第三方项目的许可证只适用于其各自材料。
