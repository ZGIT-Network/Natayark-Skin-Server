# 部署

先按 README 完成配置、数据库初始化和首个管理员设置。已有站点使用[迁移流程](migration.md)。

## 运行

```sh
npm ci
npm run build
npm start
```

构建需要开发依赖；如果要裁剪依赖，在构建完成后再执行 `npm prune --omit=dev`。站点仍需要 `src/views/`、`public/` 和运行时依赖，不要只复制 `dist/`。

生产环境设置 `NODE_ENV=production`，并使用 HTTPS。`APP_KEY` 必须是私密随机值，至少 32 个字符；`npm run setup` 会为新配置生成密钥。不要在重启或增加实例时重新生成它。

建议由反向代理提供 HTTPS，Node 监听本机或私有网络。`PUBLIC_ORIGIN` 填外部 HTTPS 地址。

`TRUST_PROXY` 默认是 `loopback`，同机 nginx 只要转发 `X-Forwarded-For` 和 `X-Forwarded-Proto`，登录限流、验证码和日志记录到的就是访客真实 IP。反向代理在容器或另一台机器时，改成代理出口所在的 IP/CIDR，例如 `TRUST_PROXY=loopback,172.18.0.0/16`；不要使用 `true` 信任任意来源。`HOST=127.0.0.1` 时 Node 只监听本机，让 nginx 独占对外端口：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## 响应头与资源限制

在已有 HTTPS `server` 块中可添加以下响应头；HSTS 不要放在纯 HTTP 监听或重定向块。应用也会返回基础响应头，代理配置应与之保持一致：

```nginx
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Content-Security-Policy "base-uri 'self'; object-src 'none'; frame-ancestors 'none'" always;
add_header Strict-Transport-Security "max-age=31536000" always;
```

基础 CSP 保留现有内联脚本和自定义 JS。收紧 `script-src` 前先部署报告策略，检查站点脚本、reCAPTCHA 和自定义内容，再逐步引入 nonce。代理请求大小上限应覆盖业务文件大小及表单字段开销。

上传奖励、认证并发、动态缓存、私有/删除语义及文件回收配置见[资源与安全说明](security-hardening.md)。

## 持久化

数据库、`.env` 和 `storage/` 应持久保存。`TEXTURE_DIR` 可指向独立材质目录。备份时同时保留数据库和材质，单独恢复其中一项可能出现缺失文件或过期引用。

多实例须共享数据库、相同 `APP_KEY` 和材质存储。join 记录在独立认证状态表中共享，30 秒后失效；令牌吊销与账户状态仍在 hasJoined 时重新验证。

## 邮件与第三方服务

需要邮箱确认或找回密码时填写 `MAIL_*`。第三方登录按后台配置或 `.env.example` 中的凭据启用，并在提供方登记完整回调。

Microsoft 网站登录使用 `LIVE_KEY`／`LIVE_SECRET`；Minecraft Java 正版验证使用独立的 `MICROSOFT_KEY`／`MICROSOFT_SECRET`。正版验证回调地址为 `PUBLIC_ORIGIN/mojang/callback`。未配置时，仪表盘显示“暂未开放”；配置后再用真实正版账户验收完整授权流程。

部署后用临时账户实际完成邮件接收、第三方授权和启动器登录。不要把测试账户、数据库备份或密钥放进公开仓库。
