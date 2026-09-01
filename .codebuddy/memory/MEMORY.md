# MEMORY

## 使用方式（2026-09-01 用户澄清）
- xiaozhao-radar 仅通过链接（GitHub Pages）访问，**不存在本地双击 HTML 的使用方式**。前端架构演进（ES Modules 拆分、构建工具、框架）无需保留 `file://` 直开兼容；docs/SYNC.md 已按此更新。

## 项目约定
- 版本变更惯例：README.md 顶部加「核心亮点」小节 + 「更新日志」条目 + 升级版本徽章，index.html 顶栏版本号同步。
- 数据链路：scripts/sync_tencent_docs.py（每周五，触发词「同步校招」）→ jobs.json → GitHub Pages；页面 fetch jobs.json，兜底 localStorage。
- 数据字段：压缩单字母键（c/p/l/w/d/s/t/ind/ut/a/u），v2.4.2 起新增 ds（数据源，默认"校招信息聚合平台"，预留多表格扩展）、e（学历）已下线。
- 搜索框带字段选择器（searchField），v2.4.2 实现；视图状态存 localStorage key `xiaozhao_radar_view_state_v1`。

## 工作经验
- 对 index.html（约 1775 行单文件）做批量 replace_in_file 时，出现过工具报成功但实际未落盘（疑似写入锁超时回滚），批量编辑后必须 grep 复核关键改动。
