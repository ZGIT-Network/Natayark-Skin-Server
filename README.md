# Natayark Skin Server

一个自托管的 Minecraft 皮肤站，使用 Node.js、TypeScript 和 MySQL。管理皮肤、披风和游戏角色，提供 Yggdrasil 外置登录与 Yggdrasil Connect，也可以通过第三方账号登录网站。

这是一个基于 Blessing Skin Server 设计理念独立开发的Minecraft皮肤站系统。

## 开始使用

需要 Node.js 22 或更新版本，以及一个 MySQL 数据库。现有数据库兼容测试使用 MySQL 5.7.26，其他版本的实测情况见[兼容说明](docs/compatibility.md)。

```sh
npm ci
npm run setup
```

`setup` 会生成带随机 `APP_KEY` 的 `.env`，已有文件不会覆盖。填写数据库连接信息后，为新站创建表：

```sh
npm run db:init -- --apply
npm run build
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000) 注册自己的账户，再用本地命令将其设为管理员：

```sh
npm run admin:promote -- --email you@example.com --apply
```

站点名称、配色、圆角、首页样式、版权和备案信息可以在后台调整。邮箱确认、找回密码需要配置 SMTP；第三方登录需要配置客户端凭据和回调地址。

已有 Blessing Skin 站点请先读[从 Blessing Skin 迁移](docs/migration.md)，保留原账户、材质和第三方登录，不要运行新站初始化命令。生产环境的 HTTPS、反向代理、持久化与备份见[部署说明](docs/deployment.md)。

## 主要功能

- 皮肤和披风上传、皮肤库、衣柜、静态渲染与可操作的 3D 预览。
- 多角色管理、材质应用、积分、签到、举报和通知。
- 邮箱密码、角色名及第三方登录，邮箱验证、密码重置和应用授权管理。
- Yggdrasil 与内置 Yggdrasil Connect，无需另外运行 Janus。
- 自动深色模式、多种首页、可配置配色和圆角。

功能范围与已知限制见[兼容说明](docs/compatibility.md)。

## 开发与贡献

```sh
npm run typecheck
npm test
npm run build
```

数据库集成测试使用独立表命名空间，准备方法见[开发说明](docs/development.md)。修复问题或提交新功能前，可以先开 issue 说明实际场景；界面修改请附截图。具体约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 的方式报告。

## 许可证

项目采用 [MIT License](LICENSE)，允许使用、修改和商业使用，分发时须保留版权及许可文本。页面默认保留 `Powered by Natayark Skin Server`，感谢使用者保留这处署名。

依赖和随附资源的许可单独列在[第三方说明](THIRD_PARTY_NOTICES.md)。

## 特别鸣谢

感谢 [Blessing Skin](https://github.com/bs-community/blessing-skin-server) 对 Minecraft 皮肤站生态的贡献。它的功能设计与接口行为为本项目的独立复现和兼容性验证提供了参考。
