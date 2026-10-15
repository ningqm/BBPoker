# 过牌双敲桌音

## 选择与来源（2026-10-15）

过牌声改为实际木桌敲击的短片段，替代此前的合成噪声/共振波形。
本地默认选方案 1「自然双敲」；这里只确认来源、波形和播放行为，最终听感由真人试听决定。
没有声称复刻或试听过 WPK 等商业客户端的音效。

[PokerStars 对现场手势的说明](https://www.pokerstars.uk/poker/learn/news/texas-holdem-poker-hand-signals/)
把敲桌说明为过牌手势，并指出实际常见手势可以很轻；这支持短、轻的桌面触击方向，
不意味着其客户端采用了下面的声音。

| 方案 | 源录音 | 处理方向 |
| --- | --- | --- |
| 1 自然双敲（默认） | Rvgerxini / Knocking / 462317 | 两次真实触桌，起点间隔 165 ms，去低频轰鸣和高频噪声，保留中频木桌质感 |
| 2 轻短双敲 | 同上 | 间隔 145 ms，更短尾音、更轻的峰值，减少低频 |
| 3 厚木双敲 | DanaGarcia / Knock knock.wav / 560225 | 间隔 175 ms，保留较低的木材共振，可供对比 |

两个原作者的官方页面均明确标注 **Creative Commons 0**，允许复制、修改和分发，包括商业使用。
项目公开源码包含加工后的短 PCM，不包含整段原始 MP3；原始文件只作为外部构建输入。

- [Rvgerxini 原作页](https://freesound.org/people/Rvgerxini/sounds/462317/)
  / [官方 HQ MP3](https://cdn.freesound.org/previews/462/462317_9453283-hq.mp3)
  / SHA-256 `257a830b3ca7facabff9bb8bd0b920e99bc061151007690160bf779837df6d0a`。
- [DanaGarcia 原作页](https://freesound.org/people/DanaGarcia/sounds/560225/)
  / [官方 HQ MP3](https://cdn.freesound.org/previews/560/560225_12494212-hq.mp3)
  / SHA-256 `120f19cfaf9714fb394610d101cd432bab03f08049e501a058a82a080d54a2e8`。
- [CC0 1.0 许可说明](https://creativecommons.org/publicdomain/zero/1.0/)。

下载的用途是制作获授权的应用音效；不抓取商业扑克软件、视频配音或未知授权素材。

## 处理和复现

需要 Python、numpy、soundfile（支持 MP3 解码）。原始 MP3 另存为
`462317.mp3`、`560225.mp3`，脚本会校验上述 SHA-256 再处理。

```sh
python scripts/build-recorded-check-knock.py \
  --source-dir /path/to/licensed-inputs \
  --output-dir /path/to/audition \
  --install-app .
```

脚本将双声道平均为单声道，从两次不同的真实敲击各裁一小段：
默认来源起点为 0.252 s / 0.451 s，各取 150 ms；二阶 Butterworth
高通 105 Hz、低通 3 kHz，3 ms 淡入、55 ms 渐隐尾音。
第二敲峰值为第一敲的 84%，起点间隔 165 ms。没有增加噪声、合成音高或人工混响。

默认结果同时写入 `public/audio/check-knock.wav` 与 `public/check-knock.js`。
JS 内嵌的是该录音处理后的 PCM16 数据，首次动作可立即建 AudioBuffer，不等待网络下载或异步解码。
多次调用返回独立的 AudioBuffer；静音、后台停止、事件去重与旧播放机制一致。

若仅需从已提交的浏览器模块重建 WAV，无需 Python 或第三方库：

```sh
node scripts/build-check-knock.mjs --output /path/to/check-knock.wav
node --test test/check-knock.test.js test/table-audio.test.js test/table-feedback.test.js
```

## 默认产物校验

- PCM16，单声道，44,100 Hz，15,876 帧，360 ms；有效双敲结束于约 319 ms。
- 31,796 字节；峰值 `0.79998779296875`，RMS `0.09632306366205202`，零削波。
- SHA-256 `9b4f2cfe28b22cd0d0eed4a1a5dd646e69ec4e5316e9f9c8e08815d6942a7bc7`。
- 实际游戏沿用音效增益 0.85；音效开关、后台静音与动作去重保持有效。
- 同一过牌的两次触桌放在一个 AudioBuffer 内，节奏不受两次网络或计时器调度影响。

应用内试听构建器 `scripts/preview-table-audio.mjs` 仍使用同一个 WAV 和实际游戏增益。
单元测试核对逐采样一致、双敲间静区、首尾淡出与无削波；这些检查不替代真机扬声器试听。
