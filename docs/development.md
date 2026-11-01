# 本地开发与测试

```sh
npm ci
npm run setup
npm run dev
```

`setup` 只在 `.env` 不存在时创建配置。修改模板不会覆盖开发者现有配置。

## 常规检查

```sh
npm run repo:check
npm run typecheck
npm test
npm run build
```

单测无需数据库，检查密码算法、渲染、外观、搜索和反馈组件。不要将构建成功等同于真实启动器验收。

## 数据库集成测试

准备专用测试数据库，在测试环境中设置连接信息，并将 `DB_TABLE_PREFIX` 设为新的 `dev_` 命名空间，例如 `dev_ci_`：

```sh
npm run db:init -- --apply
npm run test:integration
```

不要为此覆盖生产 `.env`；可通过终端环境变量或独立工作副本指定测试配置。命名空间已有表时，初始化命令会拒绝执行；重复测试可直接运行集成套件。

套件顺序运行，使用临时账户和模拟的上游 HTTP／SMTP。测试进程禁用真实 SMTP。搜索对照数据位于 `tests/fixtures/`，跨实例 join 测试会启动并关闭独立本地进程。

`audit-legacy-database.mjs`、`verify-original.mjs` 和完整原库快照脚本属于迁移维护工具，依赖本地原站数据，不是新贡献者日常测试的前置步骤。

## 浏览器检查

涉及界面时，至少检查桌面和手机、浅深色、表单错误、键盘操作及减少动态效果设置。截图可以放在 `output/playwright/`，提交 PR 时只附脱敏后的必要图片；该目录不纳入版本控制。

站内 HTML 链接与 GET 筛选使用局部导航，同一应用布局保留侧栏和顶部导航。页面模块需提供 `mount`／`unmount`，离开时释放事件监听、观察器、WebGL 与对象 URL；不要在每次切换时重复注册全局监听。

自定义前端代码可以监听 `document` 的 `site:before-render` 释放资源，监听 `site:page-load` 初始化新内容。后台自定义脚本在首次加载执行一次，局部导航不会重复执行返回 HTML 中的任意脚本。认证、下载与原生提交表单仍走浏览器正常流程。
