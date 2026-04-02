🧠 AI 原理课程竞赛 — 项目整体方案
🧩 技术栈与核心组件
🏗 前端
框架：React / Vue（任选其一，便于组件化开发）
拖拽建模：可使用 Vue.Draggable/Sortable.js 实现层级拖拽组合 UI（或 React 版本的 react-beautiful-dnd）
模型训练与推理：TensorFlow.js 浏览器端执行训练与模型管理（允许训练、可视化训练过程、保存模型等）
数据可视化：使用图表库（如 Chart.js / ECharts）显示训练曲线、准确率变化等
🧠 后端
框架：Python + FastAPI（适合做 REST API，速度快、开发简单）
数据存储：PostgreSQL / SQLite 存储用户元数据、提交记录、模型统计等
验证引擎：使用 Python 的标准库读取提交的预测结果，与服务器验证集比对计算准确率
📦 架构模式
浏览器端训练：所有模型构建、训练过程在用户浏览器中进行（借助 TF.js），避免服务器计算压力过大，同时增加参与感
服务器端验证：客户端把训练好的预测结果提交上来，由服务端做标准验证、打分和排名
🧑‍💻 前端功能一览（网页）
🖼 A. 主页（Dashboard）

展示：

当前竞赛状态：剩余时间、当前组排名榜单
自己的小组数据标注进度
最近提交的成绩

📝 B. 数据标注界面（组内共享）

功能：

通过画板写数字
标注数字标签（直接点击0-9的按钮）
显示组内标注数量
显示当前组的每个数字的数量（条状图展示）
当组内标注次数达到设定阈值时，可激活训练按钮

流程：

手写数字 -> 选择标签 -> 自动存储本地和上传到服务器 -> 组内成员更新进度


🛠 C. 拖拽式模型构建界面

这是 UI 的核心，类似“积木式建模”。

拖拽模块类型：

输入层（手写数字图片尺寸固定 28 × 28）（固定）
卷积层模块（可调 filter 数量、kernel 大小）
池化层 / Dropout / Flatten / 全连接层
Softmax 输出层（固定）

UI 实现思路：

组件库（输入层、隐藏层容器、输出层模块）
↓ Drag-and-Drop 组件组合
↓ 形成模型拓扑结构

技术参照：

Vue.Draggable 实现拖拽交互和连接逻辑
📊 D. 模型训练 & 可视化

训练界面功能：

参数选择组件
batch_size（预设选项如 16 / 32 / 64）
epoch（如 5 / 10 / 20）
学习率 lr（如 0.001 / 0.0005）
开始训练按钮
训练过程可视化
loss 曲线
准确率曲线
当前 epoch 进度

训练逻辑：

// 示例 TF.js 调用
const model = tf.sequential();
// build layers based on drag config
...
await model.fit(dataset, {...});

TensorFlow.js 支持在浏览器上训练和可视化训练行为

📤 E. 提交验证面板

当训练结束后用户按下 “提交验证”：

前端将模型的 预测结果（对验证集的预测）发送到服务器
展示提交后状态（成功 / 错误 / 排名更新）（取组内最高精度排名）
🧠 后端 API 设计（FastAPI 示例）
📌 1. 用户和组管理
POST /api/group/join

加入组 / 获取组信息

Request

{ "user_id": "xxx", "group_id": "g1" }

Response

{ "status": "ok", "group_info": {...} }
📌 2. 上传标注数据
POST /api/data/submit

上传单个标注样本

Request

{
  "user_id": "xxx",
  "group_id": "g1",
  "image_base64": "...",
  "label": 7
}

Response

{ "status": "ok" }
📌 3. 获取组内标注进度
GET /api/data/progress

Response

{ "completed": 120, "required_threshold": 150 }
📌 4. 提交预测结果

用于正式评估服务器端的验证集精度

POST /api/submit/predictions

Request

{
  "user_id": "xxx",
  "group_id": "g1",
  "predictions": [0,3,1,5...],   // 每张验证样本对应的类别
  "model_meta": {
     "param_count": 123456,
     "config": {...}
  }
}

Server Logic

加载验证集真值（服务器维护）
计算准确率
存入数据库
返回排名 / 当前成绩

Response

{
  "accuracy": 0.94,
  "rank": 3,
  "param_count": 123456
}
📌 5. 获取成绩排名
GET /api/rank

Response

[
  { "group_id": "g1", "accuracy": 0.92, "param_count": 130000 },
  ...
]
💡 训练 / 评估数据流
浏览器加载：TensorFlow.js + 所有训练数据（组内标注）
↓
浏览器训练模型 + 显示曲线
↓
训练结束后：前端生成 predictions -> POST 到 /api/submit/predictions
↓
后端用验证集真实标签计算准确率
↓
返回准确率、排名
📊 模型限制和免责逻辑

为防止模型过于复杂，你可以：

🔹 在前端提前计算模型参数量（可根据网络层加和）
🔹 拒绝超过设定阈值的配置
🔹 显示“模型参数量 / 精度”以避免过拟合问题

可以把参数量限制在合理范围（比如 ≤ 200k）以便学生训练速度不会太慢

📌 经验设计建议

✔ 可预设一些常用模型模板（如简单 CNN / LeNet）
✔ 提供“重置模型”按钮
✔ 显示组内实时进度、其他组排名
✔ 激励机制：鼓励数据标注和模型迭代