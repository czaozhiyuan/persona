# persona · P0 技术验证原型

P0 是已完成的技术可行性验证，覆盖 React Flow 逻辑拓扑、Konva 机箱布局、Vite 单 HTML 构建和离线运行。V1 按[已确认的架构](docs/architecture/V1_架构设计.md)独立实现，以 V1 的工程格式、示例和验收用例为依据。

直接使用：[打开单文件 HTML](artifacts/persona-p0.html)。也可以在资源管理器中用 Chrome/Edge 打开 `artifacts/persona-p0.html`，运行时不需要 Node、服务端或网络。

## 构建

实测环境：Windows x64，Node **24.14.0**，npm **11.9.0**。依赖精确版本由 `package-lock.json` 固定。

```powershell
cd E:\2026\Persona
npm ci --cache ./artifacts/npm-cache --registry https://registry.npmjs.org
npm run verify
```

`verify` 执行 TypeScript 类型检查、Vite 单文件构建和示例 JSON 生成。安装依赖需要网络，使用生成的 HTML 不需要网络。

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

[P0 验证报告](docs/P0_验证报告.md)保留当时的结果和验证范围，供查阅技术可行性结论。

## V1 工作台预览

安装依赖后运行 `npm run dev`，在 Vite 显示的地址后加 `/v1.html`（例如 `http://localhost:5173/v1.html`）。工作台默认加载 V1 示例，也可新建空工程。

### 构建 V1 单 HTML

在干净的 V1 提交上执行以下命令。发布入口为 `v1.html`，用锁文件安装构建依赖。

```powershell
npm ci
npm run test:v1:model
npm run build:v1
Get-FileHash artifacts/v1/persona-v1.html -Algorithm SHA256
```

`artifacts/v1/` 包含 `persona-v1.html`、两份示例 JSON、第三方声明、`build-info.json` 和 `persona-v1.html.sha256`。构建信息记录源提交、工作树状态、最终 HTML 和示例文件的大小与 SHA256。HTML 内嵌运行资源及第三方声明，校验值以完成打包后的文件为准。

将 `persona-v1.html` 单独复制到空目录，停止开发服务器并断网，用 Windows Chrome 或 Edge 直接打开。页签标题应为「persona · V1 工作台」。可直接加载内置完整示例。若要打开外部工程，在「工程」菜单选择 JSON 文件。

### V1 示例验收

「工程 → 加载示例」打开[完整系统](examples/v1-project.json)。通过「工程 → 打开工程 JSON」也可打开该文件或[独立发射机箱](examples/v1-tx-only.json)。

1. **跨机箱 EO→OE。** 在「链路 → 命名链路」选择「跨机箱 EO→OE（full）」。展开「供光查询」，选择 `TX_A / laser · OUT`，通道 `DWDM_CH28`，功率填 `0 dBm`，点「添加供光」。路径经过 `TX_A / mzm`、`TX_A / optical-switch`、MPO 纤芯 `wdm` 和 `RX_A / pd`。在「逻辑拓扑」可查看高亮。
2. **核对预算与开关。** 单点设为 `1 GHz`，RF 输入填 `−20 dBm`。展开 EO→OE 明细，PD 光功率应为 **−5.0 dBm**（0 − 3 − 2）。Profile 的固定 PD 参考是 −5 dBm，1 GHz 参考 RF 增益是 −22 dB，默认 K = 2。因此总增益 **−22.0 dB**，RF 输出 **−42.0 dBm**，跨域 NF 未建模。运行 0–67 GHz 扫描可查看 68 点，0 GHz 的 RF 增益留空，67 GHz 为 −16.0 dB。在拓扑进入 Transmitter A，选择 Optical switch，打开「属性与标定 → 对象属性」，将开关状态从 Pass 改为 Block 并保存实例属性。返回命名链路应显示不可达；恢复 Pass 后重新得到预算。
3. **纯 RF 与 DC。** 选择「纯 RF 两级预算（pure-rf）」，输入 `−20 dBm`，总增益、输出和 Friis NF 应为 **15.0 dB、−5.0 dBm、3.6 dB**。「预算 → DC 供电预算」中，`TX_A / dc-converter` 的 4 W 输出负载以效率 0.8 折算为 5 W 输入，加 3 W 直供负载，`TX_A / dc-supply` 总需求 **8.0 W**，额定 **7.0 W**，超载 **1.0 W**。在 Transmitter A 的对象属性中把「直供负载功耗」的实例覆盖设为 2 W，A 的需求变为 7.0 W，B 保持 8.0 W。
4. **布局与往返。** 在「物理布局」选 Transmitter A 和已放置的 MZM，把 X 从 20 改为 25 mm 并保存位置。通过「工程」菜单保存和重开下载的 JSON。MZM 的 X 应仍为 25 mm，逻辑接线与坐标保留；复算时重新填写临时供光功率。
5. **独立发射端。** 打开 `v1-tx-only.json`，`tx-only` 显示未完成。在「预算 → 局部光功率」选「经 EO 器件供光」，添加与步骤 1 相同的供光，选 EO 边界 `TX_A / mzm · RF_IN → OUT`、目标 `TX_A · OPT_OUT`、输出通道 `DWDM_CH28`。结果为 **−5.0 dBm**。保存并重新打开后，`TEST_OUT` 仍开放，`tx-only` 仍只有起点。
