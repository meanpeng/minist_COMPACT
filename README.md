# MNIST Compact

一个围绕 MNIST 手写数字识别竞赛流程构建的全栈练习项目。

前端使用 React + Vite，后端使用 FastAPI。项目模拟了一个完整的课堂竞赛场景，包含创建/加入队伍、标注数据、配置模型、训练模型、提交验证、排行榜和管理员后台。

## 主要功能

- 竞赛入口页：检测后端状态，创建队伍或通过邀请码加入队伍
- 总览页：查看队伍邀请码、成员、标注进度、最近验证结果和排行榜
- 标注页：提交数字标注样本并累计队伍进度
- 建模页：配置模型结构
- 训练页：记录训练过程和训练指标
- 提交页：对挑战集进行推理并提交结果
- 管理员页：创建竞赛、调整规则、控制竞赛状态、清理队伍/标注/提交记录

## 技术栈

- 前端：React 19, Vite, Vitest, TensorFlow.js
- 后端：FastAPI, Uvicorn, SQLite
- 测试：Python `unittest` + 前端 `vitest`

## 项目结构

```text
.
├── src/                  # 前端页面、组件、工具函数
├── backend/              # FastAPI 后端服务、测试、数据库与数据文件
├── data/                 # 前端示例图片与资源
├── dist/                 # 前端构建产物
├── package.json
└── vite.config.js
```

后端的核心代码在 `backend/app/`，前端路由入口在 `src/App.jsx`。

## 快速开始

### 1. 安装依赖

先安装前端依赖：

```bash
npm install
```

再安装后端依赖：

```bash
python -m pip install -r backend/requirements.txt
```

### 2. 配置环境变量

后端通过环境变量读取配置。默认值已经适合本地开发，但如果你想显式配置，可以参考 `backend/.env.example`。

常用变量如下：

- `DATABASE_PATH`：SQLite 数据库路径，默认 `backend/data/app.db`
- `CORS_ORIGINS`：允许的前端来源，默认 `http://localhost:5173,http://127.0.0.1:5173`
- `ADMIN_UI_BASE_URL`：管理员入口地址，建议设置成你对外访问的前端域名
- `ADMIN_TOKEN`：可选的固定管理员 token；不设置时后端启动时会自动生成
- `TEAM_ANNOTATION_GOAL`：队伍标注目标数，默认 `50`
- `TEAM_MEMBER_LIMIT`：队伍人数上限，默认 `5`
- `SESSION_DURATION_HOURS`：会话有效期，默认 `24`
- `SUBMISSION_CHALLENGE_TTL_MINUTES`：提交挑战有效期，默认 `10`
- `SUBMISSION_COOLDOWN_MINUTES`：提交冷却时间，默认 `5`
- `SUBMISSION_TEAM_MAX_ATTEMPTS`：队伍提交次数上限，默认 `10`
- `DEFAULT_TEST_DATASET_SOURCE`：新竞赛默认测试集来源，默认 `local_test`，正式竞赛不要使用公开 MNIST 测试集
- `VITE_API_BASE_URL`：前端请求后端的地址；不设置时默认使用当前站点同源地址，适合 nginx 反代或前后端同域部署

### 3. 启动后端

从仓库根目录执行：

```bash
uvicorn backend.main:app --reload
```

后端默认监听 `http://localhost:8000`，启动后会在终端打印管理员管理链接。

### 4. 启动前端

另开一个终端执行：

```bash
npm run dev
```

Vite 默认会启动在 `http://localhost:5173`。

### 5. 打开应用

- 普通参赛入口：`http://localhost:5173/#begin`
- 管理员入口：后端启动日志里会打印带 `admin_token` 的链接，打开后进入 `#adminneo`

## 部署建议

### Docker + Nginx 部署

项目已经提供 Docker 打包配置。镜像会先构建 Vite 前端，再用 FastAPI/Uvicorn 同时托管静态页面、`/api` 和 `/health`。`docker-compose.yml` 会额外启动一个 Nginx 容器，把公网 `80` 端口反向代理到应用容器的 `8000` 端口。

在云服务器上安装 Docker 和 Docker Compose 后执行：

```bash
cp .env.docker.example .env
```

编辑 `.env`，生产环境建议至少设置一个固定的 `ADMIN_TOKEN`。`ADMIN_UI_BASE_URL` 和 `CORS_ORIGINS` 在当前同域 Nginx 部署下不是必填项；只有当你希望后端日志打印完整公网管理员链接，或者前端和 API 分别部署在不同域名/端口时，才需要显式设置。若服务器的 80 端口已被占用，可以把 `HTTP_PORT` 改成其它端口。然后启动：

