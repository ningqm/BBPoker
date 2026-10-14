# 筹码声音素材

`public/audio/chips.wav` 使用 Joma86 的 **AllInPushChips.wav**。
用户在 2026-10-15 试听后选择了这段「② 整摞筹码推进、碰撞」。
每次下注播放单次约 929 毫秒的录音，不使用试听文件中为便于比较而添加的三次重复。

没有采集或复制 WPK、GGPoker 等平台的声音，也不表示作者为本项目背书。

## 来源与许可

- 作者：Joma86。
- 作品：AllInPushChips.wav，作者描述为以 All-in 动作推倒一摞扑克筹码，使用 Behringer C-1 录制。
- 官方素材页：<https://freesound.org/people/Joma86/sounds/532861/>
- 实际使用的官方公开 HQ MP3：<https://cdn.freesound.org/previews/532/532861_2587408-hq.mp3>
- 许可：CC0 1.0 Universal，<https://creativecommons.org/publicdomain/zero/1.0/>
- 核对日期：2026-10-15。官方条目明确标注 Creative Commons 0，可复制、修改、分发及商业使用；此处主动保留来源。
- 输入 MP3 SHA-256：`e76b9c44412b7ba1bade5b8b24ef38f739ae1d824cbe2853d38214056af751d2`

素材为公开 HQ 试听的解码版本，不是需要登录下载的无损 WAV 母带。

## 处理与复现

`scripts/build-chip-sound.py` 会校验输入素材哈希后进行以下处理：

1. 完整解码已校验的 MP3，保留单声道、44.1 kHz、40,969 个采样点。
2. 为避免 MP3 解码过冲（原始峰值约 1.00227），整段乘以同一个线性增益 `0.9478482872326646`，将峰值降到 0.95；与用户选中的试听相同。
3. 输出单声道 16-bit PCM WAV。量化规则与试听文件一致，因此采样内容与三次试听中的第一遍逐点相同。

不加 EQ、不压缩、不变调、不加混响、不裁切或重复，保留用户选中的原始音色和碰撞节奏。

使用 Python、`numpy==2.3.5`、`soundfile==0.14.0`（libsndfile 1.2.2，含 MP3 解码支持）：

```sh
python scripts/build-chip-sound.py --source-mp3 /path/to/532861_2587408-hq.mp3
```

当前输出：`0.9290022675736962` 秒、81,982 字节、峰值 `0.949981689453125`、RMS `0.07916215056888848`。
输出 SHA-256：`9af552b489efa78e594d7be96627cb9ae01bcb7938f81b183de092c05b8d40b0`。

播放音量由桌面音频模块控制；预览应与运行时使用同一文件和混音参数。
