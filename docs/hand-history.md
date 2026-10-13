# PHH 牌谱导出

BBPoker可将已经结束的无限注德州扑克记录导出成 bulk PHH 文件（`.phhs`）。它保存可见底牌、公共牌、行动和德州积分结算，用于后续工具解析或复盘。导出格式不证明洗牌公平；Merkle 证明的检查仍应使用原 JSON 导出和既有验证工具。

## 数据与权限

`exportPhh(hands, adjustments = [], viewerId)` 只接收 `RoomService.handFor()` / `exports()` 已按观看者权限过滤的对象。模块不读取数据库、牌堆、原始存档或其他玩家私有牌，也不从证明、结果或牌型反推隐藏牌。传入原始带 `deck` 或 `audit` 的手牌对象会被拒绝。

- 自己的牌和已经公开的牌按传入值导出，未公开的牌写作 `??`，两张未知牌是 `????`。
- 只亮一张则如 `As??` 或 `??Kd`；弃牌后自愿亮牌只体现在可见底牌中，不伪造为摊牌争夺底池的行动。
- 牌面是**导出时的可见状态**，目前历史数据不保存亮牌时刻，因此不表示这些牌在之前每个决策时点都可见。外部训练或策略分析不得把导出时可见牌自动当作当时已知信息。
- `viewerId` 仅用于标识导出观看者，不能替代上游权限过滤。模块不会根据它重新获取其他牌面。

## 标准字段与行动

每手用独立 TOML table：`[1]`、`[2]` 等。该结构与 PokerKit 的 `HandHistory.dumps_all()` / `loads_all()` 一致，即使只有一手也按 bulk 格式保存，使用 `loads_all()` 而非 `loads()`。

- `variant = "NT"`：无限注德州。
- 玩家按庄位后顺时针顺序排列；`seats` 是原座位加一。三人以上通常是小盲、大盲直到庄位。单挑时 p1 是大盲、p2 是庄位小盲，而 `blinds_or_straddles` 仍写 `[小盲, 大盲]`，遵循 PHH 对单挑强制注额反转的规定。
- `d dh` 发底牌；`d db` 只写本轮新增公共牌；`f` 弃牌；`cc` 过牌或跟注；`cbr` 使用**本轮加注到的总额**。
- 全下跟注写 `cc`，全下加注写 `cbr`，由原行动记录的 `isRaise` 区分。缺少该字段会报错，不猜测。
- `sm` 只为仍在争夺底池的玩家记录摊牌，放在最后一个下注动作之后、自动发完剩余公共牌之前。没有实际行动的盲注全下也按此处理。
- 盲注和前注放在初始字段中；原日志里的自动退款和派奖不会伪装成额外下注动作，解析器可按规则计算。`winnings` 单独保存实际获分，`finishing_stacks` 保存实际德州结算后的积分。
- 服务器恢复标记 `reconnect` 和超时标记 `timeout` 不属于扑克行动，导出时跳过；超时导致的实际过牌或弃牌已由独立行动日志保存，会正常导出。
- 标准时间字段使用 UTC，并明确写入 `time_zone = "Etc/UTC"`。

## 小游戏与独立退款

0.5.0 的炸弹池使用等额前注和零盲注，直接从翻牌开始。PHH 的标准无限注德州没有“跳过翻前下注”开关，导出会加入不改变积分的翻前过牌，并用 `_bbpoker_bomb_pot` 和 `_bbpoker_synthetic_preflop_checks` 标记这些仅供格式兼容的步骤。它们不是真实玩家决策，也不进入 BBPoker 的 VPIP / PFR 统计。时间牌使用记录不转换为扑克下注动作；需要原始记录时使用 JSON 导出。

标准 `starting_stacks` 是进入本手德州时可用的积分：蘑菇入池和鱿鱼预留已在此前扣除。`finishing_stacks = startingStack + net` 只计算这手德州的变化，不能直接使用包含小游戏结算的房间余额。

小游戏仅存为 PHH 允许的下划线自定义字段：