```bash
docker compose up -d --build
```

访问：

- 普通入口：`http://服务器IP/#begin`
- 管理员入口：`http://服务器IP/?admin_token=你的ADMIN_TOKEN#adminneo`
- 健康检查：`http://服务器IP/health`

运行数据保存在 Docker 命名卷 `mnist-runtime` 中，包括 SQLite 数据库、标注图片和本地隐藏测试集目录。升级镜像时直接重新执行：

```bash
docker compose up -d --build
```

如果要放隐藏测试集，推荐复制到容器的 `/app/runtime/test/<label>/*.png`，或先把数据放进命名卷对应目录，再在管理后台把测试集来源切到 `local_test`。

查看日志：

```bash
docker compose logs -f mnist-compact
```

查看 Nginx 反代日志：

```bash
docker compose logs -f nginx
```

### 手动生产部署

如果你准备把项目部署到云服务器，最省心的方式是：

1. 前端构建后由 nginx 静态托管
2. 后端 FastAPI 通过 nginx 反代到 `/api` 和 `/health`
3. 前端不设置 `VITE_API_BASE_URL`，让它默认走当前站点同源地址
4. 后端把 `CORS_ORIGINS` 和 `ADMIN_UI_BASE_URL` 改成你的公网前端地址

这样前端代码里就不会出现硬编码的 `localhost`，也更适合单域名部署。

### 一键启动脚本

如果你想本地开发时一次拉起前后端，可以直接用下面两个脚本。它们会启动后端热重载和 Vite 开发服务器：

```bash
bash ./scripts/start-linux.sh
```

```powershell
powershell -ExecutionPolicy Bypass -File ./scripts/start-windows.ps1
```

也可以直接用 `npm`：

```bash
npm run start:linux
npm run start:windows
```

正式部署不要使用上面的开发脚本。先配置好 `ADMIN_TOKEN`、`CORS_ORIGINS`、`ADMIN_UI_BASE_URL` 和隐藏测试集目录，然后使用生产脚本：

```bash
npm run build
npm run start:prod:linux
```

```powershell
npm run build
npm run start:prod:windows
```

生产脚本只启动 FastAPI/Uvicorn，不使用 `--reload`，也不启动 Vite dev server；后端会直接托管 `dist/` 静态文件，并继续提供 `/api` 和 `/health`。

## 常用脚本

```bash
npm run dev              # 启动前端开发服务器
npm run build            # 构建前端
npm run preview          # 预览构建结果
npm run test:frontend    # 运行前端测试
npm run test:backend     # 运行后端测试
npm run test:stage2      # 前后端测试一起跑
npm run test:stage3:soak:quick
npm run test:stage3:soak
```

## 测试

- 前端测试：`npm run test:frontend`
- 后端测试：`npm run test:backend`
- 联合测试：`npm run test:stage2`

如果你想做压力验证，可以运行 `test:stage3:soak:quick` 或 `test:stage3:soak`。

## 数据与持久化

- SQLite 数据库默认保存在 `backend/data/app.db`
- 标注图片默认保存在 `backend/data/annotations/`
- MNIST 数据集默认保存在 `backend/data/mnist/`
- 正式竞赛隐藏测试集建议放在 `backend/data/test/<label>/*.png`，后端会统一转成 28x28 灰度样本后下发给前端推理

这些目录都可以通过环境变量改写。

Docker Compose 会同时启动一个 Redis 容器，并通过 `REDIS_URL=redis://redis:6379/0` 启用短期热点缓存。非 Docker 本地运行时如果不设置 `REDIS_URL`，后端会自动使用进程内缓存。

## 管理员说明

管理员接口使用 `X-Admin-Token` 请求头鉴权。

如果没有显式设置 `ADMIN_TOKEN`，后端每次启动都会生成一个新的管理员 token，并在控制台输出管理链接。前端会通过 `?admin_token=...` 读取并缓存该 token。

## 备注

- 前端通过 hash 路由切换页面，核心页面包括 `begin`、`dashboard`、`annotation`、`modeling`、`training`、`submission` 和 `adminneo`
- 项目中的 `backend/main.py` 只是一个方便的入口，真正的 FastAPI 应用定义在 `backend/app/main.py`
