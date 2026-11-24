# english-daily

每天一篇英文一手长文：原文全文 + 中文导读 + AI 精读（结构 / 难句 / 词汇 / 句式 / 思辨）。

线上：https://kuangketongxue.github.io/english-daily/

## 结构

```
index.html            资料库首页（文章 / 书籍 / 剧集 / 电影 / 收藏）
read.html             阅读页，?d=YYYY-MM-DD
assets/css/base.css   设计令牌、双主题、按钮、抽屉
assets/css/home.css   应用壳：侧栏 + 列表
assets/css/read.css   阅读页：版式、目录、精读
assets/js/lib.js      存储、评分、收藏、进度、朗读、抽屉
assets/js/repo.js     评分同步到 GitHub 仓库
assets/js/home.js     首页逻辑
assets/js/read.js     阅读页逻辑
data/index.json       首页目录（只有摘要级字段，正文不进这里）
data/posts/*.json     每期全文 + 导读 + 精读
data/ratings.json     评分与收藏（浏览器写回）
scripts/daily.mjs     每日选品与写稿
scripts/sources.json  RSS 信源
.github/workflows/daily.yml  定时任务
```

## 每天的稿子怎么来

`scripts/daily.mjs` 拉全部 RSS + 全网检索，按热点与站点权重排序，去重后逐篇抓正文，
正文够长才收；然后让模型产出导读与精读，校验不过会带着问题重问一次。
没有 `AI_API_KEY` 时不会静默产出半成品：正文照发，站点自动隐藏精读区。

本地只重建目录（手改过 `data/posts/*.json` 之后）：

```bash
node scripts/daily.mjs --reindex
```

## 评分同步

页面是纯静态，评分默认只存在浏览器。设置里填一个只属于本机的 GitHub 令牌
（`contents: write`），即可把 `data/ratings.json` 写回仓库；冲突会自动重取版本重试，
按时间戳逐条合并，不整块覆盖。令牌不会离开浏览器。