| 字段 | 含义 |
| --- | --- |
| `_tongzhuo_mini_net` | 与 PHH 玩家顺序一致的小游戏净变化 |
| `_tongzhuo_room_ending_stacks` | 包含当时小游戏处理后的房间可用积分 |
| `_tongzhuo_player_ids` | PHH 玩家顺序对应的BBPoker玩家 ID |
| `_tongzhuo_viewer_id` | 导出观看者 ID（如有） |
| `_tongzhuo_commitment` | 原手牌的承诺根（如有）；没有完整证明，不能单独验证 |

通用 PHH 工具可能忽略这些自定义字段。积分没有兑换功能，导出不指定法币 `currency`，也不把小游戏金额写成德州前注、盲注或底池。

散桌时的蘑菇退款不属于任何一手牌，保存在文件开头的 `# Tongzhuo adjustment JSON: ...` 注释中。**这是BBPoker自定义的附加记录，不是 PHH 手局；通用解析器会忽略它。** 没有牌局而只有退款时，文件只有注释，`loads_all()` 返回零手。需要完整分账、审计证明或可靠程序间传递退款记录时，使用BBPoker JSON 导出。

## 验证与边界

普通测试不引入 Python 依赖：

```sh
node --test test/phh.test.js
```

可使用独立 Python 3.11+ 环境安装 PokerKit，再指定解释器运行交叉验证：

```sh
python3.13 -m venv /tmp/tongzhuo-phh-check
/tmp/tongzhuo-phh-check/bin/python -m pip install --index-url https://pypi.org/simple pokerkit==0.7.6
POKERKIT_PYTHON=/tmp/tongzhuo-phh-check/bin/python node --test test/phh.test.js
POKERKIT_PYTHON=/tmp/tongzhuo-phh-check/bin/python node --test test/room-options.test.js
```

2026-09-29 已用官方 PyPI 的 **PokerKit 0.7.6**、Python 3.13 实际验证：8 手能被官方 `HandHistory.loads_all()` 解析，其中 7 手完整牌例回放后的最终德州积分逐人一致，涵盖单挑、多人稀疏座位、弃牌、部分亮牌、主池/边池、全下跑牌、只有盲注的全下、真实存档恢复后继续完成的牌局、超时过牌，以及与小游戏分账隔离。第 8 手故意隐藏一张摊牌底牌，仅验证格式与未知牌保存，不宣称能够重算其胜负。

能解析一份牌谱，不等于其中的信息足够独立重算结算：未知的活跃玩家底牌可能使胜负无法确定。已有获分和结束积分是服务器的记录值，不能当成独立验证的结果。外部解析器也可能有不同房规或对扩展字段的支持差异，因此不承诺所有扑克软件均能直接导入。

## 规范、参考与许可证

本导出器按公开规范独立实现，没有复制第三方源码，也没有把 Python 库加入应用运行依赖。

- [PHH 规范项目](https://github.com/uoftcprg/phh-std)，核对提交 `c1bd44c3d0faef9ed989be8d6675f814c0e0f62d`。其中 [required.rst](https://github.com/uoftcprg/phh-std/blob/c1bd44c3d0faef9ed989be8d6675f814c0e0f62d/required.rst) 说明未知牌、部分摊牌、单挑盲注和动作格式；[user.rst](https://github.com/uoftcprg/phh-std/blob/c1bd44c3d0faef9ed989be8d6675f814c0e0f62d/user.rst) 说明下划线扩展字段。项目为 [MIT 许可](https://github.com/uoftcprg/phh-std/blob/c1bd44c3d0faef9ed989be8d6675f814c0e0f62d/LICENSE)。
- [PokerKit](https://github.com/uoftcprg/pokerkit)，源码核对提交 `b2fcc75c05ac43b210dd7e5ea71c0bd2f82ac3d6`；[notation.py](https://github.com/uoftcprg/pokerkit/blob/b2fcc75c05ac43b210dd7e5ea71c0bd2f82ac3d6/pokerkit/notation.py) 的 `dumps_all` / `loads_all` 是 bulk 表结构的参考。项目为 [MIT 许可](https://github.com/uoftcprg/pokerkit/blob/b2fcc75c05ac43b210dd7e5ea71c0bd2f82ac3d6/LICENSE)。

上述项目源码若以后被直接复制或分发，须保留相应版权和 MIT 许可声明；本次仅参考规范并在临时环境中用其解析器验证。
