# 第三方依赖与资源

项目代码采用根目录的 MIT 许可。依赖和资源分别遵守其各自的许可，项目的 MIT 不会替换这些许可。

## 前端分发内容

| 内容 | 用途 | 许可 |
| --- | --- | --- |
| [skinview3d](https://github.com/bs-community/skinview3d) | 交互式皮肤与披风预览 | MIT |
| [skinview-utils](https://github.com/bs-community/skinview-utils) | 皮肤图像处理，随预览包构建 | MIT |
| [three.js](https://github.com/mrdoob/three.js) | 3D 渲染，随预览包构建 | MIT |
| [Inter](https://github.com/rsms/inter) | 界面字体 | SIL Open Font License 1.1 |
| [xicons / Ionicons 5](https://github.com/07akioni/xicons) | 通过 `@sicons/ionicons5` 使用 SVG 图标 | MIT |

构建会将预览包和字体的原始许可复制到 `public/licenses/`，随静态资源分发。Ionicons 的作者与许可文本也保存在该目录。

其他运行时依赖通过 npm 安装，其许可和版权文本保留在各自包中；具体版本以 `package-lock.json` 为准。

## 测试与站点内容

`tests/fixtures/` 中的参考数据只用于兼容性和渲染测试，生成方式见该目录说明。

部署者配置的背景、Logo、上传皮肤、披风和其他站点内容，其权利归各自权利人，不因使用本软件而自动变成 MIT 许可。分发新增图片、字体或代码时，请补充真实来源和授权信息。
