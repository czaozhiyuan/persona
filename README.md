# persona · P0 技术验证原型

光电传输设备的 1U 机箱布局、逻辑拓扑、命名链路与经验预算薄原型。依据 [P0 任务书](docs/P0_技术验证任务书.md) 实现，不代表 V1 正式架构。

直接使用：[打开单文件 HTML](artifacts/persona-p0.html)。也可以在资源管理器中用 Chrome/Edge 打开 `artifacts/persona-p0.html`，运行时不需要 Node、服务端或网络。

## 构建与验证

实测环境：Windows x64，Node **24.14.0**，npm **11.9.0**。依赖精确版本由 `package-lock.json` 固定。

```powershell
cd E:\2026\Persona
npm ci --cache ./artifacts/npm-cache --registry https://registry.npmjs.org
npm run verify
npm run test:browser
```

`verify` 依次执行 8 项纯数据层测试、TypeScript 类型检查、Vite 单文件构建和示例 JSON 生成。浏览器脚本使用本机安装的 Chrome 和 Edge；不下载额外 Chromium、不启动 HTTP 服务。它以 headless 模式运行，将浏览器上下文设为 offline，并保存截图和 JSON 下载证据。安装依赖需要网络，使用生成的 HTML 不需要网络。

构建产生 `dist/index.html`，并生成相同内容的 `artifacts/persona-p0.html`、SHA256、构建信息和第三方许可声明。HTML 本身含完整运行资源与许可声明，单独复制即可运行。`npm run dev` 仅供源码开发，交付物不依赖开发服务器。

## 操作示例

1. 打开 HTML，默认载入双通道示例，选择 `RF_CH28` / `RF_CH30`，查看节点、光纤高亮及逐级摘要。
2. 当前通道光增益选择 `-3 dB` / `0 dB` / `+3 dB`，RF 增益分别为 **−28 / −22 / −16 dB**。切换另一通道应保持不变。
3. 切换“机箱布局”，拖动矩形；在右侧修改 mm 坐标、旋转 90° 或修改顶层实例名称。逻辑坐标与物理坐标独立，名称在两视图共享。
4. 选中 `tx28`，修改本实例激光功率/通道；修改“共同 MZM 光增益”验证两个模块实例共享定义。模块在拓扑中有对外端口和虚线映射，物理视图只放置内部实体器件。
5. 在连接面板选择 `input28:rf → pcb:RF_IN` 可新增连接，选择 `input28:rf → pcb:OPT_IN` 会提示类型不兼容。拓扑端口也支持拖线；模块内部网络通过 JSON/共享参数编辑，对外通过模块端口连接。
6. 选择 `PCB → RF 后级` 查看 1–5 GHz 表格及纯 RF Friis NF。选择 `PCB 光端口` 查看光功率；`未定义关系` Link 明确显示无法连通。
7. 导出 JSON，清空工程，再导入刚导出的文件；或导入 [示例 JSON](examples/p0-project.json)。无浏览器缓存持久化，请自行保存工程。

拓扑可滚轮缩放、平移，左下角提供缩放/适配全图按钮。建议桌面窗口宽度至少 1100 px。P0 没有器件库管理、自动布线、碰撞检测和撤销重做。

## 文件与边界

| 路径 | 用途 |
|---|---|
| `src/model/` | 纯数据类型、离散通道目录、示例工程 |
| `src/engine/` | 模块实例解析、端口图、唯一路径、经验计算；不导入 React/xyflow/Konva |
| `src/storage/` | 当前 JSON 结构校验、解析、序列化与下载 |
| `src/editors/` | React Flow 拓扑、React Konva 物理布局 |
| `examples/p0-project.json` | 共享模块、覆盖、布局、Connection/Link/Channel 示例 |
| `docs/P0_验证报告.md` | A1–A9 真实验证记录、截图、限制及人工验收步骤 |
| `docs/P1-P5_架构建议.md` | 后续阶段需要冻结的数据边界 |
| `artifacts/` | 单 HTML、日志、下载文件、截图与构建信息；npm 缓存不进入版本控制 |

本次自动验证覆盖 A1–A9；A1 的浏览器 offline 测试已通过，**系统断网后的人工双击与原生文件对话框验收尚未执行**。详见验证报告，不能将自动化结果当作人工验收记录。
