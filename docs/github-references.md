# GitHub 参考取舍

BBPoker 独立实现网页和服务端，没有随仓库分发其他扑克引擎。下列资料用于早期客户端探索、导出规范与产品形态参考；参考关系不代表本项目经过这些项目的作者审核，也不等于公平性或安全性认证。此次仅公开完整网页及测试所需的少量实验性客户端桥接代码。

| 参考 | 本项目的落地 | 边界 |
|---|---|---|
| [Capacitor](https://github.com/ionic-team/capacitor) | 早期探索移动端生命周期、分享和导出辅助接口 | 当前仅公开测试用辅助文件，没有分发 Capacitor 或完整 iOS/Android 工程 |
| [Electron Forge](https://github.com/electron/forge) | 早期探索隔离的本地页面、固定 API 地址、受限保存文件与加密身份接口 | 当前未分发 Electron、Forge、完整桌面工程或安装包 |
| [PokerKit](https://github.com/uoftcprg/pokerkit) / [PHH](https://github.com/uoftcprg/phh-std)，MIT | 根据公开规范独立实现 `.phhs`；借公开牌例交叉验证加注、主边池、结算 | Python 仅在独立验收环境中运行，不成为在线 Node 引擎依赖；未知牌不补全 |
| [Texas_Holdem](https://github.com/LeonemZhang/Texas_Holdem)，GPL-3.0 | 参考朋友局产品分工、桌面/网页共用界面与按玩家投影视图 | 未复制代码；BBPoker 使用受限的 BB 带入，不提供玩家间任意积分转账 |
| [PokerTH](https://github.com/pokerth/pokerth) / [web-client](https://github.com/narmod/pokerth-web-client) | 参考移动布局、牌谱入口与恢复体验 | 未复制代码；其网页端为 AGPL-3.0，依赖独立 PokerTH 游戏服务 |

不引入 predatorray 的 mental poker 内核：其 [showdown](https://github.com/predatorray/mental-texas-holdem/blob/54ce0e88adbde24c8219f7ee0ba00e3d8af8eafa/src/lib/texas-holdem/TexasHoldemGameRoom.ts#L606-L615) 会对全体参与者公开底牌，与弃牌保密约定冲突；配套 [shuffle](https://github.com/predatorray/mental-poker-toolkit/blob/4702b8b057d96e53df84d49a190ef63282aca699/src/lib/mental-poker.ts#L55-L68) 也不作为本项目随机实现。保留 Node 密码学随机源和无偏 Fisher–Yates，公平边界仍见 [fairness.md](fairness.md)。

鱿鱼与炸弹池采用明确本桌规则；蘑菇仅保留历史记录与退款。本次没有核实到能直接满足所有需求的现成开源整套产品。

第三方材料的许可边界见 [第三方说明](../THIRD_PARTY_NOTICES.md)，实验性代码范围见 [apps/README.md](../apps/README.md)。
