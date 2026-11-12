# JPLM 出入库 Android

面向安卓 8.0 及以上的联网出入库终端。首次打开时，用任意 JPLM 账号登录。应用自动读取操作员名单，在应用私有存储内保存姓名和邮箱。账号变动后可点「刷新操作员名单」重新加载。

操作员点自己的姓名、输入密码后，直接进入出入库登记。支持扫码枪、摄像头和屏幕数字键盘。入库、出库和报废使用 JPLM 现有权限和库存记录。点「切换账号」可退出并返回名单。

使用 JDK 17 和 Android SDK 35 构建测试包。

```sh
./gradlew :app:assembleDebug
```

APK 位于 `app/build/outputs/apk/debug/app-debug.apk`。
