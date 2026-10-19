# dshx-skill-manager

> A Settings page that lists every installed skill with an on/off switch and a short AI-generated summary.

在 **设置 → 技能管理** 里列出 DSH 当前解析到的所有技能（用户级、项目级），每个技能一个开关，并附一句简短的中文概述。

- **开关**：插件在自身生命周期内包装技能注册表的 `snapshot()` / `get()`，停用的技能对模型目录、`skill` 工具和 `/skill` 命令都不可见。技能文件不会被修改，卸载插件即完全还原。
- **概述**：可用默认模型批量生成（带缓存，描述变化才重新生成）；没有 AI 概述时用描述的第一句。

## 配置（`cordis.patch.yml`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `summarize` | `true` | 是否用默认模型生成概述 |
| `summaryMaxChars` | `60` | 概述长度上限 |
| `stateFile` | 空 | 状态文件，默认 `$DSH_HOME/dshx-skill-manager/state.json` |

## 安装

```sh
# Web profile
dsh plugin --profile web add github:callaumyan-design/dshx-skill-manager
# Desktop（用 DSH Desktop 自带的 dsh 命令，先从托盘完全退出 Desktop）
dsh plugin --profile desktop add github:callaumyan-design/dshx-skill-manager
```

安装后重启 DSH。卸载：`dsh plugin --profile <profile> remove dshx-skill-manager`。

## 兼容性

在 DeepSeek Harness 0.2.0-rc.2（desktop / web profile）上开发和使用。纯 JavaScript，无构建步骤，无安装脚本。

## License

MIT
