# 宝塔日常更新教程（照着做即可）

这份教程只适用于下面这种部署：

- 项目目录：`/www/wwwroot/Facebook-api-main`
- API 由宝塔 Node 项目管理
- Worker 由 PM2 管理
- Node 内部端口是 `3000`
- 对外 HTTPS 端口是 `8443`

首次安装和第一次配置 8443 请看 [宝塔完整部署指南](DEPLOY_BAOTA_UBUNTU.md)。已经安装成功、以后只想更新正式 `main` 代码时，按本文操作。

## 一、第一次更新前，只做一次

如果 Git 曾提示：

```text
fatal: detected dubious ownership in repository
```

执行：

```bash
git config --global --add safe.directory /www/wwwroot/Facebook-api-main
```

这条命令只是在告诉 Git“这个项目目录可以信任”，不会修改项目代码。成功时没有输出，以后不需要重复执行。

## 二、以后每次更新，只做 4 步

### 第 1 步：在宝塔停止 API

打开宝塔面板的 Node 项目页面，找到 `Facebook_api_main`，点击“停止”。

只停止宝塔管理的 API。不要删除项目，不要清空数据库，也不要手工停止 PostgreSQL 或 Redis。

### 第 2 步：拉取 GitHub 正式 main

在宝塔终端逐行执行：

```bash
cd /www/wwwroot/Facebook-api-main
git pull --ff-only origin main
```

正常结果会显示已经是最新版本，或者列出本次更新的文件。如果仍提示 `dubious ownership`，先执行本文第一部分的命令，再重新执行 `git pull`。

如果提示本地修改冲突，先停下来检查，不要执行 `git reset --hard`，否则可能丢失服务器上的修改。

### 第 3 步：运行统一更新脚本

继续执行：

```bash
sudo bash deploy/update_baota.sh
```

脚本会自动寻找宝塔的 Node、npm 和 PostgreSQL，备份数据库与 `.env`，安装依赖，修复数据库权限，执行迁移和自检，并启动唯一的 `capi-worker`。

看到下面两行才表示更新完成：

```text
[baota-update] update completed successfully
[baota-update] restart the API project once in Baota
```

`npm WARN`、版本升级提示或可选依赖提示不等于失败；只要脚本继续运行并最终出现上面的成功提示，就不需要额外处理。

### 第 4 步：回到宝塔启动 API 并验收

回到宝塔 Node 项目页面，点击“启动”或“重启”。等待约 10 秒，再执行：

```bash
curl -fsS http://127.0.0.1:3000/healthz
curl -i http://127.0.0.1:3000/readyz
curl -i https://pixel.atelierwrap.cc:8443/healthz
```

正确结果：

- `healthz` 返回 `ok` 或包含正常状态；
- `readyz` 的 HTTP 状态是 `200`；
- 公网 `8443` 地址的 HTTP 状态也是 `200`。

最后打开：

```text
https://pixel.atelierwrap.cc:8443/admin
```

能正常进入后台，日常更新就完成了。

## 三、这些命令不要再手工执行

宝塔服务器不要单独执行：

```bash
npm ci --omit=dev
npm install -g npm
pm2 startOrReload ecosystem.config.js
rm -f .maintenance
git reset --hard
```

原因很简单：

- root 终端找不到 `npm` 是宝塔 PATH 的常见情况，不代表 Node 项目没安装；统一脚本会自动找到它。
- root 直接运行 npm 可能制造权限不一致，导致以后出现 `EACCES`。
- API 已由宝塔管理，再用 PM2 启动 API 会争用 `3000` 端口；PM2 在这里仅管理 Worker。
- 更新失败时 `.maintenance` 是保护数据的维护标记，不能为了强行上线而手工删除。

## 四、失败时怎么处理

如果脚本没有显示 `update completed successfully`：

1. 不要启动宝塔 API，也不要删除 `.maintenance`。
2. 向上查找屏幕中第一条 `[baota-update:error]`、`FAIL` 或 `npm ERR!`。
3. 修复第一条真正错误后，重新执行同一条命令：

```bash
cd /www/wwwroot/Facebook-api-main
sudo bash deploy/update_baota.sh
```

脚本可以安全重跑，不需要从头重装服务器。

### `npm: command not found`

不要再运行裸 `npm`。直接运行：

```bash
sudo bash /www/wwwroot/Facebook-api-main/deploy/update_baota.sh
```

### `EACCES` 或 `/www/server/nodejs/cache`

这是旧版脚本使用宝塔共享 npm 缓存时可能出现的权限问题。先拉取最新 `main`，再重跑统一脚本；新版会使用项目运行用户专用的 npm 缓存：

```bash
cd /www/wwwroot/Facebook-api-main
git pull --ff-only origin main
sudo bash deploy/update_baota.sh
```

### 更新成功但网页显示 500 或 502

先确认已经在宝塔重新启动 API，然后执行：

```bash
curl -i http://127.0.0.1:3000/healthz
curl -i http://127.0.0.1:3000/readyz
```

- 内部地址失败：查看宝塔 Node 项目日志。
- 内部地址成功、8443 失败：检查宝塔 Nginx 日志和 8443 反向代理。
- `readyz` 不是 200：按响应内容检查 PostgreSQL、Redis 或 Worker，不要只靠反复重启掩盖问题。

## 五、一句话记住运行关系

```text
宝塔只管 API（src/server.js，3000）
PM2 只管 Worker（capi-worker）
Nginx 对外提供 HTTPS（8443）
```

更新时：**宝塔停止 API → Git 拉取 main → 运行统一脚本 → 宝塔启动 API → 检查 3 个地址。**
