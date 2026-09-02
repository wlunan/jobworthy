# 职得 - JobWorthy

> **AI 驱动的求职信息聚合平台** —— 800+ 央企 / 互联网大厂 / 各行业企业招聘节点，分批加载 + 分页浏览，浏览器即可使用。

[![Version](https://img.shields.io/badge/version-3.0.0-blue)]()
[![License](https://img.shields.io/badge/license-Apache%202.0-green)]()

## 简介

「职得」把分散在企业官网、官方公众号、综合招聘网站上的招聘机会汇聚到一张可筛选、可分页、可管理的表格中，覆盖校招 / 社招 / 实习全场景。

- **零后端**：纯前端单页应用 + 静态 JSON 数据，GitHub Pages 直接托管
- **数据每日同步**：`scripts/sync_tencent_docs.py` 每周自动从腾讯文档智能表格拉取最新数据生成 `jobs.json`，页面打开即读
- **个人投递记录**：投递管理数据存于浏览器本地（localStorage），支持 JSON 备份与恢复
- **四层抓取策略**：内置默认 Firecrawl Key，主选 + AnySearch 自动兜底 + BrowserAct / OpenCLI 本地 CLI 备用

## 快速上手

### 通过 GitHub Pages 访问

仓库内置 `.github/workflows/pages.yml`：

- 推送到 `main` 时自动部署 GitHub Pages
- 每天北京时间 09:30 自动运行 `scripts/sync_tencent_docs.py`
- `jobs.json` 变化后由 GitHub Actions Bot 提交并重新部署
- 也可在 GitHub Actions 页面通过 `workflow_dispatch` 手动执行

首次使用请在仓库 Settings → Pages 中将 Source 设置为 **GitHub Actions**，并确保 Actions 具有读写仓库内容的权限。

> 个人投递记录保存在当前浏览器本地，不会写入公开的 `jobs.json`。每日同步后，只要公司、岗位、地点和链接没有变化，投递记录会继续关联到对应岗位。

### 本地预览

直接打开 `index.html` 即可（项目仅通过 GitHub Pages 链接访问，无构建步骤）。

## 核心功能

### 招聘机会页（`index.html`）

- **筛选与搜索**：按行业、数据源、地点/关键词定向过滤；搜索框支持字段选择（公司 / 职位 / 地点 / 行业 / 批次 / 来源）
- **分页浏览**：20 / 50 / 100 条/页切换，上一页/下一页按钮
- **排序**：支持按更新时间、截止日期、公司名称、批次排序
- **投递管理**：未管理显示「加入管理 / 不考虑」，已加入显示「已加入 · 查看 / 不考虑」，已排除改为「已排除」状态标签 +「恢复」按钮
- **视图状态持久化**：筛选条件、排序方式、页码、每页条数保存到当前浏览器（localStorage key `xiaozhao_radar_view_state_v1`），重新打开后自动恢复
- **一键爬虫**：内置默认 Firecrawl Key，公开页免登录直接抓取；前 20 站加载完立即展示，剩余后台续拉
- **备用工具**：Firecrawl 失败时自动调用 AnySearch 兜底；遇到反爬 / 验证码可切换 BrowserAct 或 OpenCLI（详见页面「🛡 备用工具」弹窗）
- **数据源扩展位**：每条岗位记录带 `ds` 数据源标识，工具栏新增「数据源」筛选下拉，后续接入其他表格岗位数据时追加选项即可
- **底栏访问统计**：底部展示站点 PV / UV（VerCount）

### 我的投递工作台（`applications.html`）

- 从招聘机会页将岗位加入投递管理
- 直接编辑公司、岗位、渠道、状态、投递日期、一面日期和备注
- 原岗位地点、批次、更新时间、截止日期、官方公告和投递链接默认隐藏，可按需展开
- 支持列筛选、排序、移动和分页
- 支持 JSON 完整备份的导入/导出，以及 CSV 表格导出
- 投递记录仅保存在当前浏览器，请定期导出 JSON 备份

## 使用示例

### 示例 1：抓取互联网大厂 2027 校招（云端，零安装）

1. 打开 `index.html`
2. 工具栏「行业」选 **互联网科技**
3. 搜索框填 **2027**（可选：填 **北京** 做地点定向）
4. 点 **🕷 一键爬虫** → 前 20 站加载完立即展示，剩余后台续拉

### 示例 2：抓取受反爬保护的招聘页（本地 CLI 备用）

Firecrawl 被站点拦截或带验证码时：

```bash
# 安装 CLI
npm install -g browser-act
browser-act login

# 零配置抓取
browser-act stealth-extract "https://join.qq.com/" --out ba_result.json
```

回到页面点「📤 导入」选择 `ba_result.json`。需要登录态的全量库（如 51job）使用 OpenCLI xiaozhao 适配器，命令类似。

### 示例 3：让 AnySearch 走稳定本地代理

```bash
node tools/proxy.js            # 默认端口 8787
node tools/proxy.js 9090       # 自定义端口
```

代理启动后页面自动检测并使用，无需额外配置。

### 示例 4：导出我的投递记录

在 `applications.html` 点 **导出 JSON** 即可下载完整备份；下次在新设备/新浏览器打开后用 **导入 JSON** 恢复。

## 数据源

| 分类 | 数量 | 覆盖 |
|------|------|------|
| 企业官网招聘页 | 126 | 腾讯 / 阿里 / 字节 / 美团 / 百度 / 京东 / 华为 / 小米 / 国家电网 / 中石化 / 中石油 / 中国移动 … |
| 企业官方公众号 | 16 | 华电 / 科环龙源 / 上汽 / 中建 / 字节 / 腾讯 IEG / 拼多多等官方招聘号 |
| 新增公开校招节点 | 714 | 互联网科技 (195) / 银行金融 (51) / 综合 (284) / 能源电力 (43) / 装备重工 (29) / 快消零售 (21) / 汽车制造 (19) / 医药医疗 (17) / 通信运营商 (9) / 建筑地产 (11) / 石油化工 (6) / 交通物流 (3) / 农业食品 (3) / 航天军工 (6) / 证券基金 (4) 等 |
| 综合招聘网站 | 3 | 51job 校招 / 应届生求职网 / 国聘 |

详细数据量与覆盖以 `jobs.json` 中 `count` 字段为准（数据每周同步）。

## 文件结构

```
jobworthy/
├── index.html                   # 招聘机会页（HTML 结构）
├── applications.html            # 我的投递工作台
├── jobs.json                    # 页面默认加载的聚合数据
├── assets/
│   ├── js/                      # 前端 ES Modules：app.js 主逻辑 / sites.js 站点配置 / sample-data.js 样例
│   ├── index.css                # 招聘机会页样式
│   └── ui.css                   # 公共 UI 样式
├── scripts/                     # 离线数据同步脚本
├── tools/                       # 本地辅助工具（CORS 代理）
├── docs/                        # 项目导读与同步说明
│   ├── 了解项目.md              # 项目当前真实结构与数据链路
│   └── SYNC.md                  # 腾讯文档 → GitHub 数据同步方案
├── archive/                     # 旧页面和历史数据，仅供参考
├── README.md                    # 本文件
├── CHANGELOG.md                 # 版本变更历史
├── manifest.json                # 项目元数据
└── LICENSE                      # Apache 2.0
```

## 常见问题

### Q: 一键爬虫返回空数据？
A: 站点多时免费层 Firecrawl 有速率限制；前 20 站加载完会立即展示，后续站点后台陆续加载；也可先选「行业」定向爬取缩小范围。

### Q: 页面显示旧版？
A: 浏览器缓存问题，按 **Ctrl + Shift + R** 强制刷新。

### Q: 页面里的数据是实时的吗？
A: 是。页面打开时自动读取服务器上每周同步的 `jobs.json`，无需手动导入导出。

## 许可证

Apache 2.0 License — 详见 [LICENSE](LICENSE)。

## 相关文档

- [CHANGELOG.md](CHANGELOG.md) — 完整版本变更历史（v1.0.0 起）
- [docs/了解项目.md](docs/了解项目.md) — 项目当前真实结构、数据链路与二次开发指南
- [docs/SYNC.md](docs/SYNC.md) — 腾讯文档 → GitHub Pages 数据同步工作流
