# ESP32 出入库终端固件（PlatformIO / VS Code）

首板开发框架：ESP32-S3-WROOM-1U-N16R8、ER007D UART、ST7789 240×240 SPI 屏、5×4 键盘、独立扫码键。引脚统一在 `include/board_pins.h`，依据已核对的 SVG。

## 1. 在 VS Code 打开和编译

1. 安装 VS Code 扩展 **PlatformIO IDE**（发布者 PlatformIO）。
2. 克隆/更新 `chengchuancc/JPLM`，用 VS Code **打开文件夹 `warehouse-esp32/firmware`**，不要只打开根仓库或单个 `.cpp`。
3. 等待 PlatformIO 下载依赖。默认环境为 `esp32s3`，点击底部 **Build（✓）** 编译。
4. 默认不需要填写账号即可编译并测试屏幕、按键、电池和扫码模块；没有 Wi-Fi 配置时离线运行。

PlatformIO 自带的终端里也可以运行：

```sh
pio run -e esp32s3
pio run -e esp32s3 -t upload
pio device monitor -b 115200
```

配置为 16MB Flash、8MB Octal PSRAM（`qio_opi`），基于官方 `esp32-s3-devkitc-1` 板定义覆盖内存参数。若实物完整料号不同，先修改 `platformio.ini`，不要通过反复擦除解决板型不匹配。

编译输出位于 `.pio/build/esp32s3/`。PlatformIO 上传会自动选择 bootloader、分区表、应用及正确偏移；无需手动拼接 bin。分区使用平台提供的 `default_16MB.csv`，当前不含 OTA 功能。

## 2. 原生 USB 烧录

- 使用可传输数据的 Type-C 线连接 GPIO19/20 对应的原生 USB 口。
- 点击 **Upload（→）**。有多个串口时，在命令中指定 `--upload-port COMx`（Windows）或实际 `/dev/cu.usbmodem…`（macOS）；也可在本机配置 `upload_port`。
- 首次无法识别：按住 **BOOT**，按一下 **EN/RESET**，松开 BOOT，再上传；必要时烧录完成后再按一次 RESET。
- 串口监视器波特率 115200，USB 模式为硬件 CDC / Serial-JTAG；未打开监视器不会阻止设备启动。
- 无需 CH340 驱动。USB 权限问题按操作系统处理；上传时关闭其他占用串口的软件。不要把清空 Flash 作为常规上传步骤，它会删除待处理库存记录。

## 3. 配置 Wi-Fi 和 JPLM

复制 `include/local_config.example.h` 为 `include/local_config.h`，填写：

- `TERMINAL_WIFI_SSID`、`TERMINAL_WIFI_PASSWORD`：2.4GHz 网络。
- `TERMINAL_API_URL`：站点根路径，默认 `https://work.makagic.com/JPLM/`；客户端自动附加 `api/`。
- `TERMINAL_EMAIL`、`TERMINAL_PASSWORD`：已有 JPLM 操作员账号；不要用管理员作为日常终端账号。首次强制改密的账户先在网页完成改密。
- `TERMINAL_ROOT_CA`：服务端证书链对应的受信任根 CA（PEM），从证书颁发机构的官方渠道获取并核对。不要把云端代理 CA 填给实体设备。

`local_config.h` 已加入 `.gitignore`，账号和密码不会写入仓库，但会包含在编译出的固件里。这只是首板开发配置；当前未实现设备端输入密码、用户切换、加密凭据存储或配网门户。不要分发包含私人凭据的固件。

HTTPS 始终验证服务器证书，并等待 NTP 时间有效；未配置 CA 会明确拒绝连接，不使用 `setInsecure()`。设备网络应允许 DNS/NTP（`pool.ntp.org` / `time.cloudflare.com`），否则按 `login` 提示排查。可信局域网开发若确需 HTTP，显式设置 `TERMINAL_ALLOW_HTTP 1` 并改 URL；HTTP 会明文传输凭据，不适用于公网。

Wi-Fi 连接后，在串口发送 `login` 手动登录。没有自动登录循环，避免配置错误时反复触发服务器登录限流。会话只在 RAM 中；重启后需重新登录。

## 4. 操作流程

1. 上电看到英文诊断页面（首版尚未加入中文字库）。
2. 串口输入 `status` 检查 Wi-Fi、PSRAM、会话和电压；输入 `login` 登录。
3. 按独立扫码键，或串口输入 `scan`。GPIO16 开漏拉低触发，最多 3 秒；收码成功释放触发。
4. UART 默认 **9600-8-N-1**，收到 CR/LF 或空闲 150ms 后成帧；最大 512 字节，溢出和非法控制字符整帧丢弃。若模块返回命令应答/其他帧，需先按实际协议调整解析；默认不发送卖家未实测的模式切换命令。
5. 扫码后通过 JPLM 查询物料，页面显示料号和库存；离线或未登录时仅收到扫码数据，提示先登录，不自动登记库存。也可串口输入 `lookup JC210001` 测试 API。
6. 按“出库 / 入库 / 报废”选择模式，输入数量（首版整数 1～999999，默认 1，首次数字输入替换默认值），删除键回退。
7. 按一次“确定”检查模式和数量，**再按一次“确定”才真正提交**。返回取消选料；方向键预留菜单导航。
8. 成功后蜂鸣提示并清空物料；下一次登记必须重新扫码。修改数量或模式会取消此前的确认状态。

按键布局来自当前图纸，矩阵行对应 GPIO5～9、列对应 GPIO10～13：

| 行 | C0 | C1 | C2 | C3 |
| --- | --- | --- | --- | --- |
| R0 | 返回 B | 出库 O | 入库 I | 报废 S |
| R1 | 上 U | 1 | 2 | 3 |
| R2 | 下 D | 4 | 5 | 6 |
| R3 | 左 L | 7 | 8 | 9 |
| R4 | 右 R | 删除 X | 0 | 确定 E |

串口命令：`help`、`status`、`scan`、`login`、`lookup CODE`、`key K`、`retry`。例如 `key I`、`key 2`、`key E`。串口确认与实体键有相同副作用，可能真实修改库存；首次联网验证请选择测试项目及物料。

## 5. 网络失败与断电恢复

- 提交前先把**完整请求体、随机 32 位十六进制 request_id、操作员 ID、服务器地址**作为一个 NVS 记录写入。写入失败则不发请求。
- 超时、认证失败或 HTTP 错误时保留原请求并锁住新登记；点击“确定”或发送 `retry` 重试。服务器按同一个 request_id 去重，不会因为收到响应前断线就创建第二笔。
- 重启后恢复待处理请求，使用相同服务器和原操作员重新登录，再重试。不会自动提交。
- 成功响应后清除 NVS；清除失败则仍保留相同请求，再次发送仍可去重。
- 如果服务器明确拒绝、物料已删或 NVS 记录损坏，先在 JPLM 网页人工核对流水和实际库存。确认无需再重试后，串口输入 **`clear-pending CONFIRMED-IN-JPLM`** 才能清掉锁。清除后下一笔会生成新编号，因此不能把它当作超时重试手段。

## 6. 文件职责

```text
firmware/
├── platformio.ini             # 固定平台/依赖版本、USB、N16R8 参数
├── include/
│   ├── board_pins.h           # 唯一 GPIO 定义
│   ├── settings.h             # 默认参数与本地配置入口
│   ├── local_config.example.h # 本地配置模板
│   ├── terminal_logic.h       # 独立于硬件的解析和输入规则
│   ├── peripherals.h          # 外设接口
│   └── plm_client.h           # JPLM 客户端接口
├── src/
│   ├── main.cpp               # 应用流程、确认、NVS 恢复和诊断命令
│   ├── peripherals.cpp        # 屏幕、键盘、扫码串口、电池和蜂鸣器
│   └── plm_client.cpp          # TLS、Cookie 登录、查料和库存登记
└── test/test_logic/           # 本机输入解析测试
```

后端接口为现有 `POST auth/login`、`GET auth/status`、`GET warehouse/material?q=…`、`POST warehouse/movements`。不需要改 Python 服务。PSRAM 可用量由 `status` 输出；当前框架没有依赖大帧缓冲的 GUI。

## 7. 首板调试与验证边界

- 固件编译成功不能替代实物验收。首先检查电压、PSRAM、屏幕方向/颜色、20 键位置、独立扫码键、串口收码和蜂鸣器，再连接 JPLM 测试项目。
- 屏幕默认为 SPI mode 3、旋转 0、背光高有效；可在本地配置里调整。当前 BLK 假设是逻辑控制输入，不能用软件补救直接带大电流背光的电路。
- 电池电压用 ADC 毫伏值乘分压系数，需用万用表校准 `TERMINAL_BATTERY_SCALE`；尚无可靠剩余电量百分比算法。
- 无二极管矩阵拒绝多键状态，未选列高阻，消抖 30ms；支持单键操作，不支持任意多键组合。
- 当前 HTTP/TLS 操作为同步、有超时的请求，连接期间界面和按键可能短暂停顿；触发在请求前释放。后续可拆分网络任务和 GUI。
- 首版 UI 为英文 ASCII。中文物料名称/错误原因可在 UTF-8 串口查看，TFT 没有中文字库。尚未实现中文菜单、触屏、OTA、深度睡眠、历史记录页或离线新登记队列。
- 本机测试（需 C++ 编译器，VS Code 编译烧录固件不要求运行此项）：`pio test -e native`。

## 8. 当前验证记录

- `pio run -e esp32s3`：编译通过，生成 bootloader、分区表和应用固件；已分别验证无本地配置及复制配置模板的构建路径。
- `pio test -e native`：4 项测试通过，覆盖 CR/LF 和空闲分帧、溢出/控制字符拒绝、矩阵映射/多键拒绝及数量边界。
- 仓库根目录 `python3 -m unittest discover -s tests -p test_app.py -k warehouse -v`：1 项现有 HTTP/SQLite 集成测试通过，覆盖扫码查询、权限及同 request_id 重试去重。
- 未连接实体 ESP32：未实测烧录、屏幕、ER007D、电池 ADC 或设备端 Wi-Fi/TLS；NVS 掉电恢复和真实超时需要首板故障注入验证。未向线上 JPLM 写入库存数据。
